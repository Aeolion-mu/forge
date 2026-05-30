import { readFileSync } from "node:fs";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { langKeyForPath, outlineSource, type CodeSymbol } from "../kernel/code-outline.js";
import { resolveReadPath } from "./fs-tools.js";
import { truncateForContext } from "../kernel/artifacts.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

/** 把符号列表格式化成紧凑大纲：每行 `L起–止  签名`，方法在类下缩进。 */
export function formatOutline(relpath: string, syms: CodeSymbol[]): string {
  if (syms.length === 0) return `${relpath} · (无可识别符号)`;
  const head = `${relpath} · ${syms.length} symbols（用 read_file 的 offset/limit 精读某段，不必整文件读）`;
  const body = syms.map((s) => {
    const indent = s.container ? "    " : "  ";
    const range = `L${s.startLine}–${s.endLine}`.padEnd(12);
    return `${indent}${range}${s.signature}`;
  });
  return [head, ...body].join("\n");
}

const outlineSchema = Type.Object({
  path: Type.String({ description: "相对 workdir 的文件路径（开启越界只读时也可绝对路径）" }),
});

/**
 * outline 工具：列出文件的符号（函数/类/方法/接口…）及其起止行，
 * 让模型「先看结构、再用 read_file 按行精读」，避免整文件读取（省上下文、降幻觉）。
 * 支持 py/js/jsx/ts/tsx/go/rs/java；其它类型提示改用 read_file。
 */
export function makeOutlineTool(workdir: string, allowReadOutside = false): AgentTool<typeof outlineSchema, { path: string; symbols: number; supported: boolean }> {
  return {
    name: "outline",
    label: "代码大纲",
    description:
      "列出代码文件的符号（函数/类/方法/接口/枚举等）及其起止行号。**读代码前先用它看结构**，再用 read_file 的 offset/limit 精读相关函数，不要整文件通读。支持 .py/.js/.jsx/.ts/.tsx/.go/.rs/.java。",
    parameters: outlineSchema,
    execute: async (_id, params) => {
      const langKey = langKeyForPath(params.path);
      if (!langKey) {
        return {
          content: txt(`outline 不支持该文件类型（${params.path}）。请改用 read_file。`),
          details: { path: params.path, symbols: 0, supported: false },
        };
      }
      const abs = resolveReadPath(workdir, params.path, allowReadOutside);
      const source = readFileSync(abs, "utf8");
      const syms = await outlineSource(source, langKey);
      const t = truncateForContext(formatOutline(params.path, syms), { workdir, save: true });
      return { content: txt(t.text), details: { path: params.path, symbols: syms.length, supported: true } };
    },
  };
}
