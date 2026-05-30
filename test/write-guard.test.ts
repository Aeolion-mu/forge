import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWriteGuardPrompt, parseWriteGuardVerdict, WRITE_GUARD_SYSTEM_PROMPT } from "../src/kernel/write-guard.js";

test("parseWriteGuardVerdict：解析 ALLOW / DENY + REASON", () => {
  const a = parseWriteGuardVerdict("VERDICT: ALLOW\nREASON: 只读分析，写到 stdout。");
  assert.equal(a.verdict, "allow");
  assert.match(a.reason, /只读分析/);

  const d = parseWriteGuardVerdict("一些前言\nVERDICT: DENY\nREASON: cp 到 /etc 越界。");
  assert.equal(d.verdict, "deny");
  assert.match(d.reason, /越界/);
});

test("parseWriteGuardVerdict：大小写不敏感、有 VERDICT 无 REASON 也兜底", () => {
  assert.equal(parseWriteGuardVerdict("verdict: deny").verdict, "deny");
  const v = parseWriteGuardVerdict("VERDICT: ALLOW");
  assert.equal(v.verdict, "allow");
  assert.ok(v.reason.length > 0);
});

test("parseWriteGuardVerdict：解析不到裁决 → fail-open 放行", () => {
  for (const t of ["", "模型胡言乱语没给格式", "ALLOW？大概吧"]) {
    assert.equal(parseWriteGuardVerdict(t).verdict, "allow", JSON.stringify(t));
  }
});

test("buildWriteGuardPrompt：命令用 <command> 分隔符字面包裹，带 workdir 与用户指令", () => {
  const p = buildWriteGuardPrompt({
    command: "cd /tmp && echo hi > out.txt",
    workdir: "/work/proj",
    userInstruction: "review 一下 demo 项目",
  });
  assert.match(p, /<command>\ncd \/tmp && echo hi > out\.txt\n<\/command>/);
  assert.match(p, /\/work\/proj/);
  assert.match(p, /review 一下 demo 项目/);
});

test("buildWriteGuardPrompt：用户指令可省略", () => {
  const p = buildWriteGuardPrompt({ command: "ls", workdir: "/w" });
  assert.match(p, /<command>\nls\n<\/command>/);
  assert.doesNotMatch(p, /本轮用户指令/);
});

test("WRITE_GUARD_SYSTEM_PROMPT：含抗注入与「代码里的 > 不是重定向」要点", () => {
  assert.match(WRITE_GUARD_SYSTEM_PROMPT, /分隔符内是/);
  assert.match(WRITE_GUARD_SYSTEM_PROMPT, />.*不是 shell 重定向|不是.*重定向/);
  assert.match(WRITE_GUARD_SYSTEM_PROMPT, /VERDICT/);
});
