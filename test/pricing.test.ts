import { test } from "node:test";
import assert from "node:assert/strict";
import { costRmb } from "../src/kernel/pricing.js";

// usage 语义：input=未命中输入、cacheRead=命中、output=输出（每项给 1e6 → 直接得每百万价）
const u = (o: Partial<{ input: number; cacheRead: number; cacheWrite: number; output: number }>) =>
  ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: { total: 0 }, ...o }) as never;

test("Pro 定价：命中 0.025 / 未命中 3 / 输出 6（每百万）", () => {
  const m = "deepseek/deepseek-v4-pro";
  assert.equal(+costRmb(m, u({ cacheRead: 1e6 })).toFixed(6), 0.025);
  assert.equal(+costRmb(m, u({ input: 1e6 })).toFixed(6), 3);
  assert.equal(+costRmb(m, u({ output: 1e6 })).toFixed(6), 6);
});

test("Flash 定价：命中 0.02 / 未命中 1 / 输出 2（每百万）", () => {
  const m = "deepseek/deepseek-v4-flash";
  assert.equal(+costRmb(m, u({ cacheRead: 1e6 })).toFixed(6), 0.02);
  assert.equal(+costRmb(m, u({ input: 1e6 })).toFixed(6), 1);
  assert.equal(+costRmb(m, u({ output: 1e6 })).toFixed(6), 2);
});

test("cacheWrite 按未命中价计（含写缓存）", () => {
  assert.equal(+costRmb("deepseek/deepseek-v4-flash", u({ cacheWrite: 1e6 })).toFixed(6), 1);
});

test("未知模型 → 用 pi-ai 的 USD cost × 汇率兜底", () => {
  const r = costRmb("foo/bar", { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, cost: { total: 2 } } as never);
  assert.equal(+r.toFixed(2), 14.4); // 2 × 7.2
});

test("自定义定价表（config 外置）覆盖内置默认", () => {
  const rates = { "x/custom": { cacheHit: 0.1, miss: 5, output: 10 } };
  assert.equal(+costRmb("x/custom", u({ input: 1e6 }), rates).toFixed(6), 5);
  assert.equal(+costRmb("x/custom", u({ output: 1e6 }), rates).toFixed(6), 10);
  // 自定义表里没有的 ref → 不在表中 → 走 USD 兜底（这里 cost.total=0 → 0）
  assert.equal(costRmb("deepseek/deepseek-v4-pro", u({ input: 1e6 }), rates), 0);
});
