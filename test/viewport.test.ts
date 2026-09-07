import { test } from "node:test";
import assert from "node:assert/strict";
import { visible, scrollBy, accumulateNew } from "../src/ui/viewport.js";

test("visible：跟随底部（offset=0）取最后 height 行", () => {
  const v = visible({ total: 100, height: 10, offset: 0 });
  assert.equal(v.start, 90);
  assert.equal(v.count, 10);
  assert.equal(v.clampedOffset, 0);
});

test("visible：上滚 5 行 → 窗口上移；offset 恰好等于总高差时从头显示", () => {
  const v = visible({ total: 100, height: 10, offset: 5 });
  assert.equal(v.start, 85);
  assert.equal(v.count, 10);
  const top = visible({ total: 100, height: 10, offset: 90 });
  assert.equal(top.start, 0);
  assert.equal(top.count, 10);
});

test("visible：内容不足一屏 → 从头显示且 offset 钳到 0", () => {
  const v = visible({ total: 5, height: 10, offset: 3 });
  assert.equal(v.start, 0);
  assert.equal(v.count, 5);
  assert.equal(v.clampedOffset, 0);
});

test("visible：resize 变矮后 offset 超界被钳制", () => {
  const v = visible({ total: 50, height: 5, offset: 100 });
  assert.equal(v.clampedOffset, 45);
  assert.equal(v.start, 0);
});

test("scrollBy：向上/向下滚动并钳制到 [0, maxOffset]", () => {
  const s = { total: 100, height: 10 } as const;
  assert.equal(scrollBy({ ...s, offset: 0 }, 3), 3);
  assert.equal(scrollBy({ ...s, offset: 3 }, -1), 2);
  assert.equal(scrollBy({ ...s, offset: 3 }, -10), 0); // 滚到底恢复跟随
  assert.equal(scrollBy({ ...s, offset: 0 }, 999), 90); // 顶到头
});

test("accumulateNew：跟随中（offset=0）恒为 0；暂停时累加", () => {
  assert.equal(accumulateNew(0, 0, 5), 0);
  assert.equal(accumulateNew(3, 10, 5), 8);
  assert.equal(accumulateNew(8, 0, 5), 0); // 归零即清零
});
