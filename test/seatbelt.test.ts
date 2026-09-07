import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeatbeltProfile, buildSeatbeltCommand } from "../src/sandbox/seatbelt.js";
import type { SandboxPolicy } from "../src/sandbox/policy.js";

const env = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/u",
  DEEPSEEK_API_KEY: "sk-secret",
  FOO_TOKEN: "t",
} as NodeJS.ProcessEnv;

const policy: SandboxPolicy = { enabled: true, network: true, writePaths: [], readDeny: [], memMax: "", pidsMax: 0, excluded: [] };

test("buildSeatbeltProfile：allow-default + deny 写 + 白名单 subpath + /dev/null 豁免", () => {
  const p = buildSeatbeltProfile({ rwPaths: ["/Users/u/proj", "/private/tmp/forge-x"], readDeny: ["/Users/u/.ssh"], network: true });
  assert.match(p, /\(version 1\)/);
  assert.match(p, /\(allow default\)/); // Bazel 式：对系统漂移免疫
  assert.match(p, /\(deny file-write\*\)/); // 内核级只读根
  assert.match(p, /\(allow file-write\* \(subpath "\/Users\/u\/proj"\)\)/);
  assert.match(p, /\(allow file-write-data \(require-all \(literal "\/dev\/null"\) \(vnode-type CHARACTER-DEVICE\)\)\)/);
  assert.match(p, /\(deny file-read\* \(subpath "\/Users\/u\/\.ssh"\)/); // 读隐藏
  assert.ok(!p.includes("deny network"), "联网时不应有 deny network");
});

test("buildSeatbeltProfile：network=false → deny network*", () => {
  const p = buildSeatbeltProfile({ rwPaths: [], readDeny: [], network: false });
  assert.match(p, /\(deny network\*/);
});

test("buildSeatbeltCommand：env -i 白名单前置（密钥不进沙箱）+ 内层钉 /bin/bash", () => {
  const { file, args } = buildSeatbeltCommand("echo hi", policy, ["/Users/u/proj"], ["/Users/u/.ssh"], env);
  assert.equal(file, "/usr/bin/env");
  assert.equal(args[0], "-i");
  const joined = args.join(" ");
  assert.ok(args.includes("PATH=/usr/bin:/bin"));
  assert.ok(args.includes("HOME=/Users/u"));
  assert.ok(!joined.includes("sk-secret"), "API key 不应进沙箱");
  assert.ok(!joined.includes("DEEPSEEK_API_KEY"));
  assert.ok(joined.includes("/usr/bin/sandbox-exec"));
  assert.ok(joined.includes("/bin/bash -c echo hi"), "内层 shell 钉死 /bin/bash（zsh 5.9 在 Darwin 25 读未放行 sysctl 静默死）");
});

test("buildSeatbeltCommand：pidsMax 经内层 ulimit -u；**永不出现 ulimit -v**（macOS 失效）", () => {
  const withPids: SandboxPolicy = { ...policy, pidsMax: 300 };
  const { args } = buildSeatbeltCommand("make", withPids, [], [], env);
  const joined = args.join(" ");
  assert.match(joined, /ulimit -u 300/);
  assert.ok(!joined.includes("ulimit -v"));
});

test("buildSeatbeltCommand：profile 作为单个 -p 参数传入", () => {
  const { args } = buildSeatbeltCommand("ls", policy, [], [], env);
  const i = args.indexOf("-p");
  assert.ok(i >= 0);
  assert.match(args[i + 1]!, /^\(version 1\)/);
});
