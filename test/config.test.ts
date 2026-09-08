import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfigFile, applyDotEnvText, globalConfigDir } from "../src/config.js";

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

// ── sandbox 段（B 阶段重构后的形状校验）──────────────────────────────────
import { defaultReadDeny, defaultWritePaths } from "../src/sandbox/policy.js";
import { homedir } from "node:os";

test("sandbox：readDeny / excluded 字段校验", () => {
  const c = validateConfigFile({
    sandbox: {
      enabled: false,
      network: false,
      writePaths: ["/data"],
      readDeny: ["~/.ssh"],
      excluded: ["brew", "swift"],
      memMax: "4G",
      pidsMax: 128,
    },
  });
  assert.deepEqual(c.sandbox, {
    enabled: false,
    network: false,
    writePaths: ["/data"],
    readDeny: ["~/.ssh"],
    excluded: ["brew", "swift"],
    memMax: "4G",
    pidsMax: 128,
  });
  assert.throws(() => validateConfigFile({ sandbox: { readDeny: "x" } }), /sandbox\.readDeny 应为字符串数组/);
  assert.throws(() => validateConfigFile({ sandbox: { excluded: [1] } }), /sandbox\.excluded 应为字符串数组/);
  assert.throws(() => validateConfigFile({ sandbox: [1] }), /sandbox 应为对象/);
});

test("sandbox 默认策略：writePaths 不含 ~/.config；readDeny 默认盖 ~/.ssh/.aws/.gnupg", () => {
  const home = homedir();
  const writePaths = defaultWritePaths(home);
  assert.ok(!writePaths.includes(`${home}/.config`), "旧默认的 ~/.config 已收紧（显式配置才可写）");
  assert.deepEqual(defaultReadDeny(home), [`${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`]);
});

test("applyDotEnvText：解析 KEY=VAL、注释/空行/无等号跳过、已有值不覆盖（cwd 先于全局兜底的机制）", () => {
  const env: Record<string, string | undefined> = { SHELL_SET: "from-shell" };
  applyDotEnvText("# 注释\n\nFOO=bar\n SPACED = spaced \nno-eq-line\nSHELL_SET=from-file\nEMPTY=\n", env);
  assert.equal(env.FOO, "bar");
  assert.equal(env.SPACED, "spaced");
  assert.equal(env.SHELL_SET, "from-shell", "已存在的值不被文件覆盖");
  assert.equal(env.EMPTY, "", "空值也写入（覆盖语义：undefined/空串都算未设）");
  assert.equal("no-eq-line" in env, false);
});

test("globalConfigDir：默认 ~/.forge，FORGE_GLOBAL_DIR 可覆盖（全局兜底的定位）", () => {
  const prev = process.env.FORGE_GLOBAL_DIR;
  try {
    delete process.env.FORGE_GLOBAL_DIR;
    assert.ok(globalConfigDir().endsWith("/.forge"), globalConfigDir());
    process.env.FORGE_GLOBAL_DIR = "/tmp/forge-test-global";
    assert.equal(globalConfigDir(), "/tmp/forge-test-global");
  } finally {
    if (prev === undefined) delete process.env.FORGE_GLOBAL_DIR;
    else process.env.FORGE_GLOBAL_DIR = prev;
  }
});
