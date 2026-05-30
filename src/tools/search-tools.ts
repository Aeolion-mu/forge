import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { truncateForContext } from "../kernel/artifacts.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

/** 遍历时跳过的目录（噪音 / 体积大）。 */
const IGNORE = new Set(["node_modules", ".git", ".forge", "dist", "build", ".next", "coverage", ".cache", "test_project"]);

/** 按扩展名跳过的二进制文件（grep 不读它们）。 */
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".mp3",
  ".wav", ".ogg", ".webm", ".mov", ".jar", ".class", ".wasm", ".node",
]);

function safeDir(workdir: string, p: string | undefined, allowOutside: boolean): string {
  const abs = resolve(workdir, p ?? ".");
  if (!allowOutside && abs !== workdir && !abs.startsWith(workdir + sep)) throw new Error(`路径越界：${p}`);
  return abs;
}

/** 递归收集文件（posix 相对路径），跳过忽略目录，限量防爆。供 repo_map 复用。 */
export function walk(root: string, workdir: string, limit = 20000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (IGNORE.has(name)) continue;
      const abs = resolve(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(abs);
      else if (st.isFile()) out.push(relative(workdir, abs).split(sep).join("/"));
    }
  }
  return out;
}

/** glob → 正则：支持 ** / * / ?。 */
function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += "(?:.*/)?"; // ** 跨目录
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

const globSchema = Type.Object({
  pattern: Type.String({ description: "glob 模式，如 **/*.ts、src/**/*.tsx" }),
  path: Type.Optional(Type.String({ description: "起始目录（相对 workdir），默认 ." })),
});

const grepSchema = Type.Object({
  pattern: Type.String({ description: "正则表达式（JS 语法）" }),
  path: Type.Optional(Type.String({ description: "起始目录，默认 ." })),
  glob: Type.Optional(Type.String({ description: "只搜匹配此 glob 的文件，如 *.ts" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "忽略大小写，默认 false" })),
});

export function makeSearchTools(workdir: string, allowReadOutside = false): AgentTool[] {
  const glob: AgentTool<typeof globSchema, { matches: number }> = {
    name: "glob",
    label: "文件匹配",
    description: "按 glob 模式查找文件（** 跨目录），返回相对路径列表（按修改时间倒序）。自动跳过 node_modules/.git 等。",
    parameters: globSchema,
    execute: async (_id, params) => {
      const root = safeDir(workdir, params.path, allowReadOutside);
      const re = globToRegex(params.pattern);
      const files = walk(root, workdir).filter((f) => re.test(f));
      files.sort((a, b) => statSync(resolve(workdir, b)).mtimeMs - statSync(resolve(workdir, a)).mtimeMs);
      const shown = files.slice(0, 200);
      const more = files.length > shown.length ? `\n…(共 ${files.length} 个，仅显示前 ${shown.length})` : "";
      const t = truncateForContext(shown.join("\n") + more || "(无匹配)", { workdir, save: true });
      return { content: txt(t.text), details: { matches: files.length } };
    },
  };

  const grep: AgentTool<typeof grepSchema, { matches: number; files: number }> = {
    name: "grep",
    label: "内容搜索",
    description: "在文件内容里用正则搜索，返回 路径:行号: 匹配行。可用 glob 限定文件类型。自动跳过二进制/大文件/忽略目录。",
    parameters: grepSchema,
    execute: async (_id, params) => {
      const root = safeDir(workdir, params.path, allowReadOutside);
      const re = new RegExp(params.pattern, params.ignoreCase ? "i" : undefined);
      const fileGlob = params.glob ? globToRegex(params.glob.includes("/") ? params.glob : `**/${params.glob}`) : undefined;
      let files = walk(root, workdir);
      if (fileGlob) files = files.filter((f) => fileGlob.test(f));
      const hits: string[] = [];
      let matchedFiles = 0;
      for (const f of files) {
        if (hits.length >= 200) break;
        if (BINARY_EXT.has(extname(f).toLowerCase())) continue;
        const abs = resolve(workdir, f);
        try {
          if (statSync(abs).size > 1024 * 1024) continue; // 跳过 >1MB
          const lines = readFileSync(abs, "utf8").split("\n");
          let fileHit = false;
          for (let i = 0; i < lines.length && hits.length < 200; i++) {
            if (re.test(lines[i])) {
              hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              fileHit = true;
            }
          }
          if (fileHit) matchedFiles += 1;
        } catch {
          /* 读不了就跳过 */
        }
      }
      const head = hits.length >= 200 ? "(命中过多，仅显示前 200 条)\n" : "";
      const t = truncateForContext(head + (hits.join("\n") || "(无匹配)"), { workdir, save: true });
      return {
        content: txt(t.text),
        details: { matches: hits.length, files: matchedFiles },
      };
    },
  };

  return [glob, grep] as unknown as AgentTool[];
}
