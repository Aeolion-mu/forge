import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeEvent,
  summarizeContextMessages,
  safeStringify,
  FlightRecorder,
  type FlightSink,
} from "../src/kernel/flight-recorder.js";

/** 收集型假 sink：把写入的行存数组，供断言。 */
class FakeSink implements FlightSink {
  lines: string[] = [];
  closed = false;
  write(line: string): void {
    this.lines.push(line);
  }
  close(): void {
    this.closed = true;
  }
}

const recordsOf = (sink: FakeSink) => sink.lines.map((l) => JSON.parse(l.trimEnd()));

// ── serializeEvent：硬丢弃 ───────────────────────────────────────────────
test("serializeEvent：流式增量/冗余事件被硬丢弃（返回 null）", () => {
  for (const type of ["message_update", "tool_execution_update", "turn_end", "before_provider_payload", "queue_update"]) {
    assert.equal(serializeEvent({ type }, { contextFull: false }), null, `${type} 应被丢弃`);
  }
});

// ── tool_result：完整 verbatim，不截断 ──────────────────────────────────
test("serializeEvent：tool_result 的 content 完整保留（与 AuditLog 截断相反）", () => {
  const big = "x".repeat(5000);
  const rec = serializeEvent(
    { type: "tool_result", toolName: "read_file", input: { path: "a.ts" }, isError: false, content: [{ type: "text", text: big }] },
    { contextFull: false },
  );
  assert.equal(rec?.kind, "tool_result");
  assert.equal((rec?.content as { text: string }[])[0].text.length, 5000, "content 不应被截断");
});

// ── 模型回复 verbatim ────────────────────────────────────────────────────
test("serializeEvent：message_end → model_reply，message 原样", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  const rec = serializeEvent({ type: "message_end", message }, { contextFull: false });
  assert.equal(rec?.kind, "model_reply");
  assert.deepEqual(rec?.message, message);
});

// ── context：摘要 vs 全量 ────────────────────────────────────────────────
test("summarizeContextMessages：角色分布 / 消息数 / content block 数", () => {
  const s = summarizeContextMessages([
    { role: "user", content: [{}, {}] },
    { role: "assistant", content: [{}] },
    { role: "user", content: [] },
  ]);
  assert.equal(s.messages, 3);
  assert.equal(s.contentBlocks, 3);
  assert.deepEqual(s.byRole, { user: 2, assistant: 1 });
});

test("serializeEvent：context summary 模式不含全量 messages", () => {
  const ev = { type: "context", messages: [{ role: "user", content: [{ type: "text", text: "q" }] }] };
  const rec = serializeEvent(ev, { contextFull: false });
  assert.equal(rec?.kind, "context");
  assert.equal(rec?.full, false);
  assert.equal(rec?.messages, 1);
  assert.equal("messagesFull" in (rec as object), false);
});

test("serializeEvent：context full 模式整条 dump", () => {
  const ev = { type: "context", messages: [{ role: "user", content: [] }] };
  const rec = serializeEvent(ev, { contextFull: true });
  assert.equal(rec?.full, true);
  assert.deepEqual(rec?.messagesFull, ev.messages);
});

// ── 压缩前后 ──────────────────────────────────────────────────────────────
test("serializeEvent：session_before_compact 带全量 branchEntries + tokensBefore，丢弃 signal", () => {
  const ev = {
    type: "session_before_compact",
    preparation: { tokensBefore: 12345, fileOps: { read: new Set(["a.ts"]), written: new Set(), edited: new Set(["b.ts"]) } },
    branchEntries: [{ id: "e1", type: "message" }, { id: "e2", type: "message" }],
    signal: new AbortController().signal,
  };
  const rec = serializeEvent(ev, { contextFull: false });
  assert.equal(rec?.kind, "compact_before");
  assert.equal(rec?.tokensBefore, 12345);
  assert.equal(rec?.branchEntryCount, 2);
  // 经 safeStringify 后 Set 转数组、signal 被丢弃
  const round = JSON.parse(safeStringify(rec));
  assert.deepEqual(round.fileOps.read, ["a.ts"]);
  assert.deepEqual(round.fileOps.edited, ["b.ts"]);
  assert.equal("signal" in round, false);
});

test("serializeEvent：model_select 把 Model 压成关键标识", () => {
  const model = { provider: "deepseek", id: "deepseek-v4-pro", contextWindow: 1_000_000, maxTokens: 8192, tokenizer: () => 0 };
  const rec = serializeEvent({ type: "model_select", source: "set", model, previousModel: undefined }, { contextFull: false });
  assert.deepEqual(rec?.model, { provider: "deepseek", id: "deepseek-v4-pro", contextWindow: 1_000_000, maxTokens: 8192 });
  assert.equal(rec?.previousModel, undefined);
});

// ── safeStringify：边界 ──────────────────────────────────────────────────
test("safeStringify：Set→数组 / 函数与 AbortSignal 丢弃 / 循环引用标记 / BigInt→串", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  const out = JSON.parse(
    safeStringify({ s: new Set([1, 2]), fn: () => 1, sig: new AbortController().signal, big: 10n, circular }),
  );
  assert.deepEqual(out.s, [1, 2]);
  assert.equal("fn" in out, false);
  assert.equal("sig" in out, false);
  assert.equal(out.big, "10");
  assert.equal(out.circular.self, "[Circular]");
});

// ── FlightRecorder：seq / 状态机 / record / close ────────────────────────
test("FlightRecorder：seq 递增、ts 注入、丢弃事件不落行", () => {
  const sink = new FakeSink();
  const rec = new FlightRecorder(sink, { clock: () => "T" });
  rec.handle({ type: "agent_start" });
  rec.handle({ type: "message_update" } as { type: string }); // 丢弃
  rec.handle({ type: "agent_start" });
  const recs = recordsOf(sink);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].seq, 0);
  assert.equal(recs[1].seq, 1);
  assert.equal(recs[0].ts, "T");
});

test("FlightRecorder（summary 模式）：首条 context 全量、后续摘要、compact 后再次全量", () => {
  const sink = new FakeSink();
  const rec = new FlightRecorder(sink, { contextMode: "summary", clock: () => "T" });
  const ctx = { type: "context", messages: [{ role: "user", content: [] }] };
  rec.handle(ctx); // 首条 → 全量（基线）
  rec.handle(ctx); // 第二条 → 摘要
  rec.handle({ type: "session_compact", compactionEntry: { summary: "s" } }); // 武装
  rec.handle(ctx); // compact 后第一条 → 全量
  rec.handle(ctx); // 再下一条 → 摘要
  const ctxRecs = recordsOf(sink).filter((r) => r.kind === "context");
  assert.deepEqual(
    ctxRecs.map((r) => r.full),
    [true, false, true, false],
  );
});

test("FlightRecorder（full 模式）：每条 context 都整条 dump", () => {
  const sink = new FakeSink();
  const rec = new FlightRecorder(sink, { contextMode: "full", clock: () => "T" });
  const ctx = { type: "context", messages: [{ role: "user", content: [] }] };
  rec.handle(ctx);
  rec.handle(ctx);
  const ctxRecs = recordsOf(sink).filter((r) => r.kind === "context");
  assert.deepEqual(ctxRecs.map((r) => r.full), [true, true]);
});

test("FlightRecorder：主流记录打 agent:\"main\" 标签", () => {
  const sink = new FakeSink();
  const rec = new FlightRecorder(sink, { clock: () => "T" });
  rec.handle({ type: "agent_start" });
  rec.record("session_start", { sessionId: "x" });
  const recs = recordsOf(sink);
  assert.equal(recs[0].agent, "main");
  assert.equal(recs[1].agent, "main");
});

test("FlightRecorder：scope 子流打自定义标签，状态机独立于主流、共享 seq 写同一 sink", () => {
  const sink = new FakeSink();
  const rec = new FlightRecorder(sink, { contextMode: "summary", clock: () => "T" });
  const sub = rec.scope("subagent:foo#1");
  const ctx = { type: "context", messages: [{ role: "user", content: [] }] };
  rec.handle(ctx); // 主流首条 → 全量
  sub.handle(ctx); // 子流首条 → 全量（独立状态机，不受主流影响）
  rec.handle(ctx); // 主流第二条 → 摘要
  sub.handle(ctx); // 子流第二条 → 摘要
  const recs = recordsOf(sink);
  // 共享单调 seq
  assert.deepEqual(recs.map((r) => r.seq), [0, 1, 2, 3]);
  // 标签正确
  assert.deepEqual(recs.map((r) => r.agent), ["main", "subagent:foo#1", "main", "subagent:foo#1"]);
  // 各自的 context 状态机：每条子流首条都是全量
  assert.deepEqual(recs.map((r) => r.full), [true, true, false, false]);
});

test("FlightRecorder：record 写自定义里程碑；close 后不再写且 sink 关闭", () => {
  const sink = new FakeSink();
  const rec = new FlightRecorder(sink, { clock: () => "T" });
  rec.record("session_start", { sessionId: "abc" });
  rec.close();
  rec.record("after_close", {}); // 应被忽略
  rec.handle({ type: "agent_start" }); // 应被忽略
  const recs = recordsOf(sink);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, "session_start");
  assert.equal(recs[0].sessionId, "abc");
  assert.equal(sink.closed, true);
});
