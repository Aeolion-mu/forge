import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";

/** 子 agent 运行结果（含执行信息）。 */
export interface SubAgentResult {
  text: string;
  turns: number;
  tools: number;
  hitLimit: boolean;
}

/** 子 agent 状态快照（供 subagent_list）。 */
export interface SubAgentInfo {
  id: string;
  role: string;
  /** 指派的任务原文（供 TUI transcript 的首条 user block）。 */
  task: string;
  status: "running" | "done" | "cancelled" | "failed";
  turns: number;
  tools: number;
  /** 已运行/总耗时（秒）。 */
  elapsedSec: number;
  /** 最近几条运行日志（判断是否在推进 / 卡死）。 */
  recentLog: string[];
}

/**
 * 后台子 agent 编排接口（由 ForgeAgent 实现）。
 * 异步模型：spawn 立即返回 id、后台运行，**主 agent 不阻塞**；完成时结果会自动喂回主 agent。
 * 主 agent 随时可 list 看进度、steer 插话、cancel 撤销，无需（也没有）阻塞等待。
 */
export interface SubAgentOrchestrator {
  spawn(role: string, task: string, maxTurns: number | undefined): string;
  steer(id: string, message: string): string;
  cancel(id: string): string;
  list(): SubAgentInfo[];
}

const spawnSchema = Type.Object({
  role: Type.String({ description: "子 agent 角色，如 researcher / code-analyst" }),
  task: Type.String({ description: "自包含的子任务描述" }),
  maxTurns: Type.Optional(
    Type.Number({ description: "轮数上限，按复杂度设（简单 5-10 / 复杂 30-50）；0 = 不限轮次；省略 = 默认 25。" }),
  ),
});
const idSchema = Type.Object({ id: Type.String({ description: "spawn_subagent 返回的子 agent id" }) });
const steerSchema = Type.Object({
  id: Type.String({ description: "spawn_subagent 返回的子 agent id" }),
  message: Type.String({ description: "插话内容：补充指示 / 修正方向 / 追加要求。当前步工具执行完后注入，不打断当前步。" }),
});
const noneSchema = Type.Object({});

/**
 * 子 Agent 编排工具组（异步/后台、不阻塞主 agent）：
 *   spawn_subagent  —— 后台启动，立即返回 id；**完成后结果会自动作为新一轮喂回给你**
 *   subagent_steer  —— 对运行中的子 agent 插话（补充指示 / 修正方向，当前步后注入）
 *   subagent_list   —— 看所有子 agent 状态、进度与最近运行日志
 *   subagent_cancel —— 撤销运行中的子 agent
 * 子 agent 跑在隔离会话、只读工具集（含 code-intel）、无本组工具（防递归）。
 */
export function makeSubAgentTools(orch: SubAgentOrchestrator): AgentHarnessTool<object | undefined>[] {
  const spawn: AgentHarnessTool<object | undefined, typeof spawnSchema, { id: string; role: string }> = {
    name: "spawn_subagent",
    label: "派发子Agent",
    description:
      "在**后台**启动一个隔离的只读子 Agent 跑子任务，**立即返回 id 且不阻塞你**——你可以接着回复用户或派更多。" +
      "**它完成后，结论会自动作为新一轮消息喂回给你，无需你等待或轮询**。" +
      "想中途看进度用 subagent_list；想补充指示/修正方向用 subagent_steer(id, message)（不打断它的当前步）；想叫停用 subagent_cancel(id)。maxTurns 控制其轮数预算。适合调研 / 检索 / 分析类子任务。",
    parameters: spawnSchema,
    execute: async (_id, p, _onUpdate, _toolCtx, _invocation, _ctx) => {
      const id = orch.spawn(p.role, p.task, p.maxTurns);
      return {
        content: [{ type: "text", text: `已后台启动子 Agent [${p.role}]，id=${id}。它完成后结论会自动回来；其间你可继续处理别的，或用 subagent_list 看进度、subagent_steer("${id}", "…") 插话、subagent_cancel("${id}") 撤销。` }],
        details: { id, role: p.role },
      };
    },
  };

  const steer: AgentHarnessTool<object | undefined, typeof steerSchema, { id: string }> = {
    name: "subagent_steer",
    label: "插话子Agent",
    description:
      "对一个**运行中**的后台子 Agent 插话：补充指示、修正方向或追加要求。消息会在它当前工具步执行完、下一次思考前注入（不打断当前步）。" +
      "已结束（done/cancelled/failed）的子 agent 无法插话。用户也可能直接对子 agent 插话，你看到的下一条它结论里可能同时反映两边的指示。",
    parameters: steerSchema,
    execute: async (_id, p, _onUpdate, _toolCtx, _invocation, _ctx) => ({ content: [{ type: "text", text: orch.steer(p.id, p.message) }], details: { id: p.id } }),
  };

  const cancel: AgentHarnessTool<object | undefined, typeof idSchema, { id: string }> = {
    name: "subagent_cancel",
    label: "撤销子Agent",
    description: "中途撤销一个正在后台运行的子 Agent（按 id）。",
    parameters: idSchema,
    execute: async (_id, p, _onUpdate, _toolCtx, _invocation, _ctx) => ({ content: [{ type: "text", text: orch.cancel(p.id) }], details: { id: p.id } }),
  };

  const list: AgentHarnessTool<object | undefined, typeof noneSchema, { count: number }> = {
    name: "subagent_list",
    label: "列子Agent",
    description: "列出所有子 Agent 的状态（running/done/cancelled/failed）+ 已用轮数 / 工具数 / 已运行秒数 + 最近运行日志（判断是否在推进或卡死）。",
    parameters: noneSchema,
    execute: async (_id, _p, _onUpdate, _toolCtx, _invocation, _ctx) => {
      const xs = orch.list();
      const body = xs.length
        ? xs
            .map((x) => {
              const head = `${x.id} [${x.role}] ${x.status} · ${x.turns} 轮 / ${x.tools} 工具 · ${x.elapsedSec}s`;
              return x.status === "running" && x.recentLog.length ? `${head}\n    ${x.recentLog.join("\n    ")}` : head;
            })
            .join("\n")
        : "(暂无子 agent)";
      return { content: [{ type: "text", text: body }], details: { count: xs.length } };
    },
  };

  return [spawn, steer, cancel, list] as unknown as AgentHarnessTool<object | undefined>[];
}
