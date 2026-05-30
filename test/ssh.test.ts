import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { buildSshArgs, expandHome, makeSshTool } from "../src/tools/ssh.js";
import type { SshProfile } from "../src/config.js";

// ── buildSshArgs：强制非交互选项 + 端口/密钥/用户组合 ────────────────────────
test("buildSshArgs：密钥/默认模式带 BatchMode / accept-new / ConnectTimeout，命令为最后一个 argv 元素", () => {
  const args = buildSshArgs({ host: "h" }, "uptime");
  for (const opt of ["BatchMode=yes", "StrictHostKeyChecking=accept-new", "ConnectTimeout=10"]) {
    assert.ok(args.includes(opt), `应含 ${opt}`);
  }
  assert.equal(args.at(-1), "uptime");
  assert.equal(args.at(-2), "h"); // 无 user → 仅 host
});

test("buildSshArgs：user@host + 端口 + 密钥（~ 展开）", () => {
  const p: SshProfile = { host: "1.2.3.4", user: "ubuntu", port: 2222, key: "~/.ssh/id_ed25519" };
  const args = buildSshArgs(p, "systemctl restart demo-bot");
  assert.ok(args.includes("-p") && args[args.indexOf("-p") + 1] === "2222");
  assert.ok(args.includes("-i") && args[args.indexOf("-i") + 1] === `${homedir()}/.ssh/id_ed25519`);
  assert.equal(args.at(-2), "ubuntu@1.2.3.4");
  assert.equal(args.at(-1), "systemctl restart demo-bot"); // 远程命令整体一个 argv，不拆
});

test("buildSshArgs：无端口/密钥时不带 -p / -i（密钥模式仍 BatchMode）", () => {
  const args = buildSshArgs({ host: "h", user: "u" }, "ls");
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("-i"), false);
  assert.ok(args.includes("BatchMode=yes"));
  assert.equal(args.at(-2), "u@h");
});

test("buildSshArgs：密码档案 → 开交互（无 BatchMode）+ 强制密码认证 + 不带 -i", () => {
  const args = buildSshArgs({ host: "h", user: "root", password: "secret" }, "uptime");
  assert.equal(args.includes("BatchMode=yes"), false, "密码模式不能 BatchMode（askpass 要靠提示喂密码）");
  assert.ok(args.includes("PreferredAuthentications=password,keyboard-interactive"));
  assert.ok(args.includes("PubkeyAuthentication=no"));
  assert.equal(args.includes("-i"), false);
  assert.ok(args.includes("StrictHostKeyChecking=accept-new")); // 首连仍不卡
  assert.equal(args.at(-1), "uptime");
});

test("expandHome：仅展开前导 ~，不碰中间的 ~", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/x"), `${homedir()}/x`);
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("rel/~tilde"), "rel/~tilde");
});

// ── makeSshTool：档案解析 ───────────────────────────────────────────────────
test("makeSshTool：未知档案返回可读错误（不抛），列出可用档案", async () => {
  const tool = makeSshTool({ deploy: { host: "h" } });
  const r = await tool.execute("id1", { profile: "nope", command: "ls" } as never);
  const text = (r.content[0] as { text: string }).text;
  assert.match(text, /未知 ssh 档案 "nope"/);
  assert.match(text, /deploy/);
  assert.equal((r.details as { exitCode: number }).exitCode, 127);
});

test("makeSshTool：描述列出可用档案名", () => {
  const tool = makeSshTool({ deploy: { host: "h" }, staging: { host: "h2" } });
  assert.match(tool.description, /deploy/);
  assert.match(tool.description, /staging/);
  assert.equal(tool.name, "ssh_run");
});

test("makeSshTool：零档案时仍可注册，描述与调用都引导去 forge.config.json 配置", async () => {
  const tool = makeSshTool({}); // 常驻可见，未配置
  assert.match(tool.description, /未配置/);
  const r = await tool.execute("id", { profile: "deploy", command: "ls" } as never);
  const text = (r.content[0] as { text: string }).text;
  assert.match(text, /未配置任何 ssh 档案/);
  assert.match(text, /forge\.config\.json/);
  assert.equal((r.details as { exitCode: number }).exitCode, 127);
});
