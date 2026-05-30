import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { formatOutline, makeOutlineTool } from "../src/tools/outline.js";
import type { CodeSymbol } from "../src/kernel/code-outline.js";

test("formatOutline：头部 + 方法在类下缩进", () => {
  const syms: CodeSymbol[] = [
    { kind: "class", name: "Foo", startLine: 3, endLine: 5, signature: "class Foo:" },
    { kind: "method", name: "bar", container: "Foo", startLine: 4, endLine: 5, signature: "def bar(self, x):" },
  ];
  const out = formatOutline("a.py", syms);
  assert.match(out, /a\.py · 2 symbols/);
  assert.match(out, /  L3–5 {8}class Foo:/); // 顶层 2 空格缩进
  assert.match(out, /    L4–5 {8}def bar\(self, x\):/); // 方法 4 空格缩进
});

test("formatOutline：无符号", () => {
  assert.match(formatOutline("x.py", []), /无可识别符号/);
});

const findExec = (t: AgentTool) =>
  t as AgentTool & { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details: { symbols: number; supported: boolean } }> };

test("outline 工具：解析临时 Python 文件，返回符号与行范围", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-outline-"));
  try {
    writeFileSync(resolve(wd, "m.py"), "def f(x):\n    return x\n\nclass C:\n    def g(self):\n        return 1\n", "utf8");
    const tool = findExec(makeOutlineTool(wd, false));
    const r = await tool.execute("1", { path: "m.py" });
    assert.equal(r.details.supported, true);
    assert.ok(r.details.symbols >= 3, `应至少 3 个符号，实际 ${r.details.symbols}`);
    assert.match(r.content[0].text, /L1–2/);
    assert.match(r.content[0].text, /class C:/);
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});

test("outline 工具：不支持的类型 → supported:false，提示用 read_file", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-outline-"));
  try {
    writeFileSync(resolve(wd, "a.md"), "# hi", "utf8");
    const tool = findExec(makeOutlineTool(wd, false));
    const r = await tool.execute("1", { path: "a.md" });
    assert.equal(r.details.supported, false);
    assert.match(r.content[0].text, /read_file/);
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});
