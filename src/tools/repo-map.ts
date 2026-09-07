import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { langKeyForPath, outlineSource, type CodeSymbol } from "../kernel/code-outline.js";
import { resolveReadPath } from "./fs-tools.js";
import { walk } from "./search-tools.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

export interface FileOutline {
  relpath: string;
  symbols: CodeSymbol[];
}

/** 每文件最多列多少符号（防单文件吃光预算）。 */
const MAX_SYMS_PER_FILE = 40;
const CHARS_PER_TOKEN = 4;

/**
 * 把全仓符号拼成一张紧凑「代码地图」，受 token 预算约束（超了就停并标省略）。
 * 形如：
 *   src/foo.py
 *     L3   class Foo:
 *     L4     def bar(self, x):
 *     L20  def top(a, b):
 */
export function formatRepoMap(files: FileOutline[], budgetTokens: number): string {
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const withSyms = files.filter((f) => f.symbols.length > 0);
  const out: string[] = [
    `Repo map · ${withSyms.length} files（仅符号概览；用 outline 看单文件全貌、read_file 按行精读）`,
  ];
  let used = out[0].length;
  let omitted = 0;

  for (let i = 0; i < withSyms.length; i++) {
    const f = withSyms[i];
    const shown = f.symbols.slice(0, MAX_SYMS_PER_FILE);
    const lines = [
      f.relpath,
      ...shown.map((s) => `${s.container ? "    " : "  "}L${s.startLine}\t${s.signature}`),
    ];
    if (f.symbols.length > MAX_SYMS_PER_FILE) lines.push(`  …(+${f.symbols.length - MAX_SYMS_PER_FILE} more symbols)`);
    const block = lines.join("\n");
    if (used + block.length > budgetChars && out.length > 1) {
      omitted = withSyms.length - i;
      break;
    }
    out.push(block);
    used += block.length + 1;
  }
  if (omitted > 0) out.push(`…(+${omitted} more files omitted — raise budget or use outline/grep)`);
  return out.join("\n");
}

/** 遍历 root 下支持的源码文件，逐个抽 outline。maxFiles 防大仓爆。 */
export async function collectRepoOutline(workdir: string, rootAbs: string, maxFiles = 400): Promise<FileOutline[]> {
  const rels = walk(rootAbs, workdir).filter((f) => langKeyForPath(f)).slice(0, maxFiles);
  const result: FileOutline[] = [];
  for (const rel of rels) {
    const langKey = langKeyForPath(rel)!;
    try {
      const source = readFileSync(resolve(workdir, rel), "utf8");
      result.push({ relpath: rel, symbols: await outlineSource(source, langKey) });
    } catch {
      /* 读不了/解析失败的文件跳过 */
    }
  }
  result.sort((a, b) => a.relpath.localeCompare(b.relpath));
  return result;
}

const repoMapSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "起始目录（相对 workdir），默认整个 workdir" })),
  budget: Type.Optional(Type.Number({ description: "token 预算，默认 4000；超出按文件截断" })),
});

/**
 * repo_map 工具：一张全仓「文件 → 符号签名 + 行号」地图，用于快速建立代码库结构认知，
 * 再用 outline/read_file 钻取。受 token 预算约束，避免把整库灌进上下文。
 */
export function makeRepoMapTool(workdir: string, allowReadOutside = false): AgentTool<typeof repoMapSchema, { files: number; budget: number }> {
  return {
    name: "repo_map",
    label: "代码地图",
    description:
      "生成全仓（或指定子目录）的代码地图：每个源码文件的顶层符号签名 + 行号。**理解陌生代码库时先用它建立全局结构**，再用 outline 看单文件、read_file 按行精读。受 token 预算约束。支持 py/js/ts/tsx/go/rs/java。",
    parameters: repoMapSchema,
    execute: async (_id, params) => {
      const rootAbs = resolveReadPath(workdir, params.path ?? ".", allowReadOutside);
      const budget = params.budget && params.budget > 0 ? params.budget : 4000;
      const files = await collectRepoOutline(workdir, rootAbs);
      const map = formatRepoMap(files, budget);
      return { content: txt(map), details: { files: files.filter((f) => f.symbols.length > 0).length, budget } };
    },
  };
}
