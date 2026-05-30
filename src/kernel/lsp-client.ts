import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type ProtocolConnection,
} from "vscode-languageserver-protocol/node";
import * as proto from "vscode-languageserver-protocol";

/**
 * 最小 LSP 客户端 —— 语义级代码智能（tree-sitter outline 之上的增强层）。
 *
 * 每种语言 spawn 一个 language server（py=pyright, ts/js=typescript-language-server，
 * 均为 npm 自包含、无需外部工具链），用 JSON-RPC over stdio 通信。
 * server 解析不到（未安装）→ 优雅降级（query 返回 undefined，工具层回退 outline/grep）。
 *
 * 位置约定：对外方法用 1-based 行/列（与 read_file 一致）；内部转 LSP 的 0-based。
 */

interface ServerSpec {
  id: string;
  /** require.resolve 的模块入口。 */
  module: string;
  args: string[];
  languageId: string;
}

const SERVERS: Record<string, ServerSpec> = {
  ".py": { id: "pyright", module: "pyright/langserver.index.js", args: ["--stdio"], languageId: "python" },
  ".ts": { id: "tsls", module: "typescript-language-server/lib/cli.mjs", args: ["--stdio"], languageId: "typescript" },
  ".tsx": { id: "tsls", module: "typescript-language-server/lib/cli.mjs", args: ["--stdio"], languageId: "typescriptreact" },
  ".js": { id: "tsls", module: "typescript-language-server/lib/cli.mjs", args: ["--stdio"], languageId: "javascript" },
  ".jsx": { id: "tsls", module: "typescript-language-server/lib/cli.mjs", args: ["--stdio"], languageId: "javascriptreact" },
  ".mts": { id: "tsls", module: "typescript-language-server/lib/cli.mjs", args: ["--stdio"], languageId: "typescript" },
  ".cts": { id: "tsls", module: "typescript-language-server/lib/cli.mjs", args: ["--stdio"], languageId: "typescript" },
};

/** 某文件是否有可用的 LSP 语言映射（不代表 server 已安装）。 */
export function lspLangForPath(path: string): ServerSpec | undefined {
  return SERVERS[extname(path).toLowerCase()];
}

/** 归一化后的位置/范围（1-based，相对路径）。 */
export interface LspLocation {
  path: string;
  startLine: number;
  startCol: number;
  endLine: number;
}

export interface LspDiagnostic {
  line: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code?: string;
}

/** 一处文本替换（0-based 行/列，半开区间 [start,end)）。 */
export interface RenameEdit {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  newText: string;
}
/** rename 对一个文件的全部替换。 */
export interface RenameChange {
  path: string;
  edits: RenameEdit[];
}

const SEVERITY: Record<number, LspDiagnostic["severity"]> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

interface ServerHandle {
  conn: ProtocolConnection;
  child: ChildProcess;
  opened: Map<string, number>; // uri → 文档版本号（didChange 递增）
  diagnostics: Map<string, proto.Diagnostic[]>;
  /** 是否已预热（打开全工程同语言文件并等分析就绪），保证跨文件查询完整。 */
  warmed: boolean;
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".forge", "dist", "build", ".next", "coverage", ".cache", "__pycache__", ".venv", "venv",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 把 URI 归一成稳定的 map key：不同来源对盘符大小写/编码不一致
 * （我方 file:///C:/…，pyright file:///c%3A/…）。转成文件路径，Windows 再小写。
 */
function uriKey(uri: string): string {
  const p = fileURLToPath(uri);
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** 递归收集 root 下指定扩展名的文件（绝对路径），跳过忽略目录，限量。 */
function collectFiles(root: string, exts: Set<string>, cap: number): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < cap) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= cap) break;
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) stack.push(join(dir, e.name));
      } else if (exts.has(extname(e.name).toLowerCase())) {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

const requireFromHere = createRequire(import.meta.url);

const CLIENT_CAPABILITIES: proto.ClientCapabilities = {
  textDocument: {
    synchronization: { dynamicRegistration: false },
    documentSymbol: { hierarchicalDocumentSymbolSupport: false }, // 要扁平 SymbolInformation（带 location）
    definition: {},
    references: {},
    hover: { contentFormat: ["plaintext", "markdown"] },
    publishDiagnostics: {},
  },
};

export class LspClient {
  private servers = new Map<string, ServerHandle | null>(); // null = 启动失败（不再重试）

  constructor(private readonly workdir: string) {}

  /** 取（或惰性启动）处理该文件的 server；缺失/失败返回 undefined。 */
  private async ensure(path: string): Promise<{ handle: ServerHandle; spec: ServerSpec } | undefined> {
    const spec = lspLangForPath(path);
    if (!spec) return undefined;
    if (this.servers.has(spec.id)) {
      const h = this.servers.get(spec.id);
      return h ? { handle: h, spec } : undefined;
    }
    try {
      const serverJs = requireFromHere.resolve(spec.module);
      const child = spawn(process.execPath, [serverJs, ...spec.args], { cwd: this.workdir, stdio: ["pipe", "pipe", "pipe"] });
      // 吞掉子进程 / 管道错误（关闭后写 stdin 会 EPIPE），避免 unhandledRejection。
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
      const conn = createProtocolConnection(new StreamMessageReader(child.stdout!), new StreamMessageWriter(child.stdin!));
      const handle: ServerHandle = { conn, child, opened: new Map(), diagnostics: new Map(), warmed: false };
      conn.onNotification(proto.PublishDiagnosticsNotification.type, (p) => handle.diagnostics.set(uriKey(p.uri), p.diagnostics));
      conn.onError(() => {}); // 吞掉连接错误，避免崩主进程
      conn.listen();
      const rootUri = pathToFileURL(this.workdir).toString();
      await conn.sendRequest(proto.InitializeRequest.type, {
        processId: process.pid,
        rootUri,
        capabilities: CLIENT_CAPABILITIES,
        workspaceFolders: [{ uri: rootUri, name: "forge" }],
      });
      await conn.sendNotification(proto.InitializedNotification.type, {});
      this.servers.set(spec.id, handle);
      return { handle, spec };
    } catch {
      this.servers.set(spec.id, null); // 启动失败 → 标记，后续直接降级
      return undefined;
    }
  }

  private absUri(path: string): { abs: string; uri: string } {
    const abs = resolve(this.workdir, path);
    return { abs, uri: pathToFileURL(abs).toString() };
  }

  private async open(handle: ServerHandle, spec: ServerSpec, path: string): Promise<string> {
    const { abs } = this.absUri(path);
    return this.openAbs(handle, spec, abs);
  }

  /** didOpen 一个绝对路径文件（去重）。 */
  private async openAbs(handle: ServerHandle, spec: ServerSpec, abs: string): Promise<string> {
    const uri = pathToFileURL(abs).toString();
    if (!handle.opened.has(uri)) {
      const text = readFileSync(abs, "utf8");
      await handle.conn.sendNotification(proto.DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId: spec.languageId, version: 1, text },
      });
      handle.opened.set(uri, 1);
    }
    return uri;
  }

  /**
   * 通知 server 文件已变更（编辑后用），重发全文触发重新分析。
   * 若该文件还没 open，则不处理（后续 diagnostics/查询会 open 到新内容）。
   */
  async didChange(path: string): Promise<void> {
    const e = await this.ensure(path);
    if (!e) return;
    const { abs, uri } = this.absUri(path);
    const v = e.handle.opened.get(uri);
    if (v === undefined) return;
    const nv = v + 1;
    await e.handle.conn.sendNotification(proto.DidChangeTextDocumentNotification.type, {
      textDocument: { uri, version: nv },
      contentChanges: [{ text: readFileSync(abs, "utf8") }],
    });
    e.handle.opened.set(uri, nv);
  }

  /**
   * 预热工作区：打开全工程同语言文件让 server 建立索引，再等分析就绪。
   * 否则 pyright/tsls 惰性分析 → 未打开文件不进索引 → 跨文件 references/definition 漏报。
   * 只做一次（warmed）。文件数受 cap 限制，分析就绪用 diagnostics 数量趋稳判定。
   */
  private async warm(handle: ServerHandle, spec: ServerSpec): Promise<void> {
    if (handle.warmed) return;
    handle.warmed = true;
    const exts = new Set(Object.entries(SERVERS).filter(([, s]) => s.id === spec.id).map(([ext]) => ext));
    const files = collectFiles(this.workdir, exts, 300);
    for (const f of files) await this.openAbs(handle, spec, f);
    // 等分析就绪：diagnostics 收到数趋稳（连续 600ms 不变且 >0）或超时。
    const start = Date.now();
    let last = -1;
    let stableSince = Date.now();
    while (Date.now() - start < 5000) {
      const n = handle.diagnostics.size;
      if (n !== last) {
        last = n;
        stableSince = Date.now();
      } else if (n > 0 && Date.now() - stableSince > 600) {
        return;
      }
      await sleep(100);
    }
  }

  /** uri → 相对 workdir 的 posix 路径（Windows 盘符大小写不敏感比较）；workdir 外则返回绝对路径。 */
  private relFromUri(uri: string): string {
    const abs = fileURLToPath(uri);
    const base = resolve(this.workdir);
    const inside = abs.toLowerCase().startsWith(base.toLowerCase());
    return inside ? abs.slice(base.length).replace(/^[\\/]/, "").split("\\").join("/") : abs;
  }

  /** 把 LSP Location/LocationLink 归一化为相对路径 + 1-based。 */
  private norm(loc: proto.Location | proto.LocationLink): LspLocation {
    const uri = "targetUri" in loc ? loc.targetUri : loc.uri;
    const range = "targetRange" in loc ? loc.targetSelectionRange ?? loc.targetRange : loc.range;
    return { path: this.relFromUri(uri), startLine: range.start.line + 1, startCol: range.start.character + 1, endLine: range.end.line + 1 };
  }

  /** 文档符号（扁平）。server 缺失返回 undefined。 */
  async documentSymbols(path: string): Promise<{ name: string; kind: number; line: number }[] | undefined> {
    const e = await this.ensure(path);
    if (!e) return undefined;
    const uri = await this.open(e.handle, e.spec, path);
    const syms = await e.handle.conn.sendRequest(proto.DocumentSymbolRequest.type, { textDocument: { uri } });
    if (!syms) return [];
    return (syms as Array<proto.SymbolInformation | proto.DocumentSymbol>).map((s) => {
      const range = "location" in s ? s.location.range : s.range;
      return { name: s.name, kind: s.kind, line: range.start.line + 1 };
    });
  }

  /** 定义位置（1-based 入参）。 */
  async definition(path: string, line: number, col: number): Promise<LspLocation[] | undefined> {
    const e = await this.ensure(path);
    if (!e) return undefined;
    await this.warm(e.handle, e.spec); // 预热全工程，保证跨文件结果完整
    const uri = await this.open(e.handle, e.spec, path);
    const res = await e.handle.conn.sendRequest(proto.DefinitionRequest.type, {
      textDocument: { uri },
      position: { line: line - 1, character: col - 1 },
    });
    return this.toLocations(res);
  }

  /** 引用位置（1-based 入参）。 */
  async references(path: string, line: number, col: number, includeDeclaration = true): Promise<LspLocation[] | undefined> {
    const e = await this.ensure(path);
    if (!e) return undefined;
    await this.warm(e.handle, e.spec); // 预热全工程，保证跨文件结果完整
    const uri = await this.open(e.handle, e.spec, path);
    const res = await e.handle.conn.sendRequest(proto.ReferencesRequest.type, {
      textDocument: { uri },
      position: { line: line - 1, character: col - 1 },
      context: { includeDeclaration },
    });
    return (res ?? []).map((l) => this.norm(l));
  }

  /** hover 文本（1-based 入参）。 */
  async hover(path: string, line: number, col: number): Promise<string | undefined> {
    const e = await this.ensure(path);
    if (!e) return undefined;
    await this.warm(e.handle, e.spec); // 预热全工程，保证跨文件类型解析完整
    const uri = await this.open(e.handle, e.spec, path);
    const res = await e.handle.conn.sendRequest(proto.HoverRequest.type, {
      textDocument: { uri },
      position: { line: line - 1, character: col - 1 },
    });
    if (!res || !res.contents) return "";
    const c = res.contents;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x.value)).join("\n");
    return (c as proto.MarkupContent).value ?? "";
  }

  /**
   * 重命名符号（1-based 入参）：返回跨文件的替换清单（由工具层套用到磁盘）。
   * server 缺失/不支持返回 undefined；定位无效返回 []。
   */
  async rename(path: string, line: number, col: number, newName: string): Promise<RenameChange[] | undefined> {
    const e = await this.ensure(path);
    if (!e) return undefined;
    await this.warm(e.handle, e.spec); // 跨文件 rename 需索引完整
    const uri = await this.open(e.handle, e.spec, path);
    const we = await e.handle.conn.sendRequest(proto.RenameRequest.type, {
      textDocument: { uri },
      position: { line: line - 1, character: col - 1 },
      newName,
    });
    if (!we) return [];
    const toEdits = (edits: proto.TextEdit[]): RenameEdit[] =>
      edits.map((t) => ({
        startLine: t.range.start.line,
        startCol: t.range.start.character,
        endLine: t.range.end.line,
        endCol: t.range.end.character,
        newText: t.newText,
      }));
    const out: RenameChange[] = [];
    if (we.changes) {
      for (const [u, edits] of Object.entries(we.changes)) out.push({ path: this.relFromUri(u), edits: toEdits(edits) });
    } else if (we.documentChanges) {
      for (const dc of we.documentChanges) {
        if ("textDocument" in dc && "edits" in dc) {
          out.push({ path: this.relFromUri(dc.textDocument.uri), edits: toEdits(dc.edits as proto.TextEdit[]) });
        }
      }
    }
    return out;
  }

  /** 文件的诊断（错误/警告/提示）。server 缺失返回 undefined。 */
  async diagnostics(path: string): Promise<LspDiagnostic[] | undefined> {
    const e = await this.ensure(path);
    if (!e) return undefined;
    await this.warm(e.handle, e.spec);
    const uri = await this.open(e.handle, e.spec, path);
    const key = uriKey(uri);
    // pyright 常先推空诊断（分析中）再推最终结果，故等该文件诊断**趋稳**（停变 500ms）再取，
    // 否则会拿到过早的空数组漏报错误。
    const deadline = Date.now() + 4000;
    let snapshot = JSON.stringify(e.handle.diagnostics.get(key) ?? null);
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await sleep(120);
      const cur = JSON.stringify(e.handle.diagnostics.get(key) ?? null);
      if (cur !== snapshot) {
        snapshot = cur;
        stableSince = Date.now();
      } else if (e.handle.diagnostics.has(key) && Date.now() - stableSince > 500) {
        break;
      }
    }
    const diags = e.handle.diagnostics.get(key);
    return (diags ?? []).map((d) => ({
      line: d.range.start.line + 1,
      severity: SEVERITY[d.severity ?? 1] ?? "info",
      message: d.message,
      code: d.code != null ? String(d.code) : undefined,
    }));
  }

  private toLocations(res: proto.Definition | proto.LocationLink[] | null): LspLocation[] {
    if (!res) return [];
    const arr = Array.isArray(res) ? res : [res];
    return arr.map((l) => this.norm(l as proto.Location | proto.LocationLink));
  }

  /** 关闭所有 server 进程。 */
  async dispose(): Promise<void> {
    for (const h of this.servers.values()) {
      if (!h) continue;
      try {
        await h.conn.sendRequest(proto.ShutdownRequest.type);
      } catch {
        /* ignore */
      }
      try {
        await h.conn.sendNotification(proto.ExitNotification.type);
      } catch {
        /* ignore */
      }
      try {
        h.conn.dispose(); // 关闭 reader/writer，停止监听
      } catch {
        /* ignore */
      }
      try {
        h.child.stdin?.destroy();
      } catch {
        /* ignore */
      }
      h.child.kill();
    }
    this.servers.clear();
  }
}
