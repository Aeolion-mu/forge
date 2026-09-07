import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readFileSync } from "node:fs";
import { locateSymbol, makeLspTools, applyTextEdits } from "../src/tools/lsp-tools.js";
import { LspClient, type RenameEdit } from "../src/kernel/lsp-client.js";

test("locateSymbol：首个词边界匹配 / 指定行 / 未命中", () => {
  const src = "x = 1\ndef add(a, b):\n    return add\n";
  assert.deepEqual(locateSymbol(src, "add"), { line: 2, col: 5 }); // def␣add → col5
  assert.deepEqual(locateSymbol(src, "add", 3), { line: 3, col: 12 }); // 指定行内 return add
  assert.equal(locateSymbol(src, "nope"), undefined);
  // 词边界：不命中 "address" 里的子串
  assert.equal(locateSymbol("address = 1\n", "add"), undefined);
});

const tool = (tools: AgentTool[], name: string) =>
  tools.find((t) => t.name === name) as AgentTool & {
    execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
  };

test("references/definition 工具：真 pyright 跨调用解析", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-lsptool-"));
  const lsp = new LspClient(wd);
  try {
    writeFileSync(resolve(wd, "m.py"), "def add(a, b):\n    return a + b\n\nr = add(1, 2)\n", "utf8");
    const tools = makeLspTools(wd, lsp, false);

    const refs = await tool(tools, "references").execute("1", { path: "m.py", symbol: "add" });
    assert.equal(refs.details.found, true);
    assert.ok((refs.details.count as number) >= 2, "add 应有≥2 引用");
    assert.match(refs.content[0].text, /m\.py:\d+/);

    // 在调用处求定义（L4）→ 指向 L1
    const def = await tool(tools, "definition").execute("2", { path: "m.py", symbol: "add", line: 4 });
    assert.equal(def.details.found, true);
    assert.match(def.content[0].text, /m\.py:1/);
  } finally {
    await lsp.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});

test("applyTextEdits：多处替换按倒序套用，偏移不串", () => {
  // foo 出现两次（L1 col0、L2 col9），都改成 bar
  const src = "foo = 1\nx = foo + 2\n";
  const edits: RenameEdit[] = [
    { startLine: 0, startCol: 0, endLine: 0, endCol: 3, newText: "bar" },
    { startLine: 1, startCol: 4, endLine: 1, endCol: 7, newText: "bar" },
  ];
  assert.equal(applyTextEdits(src, edits), "bar = 1\nx = bar + 2\n");
});

test("applyTextEdits：CRLF 文件偏移正确", () => {
  const src = "foo = 1\r\nx = foo\r\n";
  const edits: RenameEdit[] = [{ startLine: 1, startCol: 4, endLine: 1, endCol: 7, newText: "bar" }];
  assert.equal(applyTextEdits(src, edits), "foo = 1\r\nx = bar\r\n");
});

test("rename 工具：真 pyright 跨文件改名 + 同步引用", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-rename-"));
  const lsp = new LspClient(wd);
  try {
    writeFileSync(resolve(wd, "lib.py"), "def helper(x):\n    return x\n", "utf8");
    writeFileSync(resolve(wd, "app.py"), "from lib import helper\n\ny = helper(1)\n", "utf8");
    const r = await tool(makeLspTools(wd, lsp, false), "rename").execute("1", {
      path: "lib.py",
      symbol: "helper",
      newName: "assist",
    });
    assert.equal(r.details.found, true);
    assert.ok((r.details.files as number) >= 2, `应跨 ≥2 文件，实际 ${r.details.files}`);
    assert.match(readFileSync(resolve(wd, "lib.py"), "utf8"), /def assist\(/);
    assert.match(readFileSync(resolve(wd, "app.py"), "utf8"), /assist\(1\)/); // 调用点同步改名
    assert.doesNotMatch(readFileSync(resolve(wd, "app.py"), "utf8"), /helper\(/);
  } finally {
    await lsp.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});

test("不支持语言：提示未就绪并建议回退", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-lsptool-"));
  const lsp = new LspClient(wd);
  try {
    writeFileSync(resolve(wd, "a.rb"), "def foo; end\n", "utf8");
    const refs = await tool(makeLspTools(wd, lsp, false), "references").execute("1", { path: "a.rb", symbol: "foo" });
    assert.equal(refs.details.found, false);
    assert.match(refs.content[0].text, /grep|outline/);
  } finally {
    await lsp.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});
