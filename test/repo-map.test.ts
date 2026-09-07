import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { formatRepoMap, collectRepoOutline, type FileOutline } from "../src/tools/repo-map.js";
import type { CodeSymbol } from "../src/kernel/code-outline.js";

const sym = (name: string, startLine: number, signature: string, container?: string): CodeSymbol => ({
  kind: "function",
  name,
  startLine,
  endLine: startLine,
  signature,
  container,
});

test("formatRepoMap：列出文件 + 符号行号，方法缩进", () => {
  const files: FileOutline[] = [
    { relpath: "a.py", symbols: [sym("f", 1, "def f(x):"), sym("g", 5, "def g(self):", "C")] },
    { relpath: "b.py", symbols: [] }, // 无符号 → 不计入
  ];
  const out = formatRepoMap(files, 4000);
  assert.match(out, /Repo map · 1 files/); // 只 a.py 有符号
  assert.match(out, /a\.py/);
  assert.match(out, /  L1\tdef f\(x\):/);
  assert.match(out, /    L5\tdef g\(self\):/); // 方法缩进
  assert.doesNotMatch(out, /b\.py/);
});

test("formatRepoMap：超预算按文件截断并标省略", () => {
  const big = (n: number): FileOutline => ({
    relpath: `file${n}.py`,
    symbols: [sym("x", 1, "def x():" + "y".repeat(200))],
  });
  const files = Array.from({ length: 20 }, (_, i) => big(i));
  const out = formatRepoMap(files, 100); // 极小预算
  assert.match(out, /more files omitted/);
  // 没有把 20 个文件全列出来
  assert.ok(out.split("\n").filter((l) => l.endsWith(".py")).length < 20);
});

test("collectRepoOutline：遍历临时仓，跳过非源码", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-repomap-"));
  try {
    mkdirSync(resolve(wd, "src"), { recursive: true });
    writeFileSync(resolve(wd, "src", "a.py"), "def f():\n    return 1\n", "utf8");
    writeFileSync(resolve(wd, "src", "b.ts"), "export function g(): number { return 2; }\n", "utf8");
    writeFileSync(resolve(wd, "README.md"), "# not code", "utf8");
    const files = await collectRepoOutline(wd, wd);
    const paths = files.map((f) => f.relpath).sort();
    assert.deepEqual(paths, ["src/a.py", "src/b.ts"]); // md 被跳过
    assert.ok(files.find((f) => f.relpath === "src/a.py")!.symbols.some((s) => s.name === "f"));
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});
