import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRange,
  lineRangeInSel,
  plainSlice,
  plainOf,
  highlightRange,
  expandWord,
  wholeLine,
  selectedText,
} from "../src/ui/selection.js";
import { SEL_ON, SEL_OFF } from "../src/ui/theme.js";

const ESC = "\x1b";

test("normalizeRange：正序保留、反序交换、同行按列", () => {
  assert.deepEqual(normalizeRange({ line: 5, col: 3 }, { line: 5, col: 9 }), { startLine: 5, startCol: 3, endLine: 5, endCol: 9 });
  const r = normalizeRange({ line: 9, col: 1 }, { line: 5, col: 7 });
  assert.equal(r.startLine, 5);
  assert.equal(r.startCol, 7);
  assert.equal(r.endLine, 9);
  assert.equal(r.endCol, 1);
});

test("lineRangeInSel：首尾行截断、中间行整行、界外 null", () => {
  const r = { startLine: 2, startCol: 4, endLine: 5, endCol: 6 };
  assert.equal(lineRangeInSel(r, 1), null);
  assert.deepEqual(lineRangeInSel(r, 2), [4, Infinity]);
  assert.deepEqual(lineRangeInSel(r, 3), [0, Infinity]);
  assert.deepEqual(lineRangeInSel(r, 5), [0, 6]);
  assert.equal(lineRangeInSel(r, 6), null);
});

test("plainSlice：按可见列切纯文本（ANSI 跳过、CJK 占 2 列、半格交集计入）", () => {
  const line = `${ESC}[38;5;202mhello${ESC}[0m 世界abc`;
  // 可见列: h0 e1 l2 l3 o4 (空)5 世6-7 界8-9 a10 b11 c12
  assert.equal(plainSlice(line, 0, 5), "hello");
  assert.equal(plainSlice(line, 6, 10), "世界");
  assert.equal(plainSlice(line, 4, 11), "o 世界a"); // o(4) 空格(5) 世界(6-9) a(10)
  assert.equal(plainSlice(line, 7, 9), "世界"); // 世占 6-7、界占 8-9：7 落在世的后半格 → 都计入
  assert.equal(plainOf(line), "hello 世界abc");
});

test("highlightRange：区间套蓝底——前缀样式保留、区间内 SGR 剥离、出界重放、宽字符整字", () => {
  const line = `${ESC}[31mab中c${ESC}[0m`;
  // 可见列: a0 b1 中2-3 c4
  const h = highlightRange(line, 1, 4); // 选中 b中
  // 区间前样式原样（a 仍红）；区间起 SEL_ON（蓝底亮白）
  assert.ok(h.includes(`${ESC}[31ma${SEL_ON}b中`), h);
  // 出界：SEL_OFF 后重放区间前样式（c 仍红）
  assert.ok(h.includes(`${SEL_OFF}${ESC}[31mc`), h);
  assert.ok(h.endsWith(`c${ESC}[0m`), h);
});

test("highlightRange：区间内的 SGR 丢弃（diff 色带/语法色在选区内让位）", () => {
  const line = `x${ESC}[38;5;202my${ESC}[0mz`;
  const h = highlightRange(line, 0, 3); // 全选
  assert.equal(h, `${SEL_ON}xyz${SEL_OFF}`); // 无任何转义残留
});

test("highlightRange：选到行尾在区间内收尾 SEL_OFF+重放（0m 后无样式则空）", () => {
  const line = `${ESC}[31mabc${ESC}[0mde`; // 可见列: a0 b1 c2 d3 e4
  const h = highlightRange(line, 3, 99); // 选中 de（0m 后的裸文本）
  // 0m 在区间外原样保留；区间内无样式可剥；行尾 SEL_OFF + 重放（累计样式为空）
  assert.equal(h, `${ESC}[31mabc${ESC}[0m${SEL_ON}de${SEL_OFF}`);
});

test("expandWord：路径整选、标点分段、中文逐字、下划线连字", () => {
  assert.deepEqual(expandWord("see /Users/k/src/a.ts end", 8), [4, 21]); // 双击路径中段 → 整条路径
  assert.deepEqual(expandWord("foo(bar)", 2), [0, 3]); // foo（f0 o1 o2）
  assert.deepEqual(expandWord("foo(bar)", 3), [3, 4]); // ( 独立标点段
  assert.deepEqual(expandWord("foo(bar)", 4), [4, 7]); // bar
  assert.deepEqual(expandWord("hello_world", 5), [0, 11]); // 下划线连成一个词
  assert.deepEqual(expandWord("汉 字 test", 0), [0, 2]); // 汉占 2 列
  assert.deepEqual(expandWord("汉 字 test", 3), [3, 5]); // 字占 2 列（cols 3-4）
});

test("wholeLine / selectedText：跨行拼接、首尾截断", () => {
  const lines = ["abcdef", `${ESC}[31mghijkl${ESC}[0m`, "mnopqr"];
  assert.deepEqual(wholeLine(lines[0]!), [0, 6]);
  const t = selectedText(lines, normalizeRange({ line: 0, col: 2 }, { line: 2, col: 3 }));
  assert.equal(t, "cdef\nghijkl\nmno");
});
