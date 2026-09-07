import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultWritePaths, defaultReadDeny, expandHomePaths, headToken, isExcluded, type SandboxPolicy } from "../src/sandbox/policy.js";

test("defaultWritePaths：不含 ~/.config（收紧后的新默认）", () => {
  const p = defaultWritePaths("/home/u");
  assert.deepEqual(p, ["/tmp", "/home/u/.cache", "/home/u/.npm", "/home/u/.cargo"]);
  assert.ok(!p.includes("/home/u/.config"), "~/.config 有 git config --global / gh hosts.yml，回到显式配置才可写");
});

test("defaultReadDeny：SSH 密钥 / 云凭证 / GPG", () => {
  assert.deepEqual(defaultReadDeny("/home/u"), ["/home/u/.ssh", "/home/u/.aws", "/home/u/.gnupg"]);
});

test("expandHomePaths：~ / ~/ 展开，绝对路径原样", () => {
  assert.deepEqual(expandHomePaths(["~", "~/x", "/abs"], "/home/u"), ["/home/u", "/home/u/x", "/abs"]);
});

test("headToken：取首段并剥路径前缀 / env 前缀", () => {
  assert.equal(headToken("brew install x"), "brew");
  assert.equal(headToken("/opt/homebrew/bin/brew install x"), "brew");
  assert.equal(headToken("env FOO=1 swift test"), "swift");
  assert.equal(headToken(""), "");
});

test("isExcluded：豁免名单命中（防沙箱内嵌套沙箱的 brew/swift）", () => {
  const policy: SandboxPolicy = { enabled: true, network: true, writePaths: [], readDeny: [], memMax: "", pidsMax: 0, excluded: ["brew", "swift"] };
  assert.ok(isExcluded("brew install ripgrep", policy));
  assert.ok(isExcluded("/usr/bin/swift test", policy));
  assert.ok(!isExcluded("echo hi", policy));
  assert.ok(!isExcluded("brewfile", policy), "不应子串误命中");
});
