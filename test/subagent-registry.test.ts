import { test } from "node:test";
import assert from "node:assert/strict";
import { SubAgentRegistry, type SubAgentRunLoop } from "../src/kernel/subagent-registry.js";
import type { SubAgentResult } from "../src/tools/subagent.js";

/** 可手动 resolve/reject 的 promise，用于精确控制子 agent 循环何时结束。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让已排队的微任务（spawn 内 IIFE 的 finally / onResume）跑完。 */
const flush = () => new Promise((r) => setImmediate(r));

const ok = (over: Partial<SubAgentResult> = {}): SubAgentResult => ({ text: "结论", turns: 1, tools: 0, hitLimit: false, ...over });

test("spawn 返回递增 id 并立刻处于 running", async () => {
  const d = deferred<SubAgentResult>();
  const reg = new SubAgentRegistry({ runLoop: () => d.promise });
  const id1 = reg.spawn("researcher", "查一下", undefined);
  const id2 = reg.spawn("analyst", "再查", undefined);
  assert.equal(id1, "s1");
  assert.equal(id2, "s2");
  assert.deepEqual(reg.list().map((x) => x.status), ["running", "running"]);
  d.resolve(ok());
  await flush();
});

test("runLoop 完成 → 状态 done + 结论喂回主 agent（含轮数/工具数）", async () => {
  const resumes: string[] = [];
  const d = deferred<SubAgentResult>();
  const reg = new SubAgentRegistry({ runLoop: () => d.promise, onResume: (t) => resumes.push(t) });
  const id = reg.spawn("researcher", "调研 X", undefined);
  assert.equal(reg.list()[0].status, "running");
  assert.equal(resumes.length, 0); // running 期间不喂回

  d.resolve(ok({ text: "X 的答案是 42", turns: 3, tools: 5 }));
  await flush();

  assert.equal(reg.list()[0].status, "done");
  assert.equal(resumes.length, 1);
  assert.match(resumes[0], new RegExp(`后台子 Agent ${id}（researcher）完成`));
  assert.match(resumes[0], /用 3 轮 \/ 5 工具/);
  assert.match(resumes[0], /X 的答案是 42/);
});

test("达上限的结论喂回带「达上限截断」标记", async () => {
  const resumes: string[] = [];
  const d = deferred<SubAgentResult>();
  const reg = new SubAgentRegistry({ runLoop: () => d.promise, onResume: (t) => resumes.push(t) });
  reg.spawn("worker", "干活", 5);
  d.resolve(ok({ hitLimit: true, turns: 5 }));
  await flush();
  assert.match(resumes[0], /· 达上限截断/);
});

test("runLoop 抛错 → 状态 failed + 记审计 + 失败结论喂回", async () => {
  const resumes: string[] = [];
  const errors: string[] = [];
  const d = deferred<SubAgentResult>();
  const reg = new SubAgentRegistry({
    runLoop: () => d.promise,
    onResume: (t) => resumes.push(t),
    onError: (role, msg) => errors.push(`${role}:${msg}`),
  });
  reg.spawn("researcher", "会炸的任务", undefined);
  d.reject(new Error("boom"));
  await flush();

  assert.equal(reg.list()[0].status, "failed");
  assert.deepEqual(errors, ["researcher:boom"]);
  assert.equal(resumes.length, 1);
  assert.match(resumes[0], /失败/);
  assert.match(resumes[0], /\(子 agent 失败: boom\)/);
});

test("cancel：撤销 running → 状态 cancelled，且不喂回主 agent", async () => {
  const resumes: string[] = [];
  // runLoop 跑到一半被 abort：等到 signal.aborted 后再 resolve（模拟子 harness 收到 abort 后收尾）。
  const runLoop: SubAgentRunLoop = (_r, _t, _m, signal) =>
    new Promise((resolve) => signal.addEventListener("abort", () => resolve(ok({ text: "（已被撤销）" })), { once: true }));
  const reg = new SubAgentRegistry({ runLoop, onResume: (t) => resumes.push(t) });
  const id = reg.spawn("researcher", "长任务", undefined);

  const msg = reg.cancel(id);
  assert.match(msg, /已请求撤销/);
  await flush();

  assert.equal(reg.list()[0].status, "cancelled");
  assert.equal(resumes.length, 0); // cancelled 不喂回
});

test("cancel：未知 id / 已结束的 agent → 给出可读提示，不抛错", async () => {
  const d = deferred<SubAgentResult>();
  const reg = new SubAgentRegistry({ runLoop: () => d.promise });
  assert.match(reg.cancel("s99"), /无此子 agent/);

  const id = reg.spawn("worker", "干活", undefined);
  d.resolve(ok());
  await flush();
  assert.match(reg.cancel(id), /已 done，无需撤销/);
});

test("list 快照：状态 / 轮数 / 工具数 / 已运行秒数 / 最近 3 条日志", async () => {
  let clock = 1000;
  const d = deferred<SubAgentResult>();
  // runLoop 原地推进 rec（模拟 turn_end / tool_execution_start 的副作用）。
  const runLoop: SubAgentRunLoop = (_r, _t, _m, _s, rec) => {
    rec.turns = 4;
    rec.tools = 2;
    rec.log = ["a", "b", "c", "d"]; // 应只取最近 3 条
    return d.promise;
  };
  const reg = new SubAgentRegistry({ runLoop, now: () => clock });
  reg.spawn("researcher", "调研", undefined); // startedAt = 1000
  clock = 8000; // 运行 7s

  const [snap] = reg.list();
  assert.equal(snap.status, "running");
  assert.equal(snap.turns, 4);
  assert.equal(snap.tools, 2);
  assert.equal(snap.elapsedSec, 7);
  assert.deepEqual(snap.recentLog, ["b", "c", "d"]);

  d.resolve(ok());
  await flush();
  // 已结束：elapsed 用 endedAt（=resolve 时的 clock 8000）而非继续累加
  clock = 99999;
  assert.equal(reg.list()[0].elapsedSec, 7);
});

test("onStatus：有 running 时聚合成一行，全部结束后归零(null)", async () => {
  let clock = 0;
  const statuses: (string | null)[] = [];
  const d1 = deferred<SubAgentResult>();
  const d2 = deferred<SubAgentResult>();
  const queue = [d1.promise, d2.promise];
  const reg = new SubAgentRegistry({
    runLoop: () => queue.shift()!,
    onStatus: (m) => statuses.push(m),
    now: () => clock,
  });
  reg.spawn("a", "t1", undefined);
  reg.spawn("b", "t2", undefined);

  const lastRunning = statuses[statuses.length - 1];
  assert.match(String(lastRunning), /↳ 2 subagent\(s\)/);
  assert.match(String(lastRunning), /s1\[a\]/);
  assert.match(String(lastRunning), /s2\[b\]/);

  d1.resolve(ok());
  d2.resolve(ok());
  await flush();
  assert.equal(statuses[statuses.length - 1], null); // 全结束 → null
});

test("abortAllRunning：只 abort 仍在 running 的，已结束的不再翻状态", async () => {
  const fastDone = deferred<SubAgentResult>();
  // role==="fast" 用受控 deferred 秒完成；其余挂着直到收到 abort 才收尾。
  const runLoop: SubAgentRunLoop = (role, _t, _m, signal) =>
    role === "fast"
      ? fastDone.promise
      : new Promise((resolve) => signal.addEventListener("abort", () => resolve(ok()), { once: true }));
  const reg = new SubAgentRegistry({ runLoop });

  reg.spawn("fast", "秒完成", undefined); // s1
  fastDone.resolve(ok());
  await flush(); // s1 → done

  reg.spawn("long", "挂着", undefined); // s2，running
  reg.abortAllRunning();
  await flush();

  const byId = new Map(reg.list().map((x) => [x.id, x.status]));
  assert.equal(byId.get("s1"), "done"); // 已结束的不受影响
  assert.equal(byId.get("s2"), "cancelled"); // running 的被撤销
});
