import { test } from "node:test";
import assert from "node:assert/strict";
import { Telemetry } from "../src/kernel/telemetry.js";

/** 构造一条带 usage 的 turn_end 事件（只填 telemetry 关心的字段）。 */
function turnEnd(usage: { input: number; output: number; cacheRead: number; cacheWrite?: number }, model = "fake") {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      provider: "test",
      model,
      usage: { cacheWrite: 0, ...usage, cost: { total: 0 } },
    },
  } as never;
}

test("记录最近一次回复的模型名", () => {
  const t = new Telemetry();
  assert.equal(t.model, "");
  t.handle(turnEnd({ input: 1, output: 1, cacheRead: 0 }, "deepseek-v4-flash"));
  assert.equal(t.model, "deepseek-v4-flash");
});

test("缓存命中率 = cacheRead /(input+cacheRead+cacheWrite)，跨轮累计", () => {
  const t = new Telemetry();
  // 第 1 轮：命中 900，未命中 100 → 总 prompt 1000
  t.handle(turnEnd({ input: 100, output: 50, cacheRead: 900 }));
  assert.equal(t.cacheReadTokens, 900);
  assert.equal(t.inputTokens, 100);
  assert.equal(t.cacheHitRate(), 0.9);

  // 第 2 轮：命中 0，未命中 1000 → 累计命中 900 / 总 2000 = 0.45
  t.handle(turnEnd({ input: 1000, output: 50, cacheRead: 0 }));
  assert.equal(t.cacheHitRate(), 0.45);
});

test("把 cacheWrite 计入分母（写缓存不算命中）", () => {
  const t = new Telemetry();
  // 命中 0，未命中 0，写缓存 1000 → 命中率 0（分母含 write）
  t.handle(turnEnd({ input: 0, output: 10, cacheRead: 0, cacheWrite: 1000 }));
  assert.equal(t.cacheWriteTokens, 1000);
  assert.equal(t.cacheHitRate(), 0);
});

test("无任何 prompt token 时命中率为 0（不除零）", () => {
  const t = new Telemetry();
  assert.equal(t.cacheHitRate(), 0);
});

test("summary() 输出包含命中率百分比", () => {
  const t = new Telemetry();
  t.handle(turnEnd({ input: 250, output: 10, cacheRead: 750 }));
  assert.match(t.summary(), /prompt cache hit\s+: 750 tok \(75\.0%\)/);
});
