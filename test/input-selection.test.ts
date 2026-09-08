import { test } from "node:test";
import assert from "node:assert/strict";
import { inputLineCount, inputCharAt, inputCharAtScreen, normalizeInputSelection } from "../src/ui/input-selection.js";
import * as ed from "../src/ui/text-editor.js";

test("inputLineCount：空串 1 行、多行按 \\n 计", () => {
  assert.equal(inputLineCount(""), 1);
  assert.equal(inputLineCount("abc"), 1);
  assert.equal(inputLineCount("a\nb"), 2);
  assert.equal(inputLineCount("a\nb\nc\nd"), 4);
});

test("inputCharAt：首行 ASCII 列 → 下标", () => {
  const v = "hello world";
  assert.equal(inputCharAt(v, 0, 0), 0); // 行首
  assert.equal(inputCharAt(v, 0, 5), 5); // 空格处
  assert.equal(inputCharAt(v, 0, 11), 11); // 行尾（= value 末尾）
  assert.equal(inputCharAt(v, 0, 99), 11); // 超出 → 行尾
});

test("inputCharAt：CJK 宽字符按可见宽度折算（中文占 2 列）", () => {
  const v = "你好x";
  // 列 0 → '你'（0）；列 1 落在 '你' 的后半 → 仍命中 '你'（半宽即算点中）
  assert.equal(inputCharAt(v, 0, 0), 0);
  assert.equal(inputCharAt(v, 0, 1), 0);
  // 列 2 → '好'
  assert.equal(inputCharAt(v, 0, 2), 1);
  // 列 4 → 'x'
  assert.equal(inputCharAt(v, 0, 4), 2);
  assert.equal(inputCharAt(v, 0, 5), 3); // 行尾
});

test("inputCharAt：多行 value 的后续行从该行行首起算", () => {
  const v = "ab\ncde\nf";
  // 行起点：0 / 3 / 7
  assert.equal(inputCharAt(v, 1, 0), 3); // 第二行行首 = 'c'
  assert.equal(inputCharAt(v, 1, 2), 5); // 'e'
  assert.equal(inputCharAt(v, 1, 3), 6); // 第二行行尾 = 换行符位置
  assert.equal(inputCharAt(v, 2, 0), 7); // 第三行 'f'
  assert.equal(inputCharAt(v, 2, 1), 8); // value 末尾
  // 越界行 → null
  assert.equal(inputCharAt(v, 3, 0), null);
  assert.equal(inputCharAt(v, -1, 0), null);
});

test("inputCharAtScreen：屏幕 1-based 行列 + 首行 `› ` 前缀扣减", () => {
  const v = "abc\ndef";
  // inputRow=10：首行 (row 10) 扣 2 列前缀；第二行 (row 11) 不扣。
  assert.equal(inputCharAtScreen(v, 10, 10, 3), 0); // 屏幕 col 3 = 内容 col 0 → 'a'
  assert.equal(inputCharAtScreen(v, 10, 10, 4), 1); // col 4 = 内容 col 1
  assert.equal(inputCharAtScreen(v, 10, 10, 1), 0); // 点在 `› ` 前缀上 → 内容 col 0（钳制）
  assert.equal(inputCharAtScreen(v, 10, 11, 1), 4); // 第二行 col 1 = 'd'
  assert.equal(inputCharAtScreen(v, 10, 11, 3), 6); // 'f'
  assert.equal(inputCharAtScreen(v, 10, 12, 1), null); // 行不在输入框内
  assert.equal(inputCharAtScreen(v, 10, 9, 1), null); // 输入框上方
});

test("normalizeInputSelection：归一化为 [start,end)，退化返回 null", () => {
  assert.deepEqual(normalizeInputSelection({ anchor: 5, active: 2 }), { start: 2, end: 5 });
  assert.deepEqual(normalizeInputSelection({ anchor: 2, active: 5 }), { start: 2, end: 5 });
  assert.equal(normalizeInputSelection({ anchor: 3, active: 3 }), null);
  assert.equal(normalizeInputSelection(null), null);
});

test("removeRange：删除区间、光标落 start；乱序/越界安全", () => {
  assert.deepEqual(ed.removeRange({ text: "hello world", cursor: 11 }, 5, 11), { text: "hello", cursor: 5 });
  assert.deepEqual(ed.removeRange({ text: "hello world", cursor: 0 }, 11, 5), { text: "hello", cursor: 5 }); // 乱序自动归一
  assert.deepEqual(ed.removeRange({ text: "abc", cursor: 1 }, 2, 2), { text: "abc", cursor: 1 }); // 空区间不变
  assert.deepEqual(ed.removeRange({ text: "abc", cursor: 1 }, -5, 99), { text: "", cursor: 0 }); // 越界钳制
  // 含换行的跨行选区
  assert.deepEqual(ed.removeRange({ text: "ab\ncd", cursor: 4 }, 1, 4), { text: "ad", cursor: 1 });
});
