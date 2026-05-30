import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { formatDiagnostics, makeDiagnosticsTool } from "../src/tools/diagnostics.js";
import { LspClient, type LspDiagnostic } from "../src/kernel/lsp-client.js";

test("formatDiagnostics：无诊断 / 计数 + 按行排序", () => {
  assert.match(formatDiagnostics("a.py", []), /✓ 无诊断/);
  const d: LspDiagnostic[] = [
    { line: 10, severity: "warning", message: "unused", code: "W1" },
    { line: 3, severity: "error", message: "undefined name" },
  ];
  const out = formatDiagnostics("a.py", d);
  assert.match(out, /a\.py · 1 error \/ 1 warning/);
  // 按行排序：L3 在 L10 前
  assert.ok(out.indexOf("L3") < out.indexOf("L10"));
  assert.match(out, /L10\twarning unused \[W1\]/);
});

const findExec = (t: AgentTool) =>
  t as AgentTool & {
    execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details: { ok: boolean; source: string } }>;
  };

test("diagnostics 工具：pyright 抓出未定义变量（error）", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-diag-"));
  const lsp = new LspClient(wd);
  try {
    writeFileSync(resolve(wd, "bad.py"), "def f():\n    return undefined_name\n", "utf8");
    const r = await findExec(makeDiagnosticsTool(wd, lsp)).execute("1", { path: "bad.py" });
    assert.equal(r.details.source, "lsp");
    assert.equal(r.details.ok, false, "有 error → ok=false");
    assert.match(r.content[0].text, /error/);
    assert.match(r.content[0].text, /undefined_name|not defined|undefined/i);
  } finally {
    await lsp.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});

test("diagnostics 工具：clean 文件无 error（ok=true）", async () => {
  const wd = mkdtempSync(resolve(tmpdir(), "forge-diag-"));
  const lsp = new LspClient(wd);
  try {
    writeFileSync(resolve(wd, "ok.py"), "def f(x):\n    return x + 1\n", "utf8");
    const r = await findExec(makeDiagnosticsTool(wd, lsp)).execute("1", { path: "ok.py" });
    assert.equal(r.details.source, "lsp");
    assert.equal(r.details.ok, true);
  } finally {
    await lsp.dispose();
    rmSync(wd, { recursive: true, force: true });
  }
});
