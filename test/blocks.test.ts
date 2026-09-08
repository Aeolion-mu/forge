import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBlockLines, renderLines, flattenBlocks, defaultCollapsed, resetBlockCache, fmtDur, summarizeThoughtTools, type Block } from "../src/ui/blocks.js";
import { visibleWidth } from "../src/ui/markdown.js";

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

test("user 块：整行浅灰背景（含右侧补齐），多行每行都有背景", () => {
  const b: Block = { id: 1, kind: "user", text: "第一行\n第二行" };
  const got = renderLines(b, 80);
  assert.equal(got.length, 2);
  for (const l of got) {
    assert.ok(l.includes("\x1b[48;5;237m"), "背景色码应在行内");
    assert.ok(l.endsWith("\x1b[0m"), "行尾应复位");
  }
  assert.ok(got[0]!.includes("›"), "首行带 › 前缀");
  assert.ok(got[1]!.includes("第二行"), "续行内容在");
  // 补齐：背景覆盖到内容宽（width 80 → content 77，按可见宽度——中文占 2 列）
  const widths = got.map((l) => visibleWidth(l));
  assert.ok(widths.every((w) => w === 77), `补齐后行长应一致为 77：${widths.join(",")}`);
});

test("resetBlockCache 使旧缓存失效（/rewind 重建后 id 重计不再串号）", () => {
  const md = { id: 2, kind: "markdown", source: "旧内容" } as never as Block;
  renderLines(md, 80); // 旧世界缓存 id=2
  resetBlockCache(); // rewind 重建
  const user = { id: 2, kind: "user", text: "新内容" } as never as Block;
  const got = renderLines(user, 80);
  assert.ok(got[0]!.includes("新内容"), "重建后同 id 应渲染新内容（曾拿到旧 markdown 行——'复述'根因）");
});

test("折叠切换使缓存失效（collapsed 进缓存键）", () => {
  const b: Block = { id: 5, kind: "tool", toolCallId: "t", header: "h", body: { kind: "text", preview: "p", full: "line1\nline2\nline3" }, collapsed: true };
  const c = renderLines(b, 80);
  const e = renderLines({ ...b, collapsed: false }, 80);
  assert.notEqual(c, e);
  assert.ok(c.length < e.length);
});

test("fmtDur：秒/分秒格式（向下取整）", () => {
  assert.equal(fmtDur(0), "0s");
  assert.equal(fmtDur(9.6), "9s");
  assert.equal(fmtDur(61.4), "1m 1s");
  assert.equal(fmtDur(120), "2m");
  assert.equal(fmtDur(101.9), "1m 41s");
});

test("summarizeThoughtTools：首现顺序聚合、复数、未知工具归并", () => {
  const t = (name: string) => ({ name, header: name });
  assert.equal(summarizeThoughtTools([]), "");
  assert.equal(summarizeThoughtTools([t("read_file")]), "read 1 file");
  assert.equal(
    summarizeThoughtTools([t("grep"), t("read_file"), t("read_file"), t("list_dir"), t("grep"), t("bash")]),
    "searched for 2 patterns, read 2 files, listed 1 directory, ran 1 command",
  );
  assert.equal(summarizeThoughtTools([t("hover"), t("definition")]), "used 2 tools");
});

test("thought 块：折叠一行摘要（灰/悬停白），展开出思考全文与工具明细", () => {
  const b: Block = {
    id: 7,
    kind: "thought",
    secs: 61,
    thinking: "先查索引\n再读文件",
    tools: [
      { name: "grep", header: "● grep(\"sel\")", preview: "3 files" },
      { name: "read_file", header: "● read_file(a.ts)", preview: "read 24 lines" },
    ],
  };
  const collapsed = renderBlockLines(b, 100);
  assert.equal(collapsed.length, 1);
  assert.ok(collapsed[0]!.includes("✦ Thought for 1m 1s, searched for 1 pattern, read 1 file"), collapsed[0]!);
  assert.ok(collapsed[0]!.includes("\x1b[38;5;250m"), "默认灰色");
  const hovered = renderBlockLines(b, 100, true);
  assert.ok(hovered[0]!.includes("\x1b[38;5;231m"), "悬停变白");
  const expanded = renderBlockLines({ ...b, expanded: true }, 100);
  assert.ok(expanded.length >= 5, "摘要 + 思考 2 行 + 工具 2 行");
  assert.ok(expanded.some((l) => l.includes("先查索引")));
  assert.ok(expanded.some((l) => l.includes("● read_file(a.ts)") && l.includes("read 24 lines")));
  // 无时长（/resume 回放）：省略时长段
  const noDur = renderBlockLines({ ...b, secs: 0 }, 100);
  assert.ok(noDur[0]!.startsWith("\x1b[38;5;250m✦ Thought, "), noDur[0]!);
});

test("thought 悬停/展开进缓存键（hover 变体独立缓存）", () => {
  const b: Block = { id: 9, kind: "thought", secs: 5, thinking: "x", tools: [] };
  const dim = renderLines(b, 80);
  const white = renderLines(b, 80, "main", true);
  assert.notEqual(dim, white, "hover 变体不应命中同一缓存");
  assert.ok(white[0]!.includes("\x1b[38;5;231m"));
});
