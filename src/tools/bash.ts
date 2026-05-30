import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { execSandboxed } from "../sandbox/exec.js";
import { truncateForContext } from "../kernel/artifacts.js";

const bashSchema = Type.Object({
  cmd: Type.String({ description: "要执行的命令" }),
  timeoutMs: Type.Optional(Type.Number({ description: "超时毫秒，默认 15000" })),
});

/**
 * bash 工具：在受限子进程里跑 shell 命令（见 sandbox/exec.ts）。
 * 危险命令拦截交给权限闸门（tool_call 钩子）；本工具负责「纯执行」+ 隔离。
 */
export function makeBashTool(workdir: string): AgentTool<typeof bashSchema, { exitCode: number; ms: number; truncated: boolean; timedOut: boolean; artifact?: string }> {
  return {
    name: "bash",
    label: "执行命令",
    description: "在 workdir 下的受限子进程里执行一条 shell 命令（环境已剔除密钥），返回 stdout/stderr。受权限闸门管控。",
    parameters: bashSchema,
    execute: async (_id, params, signal) => {
      const r = await execSandboxed(params.cmd, { cwd: workdir, timeoutMs: params.timeoutMs, signal });
      // 上下文友好截断：超长 stdout/stderr 落 artifacts，上下文里只留首尾 + 指针。
      const t = truncateForContext(r.out, { workdir, save: true });
      return {
        content: [{ type: "text", text: `exit=${r.code}\n${t.text}` }],
        details: { exitCode: r.code, ms: r.ms, truncated: r.truncated || t.truncated, timedOut: r.timedOut, artifact: t.artifact },
      };
    },
  };
}
