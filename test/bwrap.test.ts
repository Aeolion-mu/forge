import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildBwrapArgs,
  buildSandboxedCommand,
  memToKiB,
  type SandboxPolicy,
  type SandboxCaps,
} from "../src/sandbox/bwrap.js";

const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/u",
  OPENAI_API_KEY: "sk-secret",
  FOO_TOKEN: "t",
} as NodeJS.ProcessEnv;

test("buildBwrapArgs：只读根 + 可写口 + env 白名单 + chdir，密钥绝不进沙箱", () => {
  const a = buildBwrapArgs("/work", true, ["/work", "/home/u/.cache"], env);
  const s = a.join(" ");
  assert.match(s, /--ro-bind \/ \//); // 只读根
  assert.match(s, /--bind \/work \/work/);
  assert.match(s, /--bind \/home\/u\/\.cache \/home\/u\/\.cache/);
  assert.ok(a.includes("--clearenv"));
  assert.match(s, /--setenv PATH \/usr\/bin:\/bin/); // 白名单放行
  assert.match(s, /--setenv HOME \/home\/u/);
  assert.ok(!s.includes("OPENAI_API_KEY"), "API key 不应进沙箱"); // 黑名单→白名单的核心收益
  assert.ok(!s.includes("FOO_TOKEN"));
  assert.ok(!s.includes("sk-secret"));
  assert.equal(a[a.length - 1], "--"); // 以 -- 收尾，调用方接内层命令
  assert.match(s, /--chdir \/work --$/);
});

test("buildBwrapArgs：network 开关控制 --unshare-net（D1）", () => {
  assert.ok(!buildBwrapArgs("/work", true, ["/work"], env).includes("--unshare-net"), "联网时不应断网");
  assert.ok(buildBwrapArgs("/work", false, ["/work"], env).includes("--unshare-net"), "断网时应 --unshare-net");
});

test("buildBwrapArgs：/tmp 不重复 bind（已由 --tmpfs 提供）", () => {
  const a = buildBwrapArgs("/work", true, ["/work", "/tmp"], env);
  assert.ok(a.includes("--tmpfs"));
  assert.ok(!a.join(" ").includes("--bind /tmp /tmp"));
});

const policy: SandboxPolicy = { enabled: true, network: true, writePaths: ["/tmp"], memMax: "2G", pidsMax: 512 };

test("buildSandboxedCommand：有 systemd → 外层 systemd-run 套 cgroup（D3 优先）", () => {
  const caps: SandboxCaps = { bwrap: true, systemdRun: true };
  const { file, args } = buildSandboxedCommand("echo hi", "/work", policy, caps, ["/work"], env);
  assert.equal(file, "systemd-run");
  const s = args.join(" ");
  assert.match(s, /--user --scope/);
  assert.match(s, /MemoryMax=2G/);
  assert.match(s, /MemorySwapMax=0/); // 关 swap，否则限额会被偷换 swap 绕过
  assert.match(s, /TasksMax=512/);
  assert.match(s, /-- bwrap /); // cgroup 之后才是 bwrap
  assert.equal(args.slice(-3).join(" "), "/bin/sh -c echo hi");
});

test("buildSandboxedCommand：无 systemd → rlimits 回退（D3 fallback）", () => {
  const caps: SandboxCaps = { bwrap: true, systemdRun: false };
  const { file, args } = buildSandboxedCommand("make", "/work", policy, caps, ["/work"], env);
  assert.equal(file, "bwrap");
  const inner = args[args.length - 1]!;
  assert.match(inner, /ulimit -v 2097152/); // 2G → KiB
  assert.match(inner, /ulimit -u 512/);
  assert.match(inner, /make$/);
});

test("buildSandboxedCommand：不限额分支干净（无 ulimit、无 systemd-run）", () => {
  const caps: SandboxCaps = { bwrap: true, systemdRun: false };
  const noLimit: SandboxPolicy = { ...policy, memMax: "", pidsMax: 0 };
  const { file, args } = buildSandboxedCommand("ls", "/work", noLimit, caps, ["/work"], env);
  assert.equal(file, "bwrap");
  assert.equal(args.slice(-3).join(" "), "/bin/sh -c ls");
  assert.ok(!args.join(" ").includes("ulimit"));
});

test("memToKiB：单位解析", () => {
  assert.equal(memToKiB("2G"), 2 * 1024 * 1024);
  assert.equal(memToKiB("512M"), 512 * 1024);
  assert.equal(memToKiB("1024K"), 1024);
  assert.equal(memToKiB("  256M "), 256 * 1024);
  assert.equal(memToKiB("abc"), null);
});
