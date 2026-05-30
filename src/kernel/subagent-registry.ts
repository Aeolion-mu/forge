/**
 * 子 Agent 注册表 —— fire-and-forget 编排的状态机（与 AgentHarness 解耦，可独立单测）。
 *
 * 职责：管理 id→任务记录的注册表、跑/完成/失败/撤销的状态流转、完成后喂回主 agent、
 * 聚合 running 状态行、列表快照。**真正跑一个子 agent 的循环**（`runLoop`）由外部注入
 * （生产传 ForgeAgent.runSubAgentLoop，测试传 fake）—— 同 compaction.ts 注入 SummarizeFn 的思路。
 */

import type { SubAgentInfo, SubAgentResult } from "../tools/subagent.js";

/** 运行日志环形缓冲条数（供主 agent 判断子 agent 是否在推进 / 卡死）。 */
export const SUBAGENT_LOG_CAP = 12;

/** 后台子 agent 任务记录。 */
export interface SubAgentTask {
  id: string;
  role: string;
  status: "running" | "done" | "cancelled" | "failed";
  turns: number;
  tools: number;
  result?: SubAgentResult;
  ac: AbortController;
  done: Promise<void>;
  startedAt: number;
  /** 完成时刻（running 时为 0）。 */
  endedAt: number;
  /** 运行日志环形缓冲（turn / 工具调用）。 */
  log: string[];
}

/**
 * 实际跑一个子 agent 循环：拿到隔离会话 + 只读工具集，跑到结论 / 达上限 / 被撤销。
 * 期间应原地更新 rec.turns / rec.tools / rec.log，并调用 refresh 刷新聚合状态行。
 */
export type SubAgentRunLoop = (
  role: string,
  task: string,
  maxTurns: number | undefined,
  signal: AbortSignal,
  rec: SubAgentTask,
) => Promise<SubAgentResult>;

export interface SubAgentRegistryDeps {
  runLoop: SubAgentRunLoop;
  /** 完成（done / failed，非 cancelled）时把结论作为新一轮喂回主 agent。 */
  onResume?: (text: string) => void;
  /** running 集合变化时的聚合状态行；无 running 时传 null。 */
  onStatus?: (msg: string | null) => void;
  /** 失败时记审计（role + 错误信息）。 */
  onError?: (role: string, message: string) => void;
  /** 取当前时刻（注入便于测 elapsed）。默认 Date.now。 */
  now?: () => number;
}

export class SubAgentRegistry {
  private readonly tasks = new Map<string, SubAgentTask>();
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly deps: SubAgentRegistryDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** 后台启动一个子 agent，立即返回 id（不阻塞）；后台运行并实时更新任务记录。 */
  spawn(role: string, task: string, maxTurns: number | undefined): string {
    const id = `s${++this.seq}`;
    const ac = new AbortController();
    const rec: SubAgentTask = {
      id, role, status: "running", turns: 0, tools: 0, ac,
      done: Promise.resolve(), startedAt: this.now(), endedAt: 0, log: [],
    };
    rec.done = (async () => {
      try {
        rec.result = await this.deps.runLoop(role, task, maxTurns, ac.signal, rec);
        rec.status = ac.signal.aborted ? "cancelled" : "done";
      } catch (e) {
        const msg = (e as Error).message;
        rec.result = { text: `(子 agent 失败: ${msg})`, turns: rec.turns, tools: rec.tools, hitLimit: false };
        rec.status = ac.signal.aborted ? "cancelled" : "failed";
        this.deps.onError?.(role, msg);
      } finally {
        rec.endedAt = this.now();
        this.refresh();
      }
      // 完成（非撤销）→ 把结论作为新一轮喂回主 agent（由上层串行调度，不阻塞、不轮询）。
      if (rec.status === "done" || rec.status === "failed") {
        this.deps.onResume?.(this.feedbackText(rec));
      }
    })();
    this.tasks.set(id, rec);
    this.refresh();
    return id;
  }

  /** 完成 / 失败时喂回主 agent 的消息文本。 */
  private feedbackText(rec: SubAgentTask): string {
    const r = rec.result;
    const meta = r ? `用 ${r.turns} 轮 / ${r.tools} 工具${r.hitLimit ? " · 达上限截断" : ""}` : "";
    const head = rec.status === "done" ? "完成" : "失败";
    return (
      `[后台子 Agent ${rec.id}（${rec.role}）${head} · ${meta}]\n${r?.text ?? ""}\n\n` +
      `（这是你先前派发的子 agent 的结论，请据此继续并向用户汇报。）`
    );
  }

  /** 中途撤销运行中的子 agent。 */
  cancel(id: string): string {
    const rec = this.tasks.get(id);
    if (!rec) return `无此子 agent：${id}`;
    if (rec.status !== "running") return `子 agent ${id} 已 ${rec.status}，无需撤销`;
    rec.ac.abort();
    return `已请求撤销子 agent ${id}（${rec.role}）`;
  }

  /** 子 agent 已运行 / 总耗时（秒）：running 用当前时刻，已结束用 endedAt。 */
  private elapsedSec(r: SubAgentTask): number {
    return Math.round(((r.endedAt || this.now()) - r.startedAt) / 1000);
  }

  /** 列出所有子 agent 的状态快照（供 subagent_list / TUI）。 */
  list(): SubAgentInfo[] {
    return [...this.tasks.values()].map((r) => ({
      id: r.id, role: r.role, status: r.status, turns: r.turns, tools: r.tools,
      elapsedSec: this.elapsedSec(r), recentLog: r.log.slice(-3),
    }));
  }

  /** 聚合 running 的子 agent 成一行状态（含已运行秒数）；无 running 时通知 null。 */
  refresh(): void {
    const running = [...this.tasks.values()].filter((r) => r.status === "running");
    if (!running.length) {
      this.deps.onStatus?.(null);
      return;
    }
    const parts = running.map((r) => `${r.id}[${r.role}] t${r.turns} ${this.elapsedSec(r)}s`);
    this.deps.onStatus?.(`↳ ${running.length} subagent(s) · ${parts.join(" · ")}`);
  }

  /** 撤销所有仍在运行的子 agent（供 abort / dispose）。 */
  abortAllRunning(): void {
    for (const rec of this.tasks.values()) if (rec.status === "running") rec.ac.abort();
  }
}
