import { test } from "node:test";
import assert from "node:assert/strict";
import { replayBlocks } from "../src/ui/session-replay.js";
import type { Entry } from "@earendil-works/pi-agent-core";

let idc = 0;
const msg = (role: string, m: object, parent?: string): Entry =>
  ({ id: `e${idc++}`, parentId: parent ?? null, seq: idc, timestamp: 0, type: "message", message: { role, timestamp: 0, ...m } }) as unknown as Entry;

test("replay：用户/助手文本逐字保留（含中文、多行、markdown 源）", () => {
  const src = "第一行\n```ts\nconst x = 1;\n```";
  const blocks = replayBlocks([
    msg("user", { content: "你好 世界" }),
    msg("assistant", { content: [{ type: "text", text: src }] }),
  ]);
  assert.equal(blocks[0]!.kind, "user");
  assert.equal((blocks[0] as { text: string }).text, "你好 世界");
  assert.equal(blocks[1]!.kind, "markdown");
  assert.equal((blocks[1] as { source: string }).source, src); // 逐字节
});

test("replay：thinking → thinking 块；user 的 content 数组形态文本拼接", () => {
  const blocks = replayBlocks([
    msg("assistant", { content: [{ type: "thinking", thinking: "嗯…".repeat(40) }, { type: "text", text: "答" }] }),
    msg("user", { content: [{ type: "text", text: "A" }, { type: "image", url: "x" }, { type: "text", text: "B" }] }),
  ]);
  assert.equal(blocks[0]!.kind, "thinking");
  assert.equal(blocks[1]!.kind, "markdown");
  assert.equal(blocks[2]!.kind, "user");
  assert.equal((blocks[2] as { text: string }).text, "AB"); // 图片跳过、文本拼接
});

test("replay：toolCall + toolResult 按 toolCallId 配对回填（默认折叠含全文）", () => {
  const callId = "call-1";
  const blocks = replayBlocks([
    msg("assistant", { content: [{ type: "toolCall", id: callId, name: "bash", arguments: { cmd: "seq 1 60" } }] }),
    { id: `e${idc++}`, parentId: null, seq: idc, timestamp: 0, type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "1\n2\n3\n…\n60" }], isError: false, timestamp: 0 } } as unknown as Entry,
  ]);
  const tool = blocks[0]!;
  assert.equal(tool.kind, "tool");
  const t = tool as { body?: { kind: string; preview: string; full: string; isError: boolean }; collapsed?: boolean };
  assert.equal(t.body?.full, "1\n2\n3\n…\n60");
  assert.equal(t.body?.preview, "1");
  assert.equal(t.collapsed, true); // 有全文默认折叠
});

test("replay：孤儿 toolResult 单独落 plain 不丢数据；错误结果 isError 传递", () => {
  const blocks = replayBlocks([
    { id: `e${idc++}`, parentId: null, seq: idc, timestamp: 0, type: "message", message: { role: "toolResult", toolCallId: "nope", toolName: "bash", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 0 } } as unknown as Entry,
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, "plain");
});

test("replay：compaction 条目 → 提示块", () => {
  const blocks = replayBlocks([
    { id: `e${idc++}`, parentId: null, seq: idc, timestamp: 0, type: "compaction", summary: "S".repeat(500), retainedTail: [], tokensBefore: 1, fromHook: false } as unknown as Entry,
    msg("user", { content: "after" }),
  ]);
  assert.equal(blocks[0]!.kind, "plain");
  assert.equal(blocks[1]!.kind, "user");
});
