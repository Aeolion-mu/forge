import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { computeFileDiff, type FileDiff } from "../ui/diff.js";

/**
 * apply_patch —— 带上下文的多文件补丁（Codex 风格）。比 edit_file 强：一次跨多文件、
 * 多个 hunk，靠**上下文行**定位（空格=保留，- =删除，+ =新增）。
 *
 * 格式：
 *   *** Begin Patch
 *   *** Update File: src/a.ts
 *   @@
 *    保留的上下文行
 *   -被删除的行
 *   +新增的行
 *   *** Add File: src/b.ts
 *   +新文件内容
 *   *** Delete File: src/c.ts
 *   *** End Patch
 */

const patchSchema = Type.Object({
  patch: Type.String({
    description:
      "*** Begin Patch / *** Update|Add|Delete File: <path> / @@ hunk（空格上下文 / -删 / +增）/ *** End Patch。Add File 的内容行以 + 开头。标记行的 *** 前缀不可省略",
  }),
});

function safePath(workdir: string, p: string): string {
  const abs = resolve(workdir, p);
  if (abs !== workdir && !abs.startsWith(workdir + sep)) throw new Error(`路径越界，拒绝访问 workdir 之外：${p}`);
  return abs;
}

interface FileOp {
  kind: "update" | "add" | "delete";
  path: string;
  body: string[];
}

/**
 * 文件标记行：`*** Update File: path`（严格 Codex 格式）或裸 `Update File: path`。
 * 后者是常见模型变体（实测 glm/gpt 都会发）——只认严格格式会把整份 patch 判成
 * 「未解析到文件操作」。行首空格**不**容忍（空格只许跟在 *** 后面）：hunk 上下文行
 * 以空格开头，" Update File: xxx" 是内容不是标记。
 */
const FILE_MARKER_RE = /^(?:\*\*\*[ \t]*)?(Update|Add|Delete) File:\s*(.+)$/;

function parsePatch(patch: string): FileOp[] {
  const ops: FileOp[] = [];
  let cur: FileOp | null = null;
  // 按 \r?\n 切分：模型输出的 patch 文本可能带 CRLF（与宿主平台无关），残留的 \r
  // 会让标记正则匹配失败（(.+)$ 卡在 \r 前），且污染 body 行内容。
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) continue;
    // markdown 围栏（```text … ``` 包裹整份 patch 的常见习惯）：跳过，不当 body。
    if (/^\s*```/.test(line)) continue;
    const m = FILE_MARKER_RE.exec(line);
    if (m) {
      const kind = m[1]!.toLowerCase() as FileOp["kind"];
      cur = pushOp(ops, kind, m[2]!);
    } else if (cur) {
      cur.body.push(line);
    }
  }
  return ops;
}

function pushOp(ops: FileOp[], kind: FileOp["kind"], path: string): FileOp {
  const op: FileOp = { kind, path: path.trim(), body: [] };
  ops.push(op);
  return op;
}

/** 把一个 Update 的 body 按 @@ 切成 hunk，逐个按上下文定位替换。 */
function applyUpdate(content: string, body: string[]): string {
  const hunks: string[][] = [];
  let h: string[] = [];
  for (const line of body) {
    if (line.startsWith("@@")) {
      if (h.length) hunks.push(h);
      h = [];
    } else {
      h.push(line);
    }
  }
  if (h.length) hunks.push(h);

  let out = content;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of hunk) {
      if (line.startsWith("+")) newLines.push(line.slice(1));
      else if (line.startsWith("-")) oldLines.push(line.slice(1));
      else {
        const c = line.startsWith(" ") ? line.slice(1) : line; // 上下文（含无前缀的宽松写法）
        oldLines.push(c);
        newLines.push(c);
      }
    }
    const oldBlock = oldLines.join("\n");
    const newBlock = newLines.join("\n");
    if (oldBlock === "") continue;
    const idx = out.indexOf(oldBlock);
    if (idx === -1) throw new Error(`补丁 hunk 上下文未匹配：\n${oldBlock.slice(0, 160)}…`);
    out = out.slice(0, idx) + newBlock + out.slice(idx + oldBlock.length);
  }
  return out;
}

export function makeApplyPatchTool(workdir: string): AgentHarnessTool<object | undefined, typeof patchSchema, { files: number; diffs: FileDiff[] }> {
  return {
    name: "apply_patch",
    label: "应用补丁",
    description:
      "应用带上下文的多文件补丁（*** Begin Patch / Update|Add|Delete File / @@ / 空格上下文·-删·+增 / *** End Patch）。改局部、跨多文件首选。写操作经权限闸门。",
    parameters: patchSchema,
    execute: async (_id, params, _onUpdate, _toolCtx, _invocation, _ctx) => {
      const ops = parsePatch(params.patch);
      if (!ops.length) throw new Error("未解析到文件操作（检查 *** Update/Add/Delete File 标记）");
      const summary: string[] = [];
      const diffs: FileDiff[] = [];
      for (const op of ops) {
        const abs = safePath(workdir, op.path);
        if (op.kind === "delete") {
          const before = readFileSync(abs, "utf8");
          rmSync(abs);
          summary.push(`删除 ${op.path}`);
          diffs.push(computeFileDiff(before, "", "Delete", op.path));
        } else if (op.kind === "add") {
          const text = op.body.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n");
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, text, "utf8");
          summary.push(`新增 ${op.path}（${text.length} 字符）`);
          diffs.push(computeFileDiff("", text, "Create", op.path));
        } else {
          const before = readFileSync(abs, "utf8");
          const after = applyUpdate(before, op.body);
          writeFileSync(abs, after, "utf8");
          summary.push(`更新 ${op.path}（${before.length}→${after.length} 字符）`);
          diffs.push(computeFileDiff(before, after, "Update", op.path));
        }
      }
      return { content: [{ type: "text", text: `已应用补丁：\n${summary.join("\n")}` }], details: { files: ops.length, diffs } };
    },
  };
}
