import { test } from "node:test";
import assert from "node:assert/strict";
import { texToUnicode, convertInlineMath } from "../src/ui/math.js";

test("希腊字母与运算符", () => {
  assert.equal(texToUnicode("2\\pi"), "2π");
  assert.equal(texToUnicode("a \\le b"), "a ≤ b");
  assert.equal(texToUnicode("a \\cdot b \\times c"), "a · b × c");
  assert.equal(texToUnicode("\\infty"), "∞");
});

test("分数 / 上下标 → Unicode", () => {
  assert.equal(texToUnicode("\\frac{n}{2^{n-1}}"), "n/2ⁿ⁻¹");
  assert.equal(texToUnicode("x^2 + y^2 = r^2"), "x² + y² = r²");
  assert.equal(texToUnicode("a_{i} \\le b_{i}"), "aᵢ ≤ bᵢ");
  assert.equal(texToUnicode("\\frac{a+b}{c}"), "(a+b)/c"); // 含运算符加括号
});

test("\\boxed / \\left\\right / 间距命令清理", () => {
  assert.equal(texToUnicode("\\boxed{P_n = \\frac{n}{2^{\\,n-1}}}"), "Pₙ = n/2ⁿ⁻¹");
  assert.equal(texToUnicode("\\left(\\frac{1}{2}\\right)^{n-1}"), "(1/2)ⁿ⁻¹");
});

test("行内定界符剥离，文本保留", () => {
  assert.equal(convertInlineMath("它们在 \\([0, 2\\pi)\\) 上分布"), "它们在 [0, 2π) 上分布");
  assert.equal(convertInlineMath("概率为 \\(\\frac{3}{4}\\)。"), "概率为 3/4。");
});

test("未知命令保持原样，不破坏", () => {
  assert.equal(texToUnicode("\\foobar{x}"), "\\foobarx"); // 命令未知保留反斜杠，仅剥分组花括号
});

test("货币 $ 不被误当公式", () => {
  assert.equal(convertInlineMath("花了 $5 和 $10"), "花了 $5 和 $10");
});
