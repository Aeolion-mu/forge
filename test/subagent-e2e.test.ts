import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeAgent } from "../src/kernel/forge-agent.js";
import { resetModels } from "../src/kernel/models.js";
import type { ForgeConfig } from "../src/config.js";
import { mockProvider, type MockReply } from "./helpers/mock-provider.js";

/**
 * 端到端（无 HTTP / 无真实 key）：mock provider 直出事件流，但整条链路是真的——
 * AgentHarness → Models → lane.prompt → 工具执行 → SubAgentRegistry → steer 注入 → 喂回。
 *
 * 时序控制核心：把子 agent 的**第一次 LLM 调用 park 在 responder 里**（返回一个不 resolve
 * 的 Promise）。此时子 lane 已建好（onSteerReady 已回填 steer 通道），插话可以确定性地
 * 在「子 agent 运行中」送达；再放行首调，插话必然出现在它的下一次 LLM 上下文里。
 */

/** 轮询直到条件成立（超时抛错带 label）。 */
async function waitUntil(label: string, pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitUntil 超时：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 手工构造最小 ForgeConfig（绕过 loadConfig 的 env/文件依赖；模型走 mock provider）。 */
function testConfig(workdir: string): ForgeConfig {
  return {
    modelRef: "mock/main",
    provider: "mock",
    modelId: "main",
    model: {
      id: "main", name: "main", api: "mock" as never, provider: "mock", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192,
    } as ForgeConfig["model"],
    live: true,
    thinkingLevel: "off",
    models: [],
    workdir,
    skillsDirs: [],
    skills: { builtin: false, dirs: [], compat: false, overrides: {} },
    sessionsDir: join(workdir, ".forge-sessions"),
    auditPath: join(workdir, ".forge-audit.jsonl"),
    compaction: { reserveTokens: 16384, keepRecentTokens: 20000 },
    stream: { maxRetries: 1, maxRetryDelayMs: 1000 },
    customModels: [],
    subagentModel: "mock/main",
    pricing: {},
    allowReadOutsideWorkdir: false,
    flightLog: { enabled: false, dir: join(workdir, ".forge-flight"), contextMode: "summary" },
    ssh: {},
    sandbox: { enabled: false, network: false, writePaths: [], readDeny: [], memMax: "", pidsMax: 0, excluded: [] },
  };
}

/** park 用的手动门。 */
function gate() {
  let open = false;
  const waiters: Array<() => void> = [];
  return {
    open: () => {
      open = true;
      waiters.splice(0).forEach((w) => w());
    },
    wait: () => (open ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
  };
}

test("e2e（用户侧 steer）：spawn → 取证 → 插话注入子 agent 上下文 → 结论喂回主 agent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-"));
  writeFileSync(join(dir, "answer.txt"), "answer = 42");

  const subFirstCall = gate(); // 子 agent 首调 park：拿到确定性插话窗口
  let subParked = false;
  const subSecondCtx = { transcript: "", seen: false };
  // 调用计数分支（transcript 嗅探不可靠：喂回消息不含工具名字样，曾致无限重派）。
  let mainCalls = 0;
  let subCalls = 0;

  const { install } = mockProvider("mock/main", (call): MockReply | Promise<MockReply> => {
    if (call.systemPrompt.startsWith("SUBAGENT[")) {
      subCalls += 1;
      if (subCalls === 1) {
        subParked = true; // 此刻子 lane 已建好（onSteerReady 已回填），park 等插话
        return subFirstCall.wait().then(() => ({ toolCalls: [{ name: "read_file", args: { path: join(dir, "answer.txt") } }] }));
      }
      if (!subSecondCtx.seen) {
        subSecondCtx.transcript = call.transcript;
        subSecondCtx.seen = true;
      }
      return { text: "结论：answer=42（已含插话要求）。" };
    }
    mainCalls += 1;
    if (mainCalls === 1) {
      return { toolCalls: [{ name: "spawn_subagent", args: { role: "researcher", task: "调查 answer.txt 的答案并汇报" } }] };
    }
    return { text: "已收到结论，向用户汇报完毕。" };
  });
  install();

  const subEvents: Array<{ id: string; type: string; tool?: string }> = [];
  const resumes: string[] = [];
  let statusPings = 0;
  let agent!: ForgeAgent;
  agent = await ForgeAgent.create(testConfig(dir), {
    autoApprove: true,
    render: false,
    // 模拟 TUI 的串行队列：结论喂回 = 主 agent 的新一轮 run。
    onResume: (t) => {
      resumes.push(t);
      void agent.run(t).catch(() => {});
    },
    onSubAgentEvent: (id, e) => subEvents.push({ id, type: e.type, tool: (e as { toolName?: string }).toolName }),
    onSubStatus: () => (statusPings += 1),
  });

  try {
    // 1) 主 run：spawn 后主 agent 先收尾（子 agent 后台继续）。
    await agent.run("去调查答案");
    await waitUntil("子 agent 出现在注册表", () => agent.listSubAgents().some((x) => x.id === "s1"));
    const early = agent.listSubAgents().find((x) => x.id === "s1")!;
    assert.equal(early.status, "running");
    assert.match(early.task, /answer\.txt/); // 任务原文进快照（TUI transcript 用）
    assert.ok(statusPings > 0, "注册表变化应 ping UI（onSubStatus）");
    await waitUntil("子 agent 首调已 park（steer 通道就绪）", () => subParked);

    // 2) 用户侧插话（TUI 子视图输入 → agent.steerSubAgent → Registry.steer → 子 lane）。
    const steerMsg = agent.steerSubAgent("s1", "顺便确认一下单位");
    assert.match(steerMsg, /已向子 agent s1（researcher）插话/);
    assert.match(agent.listSubAgents().find((x) => x.id === "s1")!.recentLog.join("\n"), /插话: 顺便确认一下单位/);

    // 3) 放行子 agent 首调 → read_file 取证 → 插话在下一次 LLM 调用前注入。
    subFirstCall.open();
    await waitUntil("插话文本出现在子 agent 上下文", () => subSecondCtx.seen);
    assert.match(subSecondCtx.transcript, /顺便确认一下单位/, "插话应作为用户消息注入子 agent 上下文");
    assert.ok(subEvents.some((e) => e.id === "s1" && e.type === "tool_start" && e.tool === "read_file"), "子 agent 事件流应转发（tool_start read_file）");

    // 4) 结论自动喂回主 agent → 主 agent 汇报 → 全部结束、状态行随 running 清空而消失。
    await waitUntil("结论喂回主 agent", () => resumes.length >= 1);
    assert.match(resumes[0]!, /结论：answer=42/);
    await waitUntil("子 agent 状态落定 done", () => agent.listSubAgents().find((x) => x.id === "s1")?.status === "done");
    const done = agent.listSubAgents().find((x) => x.id === "s1")!;
    assert.equal(done.turns, 2); // 取证轮 + 结论轮
    assert.equal(done.tools, 1);
    await waitUntil("主 agent 完成汇报轮", () => resumes.length >= 1 && agent.telemetry.turns >= 3);

    // 5) 已结束的子 agent 拒绝插话。
    assert.match(agent.steerSubAgent("s1", "还在吗"), /已 done，无法插话/);
  } finally {
    await agent.dispose();
    resetModels();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("e2e（主 agent 工具 steer）：subagent_steer 在运行中送达子 agent 上下文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-e2e-tool-"));
  writeFileSync(join(dir, "data.txt"), "v=7");

  const subFirstCall = gate();
  const subParkedGate = gate(); // 主 agent 的 steer 工具调用等它（= steer 通道就绪）再发
  let steerToolIssued = false;
  const subSecondCtx = { transcript: "", seen: false };
  let mainCalls = 0;
  let subCalls = 0;

  const { install } = mockProvider("mock/main", (call): MockReply | Promise<MockReply> => {
    if (call.systemPrompt.startsWith("SUBAGENT[")) {
      subCalls += 1;
      if (subCalls === 1) {
        subParkedGate.open();
        return subFirstCall.wait().then(() => ({ toolCalls: [{ name: "read_file", args: { path: join(dir, "data.txt") } }] }));
      }
      if (!subSecondCtx.seen) {
        subSecondCtx.transcript = call.transcript;
        subSecondCtx.seen = true;
      }
      return { text: "结论：v=7。" };
    }
    mainCalls += 1;
    if (mainCalls === 1) {
      return { toolCalls: [{ name: "spawn_subagent", args: { role: "analyst", task: "读 data.txt" } }] };
    }
    if (mainCalls === 2) {
      // 等 sub park（子 lane 已建、steer 通道已回填）再让主 agent 发起 steer 工具调用。
      return subParkedGate.wait().then(() => {
        steerToolIssued = true;
        return { toolCalls: [{ name: "subagent_steer", args: { id: "s1", message: "把数值精确到小数位" } }] };
      });
    }
    return { text: "收到结论，汇报。" };
  });
  install();

  const resumes: string[] = [];
  let agent!: ForgeAgent;
  agent = await ForgeAgent.create(testConfig(dir), {
    autoApprove: true,
    render: false,
    onResume: (t) => {
      resumes.push(t);
      void agent.run(t).catch(() => {});
    },
  });

  try {
    await agent.run("调查 data.txt");
    // 主 agent 的 steer 工具调用应在子 agent park（steer 通道就绪）后立即发出并执行。
    await waitUntil("主 agent 已发起 steer 工具调用", () => steerToolIssued);
    // steer 工具执行需要一点时间（主 harness 收到工具调用 → 执行 → lane.steer 入队）。
    await new Promise((r) => setTimeout(r, 200));
    subFirstCall.open();

    await waitUntil("插话出现在子 agent 上下文", () => subSecondCtx.seen);
    assert.match(subSecondCtx.transcript, /把数值精确到小数位/, "subagent_steer 的消息应注入子 agent 上下文");
    await waitUntil("结论喂回", () => resumes.length >= 1);
    await waitUntil("done", () => agent.listSubAgents()[0]?.status === "done");
  } finally {
    await agent.dispose();
    resetModels();
    rmSync(dir, { recursive: true, force: true });
  }
});
