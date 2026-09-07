import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { makeFsTools } from "../src/tools/fs-tools.js";

/** 建一个 base 目录，内含 workdir 子目录 + 一个 workdir 外的兄弟文件。 */
function setup() {
  const base = mkdtempSync(resolve(tmpdir(), "forge-fs-"));
  const wd = resolve(base, "wd");
  mkdirSync(wd, { recursive: true });
  writeFileSync(resolve(base, "secret.txt"), "TOP SECRET\nline2", "utf8");
  writeFileSync(resolve(wd, "inside.txt"), "hello inside", "utf8");
  return { base, wd };
}

const findTool = (tools: AgentTool[], name: string) =>
  tools.find((t) => t.name === name) as AgentTool & { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> };

const textOf = (r: { content: { text: string }[] }) => r.content[0].text;

test("默认（allowReadOutside=false）：read_file 读 workdir 内 OK，越界报错", async () => {
  const { base, wd } = setup();
  try {
    const read = findTool(makeFsTools(wd, false), "read_file");
    assert.match(textOf(await read.execute("1", { path: "inside.txt" })), /hello inside/);
    await assert.rejects(() => read.execute("2", { path: "../secret.txt" }), /路径越界/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowReadOutside=true：read_file 可读 workdir 外的文件", async () => {
  const { base, wd } = setup();
  try {
    const read = findTool(makeFsTools(wd, true), "read_file");
    const out = textOf(await read.execute("1", { path: "../secret.txt" }));
    assert.match(out, /TOP SECRET/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowReadOutside=true：写工具仍锁死 workdir（越界写被拒）", async () => {
  const { base, wd } = setup();
  try {
    const write = findTool(makeFsTools(wd, true), "write_file");
    await assert.rejects(() => write.execute("1", { path: "../evil.txt", content: "x" }), /路径越界/);
    // 确认没写出去
    assert.throws(() => readFileSync(resolve(base, "evil.txt"), "utf8"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allowReadOutside=true：edit_file 越界同样被拒（写恒锁 workdir）", async () => {
  const { base, wd } = setup();
  try {
    const edit = findTool(makeFsTools(wd, true), "edit_file");
    await assert.rejects(() => edit.execute("1", { path: "../secret.txt", old_string: "TOP", new_string: "X" }), /路径越界/);
    assert.equal(readFileSync(resolve(base, "secret.txt"), "utf8").startsWith("TOP SECRET"), true); // 未被改
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
