import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineSource, langKeyForPath } from "../src/kernel/code-outline.js";

test("langKeyForPath：识别支持的扩展名", () => {
  assert.equal(langKeyForPath("a/b/c.py"), ".py");
  assert.equal(langKeyForPath("x.tsx"), ".tsx");
  assert.equal(langKeyForPath("README.md"), undefined);
  assert.equal(langKeyForPath("noext"), undefined);
});

test("Python：抽取 class / method(容器) / 顶层 function + 行范围 + 签名", async () => {
  const src = [
    "import os", // 1
    "", // 2
    "class Foo:", // 3
    "    def bar(self, x):", // 4
    "        return x + 1", // 5
    "", // 6
    "def top_level(a, b):", // 7
    "    return a + b", // 8
  ].join("\n");
  const syms = await outlineSource(src, ".py");
  const foo = syms.find((s) => s.name === "Foo");
  const bar = syms.find((s) => s.name === "bar");
  const top = syms.find((s) => s.name === "top_level");

  assert.ok(foo && foo.kind === "class" && foo.startLine === 3 && foo.endLine === 5);
  assert.ok(bar && bar.kind === "method" && bar.container === "Foo", "类内函数应标为 method 且容器为 Foo");
  assert.equal(bar!.startLine, 4);
  assert.equal(bar!.signature, "def bar(self, x):");
  assert.ok(top && top.kind === "function" && top.container === undefined && top.startLine === 7);
  // 按起始行排序
  assert.deepEqual(
    syms.map((s) => s.startLine),
    [...syms.map((s) => s.startLine)].sort((a, b) => a - b),
  );
});

test("TypeScript：interface / class / method / enum / function", async () => {
  const src = [
    "export interface Point { x: number; y: number }", // 1
    "export enum Color { Red, Green }", // 2
    "export class Box {", // 3
    "  area(): number { return 1; }", // 4
    "}", // 5
    "function helper(n: number): number { return n; }", // 6
  ].join("\n");
  const syms = await outlineSource(src, ".ts");
  const byName = (n: string) => syms.find((s) => s.name === n);
  assert.equal(byName("Point")?.kind, "interface");
  assert.equal(byName("Color")?.kind, "enum");
  assert.equal(byName("Box")?.kind, "class");
  assert.equal(byName("area")?.kind, "method");
  assert.equal(byName("area")?.container, "Box");
  assert.equal(byName("helper")?.kind, "function");
});

test("不支持的语言 → 抛错", async () => {
  await assert.rejects(() => outlineSource("x", ".md"));
});
