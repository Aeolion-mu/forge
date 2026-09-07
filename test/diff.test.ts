import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFileDiff, renderFileDiff } from "../src/ui/diff.js";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("computeFileDiff 统计增删行数", () => {
  const before = ["a", "b", "c"].join("\n");
  const after = ["a", "B", "c", "d"].join("\n");
  const d = computeFileDiff(before, after, "Update", "x.ts");
  assert.equal(d.removed, 1); // b
  assert.equal(d.added, 2); // B, d
  assert.equal(d.verb, "Update");
  assert.equal(d.path, "x.ts");
});

test("新建文件：before 为空 → 全是新增", () => {
  const d = computeFileDiff("", "x\ny", "Create", "n.ts");
  assert.equal(d.removed, 0);
  assert.equal(d.added, 2);
});

test("renderFileDiff 输出 Claude-Code 风格头 + 带行号的 +/- hunk", () => {
  const before = ["keep", "old"].join("\n");
  const after = ["keep", "new"].join("\n");
  const out = strip(renderFileDiff(computeFileDiff(before, after, "Update", "x.ts")));
  assert.match(out, /Added 1 lines, removed 1 lines/);
  assert.match(out, /- old/);
  assert.match(out, /\+ new/);
  assert.match(out, /keep/); // 上下文行保留
});

test("超大文件跳过 LCS，仅给近似计数", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n");
  const d = computeFileDiff(big, big + "\nextra", "Update", "big.ts");
  assert.equal(d.lines.length, 0); // 不做逐行 diff
  assert.ok(d.added >= 1);
});
