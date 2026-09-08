import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockProvider } from "./helpers/mock-provider.js";
import { ForgeAgent } from "../src/kernel/forge-agent.js";
import type { ForgeConfig } from "../src/config.js";

/**
 * P1 功能测试：skills 索引快照注入 + system prompt 前缀缓存稳定性。
 * 核心 断言是 D1——同一会话内多次 LLM 调用（含磁盘上 memory/skills 变更后）的
 * system prompt 字节相同。旧实现 memory.indexBlock() 每次重读磁盘，本测试即其回归。
 */

function config(workdir: string, over: Partial<ForgeConfig["skills"]> = {}): ForgeConfig {
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
    skillsDirs: [join(workdir, ".forge", "skills")],
    skills: { builtin: false, targets: ["common"], dirs: [], compat: false, indexBudgetTokens: 1500, overrides: {}, ...over },
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

test("P1：skills 索引块注入 system prompt，且会话内字节级稳定（含磁盘变更后）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-p1-"));
  const prevGlobal = process.env.FORGE_GLOBAL_DIR;
  process.env.FORGE_GLOBAL_DIR = join(dir, "home"); // 隔离 ~/.forge（全局 skills/memory）
  try {
    mkdirSync(join(dir, ".forge/skills/triton-basics"), { recursive: true });
    writeFileSync(join(dir, ".forge/skills/triton-basics/SKILL.md"),
      "---\nname: triton-basics\ndescription: Triton kernel 工程基础与调参\n---\n\n正文。", "utf8");
    mkdirSync(join(dir, ".forge/memory"), { recursive: true });
    writeFileSync(join(dir, ".forge/memory/MEMORY.md"), "- proj-note — 项目记忆", "utf8");

    const { install, calls } = mockProvider("mock/main", () => ({ text: "收到。" }));
    install();
    const agent = await ForgeAgent.create(config(dir), { autoApprove: true, render: false });

    await agent.run("第一轮");
    assert.equal(calls.length, 1);
    const sp1 = calls[0]!.systemPrompt;
    assert.match(sp1, /【Skills 索引】/);
    assert.match(sp1, /triton-basics — Triton kernel 工程基础与调参/);
    assert.match(sp1, /【长期记忆索引】/); // memory 索引块同样在
    assert.match(sp1, /proj-note/);

    // 磁盘变更：模拟 memory_write 改索引 + 新增一个 skill 文件（模拟外部动 skills 目录）。
    writeFileSync(join(dir, ".forge/memory/MEMORY.md"), "- proj-note — 项目记忆\n- new-note — 会话中途写入", "utf8");
    mkdirSync(join(dir, ".forge/skills/late-skill"), { recursive: true });
    writeFileSync(join(dir, ".forge/skills/late-skill/SKILL.md"),
      "---\nname: late-skill\ndescription: 会话中途出现的 skill\n---\n\n正文。", "utf8");

    await agent.run("第二轮");
    assert.equal(calls.length, 2);
    const sp2 = calls[1]!.systemPrompt;
    // D1 核心断言：字节相同 → 前缀缓存不被打穿。变更下会话/压缩重建才生效。
    assert.equal(sp2, sp1, "system prompt 在会话内必须字节级稳定（D1：快照注入）");
    assert.ok(!sp2.includes("new-note"));
    assert.ok(!sp2.includes("late-skill"));
    await agent.dispose();
  } finally {
    if (prevGlobal === undefined) delete process.env.FORGE_GLOBAL_DIR;
    else process.env.FORGE_GLOBAL_DIR = prevGlobal;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P1：内置 targets/common.yaml 可解析（默认 target 不报 unknown_target）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-p1b-"));
  const prevGlobal = process.env.FORGE_GLOBAL_DIR;
  process.env.FORGE_GLOBAL_DIR = join(dir, "home");
  try {
    const { install, calls } = mockProvider("mock/main", () => ({ text: "好。" }));
    install();
    const agent = await ForgeAgent.create(config(dir, { builtin: true }), { autoApprove: true, render: false });
    await agent.run("跑一下");
    await agent.dispose();
    assert.equal(calls.length, 1);
    // 仓库 skills/ 的 common 层（3 个通用 skill）经 targets/common.yaml 进入索引；无 unknown_target。
    assert.match(calls[0]!.systemPrompt, /【Skills 索引】/);
    assert.match(calls[0]!.systemPrompt, /triton-kernel-basics/);
    assert.ok(!agent.skillsRegistry.diagnostics.some((d) => d.code === "unknown_target"));
  } finally {
    if (prevGlobal === undefined) delete process.env.FORGE_GLOBAL_DIR;
    else process.env.FORGE_GLOBAL_DIR = prevGlobal;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P2 e2e：模型经真实工具链调 skill_read，D7 幂等让第二次只留短注记", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-p2-"));
  const prevGlobal = process.env.FORGE_GLOBAL_DIR;
  process.env.FORGE_GLOBAL_DIR = join(dir, "home");
  try {
    mkdirSync(join(dir, ".forge/skills/op-guide"), { recursive: true });
    writeFileSync(join(dir, ".forge/skills/op-guide/SKILL.md"),
      "---\nname: op-guide\ndescription: 算子开发守则样本\n---\n\n先写测试再写 kernel。\n\n## 调优\n\n看 roofline。", "utf8");

    // 调用序列：①skill_read 全文 → ②skill_read 重复（应得短注记）→ ③收尾。
    let mainCalls = 0;
    const { install, calls } = mockProvider("mock/main", () => {
      mainCalls += 1;
      if (mainCalls === 1) return { toolCalls: [{ name: "skill_read", args: { name: "op-guide" } }] };
      if (mainCalls === 2) return { toolCalls: [{ name: "skill_read", args: { name: "op-guide" } }] };
      return { text: "完成。" };
    });
    install();
    const agent = await ForgeAgent.create(config(dir), { autoApprove: true, render: false });
    await agent.run("按 op-guide 干活，读两次验证幂等");

    assert.equal(calls.length, 3);
    // 第二次调用的上下文里已有首次正文（工具结果）……
    assert.match(calls[1]!.transcript, /先写测试再写 kernel/);
    // 第三次调用的上下文里，第二次 skill_read 的结果是短注记而非正文重复（D7）。
    const occurrences = calls[2]!.transcript.split("先写测试再写 kernel").length - 1;
    assert.equal(occurrences, 1, "正文只应出现一次（第二次读取被幂等拦截）");
    assert.match(calls[2]!.transcript, /已加载过/);
    await agent.dispose();
  } finally {
    if (prevGlobal === undefined) delete process.env.FORGE_GLOBAL_DIR;
    else process.env.FORGE_GLOBAL_DIR = prevGlobal;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P4 e2e：子 agent 的 system prompt 含同一份 skills 索引快照", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-p4-"));
  const prevGlobal = process.env.FORGE_GLOBAL_DIR;
  process.env.FORGE_GLOBAL_DIR = join(dir, "home");
  try {
    mkdirSync(join(dir, ".forge/skills/op-guide"), { recursive: true });
    writeFileSync(join(dir, ".forge/skills/op-guide/SKILL.md"),
      "---\nname: op-guide\ndescription: 算子开发守则样本\n---\n\n先写测试再写 kernel。", "utf8");

    let mainCalls = 0;
    let subPrompt: string | null = null;
    const { install } = mockProvider("mock/main", (call) => {
      if (call.systemPrompt.startsWith("SUBAGENT[")) {
        subPrompt = call.systemPrompt;
        return { text: "子 agent 结论。" };
      }
      mainCalls += 1;
      if (mainCalls === 1) return { toolCalls: [{ name: "spawn_subagent", args: { role: "researcher", task: "查一下 op-guide 说了什么" } }] };
      return { text: "收到子 agent 结论。" };
    });
    install();
    const agent = await ForgeAgent.create(config(dir), { autoApprove: true, render: false });
    await agent.run("派个子 agent 去查 op-guide");
    await agent.dispose();

    assert.ok(subPrompt, "子 agent 应至少被调用一次");
    assert.match(subPrompt!, /^SUBAGENT\[researcher\]/);
    assert.match(subPrompt!, /【Skills 索引】/);
    assert.match(subPrompt!, /op-guide — 算子开发守则样本/);
    // 与主 agent 同一份快照：字节一致（同一字符串引用的运行时体现）
    assert.ok(subPrompt!.includes(agent.skillsRegistry.indexBlock));
  } finally {
    if (prevGlobal === undefined) delete process.env.FORGE_GLOBAL_DIR;
    else process.env.FORGE_GLOBAL_DIR = prevGlobal;
    rmSync(dir, { recursive: true, force: true });
  }
});
