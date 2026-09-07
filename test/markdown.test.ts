import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapVisible } from "../src/ui/markdown.js";

/** 剔除 ANSI 后的可见宽度（CJK=2）。 */
function vwidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide = (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

test("英文长行按宽度折行，且不超出宽度", () => {
  const text = "the quick brown fox jumps over the lazy dog again and again and again";
  const out = wrapVisible(text, 20);
  const lines = out.split("\n");
  assert.ok(lines.length > 1, "应折成多行");
  for (const ln of lines) assert.ok(vwidth(ln) <= 20, `行宽应≤20，实际 ${vwidth(ln)}：${JSON.stringify(ln)}`);
});

test("不在单词中间断（有空格时优先空格断词）", () => {
  const out = wrapVisible("hello Gigafactory world", 12);
  assert.ok(!/Gigafa\n/.test(out), "不应把 Gigafactory 拦腰断开");
  // 每个完整单词都应出现在某一行里
  assert.match(out, /Gigafactory/);
});

test("超长单词（无空格）才硬断", () => {
  const out = wrapVisible("aaaaaaaaaaaaaaaaaaaaaaaa", 10);
  const lines = out.split("\n");
  assert.ok(lines.length >= 3, "无空格超长词应硬断成多行");
  for (const ln of lines) assert.ok(vwidth(ln) <= 10);
});

test("CJK 按宽度折行（每字宽 2）", () => {
  const out = wrapVisible("第一性原理就是把问题拆到不可再拆的基本事实", 12);
  const lines = out.split("\n");
  assert.ok(lines.length > 1);
  for (const ln of lines) assert.ok(vwidth(ln) <= 12, `行宽应≤12，实际 ${vwidth(ln)}`);
});

test("保留并跨行续接 ANSI 颜色", () => {
  const colored = "\x1b[38;5;220m" + "alpha beta gamma delta epsilon" + "\x1b[39m";
  const out = wrapVisible(colored, 12);
  const lines = out.split("\n");
  assert.ok(lines.length > 1);
  // 续行应重新开色（不丢色），首行应自带 reset 收尾
  assert.match(lines[0], /\x1b\[0m$/);
  assert.ok(lines[1].startsWith("\x1b[38;5;220m"), "续行应重开金色");
});

test("窄宽度（<8）不折行，原样返回", () => {
  const text = "abcdefghij";
  assert.equal(wrapVisible(text, 4), text);
});

test("短文本与多段换行原样保留", () => {
  assert.equal(wrapVisible("short", 80), "short");
  assert.equal(wrapVisible("line1\nline2", 80), "line1\nline2");
});
