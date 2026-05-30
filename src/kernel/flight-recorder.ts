import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { estimateContextTokens } from "@earendil-works/pi-agent-core";

/**
 * 飞行记录仪（Flight Recorder）—— 把 harness 的**完整事件流**逐条落成结构化 JSONL，
 * 供离线复盘 / 压测分析 / 未来 resume 的观测底座。
 *
 * 与 AuditLog 的分工：AuditLog 是「截断到 300 字」的合规留痕 + 内存环形缓冲（喂 UI 近况）；
 * 本模块是**未截断的全量 trace**——工具结果 / 模型回复 / 压缩前后全部 verbatim 落盘。
 *
 * 设计（抽可测纯核 + 注入 sink）：
 *   · serializeEvent —— 纯函数，事件 → JSON 安全记录（或 null=丢弃），可独立单测。
 *   · FlightSink —— 落盘抽象（注入）。FileFlightSink 用持久 fd + writeSync（durable，捕得到崩溃前最后一条）。
 *   · FlightRecorder —— 订阅 harness、维护 seq + 「压缩后下一条 context 整条 dump」状态机。
 *
 * context 体积策略（与用户对齐）：默认「增量流 + 压缩点全量快照」——
 *   每轮 context 只记摘要行（消息数 / token / 角色分布）；会话首条 & 每次 compact 后第一条
 *   context 整条 dump（基线 + 压缩前后对比）。contextMode:"full" 则每轮都整条 dump（压测最高保真）。
 */

/** 落盘抽象。测试注入收集数组，生产用 FileFlightSink。 */
export interface FlightSink {
  write(line: string): void;
  close(): void;
}

/** 持久 fd + writeSync 的文件 sink：每行同步落盘，崩溃也不丢已写行。 */
export class FileFlightSink implements FlightSink {
  private fd: number;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
  }
  write(line: string): void {
    writeSync(this.fd, line);
  }
  close(): void {
    try {
      closeSync(this.fd);
    } catch {
      /* 已关或无效 fd，忽略 */
    }
  }
}

export type ContextMode = "summary" | "full";

/** 事件最小形状（避免把纯核耦合到库的具体 union 类型，便于单测构造假事件）。 */
type RawEvent = { type: string; [key: string]: unknown };

/** 流式增量 / 大而冗余 / 低价值的事件：硬丢弃（防 message_update 逐 token 刷屏、payload 全量每轮致二次膨胀）。 */
const HARD_SKIP = new Set([
  "turn_start",
  "turn_end", // 等价于 message_end + tool_result，去重
  "message_start",
  "message_update", // 逐 token 增量
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end", // 与 tool_call / tool_result 重复
  "before_provider_request", // 巨大的 Model 对象，低价值
  "before_provider_payload", // 整个 messages 每轮 = 二次膨胀
  "queue_update",
  "save_point",
  "settled",
  "session_before_tree",
]);

/** JSON 安全替换器：Set→数组、BigInt→串、函数/AbortSignal→丢弃、循环引用→标记。 */
function makeSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return function (_key: string, value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return undefined;
    if (value instanceof Set) return [...value];
    if (value instanceof Map) return Object.fromEntries(value);
    if (value && typeof value === "object") {
      const ctor = (value as { constructor?: { name?: string } }).constructor?.name;
      if (ctor === "AbortSignal" || ctor === "AbortController") return undefined;
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    return value;
  };
}

/** 安全序列化：吞掉不可序列化字段，绝不抛错中断 agent。 */
export function safeStringify(value: unknown): string {
  return JSON.stringify(value, makeSafeReplacer());
}

/** context 摘要：消息数 / 角色分布 / content block 数（纯函数）。 */
export function summarizeContextMessages(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): { messages: number; byRole: Record<string, number>; contentBlocks: number } {
  const byRole: Record<string, number> = {};
  let contentBlocks = 0;
  for (const m of messages) {
    const role = typeof m.role === "string" ? m.role : "unknown";
    byRole[role] = (byRole[role] ?? 0) + 1;
    if (Array.isArray(m.content)) contentBlocks += m.content.length;
  }
  return { messages: messages.length, byRole, contentBlocks };
}

/** 估算 context token，失败兜底 0（绝不让记录拖垮主流程）。 */
function safeTokens(messages: unknown[]): number {
  try {
    return estimateContextTokens(messages as Parameters<typeof estimateContextTokens>[0]).tokens;
  } catch {
    return 0;
  }
}

type ModelLike = { provider?: string; id?: string; contextWindow?: number; maxTokens?: number } | undefined;
/** Model 对象巨大（含 tokenizer 等），只留关键标识。 */
function modelBrief(m: ModelLike): Record<string, unknown> | undefined {
  if (!m) return undefined;
  return { provider: m.provider, id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens };
}

/**
 * 事件 → JSON 安全记录（纯函数）。返回 null 表示丢弃该事件。
 * 不含 seq/ts（由 FlightRecorder 注入），便于单测断言载荷本身。
 */
export function serializeEvent(event: RawEvent, opts: { contextFull: boolean }): Record<string, unknown> | null {
  const type = event.type;
  if (HARD_SKIP.has(type)) return null;

  switch (type) {
    case "before_agent_start": {
      const e = event as { prompt?: string; images?: unknown[]; systemPrompt?: string; resources?: { skills?: { name?: string }[] } };
      return {
        kind: "user_input",
        prompt: e.prompt,
        images: e.images?.length ?? 0,
        systemPromptChars: e.systemPrompt?.length ?? 0,
        skills: (e.resources?.skills ?? []).map((s) => s.name),
      };
    }
    case "message_end": {
      // 模型完整回复（thinking + text + tool_use blocks），verbatim
      return { kind: "model_reply", message: (event as { message?: unknown }).message };
    }
    case "tool_call": {
      const e = event as { toolCallId?: string; toolName?: string; input?: unknown };
      return { kind: "tool_call", toolCallId: e.toolCallId, toolName: e.toolName, input: e.input };
    }
    case "tool_result": {
      // content / details 完整 verbatim（与 AuditLog 的 300 字截断相反——这正是飞行记录的价值）
      const e = event as { toolCallId?: string; toolName?: string; input?: unknown; content?: unknown; isError?: boolean; details?: unknown };
      return {
        kind: "tool_result",
        toolCallId: e.toolCallId,
        toolName: e.toolName,
        input: e.input,
        isError: e.isError,
        content: e.content,
        details: e.details,
      };
    }
    case "context": {
      const raw = (event as { messages?: unknown[] }).messages;
      const messages = Array.isArray(raw) ? raw : [];
      const base = { kind: "context", tokens: safeTokens(messages), ...summarizeContextMessages(messages as { role?: string }[]) };
      return opts.contextFull ? { ...base, full: true, messagesFull: messages } : { ...base, full: false };
    }
    case "session_before_compact": {
      // 压缩前全量快照：branchEntries = 压缩前完整会话树分支
      const e = event as { preparation?: { tokensBefore?: number; fileOps?: unknown }; branchEntries?: unknown[]; customInstructions?: string };
      return {
        kind: "compact_before",
        tokensBefore: e.preparation?.tokensBefore,
        branchEntryCount: Array.isArray(e.branchEntries) ? e.branchEntries.length : 0,
        fileOps: e.preparation?.fileOps,
        customInstructions: e.customInstructions,
        branchEntries: e.branchEntries,
      };
    }
    case "session_compact": {
      // 压缩后：compactionEntry 含产出的摘要
      const e = event as { compactionEntry?: unknown; fromHook?: boolean };
      return { kind: "compact_after", fromHook: e.fromHook, compactionEntry: e.compactionEntry };
    }
    case "model_select": {
      const e = event as { model?: ModelLike; previousModel?: ModelLike; source?: string };
      return { kind: "model_select", source: e.source, model: modelBrief(e.model), previousModel: modelBrief(e.previousModel) };
    }
    case "thinking_level_select": {
      const e = event as { level?: string; previousLevel?: string };
      return { kind: "thinking_level_select", level: e.level, previousLevel: e.previousLevel };
    }
    case "agent_start":
      return { kind: "agent_start" };
    case "agent_end": {
      const msgs = (event as { messages?: unknown[] }).messages;
      return { kind: "agent_end", messageCount: Array.isArray(msgs) ? msgs.length : 0 };
    }
    case "after_provider_response":
      return { kind: "provider_response", status: (event as { status?: number }).status };
    case "abort":
      return { kind: "abort" };
    case "resources_update":
      return { kind: "resources_update" };
    case "session_tree": {
      const e = event as { newLeafId?: string | null; oldLeafId?: string | null };
      return { kind: "session_tree", newLeafId: e.newLeafId, oldLeafId: e.oldLeafId };
    }
    default:
      // 未知/新增类型：留个轻量时间线标记，不丢
      return { kind: type };
  }
}

/** 带标签的子流监听器（子 agent / Convergent 各一个，独立 context 状态机，共享 sink + seq）。 */
export interface FlightScope {
  /** 作为某个 harness.subscribe 的监听器。 */
  handle: (event: { type: string }) => void;
}

export class FlightRecorder {
  private seq = 0;
  private closed = false;
  private readonly contextMode: ContextMode;
  private readonly clock: () => string;
  /** 主 agent 子流（持久状态机，构造后即用）。 */
  private readonly mainScope: FlightScope;

  constructor(private readonly sink: FlightSink, opts: { contextMode?: ContextMode; clock?: () => string } = {}) {
    this.contextMode = opts.contextMode ?? "summary";
    this.clock = opts.clock ?? (() => new Date().toISOString());
    this.mainScope = this.scope("main");
  }

  /** 写一条带 agent 标签的记录（所有子流汇入此处，共享单调 seq + 同一 sink）。 */
  private emit(agent: string, data: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.sink.write(`${safeStringify({ seq: this.seq++, ts: this.clock(), agent, ...data })}\n`);
    } catch {
      /* 落盘失败绝不中断 agent */
    }
  }

  /**
   * 开一个带标签的子流。每个子流持有自己的「下一条 context 整条 dump」状态机
   * （会话首条 = true 基线，compact 后重新武装），故主 agent 与各子 agent 的 context
   * 节奏互不干扰；记录统一打 `agent` 标签、共享 seq 写同一文件。
   */
  scope(agent: string): FlightScope {
    let dumpNextContextFull = true; // 该子流首条 context = 基线全量
    const handle = (event: { type: string }): void => {
      const e = event as RawEvent;
      let contextFull = this.contextMode === "full";
      if (e.type === "context" && dumpNextContextFull) contextFull = true;
      const data = serializeEvent(e, { contextFull });
      if (e.type === "context") dumpNextContextFull = false; // 一次性 full 用掉
      else if (e.type === "session_compact") dumpNextContextFull = true; // compact 后重新武装
      if (data) this.emit(agent, data);
    };
    return { handle };
  }

  /** 作为主 harness.subscribe 的监听器（只读观察，不干预 harness）。 */
  handle = (event: { type: string }): void => this.mainScope.handle(event);

  /** 显式记录里程碑（如 compact_detail 的压缩前后对比、session_start），归到主流。 */
  record(kind: string, data: Record<string, unknown> = {}): void {
    this.emit("main", { kind, ...data });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sink.close();
  }
}
