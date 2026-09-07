import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { execSandboxed } from "../sandbox/exec.js";
import { lspLangForPath, type LspClient, type LspDiagnostic } from "../kernel/lsp-client.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

/** 格式化 LSP 单文件诊断。 */
export function formatDiagnostics(relpath: string, diags: LspDiagnostic[]): string {
  if (diags.length === 0) return `${relpath} · ✓ 无诊断`;
  const lines = diags
    .slice()
    .sort((a, b) => a.line - b.line)
    .map((d) => `  L${d.line}\t${d.severity.padEnd(8)}${d.message}${d.code ? ` [${d.code}]` : ""}`);
  const errs = diags.filter((d) => d.severity === "error").length;
  const warns = diags.filter((d) => d.severity === "warning").length;
  return `${relpath} · ${errs} error / ${warns} warning\n${lines.join("\n")}`;
}

const schema = Type.Object({
  path: Type.Optional(Type.String({ description: "要诊断的文件（py/ts/js 走 LSP 语义诊断）。不给则跑整项目 tsc 检查。" })),
});

/**
 * diagnostics —— 统一诊断入口：
 *  · 给 path 且该语言有 LSP（py/ts/tsx/js/jsx）→ 语言服务器对**单文件**做语义诊断
 *    （类型错误、未定义、未用导入等），近瞬时。**编辑后用它自检最合适。**
 *  · 否则（无 path / 非上述语言 / server 未装）→ 回退跑 `tsc --noEmit` 整项目类型检查。
 */
export function makeDiagnosticsTool(workdir: string, lsp: LspClient): AgentTool<typeof schema, { ok: boolean; source: string }> {
  return {
    name: "diagnostics",
    label: "诊断",
    description:
      "检查代码错误/警告（类型、未定义、未用导入等）。给 path → 用 LSP 对单文件做语义诊断（py/ts/tsx/js/jsx），编辑后自检首选；不给 path 或该语言无 LSP → 跑 tsc 整项目检查。只读、不改文件。",
    parameters: schema,
    execute: async (_id, params, signal) => {
      // 1) 单文件 LSP 语义诊断
      if (params.path && lspLangForPath(params.path)) {
        const diags = await lsp.diagnostics(params.path);
        if (diags !== undefined) {
          const ok = !diags.some((d) => d.severity === "error");
          return { content: txt(formatDiagnostics(params.path, diags)), details: { ok, source: "lsp" } };
        }
        // server 未就绪/未装 → 落到 tsc 兜底
      }
      // 2) 整项目 tsc 兜底
      if (!existsSync(resolve(workdir, "tsconfig.json"))) {
        return {
          content: txt("未检测到 tsconfig.json；如需单文件语义诊断请传 path（支持 py/ts/js）。"),
          details: { ok: true, source: "none" },
        };
      }
      const r = await execSandboxed("npx tsc --noEmit", { cwd: workdir, timeoutMs: 180000, maxBytes: 512 * 1024, signal });
      const ok = r.code === 0 && !r.timedOut;
      return { content: txt(ok ? "✓ 类型检查通过，无错误。" : r.out), details: { ok, source: "tsc" } };
    },
  };
}
