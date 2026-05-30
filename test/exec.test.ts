import { test } from "node:test";
import assert from "node:assert/strict";
import { execSandboxed } from "../src/sandbox/exec.js";

const sleepCmd = process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30";

test("execSandboxed：已 aborted 的 signal → 不 spawn，立即返回 aborted=true（code=130）", async () => {
  const ac = new AbortController();
  ac.abort();
  const t0 = Date.now();
  const r = await execSandboxed(sleepCmd, { cwd: process.cwd(), timeoutMs: 5000, signal: ac.signal });
  // 不应该真去跑 30s sleep，更不应该等到 timeoutMs
  assert.equal(r.aborted, true);
  assert.equal(r.code, 130);
  assert.equal(r.timedOut, false);
  assert.ok(Date.now() - t0 < 500, `expected fast return, got ${Date.now() - t0}ms`);
});

test("execSandboxed：运行中 abort → 立刻 kill 子进程并返回 aborted=true", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  // 200ms 后触发 abort —— 子进程应该被 kill，不会跑满 30s sleep，更不会等 timeoutMs(10s)
  setTimeout(() => ac.abort(), 200);
  const r = await execSandboxed(sleepCmd, { cwd: process.cwd(), timeoutMs: 10000, signal: ac.signal });
  const elapsed = Date.now() - t0;
  assert.equal(r.aborted, true, `expected aborted=true, got ${JSON.stringify(r)}`);
  assert.equal(r.timedOut, false);
  // Windows taskkill 落地有延迟，给宽一点的 5s 上限；正常 <2s
  assert.ok(elapsed < 5000, `expected fast kill, got ${elapsed}ms`);
});

test("execSandboxed：无 signal 时与原行为一致（命令正常跑完）", async () => {
  const cmd = process.platform === "win32" ? "Write-Output hello" : "echo hello";
  const r = await execSandboxed(cmd, { cwd: process.cwd(), timeoutMs: 5000 });
  assert.equal(r.aborted, false);
  assert.equal(r.code, 0);
  assert.match(r.out, /hello/);
});
