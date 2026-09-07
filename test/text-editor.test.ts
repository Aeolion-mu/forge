import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampCursor,
  normalizeNewlines,
  insert,
  backspace,
  cursorRowCol,
  lineStarts,
  moveUp,
  moveDown,
  lineHome,
  lineEnd,
} from "../src/ui/text-editor.js";

test("clampCursor：夹在 [0, len]", () => {
  assert.equal(clampCursor("abc", -5), 0);
  assert.equal(clampCursor("abc", 99), 3);
  assert.equal(clampCursor("abc", 2), 2);
});

test("normalizeNewlines：CRLF / 裸 CR → LF", () => {
  assert.equal(normalizeNewlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("insert：在光标处插入，光标移到插入末尾", () => {
  assert.deepEqual(insert({ text: "ac", cursor: 1 }, "b"), { text: "abc", cursor: 2 });
  // 整段（含换行）粘贴插入
  assert.deepEqual(insert({ text: "xy", cursor: 1 }, "1\n2"), { text: "x1\n2y", cursor: 4 });
});

test("backspace：删光标前一字符；行首不动", () => {
  assert.deepEqual(backspace({ text: "abc", cursor: 2 }), { text: "ac", cursor: 1 });
  assert.deepEqual(backspace({ text: "abc", cursor: 0 }), { text: "abc", cursor: 0 });
});

test("cursorRowCol：按 \\n 逻辑行算行列", () => {
  const t = "ab\ncde\nf";
  assert.deepEqual(cursorRowCol(t, 0), { row: 0, col: 0 });
  assert.deepEqual(cursorRowCol(t, 2), { row: 0, col: 2 }); // 第一行末
  assert.deepEqual(cursorRowCol(t, 3), { row: 1, col: 0 }); // 第二行首
  assert.deepEqual(cursorRowCol(t, 5), { row: 1, col: 2 });
  assert.deepEqual(cursorRowCol(t, 7), { row: 2, col: 0 });
});

test("lineStarts：各逻辑行起始偏移", () => {
  assert.deepEqual(lineStarts("ab\ncde\nf"), [0, 3, 7]);
  assert.deepEqual(lineStarts("no newline"), [0]);
});

test("moveUp：保持列、夹到目标行长；首行返回 null（→翻历史）", () => {
  const t = "abcd\nxy\nz"; // 行长 4 / 2 / 1
  // 光标在第三行 col0(offset 8) 上移 → 第二行 col0 (offset 5)
  assert.equal(moveUp(t, 8), 5);
  // 光标在第一行 → null
  assert.equal(moveUp(t, 2), null);
  // 列被夹：第二行 col2(offset 7=行"xy"末) 上移 → 第一行 col2 (offset 2)
  assert.equal(moveUp(t, 7), 2);
});

test("moveDown：保持列、夹到目标行长；尾行返回 null（→翻历史）", () => {
  const t = "abcd\nxy\nz";
  // 第一行 col3(offset 3) 下移 → 第二行 min(3,2)=2 (offset 5+2=7)
  assert.equal(moveDown(t, 3), 7);
  // 尾行 → null
  assert.equal(moveDown(t, 8), null);
  // 第二行 col1(offset 6) 下移 → 第三行 min(1,1)=1 (offset 8+1=9)
  assert.equal(moveDown(t, 6), 9);
});

test("单行文本：moveUp / moveDown 都返回 null（任何位置都翻历史）", () => {
  assert.equal(moveUp("hello", 3), null);
  assert.equal(moveDown("hello", 3), null);
});

test("lineHome / lineEnd：当前逻辑行的行首 / 行尾", () => {
  const t = "abc\ndefg\nh";
  assert.equal(lineHome(t, 6), 4); // 第二行内 → 行首 offset 4
  assert.equal(lineEnd(t, 6), 8); // 第二行末 offset 8（"\n" 前）
  assert.equal(lineHome(t, 1), 0); // 第一行
  assert.equal(lineEnd(t, 9), 10); // 末行 → text.length
});
