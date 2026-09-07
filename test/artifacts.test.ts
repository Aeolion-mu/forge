import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { truncateForContext, saveArtifact, MAX_OUTPUT_CHARS } from "../src/kernel/artifacts.js";

function tmpWorkdir(): string {
  return mkdtempSync(resolve(tmpdir(), "forge-artifacts-"));
}

test("短输出原样返回，不截断、不落 artifact", () => {
  const wd = tmpWorkdir();
  try {
    const r = truncateForContext("hello world", { workdir: wd, save: false });
    assert.equal(r.truncated, false);
    assert.equal(r.text, "hello world");
    assert.equal(r.artifact, undefined);
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});

test("超长 + save=true：落 artifact，留首尾 + 指针，总长缩短", () => {
  const wd = tmpWorkdir();
  try {
    const big = "A".repeat(5000) + "MIDDLE_MARKER" + "Z".repeat(5000); // > MAX_OUTPUT_CHARS
    const r = truncateForContext(big, { workdir: wd, save: true });
    assert.equal(r.truncated, true);
    assert.ok(r.artifact, "应返回 artifact 路径");
    assert.match(r.artifact!, /^\.forge\/artifacts\/[0-9a-f]{12}\.txt$/);
    assert.ok(r.text.length < big.length, "截断后应更短");
    assert.ok(r.text.startsWith("A"), "应保留头部");
    assert.ok(r.text.endsWith("Z"), "应保留尾部");
    // 指针应引导用 read_file 按行精准读取该 artifact（offset/limit）
    assert.match(r.text, /read_file.*offset\/limit/);
    assert.ok(r.text.includes(r.artifact!), "指针应含 artifact 路径");
    // artifact 落盘且内容完整
    assert.equal(readFileSync(resolve(wd, r.artifact!), "utf8"), big);
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});

test("超长 + save=false：截断但不落 artifact，指针给 offset 提示", () => {
  const wd = tmpWorkdir();
  try {
    const big = "x".repeat(MAX_OUTPUT_CHARS + 1);
    const r = truncateForContext(big, { workdir: wd, save: false, hint: "用 offset 读 foo.txt" });
    assert.equal(r.truncated, true);
    assert.equal(r.artifact, undefined);
    assert.match(r.text, /用 offset 读 foo\.txt/);
    assert.ok(!existsSync(resolve(wd, ".forge", "artifacts")), "save=false 不应建 artifacts 目录");
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});

test("saveArtifact：内容相同 → hash 相同（确定性，便于去重）", () => {
  const wd = tmpWorkdir();
  try {
    const a = saveArtifact(wd, "same content");
    const b = saveArtifact(wd, "same content");
    assert.equal(a, b);
    assert.equal(readFileSync(resolve(wd, a), "utf8"), "same content");
  } finally {
    rmSync(wd, { recursive: true, force: true });
  }
});
