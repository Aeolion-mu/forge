import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCommands, menuShouldOpen, resolveSubmitted, COMMANDS } from "../src/ui/commands.js";

test("matchCommands：非斜杠输入 → 空（非菜单态）", () => {
  assert.deepEqual(matchCommands("hello"), []);
  assert.deepEqual(matchCommands(""), []);
});

test("matchCommands：单个 / 列全部命令", () => {
  assert.equal(matchCommands("/").length, COMMANDS.length);
});

test("matchCommands：子串模糊匹配（不限前缀）", () => {
  assert.deepEqual(matchCommands("/comp").map((c) => c.name), ["/compact"]);
  // "skill" 命中 /skills；"s" 命中 /skills + /stats + /pass-permissions(permissionS) 等含 s 的
  assert.deepEqual(matchCommands("/skil").map((c) => c.name), ["/skills"]);
  assert.deepEqual(matchCommands("/zzz"), []);
});

test("menuShouldOpen：有候选则开；精确补全到唯一首项则收起", () => {
  assert.equal(menuShouldOpen("/comp"), true);
  assert.equal(menuShouldOpen("/compact"), false); // 已精确 = 首项 → 收起
  assert.equal(menuShouldOpen("hello"), false);
  assert.equal(menuShouldOpen("/zzz"), false);
});

test("resolveSubmitted：部分斜杠输入 → 用选中项替换", () => {
  assert.equal(resolveSubmitted("/comp", 0), "/compact");
});

test("resolveSubmitted：精确命令原样返回", () => {
  assert.equal(resolveSubmitted("/stats", 0), "/stats");
});

test("resolveSubmitted：选中第 2 项（↑↓ 选择后 Enter）", () => {
  // "/s" 命中多个（含 s 的命令），选 idx=1 取第二个
  const m = matchCommands("/s");
  assert.ok(m.length >= 2);
  assert.equal(resolveSubmitted("/s", 1), m[1].name);
});

test("resolveSubmitted：selIdx 越界被钳制", () => {
  const m = matchCommands("/s");
  assert.equal(resolveSubmitted("/s", 999), m[m.length - 1].name);
  assert.equal(resolveSubmitted("/s", -5), m[0].name);
});

test("resolveSubmitted：普通聊天输入原样 trim 返回", () => {
  assert.equal(resolveSubmitted("  写个测试  ", 0), "写个测试");
});
