import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunQueue } from "../src/ui/run-queue.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setImmediate(r));

test("单条 enqueue 立即执行", async () => {
  const seen: string[] = [];
  const q = createRunQueue(async (t) => {
    seen.push(t);
  });
  q.enqueue("hello");
  await flush();
  assert.deepEqual(seen, ["hello"]);
  assert.equal(q.running, false);
  assert.equal(q.pending, 0);
});

test("串行：跑的过程中入队的排队，一次只跑一个，FIFO", async () => {
  const order: string[] = [];
  const gates = [deferred(), deferred(), deferred()];
  let i = 0;
  const q = createRunQueue(async (t) => {
    order.push(`start:${t}`);
    await gates[i++].promise;
    order.push(`end:${t}`);
  });

  q.enqueue("a");
  q.enqueue("b");
  q.enqueue("c");
  await flush();

  // 只有 a 在跑，b/c 排队
  assert.equal(q.running, true);
  assert.equal(q.pending, 2);
  assert.deepEqual(order, ["start:a"]);

  gates[0].resolve();
  await flush();
  assert.deepEqual(order, ["start:a", "end:a", "start:b"]);
  assert.equal(q.pending, 1);

  gates[1].resolve();
  await flush();
  gates[2].resolve();
  await flush();
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  assert.equal(q.running, false);
  assert.equal(q.pending, 0);
});

test("某个 run 抛错 → onError 收到，队列继续 drain 下一个", async () => {
  const seen: string[] = [];
  const errs: unknown[] = [];
  const q = createRunQueue(
    async (t) => {
      if (t === "boom") throw new Error("kaboom");
      seen.push(t);
    },
    (e) => errs.push(e),
  );

  q.enqueue("boom");
  q.enqueue("after");
  await flush();
  await flush();

  assert.equal(errs.length, 1);
  assert.match((errs[0] as Error).message, /kaboom/);
  assert.deepEqual(seen, ["after"]); // 错误没卡死队列
  assert.equal(q.running, false);
});

test("无 onError 时 run 抛错也不会卡死后续", async () => {
  const seen: string[] = [];
  const q = createRunQueue(async (t) => {
    if (t === "x") throw new Error("ignored");
    seen.push(t);
  });
  q.enqueue("x");
  q.enqueue("y");
  await flush();
  await flush();
  assert.deepEqual(seen, ["y"]);
});

test("空闲后再 enqueue 能重新启动队列", async () => {
  const seen: string[] = [];
  const q = createRunQueue(async (t) => {
    seen.push(t);
  });
  q.enqueue("1");
  await flush();
  assert.deepEqual(seen, ["1"]);
  q.enqueue("2");
  await flush();
  assert.deepEqual(seen, ["1", "2"]);
});

test("submit：闲时作为新 run 入队（queued），不走 steer", async () => {
  const runs: string[] = [];
  const steers: string[] = [];
  const q = createRunQueue(
    async (t) => {
      runs.push(t);
    },
    undefined,
    (t) => steers.push(t),
  );
  assert.equal(q.submit("hi"), "queued");
  await flush();
  assert.deepEqual(runs, ["hi"]);
  assert.deepEqual(steers, []);
});

test("submit：忙时插话当前 run（steered），不新开 run", async () => {
  const runs: string[] = [];
  const steers: string[] = [];
  const gate = deferred();
  const q = createRunQueue(
    async (t) => {
      runs.push(t);
      await gate.promise;
    },
    undefined,
    (t) => steers.push(t),
  );

  assert.equal(q.submit("task"), "queued"); // 第一条：闲 → 新 run
  await flush();
  assert.equal(q.running, true);

  // run 进行中再提交两条 → 都走 steer，不入 pending、不新开 run
  assert.equal(q.submit("插话1"), "steered");
  assert.equal(q.submit("插话2"), "steered");
  assert.equal(q.pending, 0);
  assert.deepEqual(steers, ["插话1", "插话2"]);
  assert.deepEqual(runs, ["task"]);

  gate.resolve();
  await flush();
  assert.equal(q.running, false);
  assert.deepEqual(runs, ["task"]); // 插话没有变成新 run
});

test("submit：未配置 steer 时忙也退化为排队（queued）", async () => {
  const runs: string[] = [];
  const gate = deferred();
  const q = createRunQueue(async (t) => {
    runs.push(t);
    await gate.promise;
  });
  assert.equal(q.submit("a"), "queued");
  await flush();
  assert.equal(q.submit("b"), "queued"); // 无 steer 回调 → 排队
  assert.equal(q.pending, 1);
  gate.resolve();
  await flush();
  await flush();
  assert.deepEqual(runs, ["a", "b"]);
});
