import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectCutPoint,
  groupByTurn,
  buildSummaryPrompt,
  serializeConversation,
  runFullCompaction,
  isTooLongError,
  estimateTokens,
  extractCompactionPlan,
  keptTokensFrom,
  CompactionFailed,
  type CompactMessage,
  type PlanEntry,
  type SummarizeFn,
} from "../src/kernel/compaction.js";

const u = (text: string): CompactMessage => ({ role: "user", text });
const a = (text: string): CompactMessage => ({ role: "assistant", text });
const tr = (text: string): CompactMessage => ({ role: "toolResult", text });

// 每条 400 字符 ≈ 100 token，方便按预算推算
const big = (n: number) => "x".repeat(n);

test("selectCutPoint：按预算从尾部累加，向前对齐到 turn 起始", () => {
  // 3 个 turn，每 turn = user(100tok) + assistant(100tok) = 200tok
  const msgs = [u(big(400)), a(big(400)), u(big(400)), a(big(400)), u(big(400)), a(big(400))];
  // 留 ~250 tok：从尾累加 100→200→300(>=250 命中 idx=3 即第2个turn的assistant)，向前对齐到 idx=2(user)
  const cut = selectCutPoint(msgs, 250);
  assert.equal(cut, 2);
  assert.equal(msgs[cut].role, "user"); // 对齐到 turn 起始
});

test("selectCutPoint：会话全在预算内 → 返回 0（无可压缩）", () => {
  const msgs = [u(big(40)), a(big(40))];
  assert.equal(selectCutPoint(msgs, 100000), 0);
});

test("keptTokensFrom：只数 firstKeptEntryId 起的 message，绕开压缩前满窗 usage", () => {
  // 模拟压缩后的 branch：前缀(被摘要的大段) + 保留窗口(从 e3 起)
  const entries: PlanEntry[] = [
    { id: "e1", type: "message", role: "user", text: big(40000) }, // 被摘要的大前缀
    { id: "e2", type: "message", role: "assistant", text: big(40000) },
    { id: "e3", type: "message", role: "user", text: big(400) }, // ← firstKept
    { id: "e4", type: "message", role: "assistant", text: big(800) },
  ];
  // 只数 e3+e4 = (400+800)/4 = 300 token，而非把前缀 2 万 token 算进来
  assert.equal(keptTokensFrom(entries, "e3"), 300);
});

test("keptTokensFrom：firstKeptEntryId 不存在 → 0（保守，等下轮 usage 校正）", () => {
  const entries: PlanEntry[] = [{ id: "e1", type: "message", role: "user", text: big(400) }];
  assert.equal(keptTokensFrom(entries, "missing"), 0);
});

test("keptTokensFrom：非 message entry（compaction 等）不计入", () => {
  const entries: PlanEntry[] = [
    { id: "c1", type: "compaction", summary: big(99999) }, // 摘要 entry 本身不算
    { id: "m1", type: "message", role: "assistant", text: big(400) },
  ];
  assert.equal(keptTokensFrom(entries, "c1"), 100); // 只有 m1 的 100 token
});

test("selectCutPoint：不拆 tool 对——整 turn（含 toolResult）一起保留", () => {
  // turn0: u,a,tr,a   turn1: u,a
  const msgs = [u(big(400)), a(big(400)), tr(big(400)), a(big(400)), u(big(400)), a(big(400))];
  const cut = selectCutPoint(msgs, 250);
  // 对齐后 cut 必落在某个 user 上，保证它后面的 tool 对完整
  assert.equal(msgs[cut].role, "user");
});

test("groupByTurn：每组以一条用户消息开头", () => {
  const msgs = [u("q1"), a("r1"), tr("t1"), u("q2"), a("r2")];
  const groups = groupByTurn(msgs);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((m) => m.role), ["user", "assistant", "toolResult"]);
  assert.deepEqual(groups[1].map((m) => m.role), ["user", "assistant"]);
});

test("buildSummaryPrompt：首次含 9 段模板与 conversation 标签", () => {
  const p = buildSummaryPrompt("CONV", undefined);
  assert.match(p, /<conversation>\nCONV\n<\/conversation>/);
  assert.match(p, /Primary Request and Intent/);
  assert.match(p, /All User Messages/);
  assert.match(p, /Next Step/);
  assert.doesNotMatch(p, /<previous-summary>/);
  assert.doesNotMatch(p, /<analysis>/); // 确认无 analysis 标签
});

test("buildSummaryPrompt：有 previousSummary 走增量模板", () => {
  const p = buildSummaryPrompt("NEW", "OLD SUMMARY");
  assert.match(p, /<previous-summary>\nOLD SUMMARY\n<\/previous-summary>/);
  assert.match(p, /Update the existing summary/);
});

test("isTooLongError 识别多种过长措辞", () => {
  assert.equal(isTooLongError("This model's maximum context length is 128000 tokens"), true);
  assert.equal(isTooLongError("prompt is too long"), true);
  assert.equal(isTooLongError("rate limited"), false);
  assert.equal(isTooLongError(undefined), false);
});

test("runFullCompaction：正常一次成功", async () => {
  const summarize: SummarizeFn = async () => ({ ok: true, text: "SUMMARY" });
  const out = await runFullCompaction({ messages: [u("hi"), a("yo")], summarize });
  assert.equal(out, "SUMMARY");
});

test("runFullCompaction：非过长错误直接抛", async () => {
  const summarize: SummarizeFn = async () => ({ ok: false, text: "", errorMessage: "401 unauthorized" });
  await assert.rejects(() => runFullCompaction({ messages: [u("hi")], summarize }), CompactionFailed);
});

test("runFullCompaction：prompt 过长 → map-reduce 兜底分块后成功", async () => {
  // 整体过长，但分块（每次调用消息数减少）后成功。记录调用次数验证确实分块了。
  let calls = 0;
  const summarize: SummarizeFn = async ({ userPrompt }) => {
    calls++;
    // 提取 conversation 里的消息条数：用 [User]/[Assistant] 标签数粗判
    const labels = (userPrompt.match(/\[(User|Assistant|ToolResult)\]/g) ?? []).length;
    // 第一次（全量 4 条）过长；分块后（<=2 条）成功
    if (labels > 2) return { ok: false, text: "", tooLong: true, errorMessage: "context length exceeded" };
    return { ok: true, text: "PART" };
  };
  const msgs = [u("q1"), a("r1"), u("q2"), a("r2")];
  const out = await runFullCompaction({ messages: msgs, summarize });
  assert.match(out, /PART|SUMMARY/); // 合并结果
  assert.ok(calls >= 3, `应发生分块+合并的多次调用，实际 ${calls}`);
});

test("runFullCompaction：分到底仍过长 → 抛 CompactionFailed（不盲丢）", async () => {
  const summarize: SummarizeFn = async () => ({ ok: false, text: "", tooLong: true, errorMessage: "too long" });
  await assert.rejects(
    () => runFullCompaction({ messages: [u("q1"), a("r1"), u("q2"), a("r2")], summarize, maxDepth: 2 }),
    CompactionFailed,
  );
});

const me = (id: string, role: string, text: string): PlanEntry => ({ id, type: "message", role, text });

test("extractCompactionPlan：从最近 compaction 之后开始，带出 previousSummary", () => {
  const entries: PlanEntry[] = [
    me("m0", "user", big(400)),
    { id: "c0", type: "compaction", summary: "OLD" },
    me("m1", "user", big(400)),
    me("m2", "assistant", big(400)),
    me("m3", "user", big(400)),
    me("m4", "assistant", big(400)),
  ];
  const plan = extractCompactionPlan(entries, 150);
  assert.ok(plan);
  assert.equal(plan!.previousSummary, "OLD"); // 滚动增量
  // m0 在 compaction 之前，不参与；从 m1 起算
  assert.ok(plan!.messagesToSummarize.length >= 1);
  assert.match(plan!.firstKeptEntryId, /^m[1-4]$/);
});

test("extractCompactionPlan：无可压缩前缀 → undefined", () => {
  const entries: PlanEntry[] = [me("m1", "user", big(40)), me("m2", "assistant", big(40))];
  assert.equal(extractCompactionPlan(entries, 100000), undefined);
});

test("extractCompactionPlan：firstKeptEntryId 指向真实保留 entry，summarize 的是它之前的", () => {
  const entries: PlanEntry[] = [
    me("m1", "user", big(400)),
    me("m2", "assistant", big(400)),
    me("m3", "user", big(400)),
    me("m4", "assistant", big(400)),
  ];
  const plan = extractCompactionPlan(entries, 150)!;
  // 留 ~150tok：尾部 m4(100)+m3(100)>=150 → idx=2(m3,user) → firstKept=m3
  assert.equal(plan.firstKeptEntryId, "m3");
  assert.equal(plan.messagesToSummarize.length, 2); // m1,m2 被摘要
});

test("estimateTokens / serializeConversation 基本行为", () => {
  assert.equal(estimateTokens("xxxx"), 1);
  assert.equal(serializeConversation([u("hi"), tr("res")]), "[User]\nhi\n\n[ToolResult]\nres");
});
