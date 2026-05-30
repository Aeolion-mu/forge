import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { LspClient, lspLangForPath } from "../src/kernel/lsp-client.js";

test("lspLangForPath：映射语言，未知类型返回 undefined", () => {
  assert.equal(lspLangForPath("a.py")?.id, "pyright");
  assert.equal(lspLangForPath("a.tsx")?.id, "tsls");
  assert.equal(lspLangForPath("a.rb"), undefined);
  assert.equal(lspLangForPath("a.md"), undefined);
});

test("Python (pyright)：documentSymbols / references / definition / hover", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-lsp-"));
  const client = new LspClient(wd);
  try {
    // L1: def add   L2: return   L4: result = add(1, 2)
    writeFileSync(resolve(wd, "m.py"), "def add(a, b):\n    return a + b\n\nresult = add(1, 2)\n", "utf8");

    const syms = await client.documentSymbols("m.py");
    assert.ok(syms, "pyright 应可用");
    assert.ok(syms!.some((s) => s.name === "add"), "应含符号 add");

    // 'add' 定义在 L1 第 5 列（def␣add）→ references 含定义 + 调用点 = 2
    const refs = await client.references("m.py", 1, 5);
    assert.ok(refs && refs.length >= 2, `references(add) 应≥2，实际 ${refs?.length}`);

    // 在调用点 L4 'add' 上求定义 → 指向 L1
    const def = await client.definition("m.py", 4, 10);
    assert.ok(def && def.some((d) => d.startLine === 1), "definition 应指向 L1");

    const hov = await client.hover("m.py", 1, 5);
    assert.ok(typeof hov === "string", "hover 返回字符串");
  } finally {
    await client.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});

test("跨文件 references：预热后能找到另一文件里的调用点", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-lsp-x-"));
  const client = new LspClient(wd);
  try {
    // 定义在 lib.py，调用在 app.py（另一个文件）
    writeFileSync(resolve(wd, "lib.py"), "def helper(x):\n    return x * 2\n", "utf8");
    writeFileSync(resolve(wd, "app.py"), "from lib import helper\n\ny = helper(10)\n", "utf8");
    // 在定义处（lib.py L1 'helper' 第 5 列）查引用 → 应含定义 + app.py 的调用 = 2
    const refs = await client.references("lib.py", 1, 5);
    assert.ok(refs, "pyright 应可用");
    assert.ok(refs!.length >= 2, `跨文件 references 应≥2，实际 ${refs?.length}`);
    assert.ok(refs!.some((r) => r.path === "app.py"), "应找到 app.py 里的调用点");
  } finally {
    await client.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});

test("didChange 后诊断反映新内容（编辑后自检的基础）", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-lsp-chg-"));
  const client = new LspClient(wd);
  try {
    writeFileSync(resolve(wd, "m.py"), "def f(x):\n    return x + 1\n", "utf8");
    const before = await client.diagnostics("m.py"); // 先打开（clean）
    assert.ok(before && !before.some((d) => d.severity === "error"), "干净文件无 error");
    // 编辑文件引入未定义变量
    writeFileSync(resolve(wd, "m.py"), "def f(x):\n    return undefined_y\n", "utf8");
    await client.didChange("m.py"); // 不发 didChange 的话 server 仍持旧内容
    const after = await client.diagnostics("m.py");
    assert.ok(after && after.some((d) => d.severity === "error"), "didChange 后应报出新引入的 error");
  } finally {
    await client.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});

test("无对应 server 的文件类型 → 优雅降级（undefined）", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-lsp-"));
  const client = new LspClient(wd);
  try {
    writeFileSync(resolve(wd, "a.rb"), "def foo; end\n", "utf8");
    assert.equal(await client.documentSymbols("a.rb"), undefined);
    assert.equal(await client.definition("a.rb", 1, 1), undefined);
  } finally {
    await client.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});
