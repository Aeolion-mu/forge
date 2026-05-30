import { test } from "node:test";
import assert from "node:assert/strict";
import { ctrlCAction } from "../src/ui/keybinds.js";

const base = { confirm: false, running: false, hasInput: false, armedRecently: false };

test("确认提示中 → 拒绝（优先级最高）", () => {
  assert.equal(ctrlCAction({ ...base, confirm: true, running: true, hasInput: true }), "deny");
});

test("运行中（思考/工具/压缩）→ 中止，而非退出", () => {
  assert.equal(ctrlCAction({ ...base, running: true, hasInput: true }), "abort");
});

test("有输入且空闲 → 清空输入", () => {
  assert.equal(ctrlCAction({ ...base, hasInput: true }), "clear");
});

test("空输入首次 → 武装（提示再按）", () => {
  assert.equal(ctrlCAction({ ...base }), "arm");
});

test("空输入且刚按过 → 退出", () => {
  assert.equal(ctrlCAction({ ...base, armedRecently: true }), "exit");
});

test("运行中优先于「刚武装」——不会误退出", () => {
  assert.equal(ctrlCAction({ ...base, running: true, armedRecently: true }), "abort");
});
