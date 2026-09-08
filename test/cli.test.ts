import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs } from "../src/cli.js";

test("parseCliArgs：单/多位置参数进 prompt（回归：曾把首个参数永远丢掉）", () => {
  assert.equal(parseCliArgs(["只回复 ok"]).prompt, "只回复 ok"); // 单参数曾因 off-by-one 静默进 REPL
  assert.equal(parseCliArgs(["把", "README", "里的", "TODO", "列出来"]).prompt, "把 README 里的 TODO 列出来");
  assert.equal(parseCliArgs([]).prompt, "");
});

test("parseCliArgs：--resume 的 id 不进 prompt；--confirm 关默认放行；旗标不进 prompt", () => {
  const a = parseCliArgs(["--resume", "abc123", "干点活"]);
  assert.equal(a.resumeId, "abc123");
  assert.equal(a.prompt, "干点活");
  assert.equal(a.autoApprove, true);
  assert.equal(parseCliArgs(["--confirm", "任务"]).autoApprove, false);
  assert.equal(parseCliArgs(["任务", "--confirm"]).prompt, "任务");
  assert.equal(parseCliArgs(["--resume"]).resumeId, null); // --resume 无值
});
