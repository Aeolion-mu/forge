import { test } from "node:test";
import assert from "node:assert/strict";
import { textOfMessage, toPlanEntries, editedPaths } from "../src/kernel/forge-agent.js";
import { extractCompactionPlan } from "../src/kernel/compaction.js";

// 用最小 fake 构造库的 Message / SessionTreeEntry（只填被读取的字段）。
const asMsg = (o: unknown) => o as never;
const asEntries = (o: unknown[]) => o as never;

test("textOfMessage：user 字符串内容直接返回", () => {
  assert.equal(textOfMessage(asMsg({ role: "user", content: "hello" })), "hello");
});

test("textOfMessage：user 数组内容取 text 片段", () => {
  assert.equal(
    textOfMessage(asMsg({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })),
    "a\nb",
  );
});

test("textOfMessage：assistant 取 text + tool_call 标记", () => {
  const out = textOfMessage(asMsg({ role: "assistant", content: [{ type: "text", text: "doing" }, { type: "toolCall", name: "bash" }] }));
  assert.equal(out, "doing\n[tool_call bash]");
});

test("textOfMessage：toolResult 取 text 片段", () => {
  assert.equal(textOfMessage(asMsg({ role: "toolResult", content: [{ type: "text", text: "exit=0" }] })), "exit=0");
});

test("textOfMessage：assistant 计入 tool_call 参数（不止标记）", () => {
  const out = textOfMessage(
    asMsg({ role: "assistant", content: [{ type: "toolCall", name: "write_file", arguments: { path: "a.py", content: "print(1)" } }] }),
  );
  assert.equal(out, '[tool_call write_file] {"path":"a.py","content":"print(1)"}');
});

test("textOfMessage：assistant 计入 thinking（不再丢弃）", () => {
  const out = textOfMessage(
    asMsg({ role: "assistant", content: [{ type: "thinking", thinking: "let me reason" }, { type: "text", text: "answer" }] }),
  );
  assert.equal(out, "let me reason\nanswer");
});

test("回归：含大 tool_call 参数/thinking 的 assistant 不被低估 → 仍判定为可压缩", () => {
  // 还原本次 bug：assistant 文本极短，主体是 tool_call 参数(写文件全文)与 thinking。
  // 旧 textOfMessage 把这两块清零 → 整段被估成几乎 0 token → selectCutPoint 累加永不达预算 →
  // cut 停在 0 → extractCompactionPlan 误判"无可压缩"返回 undefined（每次都退回库默认压缩）。
  // 计入后每条 assistant ~1000tok，近端两轮即超过 keepRecent，cut 正确落在靠后的 user。
  const bigArgs = { content: "x".repeat(2000) };
  const bigThink = "t".repeat(2000);
  const turn = (u: string, a: string) => [
    { type: "message", id: u, message: { role: "user", content: "q" } },
    { type: "message", id: a, message: { role: "assistant", content: [{ type: "thinking", thinking: bigThink }, { type: "toolCall", name: "write_file", arguments: bigArgs }] } },
  ];
  const entries = asEntries([...turn("u1", "a1"), ...turn("u2", "a2"), ...turn("u3", "a3"), ...turn("u4", "a4")]);
  const plan = extractCompactionPlan(toPlanEntries(entries), 1500);
  assert.ok(plan, "应判定为可压缩（不返回 undefined）");
  assert.equal(plan!.firstKeptEntryId, "u3"); // 留近端两轮(u3a3+u4a4 ~2020tok≥1500)，摘要前两轮
});

test("toPlanEntries：message/compaction/其它 三类正确投影", () => {
  const entries = asEntries([
    { type: "message", id: "m1", message: { role: "user", content: "q" } },
    { type: "compaction", id: "c1", summary: "S" },
    { type: "model_change", id: "x1" },
    { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a" }] } },
  ]);
  const plan = toPlanEntries(entries);
  assert.deepEqual(plan, [
    { id: "m1", type: "message", role: "user", text: "q" },
    { id: "c1", type: "compaction", summary: "S" },
    { id: "x1", type: "model_change" },
    { id: "m2", type: "message", role: "assistant", text: "a" },
  ]);
});

test("editedPaths：edit/write 取 input.path，apply_patch 取 diffs 多文件", () => {
  assert.deepEqual(editedPaths({ toolName: "edit_file", input: { path: "a.py" } }), ["a.py"]);
  assert.deepEqual(editedPaths({ toolName: "write_file", input: { path: "b.ts" } }), ["b.ts"]);
  assert.deepEqual(
    editedPaths({ toolName: "apply_patch", details: { diffs: [{ path: "x.py" }, { path: "y.py" }] } }),
    ["x.py", "y.py"],
  );
  assert.deepEqual(editedPaths({ toolName: "edit_file", input: {} }), []); // 无 path
});

test("端到端：toPlanEntries → extractCompactionPlan 选对 firstKeptEntryId", () => {
  const big = "x".repeat(400); // ~100 tok/条
  const entries = asEntries([
    { type: "message", id: "m1", message: { role: "user", content: big } },
    { type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: big }] } },
    { type: "message", id: "m3", message: { role: "user", content: big } },
    { type: "message", id: "m4", message: { role: "assistant", content: [{ type: "text", text: big }] } },
  ]);
  const plan = extractCompactionPlan(toPlanEntries(entries), 150);
  assert.ok(plan);
  assert.equal(plan!.firstKeptEntryId, "m3"); // 留近端 ~150tok（m3+m4），摘要 m1+m2
  assert.equal(plan!.messagesToSummarize.length, 2);
});
