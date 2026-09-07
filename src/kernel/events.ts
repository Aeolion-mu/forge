import type { Events, HarnessEvent, HarnessEventType } from "@earendil-works/pi-agent-core";

/**
 * 0.85 起 harness 没有 subscribe() 了 —— 只能 `events.on(type, listener)` 逐类型注册。
 * 这里把 HarnessEvent 的类型 union 穷尽枚举一次（satisfies 保证漏一个就编译报错），
 * 全量扇出（UI / telemetry / 飞行记录）都经 subscribeHarness，union 变更只改这一处。
 */
const EVENT_TYPES = [
  "run_start",
  "run_resume",
  "run_suspend",
  "operation_abort",
  "run_end",
  "fault",
  "handler_error",
  "turn_start",
  "turn_end",
  "retry_scheduled",
  "retry_start",
  "retry_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_start",
  "tool_update",
  "tool_end",
  "entry_added",
  "queue_update",
  "value_update",
  "config_update",
  "compaction_start",
  "compaction_end",
  "navigation_start",
  "navigation_end",
  "lane_created",
  "usage",
] as const satisfies readonly HarnessEventType[];

/** 对全部事件类型注册同一个 listener，返回统一退订函数（替代旧 harness.subscribe）。 */
export function subscribeHarness(events: Events, listener: (event: HarnessEvent) => void): () => void {
  const unsubs = EVENT_TYPES.map((t) => events.on(t, (e) => listener(e)));
  return () => unsubs.forEach((u) => u());
}
