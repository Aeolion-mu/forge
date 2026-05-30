import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { computeFileDiff, type FileDiff } from "../ui/diff.js";
import { truncateForContext } from "../kernel/artifacts.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

/** 把相对路径收口到 workdir 内，防止路径穿越（../../etc/passwd）。写操作恒用它。 */
function safePath(workdir: string, p: string): string {
  const abs = resolve(workdir, p);
  if (abs !== workdir && !abs.startsWith(workdir + sep)) {
    throw new Error(`路径越界，拒绝访问 workdir 之外：${p}`);
  }
  return abs;
}

/** 只读路径解析：allowOutside 时放行 workdir 外的绝对/相对路径（供跨项目审查），否则同 safePath。 */
export function resolveReadPath(workdir: string, p: string, allowOutside: boolean): string {
  return allowOutside ? resolve(workdir, p) : safePath(workdir, p);
}

const readFileSchema = Type.Object({
  path: Type.String({ description: "相对 workdir 的文件路径" }),
  offset: Type.Optional(Type.Number({ description: "起始行号（1 基），默认 1。用于按行读大文件。" })),
  limit: Type.Optional(Type.Number({ description: "读取行数，默认全部（上限 2000 行）。" })),
});
const listDirSchema = Type.Object({ path: Type.Optional(Type.String({ description: "相对路径，默认 ." })) });
const writeFileSchema = Type.Object({
  path: Type.String({ description: "相对 workdir 的文件路径" }),
  content: Type.String({ description: "要写入的完整内容" }),
});
const editFileSchema = Type.Object({
  path: Type.String({ description: "相对 workdir 的文件路径（文件须已存在）" }),
  old_string: Type.String({ description: "要被替换的原文，须与文件内容精确匹配（含缩进/换行）。默认必须在文件中唯一。" }),
  new_string: Type.String({ description: "替换后的新文本。" }),
  replace_all: Type.Optional(Type.Boolean({ description: "替换全部匹配（默认 false：要求唯一匹配，否则报错）。" })),
});

/** 统计 needle 在 hay 中出现的次数（字面子串）。 */
function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

export function makeFsTools(workdir: string, allowReadOutside = false): AgentTool[] {
  const outsideHint = allowReadOutside ? "已开启只读越界：path 也可为 workdir 外的绝对路径（如审查其它项目）。" : "";
  const readFile: AgentTool<typeof readFileSchema, { path: string; lines: number; from: number; truncated: boolean }> = {
    name: "read_file",
    label: "读取文件",
    description:
      `读取文件，带行号显示（\`行号→内容\`，行号仅供参考、不是文件内容，编辑时勿带）。支持 offset/limit 按行读大文件，默认最多 2000 行。优先用本工具而非 bash 的 Get-Content/cat。${outsideHint}`,
    parameters: readFileSchema,
    execute: async (_id, params) => {
      const all = readFileSync(resolveReadPath(workdir, params.path, allowReadOutside), "utf8").split("\n");
      const from = Math.max(1, params.offset ?? 1);
      const max = Math.min(params.limit ?? 2000, 2000);
      const slice = all.slice(from - 1, from - 1 + max);
      const width = String(from + slice.length - 1).length;
      const body = slice.map((line, i) => `${String(from + i).padStart(width)}→${line}`).join("\n");
      const tail = from - 1 + slice.length < all.length ? `\n…(文件共 ${all.length} 行，可用 offset 继续读)` : "";
      // 行数已限 2000，但长行仍可能撑爆 token：超 maxChars 再按字符截断（原文件即来源，不落 artifact）。
      const t = truncateForContext(body + tail || "(空文件)", { workdir, save: false, hint: `用 read_file offset/limit 读取 ${params.path} 的指定行段` });
      return { content: txt(t.text), details: { path: params.path, lines: slice.length, from, truncated: t.truncated } };
    },
  };

  const listDir: AgentTool<typeof listDirSchema, { entries: number }> = {
    name: "list_dir",
    label: "列目录",
    description: `列出某个目录的条目（文件 / 子目录）。${outsideHint}`,
    parameters: listDirSchema,
    execute: async (_id, params) => {
      const abs = resolveReadPath(workdir, params.path ?? ".", allowReadOutside);
      const items = readdirSync(abs).map((name) => `${statSync(resolve(abs, name)).isDirectory() ? "d" : "-"} ${name}`);
      return { content: txt(items.join("\n") || "(空目录)"), details: { entries: items.length } };
    },
  };

  const writeFile: AgentTool<typeof writeFileSchema, { path: string; bytes: number; diff: FileDiff }> = {
    name: "write_file",
    label: "写入文件",
    description: "把内容写入 workdir 内文件（整文件覆盖）。用于新建文件或整体重写；改动已有文件的局部请优先用 edit_file。写操作会经过权限闸门确认。",
    parameters: writeFileSchema,
    execute: async (_id, params) => {
      const abs = safePath(workdir, params.path);
      const existed = existsSync(abs);
      const before = existed ? readFileSync(abs, "utf8") : "";
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, params.content, "utf8");
      const diff = computeFileDiff(before, params.content, existed ? "Update" : "Create", params.path);
      return {
        content: txt(`已写入 ${params.path}（${params.content.length} 字符）`),
        details: { path: params.path, bytes: params.content.length, diff },
      };
    },
  };

  const editFile: AgentTool<typeof editFileSchema, { path: string; replacements: number; diff: FileDiff }> = {
    name: "edit_file",
    label: "精准编辑",
    description:
      "对 workdir 内已有文件做精准片段替换：把 old_string 替换为 new_string。old_string 必须与文件内容精确匹配且默认唯一（不唯一时请补足上下文或用 replace_all）。适合改局部而不重写整文件。写操作会经过权限闸门确认。",
    parameters: editFileSchema,
    execute: async (_id, params) => {
      const abs = safePath(workdir, params.path);
      const before = readFileSync(abs, "utf8");
      if (params.old_string === params.new_string) {
        throw new Error("old_string 与 new_string 相同，无需编辑。");
      }
      const count = countOccurrences(before, params.old_string);
      if (count === 0) {
        throw new Error("未在文件中找到 old_string（需精确匹配，含缩进与换行）。");
      }
      if (count > 1 && !params.replace_all) {
        throw new Error(`old_string 在文件中出现 ${count} 次，不唯一。请补足上下文使其唯一，或设 replace_all=true。`);
      }
      // 用字面拼接而非 String.replace —— 后者会把 new_string 里的 $&/$1 当特殊模式。
      let after: string;
      if (params.replace_all) {
        after = before.split(params.old_string).join(params.new_string);
      } else {
        const idx = before.indexOf(params.old_string);
        after = before.slice(0, idx) + params.new_string + before.slice(idx + params.old_string.length);
      }
      writeFileSync(abs, after, "utf8");
      const replacements = params.replace_all ? count : 1;
      const diff = computeFileDiff(before, after, "Update", params.path);
      return {
        content: txt(`已编辑 ${params.path}（替换 ${replacements} 处，${before.length}→${after.length} 字符）`),
        details: { path: params.path, replacements, diff },
      };
    },
  };

  return [readFile, listDir, writeFile, editFile] as unknown as AgentTool[];
}
