import { readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { resolveReadPath } from "./fs-tools.js";
import { computeFileDiff, type FileDiff } from "../ui/diff.js";
import { lspLangForPath, type LspClient, type LspLocation, type RenameEdit } from "../kernel/lsp-client.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

/** 正则转义。 */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 在源码里定位符号名的位置（1-based 行/列）。指定 line 则只在该行找；否则取首个词边界匹配。
 * 朴素文本定位（可能命中注释/子串），但足够给 LSP 一个落点，语义由 server 解析。
 */
export function locateSymbol(source: string, symbol: string, line?: number): { line: number; col: number } | undefined {
  const lines = source.split("\n");
  const re = new RegExp(`\\b${esc(symbol)}\\b`);
  if (line !== undefined) {
    const m = re.exec(lines[line - 1] ?? "");
    return m ? { line, col: m.index + 1 } : undefined;
  }
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) return { line: i + 1, col: m.index + 1 };
  }
  return undefined;
}

const fmtLoc = (l: LspLocation) => `${l.path}:${l.startLine}`;

/**
 * 把 LSP 的文本替换（0-based 行/列，半开区间）套用到源码。
 * 按起始偏移**倒序**套，避免前面的替换移动后面的偏移；用 \n 计行首偏移，CRLF 也安全
 * （col 是行内 UTF-16 偏移，落在行文本内，不触及行尾 \r\n）。
 */
export function applyTextEdits(content: string, edits: RenameEdit[]): string {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  const off = (line: number, col: number) => (starts[line] ?? content.length) + col;
  const sorted = [...edits].sort((a, b) => off(b.startLine, b.startCol) - off(a.startLine, a.startCol));
  let out = content;
  for (const e of sorted) {
    out = out.slice(0, off(e.startLine, e.startCol)) + e.newText + out.slice(off(e.endLine, e.endCol));
  }
  return out;
}

const symSchema = Type.Object({
  path: Type.String({ description: "符号所在文件（相对 workdir；开启越界只读时可绝对路径）" }),
  symbol: Type.String({ description: "符号名（函数/类/变量名）" }),
  line: Type.Optional(Type.Number({ description: "符号所在行号（1-based），多处同名时用它消歧；缺省取首个匹配" })),
});

const UNAVAILABLE = "LSP 未就绪（该语言无 server 或未安装，仅 py/ts/tsx/js/jsx 支持）。请改用 grep / outline 代替。";

/**
 * LSP 语义工具：definition / references / hover，按**符号名**查询（先在文件里定位符号位置，
 * 再交 language server 做跨文件语义解析）。比 grep 准、跨文件。server 缺失则提示并建议回退。
 */
export function makeLspTools(workdir: string, lsp: LspClient, allowReadOutside = false): AgentTool[] {
  const locate = (path: string, symbol: string, line?: number) => {
    const abs = resolveReadPath(workdir, path, allowReadOutside);
    return locateSymbol(readFileSync(abs, "utf8"), symbol, line);
  };

  const references: AgentTool<typeof symSchema, { found: boolean; count: number }> = {
    name: "references",
    label: "查引用",
    description: "用 LSP 找一个符号在全工程的所有引用（跨文件，比 grep 准）。支持 py/ts/tsx/js/jsx。",
    parameters: symSchema,
    execute: async (_id, p) => {
      if (!lspLangForPath(p.path)) return { content: txt(UNAVAILABLE), details: { found: false, count: 0 } };
      const pos = locate(p.path, p.symbol, p.line);
      if (!pos) return { content: txt(`未在 ${p.path} 找到符号 ${p.symbol}`), details: { found: false, count: 0 } };
      const refs = await lsp.references(p.path, pos.line, pos.col);
      if (refs === undefined) return { content: txt(UNAVAILABLE), details: { found: false, count: 0 } };
      const body = refs.length ? refs.map(fmtLoc).join("\n") : "(无引用)";
      return { content: txt(`references ${p.symbol} (${refs.length}):\n${body}`), details: { found: true, count: refs.length } };
    },
  };

  const definition: AgentTool<typeof symSchema, { found: boolean; count: number }> = {
    name: "definition",
    label: "查定义",
    description: "用 LSP 跳到符号的定义处（跨文件，比 grep 准）。给出符号在某文件的使用处，返回其定义位置。支持 py/ts/tsx/js/jsx。",
    parameters: symSchema,
    execute: async (_id, p) => {
      if (!lspLangForPath(p.path)) return { content: txt(UNAVAILABLE), details: { found: false, count: 0 } };
      const pos = locate(p.path, p.symbol, p.line);
      if (!pos) return { content: txt(`未在 ${p.path} 找到符号 ${p.symbol}`), details: { found: false, count: 0 } };
      const defs = await lsp.definition(p.path, pos.line, pos.col);
      if (defs === undefined) return { content: txt(UNAVAILABLE), details: { found: false, count: 0 } };
      const body = defs.length ? defs.map(fmtLoc).join("\n") : "(无定义)";
      return { content: txt(`definition ${p.symbol}:\n${body}`), details: { found: true, count: defs.length } };
    },
  };

  const hover: AgentTool<typeof symSchema, { found: boolean }> = {
    name: "hover",
    label: "查类型/文档",
    description: "用 LSP 取符号的类型签名 / 文档（hover）。支持 py/ts/tsx/js/jsx。",
    parameters: symSchema,
    execute: async (_id, p) => {
      if (!lspLangForPath(p.path)) return { content: txt(UNAVAILABLE), details: { found: false } };
      const pos = locate(p.path, p.symbol, p.line);
      if (!pos) return { content: txt(`未在 ${p.path} 找到符号 ${p.symbol}`), details: { found: false } };
      const h = await lsp.hover(p.path, pos.line, pos.col);
      if (h === undefined) return { content: txt(UNAVAILABLE), details: { found: false } };
      return { content: txt(h || "(无 hover 信息)"), details: { found: true } };
    },
  };

  const renameSchema = Type.Object({
    path: Type.String({ description: "符号所在文件" }),
    symbol: Type.String({ description: "要重命名的符号名" }),
    newName: Type.String({ description: "新名字" }),
    line: Type.Optional(Type.Number({ description: "符号所在行号（1-based）消歧，缺省取首个匹配" })),
  });

  const rename: AgentTool<typeof renameSchema, { found: boolean; files: number; diffs: FileDiff[] }> = {
    name: "rename",
    label: "重命名符号",
    description:
      "用 LSP 跨全工程重命名一个符号（函数/类/变量）并同步所有引用，比手工改安全。支持 py/ts/tsx/js/jsx。写操作经权限闸门。",
    parameters: renameSchema,
    execute: async (_id, p) => {
      const args = p as { path: string; symbol: string; newName: string; line?: number };
      if (!lspLangForPath(args.path)) return { content: txt(UNAVAILABLE), details: { found: false, files: 0, diffs: [] } };
      const pos = locate(args.path, args.symbol, args.line);
      if (!pos) return { content: txt(`未在 ${args.path} 找到符号 ${args.symbol}`), details: { found: false, files: 0, diffs: [] } };
      const changes = await lsp.rename(args.path, pos.line, pos.col, args.newName);
      if (changes === undefined) return { content: txt(UNAVAILABLE), details: { found: false, files: 0, diffs: [] } };
      if (changes.length === 0) return { content: txt(`无可重命名的引用（${args.symbol}）`), details: { found: false, files: 0, diffs: [] } };
      const diffs: FileDiff[] = [];
      const summary: string[] = [];
      for (const ch of changes) {
        const abs = resolveReadPath(workdir, ch.path, allowReadOutside);
        const before = readFileSync(abs, "utf8");
        const after = applyTextEdits(before, ch.edits);
        writeFileSync(abs, after, "utf8");
        await lsp.didChange(ch.path); // 同步 server，后续查询/诊断看到新内容
        diffs.push(computeFileDiff(before, after, "Update", ch.path));
        summary.push(`${ch.path}（${ch.edits.length} 处）`);
      }
      return {
        content: txt(`已重命名 ${args.symbol} → ${args.newName}，跨 ${changes.length} 文件：\n${summary.join("\n")}`),
        details: { found: true, files: changes.length, diffs },
      };
    },
  };

  return [definition, references, hover, rename] as unknown as AgentTool[];
}
