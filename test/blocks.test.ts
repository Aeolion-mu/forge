import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBlockLines, renderLines, flattenBlocks, defaultCollapsed, type Block } from "../src/ui/blocks.js";

test("markdown block：按渲染期宽度折行——同一 block 两种宽度产出不同行（resize 重排的证据）", () => {
  const b: Block = { id: 1, kind: "markdown", source: "这是一段比较长的中文内容 ".repeat(12) };
  const narrow = renderBlockLines(b, 30);
  const wide = renderBlockLines(b, 100);
  assert.ok(narrow.length > wide.length, "窄屏行数应更多");
  assert.ok(narrow[0]!.startsWith("●") || /\x1b\[38;5;220m/.test(narrow[0]!), "首行带 ● 前缀");
  assert.ok(narrow[1]!.startsWith("  "), "续行 2 空格悬挂缩进");
});

test("记忆化：同 (id,width) 返回同一数组引用，不同 width 各自缓存", () => {
  const b: Block = { id: 2, kind: "markdown", source: "hello" };
  const a1 = renderLines(b, 80);
  const a2 = renderLines(b, 80);
  const a3 = renderLines(b, 100);
  assert.equal(a1, a2, "同宽同引用（缓存命中）");
  assert.notEqual(a1, a3, "不同宽各自缓存");
});

test("tool block：折叠只留预览行，展开出全文；diff 形态不受折叠影响", () => {
  const base = { id: 3, kind: "tool", toolCallId: "t1", header: "● bash(echo hi)" } as const;
  const body = { kind: "text" as const, preview: "hi", full: "hi\nline2\nline3" };
  const collapsed = renderBlockLines({ ...base, body, collapsed: true }, 80);
  assert.equal(collapsed.length, 2); // header + preview
  assert.ok(collapsed[1]!.includes("hi"));
  const expanded = renderBlockLines({ ...base, body, collapsed: false }, 80);
  assert.equal(expanded.length, 4); // header + 3 行
  // diff 形态：无论 collapsed 与否都渲染 diff
  const diffBody = { kind: "diff" as const, diffs: [{ verb: "Update", path: "a.ts", added: 1, removed: 1, lines: [{ tag: "-", oldNo: 1, text: "x" }, { tag: "+", newNo: 1, text: "y" }] }] };
  const d1 = renderBlockLines({ ...base, body: diffBody, collapsed: true }, 80);
  const d2 = renderBlockLines({ ...base, body: diffBody, collapsed: false }, 80);
  assert.equal(d1.length, d2.length);
  assert.ok(d1.some((l) => l.includes("a.ts")));
});

test("defaultCollapsed：有全文的 text 默认折叠；diff 不折叠；无全文不折叠", () => {
  assert.ok(defaultCollapsed({ kind: "text", preview: "p", full: "多行…" }));
  assert.ok(!defaultCollapsed({ kind: "text", preview: "p" }));
  assert.ok(!defaultCollapsed({ kind: "diff", diffs: [] }));
});

test("flattenBlocks：行数组与 owner 映射对齐，block 间空行", () => {
  const blocks: Block[] = [
    { id: 10, kind: "user", text: "hi" },
    { id: 11, kind: "plain", text: "done" },
  ];
  const { lines, owner } = flattenBlocks(blocks, 80);
  assert.equal(lines.length, owner.length);
  assert.equal(lines.filter((l) => l === "").length, 2, "每 block 一条间隔空行");
  assert.ok(owner.every((id) => id === 10 || id === 11));
});

test("折叠切换使缓存失效（collapsed 进缓存键）", () => {
  const b: Block = { id: 5, kind: "tool", toolCallId: "t", header: "h", body: { kind: "text", preview: "p", full: "line1\nline2\nline3" }, collapsed: true };
  const c = renderLines(b, 80);
  const e = renderLines({ ...b, collapsed: false }, 80);
  assert.notEqual(c, e);
  assert.ok(c.length < e.length);
});
