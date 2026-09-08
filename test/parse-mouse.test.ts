import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMouseSequence, splitMouseSequences, createMouseStdin } from "../src/ui/terminal-io.js";

const ESC = "\x1b";

test("parseMouseSequence：左键按下（b=0 → button 0）", () => {
  const e = parseMouseSequence(`${ESC}[<0;12;34M`);
  assert.deepEqual(e, { kind: "press", button: 0, col: 12, row: 34, mods: { shift: false, alt: false, ctrl: false } });
});

test("parseMouseSequence：滚轮上/下（64/65）", () => {
  const up = parseMouseSequence(`${ESC}[<64;5;10M`)!;
  assert.equal(up.kind, "wheel");
  assert.equal(up.button, 64);
  const down = parseMouseSequence(`${ESC}[<65;5;10M`)!;
  assert.equal(down.kind, "wheel");
  assert.equal(down.button, 65);
});

test("parseMouseSequence：修饰键位（Shift=4 / Alt=8 / Ctrl=16）；松开=m", () => {
  const sh = parseMouseSequence(`${ESC}[<4;1;1M`)!; // 0|4 = 左键+Shift
  assert.ok(sh.mods.shift && !sh.mods.alt && !sh.mods.ctrl);
  const ca = parseMouseSequence(`${ESC}[<24;1;1M`)!; // 0|8|16 = 左键+Alt+Ctrl
  assert.ok(!ca.mods.shift && ca.mods.alt && ca.mods.ctrl);
  const rel = parseMouseSequence(`${ESC}[<0;1;1m`)!;
  assert.equal(rel.kind, "release");
});

test("parseMouseSequence：非鼠标序列返回 null", () => {
  assert.equal(parseMouseSequence(`${ESC}[A`), null); // 方向键
  assert.equal(parseMouseSequence(`${ESC}[200~`), null); // 括号粘贴
  assert.equal(parseMouseSequence("abc"), null);
  assert.equal(parseMouseSequence(""), null);
});

test("splitMouseSequences：鼠标剥出、键盘/粘贴透传", () => {
  const { passthrough, events, leftover } = splitMouseSequences(
    `x${ESC}[<0;3;5M${ESC}[A${ESC}[<64;1;1M${ESC}[200~paste${ESC}[<0;3;5m`,
  );
  assert.equal(passthrough, `x${ESC}[A${ESC}[200~paste`); // 方向键与粘贴原样透传
  assert.equal(events.length, 3); // press + wheel + release
  assert.equal(events[0]!.kind, "press");
  assert.equal(events[1]!.button, 64);
  assert.equal(events[2]!.kind, "release");
  assert.equal(leftover, "");
});

test("splitMouseSequences：跨 chunk 断裂序列留 leftover，拼上后续 chunk 能解析", () => {
  const a = splitMouseSequences(`text${ESC}[<0;12`); // 断在参数中间
  assert.equal(a.passthrough, "text");
  assert.equal(a.events.length, 0);
  assert.equal(a.leftover, `${ESC}[<0;12`);
  const b = splitMouseSequences(`${a.leftover};34M`);
  assert.equal(b.leftover, "");
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0]!.row, 34);
});

test("splitMouseSequences：孤零零 ESC 留 leftover（可能是断裂前缀）", () => {
  const a = splitMouseSequences(`hi${ESC}`);
  assert.equal(a.passthrough, "hi");
  assert.equal(a.leftover, ESC);
  // 现实分片：下一片以 [A 开头，拼上 leftover 后是完整方向键 → 透传给 Ink
  const b = splitMouseSequences(`${a.leftover}[A`);
  assert.equal(b.passthrough, `${ESC}[A`);
  assert.equal(b.leftover, "");
});

test("splitMouseSequences：纯文本直通", () => {
  const r = splitMouseSequences("hello 世界\n");
  assert.equal(r.passthrough, "hello 世界\n");
  assert.equal(r.events.length, 0);
  assert.equal(r.leftover, "");
});

test("createMouseStdin：孤立 ESC（真实 Esc 键）超时冲刷透传，不再被永久扣住", async () => {
  const { PassThrough } = await import("node:stream");
  const real = new PassThrough();
  const proxy = createMouseStdin(real);
  const read: () => string[] = () => {
    const out: string[] = [];
    for (;;) {
      const v = proxy.read() as string | null;
      if (v === null || v === undefined) break;
      out.push(v);
    }
    return out;
  };
  // 方向键（完整序列）立即透传
  real.write(`${ESC}[A`);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(read(), [`${ESC}[A`]);
  // 孤立 ESC：30ms 冲刷定时器后作为普通输入出现（此前是永久 leftover —— Esc 键失灵根因）
  real.write(ESC);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(read(), [ESC]);
  // 冲刷计时器不拖住进程退出（unref）
  (proxy as unknown as { detach?: () => void }).detach?.();
});
