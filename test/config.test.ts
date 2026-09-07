import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfigFile } from "../src/config.js";

test("合法配置原样通过", () => {
  const c = validateConfigFile({
    defaultModel: "deepseek/deepseek-v4-pro",
    models: [{ ref: "a/b", label: "B" }],
    maxRetries: 4,
    reserveTokens: 16384,
  });
  assert.equal(c.defaultModel, "deepseek/deepseek-v4-pro");
  assert.equal(c.maxRetries, 4);
  assert.equal(c.models?.[0].ref, "a/b");
});

test("空对象合法（全用默认）", () => {
  assert.deepEqual(validateConfigFile({}), {});
});

test("顶层非对象 → 抛错", () => {
  assert.throws(() => validateConfigFile([1, 2, 3]), /顶层应是一个 JSON 对象/);
  assert.throws(() => validateConfigFile("nope"), /顶层应是一个 JSON 对象/);
});

test("字段类型错误 → 抛错且列出具体问题", () => {
  assert.throws(() => validateConfigFile({ maxRetries: "lots" }), /maxRetries 应为非负数字/);
  assert.throws(() => validateConfigFile({ defaultModel: "" }), /defaultModel 应为非空字符串/);
  assert.throws(() => validateConfigFile({ maxRetries: -1 }), /maxRetries 应为非负数字/);
});

test("models 形状错误 → 抛错", () => {
  assert.throws(() => validateConfigFile({ models: "x" }), /models 应为数组/);
  assert.throws(() => validateConfigFile({ models: [{ ref: "a" }] }), /models\[0\] 应含字符串字段 ref 与 label/);
});

test("maxContextTokens 必须是非负数字", () => {
  assert.equal(validateConfigFile({ maxContextTokens: 200000 }).maxContextTokens, 200000);
  assert.throws(() => validateConfigFile({ maxContextTokens: -1 }), /maxContextTokens 应为非负数字/);
  assert.throws(() => validateConfigFile({ maxContextTokens: "big" }), /maxContextTokens 应为非负数字/);
});

test("allowReadOutsideWorkdir 必须是布尔", () => {
  assert.equal(validateConfigFile({ allowReadOutsideWorkdir: true }).allowReadOutsideWorkdir, true);
  assert.throws(() => validateConfigFile({ allowReadOutsideWorkdir: "yes" }), /allowReadOutsideWorkdir 应为布尔值/);
});

test("pricing：合法的定价表通过；字段缺失/负数 → 抛错", () => {
  const c = validateConfigFile({
    pricing: { "deepseek/deepseek-v4-pro": { cacheHit: 0.025, miss: 3, output: 6 } },
  });
  assert.deepEqual(c.pricing?.["deepseek/deepseek-v4-pro"], { cacheHit: 0.025, miss: 3, output: 6 });
  assert.throws(() => validateConfigFile({ pricing: [1, 2] }), /pricing 应为对象/);
  assert.throws(() => validateConfigFile({ pricing: { "a/b": { cacheHit: 1, miss: 1 } } }), /pricing\["a\/b"\] 应含非负数字字段/);
  assert.throws(() => validateConfigFile({ pricing: { "a/b": { cacheHit: -1, miss: 1, output: 1 } } }), /pricing\["a\/b"\] 应含非负数字字段/);
});

test("ssh：合法档案通过；缺 host / 端口越界 / 非对象 → 抛错", () => {
  const c = validateConfigFile({
    ssh: { deploy: { host: "1.2.3.4", user: "ubuntu", port: 2222, key: "~/.ssh/id_ed25519" } },
  });
  assert.deepEqual(c.ssh?.deploy, { host: "1.2.3.4", user: "ubuntu", port: 2222, key: "~/.ssh/id_ed25519" });
  // 仅 host 也合法
  assert.deepEqual(validateConfigFile({ ssh: { h: { host: "x" } } }).ssh?.h, { host: "x" });
  assert.throws(() => validateConfigFile({ ssh: [1] }), /ssh 应为对象/);
  assert.throws(() => validateConfigFile({ ssh: { bad: { user: "u" } } }), /ssh\["bad"\]\.host 应为非空字符串/);
  assert.throws(() => validateConfigFile({ ssh: { bad: { host: "h", port: 0 } } }), /ssh\["bad"\]\.port 应为 1-65535/);
  assert.throws(() => validateConfigFile({ ssh: { bad: { host: "h", port: 70000 } } }), /ssh\["bad"\]\.port 应为 1-65535/);
});

test("ssh：password 是合法字段（内网密码认证）；未知字段仍报错（防「配了却静默失效」）", () => {
  // password 现在被接受（走 SSH_ASKPASS）
  assert.deepEqual(validateConfigFile({ ssh: { target: { host: "h", user: "root", password: "p@$$!&^" } } }).ssh?.target, {
    host: "h",
    user: "root",
    password: "p@$$!&^",
  });
  assert.throws(() => validateConfigFile({ ssh: { t: { host: "h", password: 123 } } }), /password 应为字符串/);
  // 未知字段仍报错
  assert.throws(() => validateConfigFile({ ssh: { t: { host: "h", foo: 1, bar: 2 } } }), /未知字段 foo, bar/);
  // key 档案照常
  assert.deepEqual(validateConfigFile({ ssh: { t: { host: "h", key: "~/.ssh/id_ed25519" } } }).ssh?.t, {
    host: "h",
    key: "~/.ssh/id_ed25519",
  });
});

test("未知字段被忽略（前向兼容）", () => {
  const c = validateConfigFile({ futureFlag: true, defaultModel: "a/b" });
  assert.equal((c as Record<string, unknown>).futureFlag, undefined);
  assert.equal(c.defaultModel, "a/b");
});
