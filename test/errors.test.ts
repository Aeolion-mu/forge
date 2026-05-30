import { test } from "node:test";
import assert from "node:assert/strict";
import { explainApiError } from "../src/kernel/errors.js";

test("致命错误：认证 / 额度 / 请求非法 → transient=false", () => {
  assert.equal(explainApiError({ status: 401 }).transient, false);
  assert.equal(explainApiError({ status: 403 }).transient, false);
  assert.equal(explainApiError({ status: 402 }).transient, false);
  assert.equal(explainApiError({ status: 400, message: "bad" }).transient, false);
  assert.equal(explainApiError({ status: 422 }).transient, false);
});

test("瞬时错误：限流 / 5xx → transient=true", () => {
  assert.equal(explainApiError({ status: 429 }).transient, true);
  assert.equal(explainApiError({ status: 500 }).transient, true);
  assert.equal(explainApiError({ status: 503 }).transient, true);
  assert.equal(explainApiError({ statusCode: 502 }).transient, true); // 兼容 statusCode 字段
});

test("瞬时错误：网络 / 超时（无状态码，靠 code/message 识别）", () => {
  assert.equal(explainApiError({ code: "ETIMEDOUT" }).transient, true);
  assert.equal(explainApiError({ code: "ECONNRESET" }).transient, true);
  assert.equal(explainApiError(new Error("socket hang up")).transient, true);
  assert.equal(explainApiError(new Error("request timed out")).transient, true);
});

test("未知错误默认按致命处理，并带原始消息", () => {
  const ex = explainApiError(new Error("weird boom"));
  assert.equal(ex.transient, false);
  assert.match(ex.message, /weird boom/);
});

test("response.status 嵌套也能识别", () => {
  assert.equal(explainApiError({ response: { status: 429 } }).transient, true);
});
