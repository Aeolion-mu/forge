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

// ── 模型格式变体容忍（实测 glm-5.2 发裸 "Add File:" 无 *** 前缀）──────────
test("裸 Add/Update/Delete File 标记（无 *** 前缀）也能解析 —— 回归：之前直接「未解析到文件操作」", async () => {
  const w = wd();
  try {
    const r = await exec(makeApplyPatchTool(w)).execute("1", {
      patch: "*** Begin Patch\nAdd File: bare-marker.ts\n+export const OK = 1;\n*** End Patch",
    });
    assert.equal(r.details.files, 1);
    assert.equal(readFileSync(resolve(w, "bare-marker.ts"), "utf8"), "export const OK = 1;");
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("markdown 围栏包裹的 patch（```text … ```）被剥离，不当 body", async () => {
  const w = wd();
  try {
    const r = await exec(makeApplyPatchTool(w)).execute("1", {
      patch: "```text\n*** Begin Patch\n*** Add File: fenced.txt\n+inner\n*** End Patch\n```",
    });
    assert.equal(r.details.files, 1);
    assert.equal(readFileSync(resolve(w, "fenced.txt"), "utf8"), "inner");
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});

test("hunk 上下文行里的缩进 \" Update File:\" 不会被误判为标记", async () => {
  const w = wd();
  try {
    // 文件内容恰含疑似标记的文本（无前导空格）；hunk 里它作为上下文行（空格前缀）
    writeFileSync(resolve(w, "u.txt"), "line1\nUpdate File: not-a-marker\nline3\n");
    const r = await exec(makeApplyPatchTool(w)).execute("1", {
      patch: "*** Begin Patch\n*** Update File: u.txt\n@@\n line1\n Update File: not-a-marker\n-line3\n+line3-changed\n*** End Patch",
    });
    assert.equal(r.details.files, 1);
    const after = readFileSync(resolve(w, "u.txt"), "utf8");
    assert.ok(after.includes("Update File: not-a-marker"), "上下文行应原样保留（未被当标记切走）");
    assert.ok(after.includes("line3-changed"), "hunk 的替换照常生效");
  } finally {
    rmSync(w, { recursive: true, force: true });
  }
});
