import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { makeApplyPatchTool } from "../src/tools/apply-patch.js";

const exec = (t: AgentTool) =>
  t as AgentTool & { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details: { files: number } }> };

function wd() {
  return mkdtempSync(resolve(tmpdir(), "forge-ap-"));
}

test("Add File（LF）", async () => {
  const w = wd();
  try {
    const r = await exec(makeApplyPatchTool(w)).execute("1", {
      patch: "*** Begin Patch\n*** Add File: a.txt\n+hello\n+world\n*** End Patch",
    });
    assert.equal(r.details.files, 1);
    assert.equal(readFileSync(resolve(w, "a.txt"), "utf8"), "hello\nworld");
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("Add File（CRLF）—— 回归：之前 \\r 导致解析失败", async () => {
  const w = wd();
  try {
    const r = await exec(makeApplyPatchTool(w)).execute("1", {
      patch: "*** Begin Patch\r\n*** Add File: b.txt\r\n+hello\r\n+world\r\n*** End Patch\r\n",
    });
    assert.equal(r.details.files, 1);
    // 内容不应残留 \r
    assert.equal(readFileSync(resolve(w, "b.txt"), "utf8"), "hello\nworld");
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("Update File：按上下文定位替换（CRLF）", async () => {
  const w = wd();
  try {
    writeFileSync(resolve(w, "d.txt"), "line1\nline2\nline3\n", "utf8");
    await exec(makeApplyPatchTool(w)).execute("1", {
      patch: "*** Begin Patch\r\n*** Update File: d.txt\r\n@@\r\n line1\r\n-line2\r\n+LINE2\r\n line3\r\n*** End Patch\r\n",
    });
    assert.match(readFileSync(resolve(w, "d.txt"), "utf8"), /line1\nLINE2\nline3/);
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("Delete File", async () => {
  const w = wd();
  try {
    writeFileSync(resolve(w, "c.txt"), "bye", "utf8");
    await exec(makeApplyPatchTool(w)).execute("1", { patch: "*** Delete File: c.txt\n" });
    assert.equal(existsSync(resolve(w, "c.txt")), false);
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("无文件标记 → 抛错", async () => {
  const w = wd();
  try {
    await assert.rejects(() => exec(makeApplyPatchTool(w)).execute("1", { patch: "just some text\n+nope" }), /未解析到文件操作/);
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});
