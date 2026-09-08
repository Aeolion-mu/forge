import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import { App, type AppBridge } from "../src/ui/app.js";
import { createMouseStdin } from "../src/ui/terminal-io.js";
import { resetBlockCache } from "../src/ui/blocks.js";
import { SubAgentRegistry } from "../src/kernel/subagent-registry.js";
import type { ForgeAgent } from "../src/kernel/forge-agent.js";
import type { ForgeConfig } from "../src/config.js";

/**
 * App 层交互测试：真 ink 渲染 + 假 agent + 伪终端（stdin/stdout PassThrough）。
 * 帧断言：debug 模式下 ink 每次渲染整帧直写 stdout → 收集 chunk、剥 ANSI、取最后一帧。
 * 鼠标：往同一 stdin 写 SGR 序列（createMouseStdin 剥出事件）；键盘：写普通按键。
 */

const ROWS = 30;
const COLS = 100;

function fakeStdout(): PassThrough & { columns: number; rows: number } {
  const out = new PassThrough() as PassThrough & { columns: number; rows: number };
  out.columns = COLS;
  out.rows = ROWS;
  return out;
}

function fakeStdin(): PassThrough {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (m: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true; // ink 的 useInput 需要（否则 setRawMode 抛错）
  stdin.setRawMode = () => {};
  stdin.ref = () => {}; // ink 的 useInput 也会调 ref/unref（PassThrough 没有）
  stdin.unref = () => {};
  return stdin;
}

/** 剥 ANSI 转义后的整帧文本。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/** SGR 鼠标序列（1-based 行列）。press/motion/release 各一形态。 */
const mouse = {
  press: (col: number, row: number) => `\x1b[<0;${col};${row}M`,
  motion: (col: number, row: number) => `\x1b[<32;${col};${row}M`,
  release: (col: number, row: number) => `\x1b[<0;${col};${row}m`,
};

/** 挂起但可被 cancel 收尾的 registry；onUpdate 转发到（后赋值的）bridge.subagent。 */
function wiredRegistry(bridgeRef: { current: AppBridge | null }) {
  const runLoop = (_r: string, _t: string, _m: number | undefined, signal: AbortSignal) =>
    new Promise<{ text: string; turns: number; tools: number; hitLimit: boolean }>((resolve) =>
      signal.addEventListener("abort", () => resolve({ text: "（已被撤销）", turns: 0, tools: 0, hitLimit: false }), { once: true }),
    );
  return new SubAgentRegistry({ runLoop, onUpdate: () => bridgeRef.current?.subagent() });
}

interface Harness {
  write: (s: string) => void;
  frame: () => string;
  flush: () => Promise<void>;
  unmount: () => void;
  bridge: AppBridge;
  registry: SubAgentRegistry;
  steered: Array<[string, string]>;
  agent: ForgeAgent;
}

/** 渲染一个 App 实例（假 agent 挂真 SubAgentRegistry）。 */
function mountApp(opts: { resumedFrom?: unknown; entries?: unknown[] } = {}): Harness {
  const out = fakeStdout();
  const chunks: string[] = [];
  out.on("data", (c) => chunks.push(String(c)));
  const realStdin = fakeStdin();
  const mouseStdin = createMouseStdin(realStdin);

  const bridgeRef: { current: AppBridge | null } = { current: null };
  const registry = wiredRegistry(bridgeRef);
  const steered: Array<[string, string]> = [];
  const agent = {
    subscribe: () => () => {},
    telemetry: { turns: 0, inputTokens: 0, outputTokens: 0, costRmb: 0, cacheHitRate: () => 0, summary: () => "" },
    subTelemetry: { turns: 5, model: "mock/flash", inputTokens: 100, outputTokens: 50, costRmb: 0.01 },
    bypassingPermissions: true,
    contextWindow: 200_000,
    contextTokens: 1000,
    sessionId: "t",
    run: async () => {},
    steer: () => {},
    abort: async () => {},
    conversationEntries: async () => (opts.entries ?? []) as never,
    userTurns: async () => [],
    rewindTo: async () => {},
    compactNow: async () => {},
    listSkills: () => [],
    convergeStatus: () => "",
    clearConverge: () => "",
    startConverge: () => "",
    passPermissions: () => {},
    listSubAgents: () => registry.list(),
    steerSubAgent: (id: string, msg: string) => {
      steered.push([id, msg]);
      return registry.steer(id, msg);
    },
  } as unknown as ForgeAgent;

  const bridge: AppBridge = {
    confirm: async () => true,
    notice: () => {},
    status: () => {},
    subagent: () => {},
    resume: () => {},
    subagentEvent: () => {},
    convergentEvent: () => {},
  };
  const config = { live: true, modelRef: "mock/main", allowReadOutsideWorkdir: false } as unknown as ForgeConfig;
  const instance = render(createElement(App, { agent, config, bridge, mouseStdin, resumedFrom: opts.resumedFrom as never }), {
    stdout: out as unknown as NodeJS.WriteStream,
    stdin: mouseStdin as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  bridgeRef.current = bridge; // registry onUpdate → bridge.subagent（App 挂载后生效）

  const frame = () => {
    const stripped = chunks.map(stripAnsi).filter((c) => c.trim().length > 20);
    return stripped[stripped.length - 1] ?? "";
  };
  return {
    write: (s) => realStdin.write(s),
    frame,
    flush: async () => {
      await new Promise((r) => setTimeout(r, 120));
    },
    unmount: () => {
      instance.unmount();
      (mouseStdin as unknown as { detach?: () => void }).detach?.();
      realStdin.destroy();
      out.destroy();
    },
    bridge,
    registry,
    steered,
    agent,
  };
}

const ev = (e: unknown) => e as HarnessEvent;

test("App 交互：子 agent 状态行出现/消失 · 点击切换上下文 · 子视图输入=插话 · Esc 返回", async () => {
  resetBlockCache();
  const h = mountApp();
  try {
    await h.flush();
    // 初始：无子 agent → 无状态行、无子用量行
    assert.ok(!h.frame().includes("点击查看"), "初始不应有子 agent 状态行");

    // spawn s1（running，runLoop 挂起）→ bridge ping → 状态行出现 + 子用量行出现
    h.registry.spawn("researcher", "调查 answer.txt 的答案并汇报", undefined);
    h.bridge.subagent();
    await h.flush();
    const f1 = h.frame();
    assert.ok(f1.includes("s1[researcher]"), `状态行应出现：\n${f1}`);
    assert.ok(f1.includes("点击查看"), f1);
    assert.ok(f1.includes("mock/flash"), "running 期间子用量行应出现");

    // 子 agent 事件流 → transcript（工具调用 + 结论）
    h.bridge.subagentEvent("s1", ev({ type: "tool_start", toolCallId: "tc1", toolName: "read_file", args: { path: "/tmp/answer.txt" } }));
    h.bridge.subagentEvent("s1", ev({ type: "tool_end", toolCallId: "tc1", result: { content: [{ type: "text", text: "answer = 42" }] }, isError: false }));
    h.bridge.subagentEvent("s1", ev({ type: "message_start", message: { role: "assistant" } }));
    h.bridge.subagentEvent("s1", ev({ type: "message_update", event: { type: "text_delta", delta: "结论：answer=42" } }));
    h.bridge.subagentEvent("s1", ev({ type: "message_end", message: { role: "assistant" } }));
    await h.flush();

    // 点击状态行（底部最后一行 = row ROWS-1）→ 进入子 agent 上下文
    h.write(mouse.press(10, ROWS - 1) + mouse.release(10, ROWS - 1));
    await h.flush();
    const f2 = h.frame();
    assert.ok(f2.includes("返回主上下文"), `点击状态行应切换到子视图：\n${f2}`);
    assert.ok(f2.includes("调查 answer.txt"), "子视图应显示指派任务（transcript 首条 user block）");
    assert.ok(f2.includes("read_file"), "子视图应显示工具调用");
    assert.ok(f2.includes("结论：answer=42"), "子视图应显示结论");

    // 子视图内输入 = 对该子 agent 插话（用户侧 steering）
    h.write("请注意单位");
    await h.flush();
    h.write("\r");
    await h.flush();
    assert.deepEqual(h.steered, [["s1", "请注意单位"]], "提交应走 steerSubAgent");
    const f3 = h.frame();
    assert.ok(f3.includes("插话"), `插话确认行应显示：\n${f3}`);
    assert.ok(f3.includes("请注意单位"), f3);

    // /agents 在子视图内执行 → 输出在主上下文（toast 提示）；Esc 返回后可见清单
    h.write("/agents\r");
    await h.flush();
    assert.ok(h.frame().includes("命令输出在主上下文"), "子视图内跑命令应 toast 提示输出位置");

    // Esc → 返回主上下文
    h.write("\x1b");
    await h.flush();
    const f4 = h.frame();
    assert.ok(!f4.includes("返回主上下文"), `Esc 应回到主上下文：\n${f4}`);
    assert.ok(f4.includes("s1 [researcher]"), `/agents 清单应显示在主上下文：\n${f4}`);

    // 输入框拖选 + 打字替换：hello world → 选中 world → 输入 X → hello X
    // 输入内容行：viewportHeight 变化后重算——先清输入框状态（当前为空）。
    // 布局：rows=30，view=main，无 toast/jump/busy/working/menu/picker；input 1 行；
    // dashboard 1；subDash 1；subRow 1 → chrome=7 → viewport=22 → inputRow=23+1+1=25。
    const inputRow = 25;
    h.write("hello world");
    await h.flush();
    h.write(mouse.press(9, inputRow) + mouse.motion(15, inputRow) + mouse.release(15, inputRow));
    await h.flush();
    h.write("X");
    await h.flush();
    const f5 = h.frame();
    assert.ok(f5.includes("hello X"), `拖选后打字应替换选中段（得到 hello X）：\n${f5}`);
    assert.ok(!f5.includes("hello world"), f5);

    // 子 agent 结束 → ping → 状态行与子用量行一起消失
    //（registry 的挂起 runLoop 无法自然结束——用 cancel 走 aborted → cancelled 收尾）
    h.registry.cancel("s1");
    await h.flush();
    const f6 = h.frame();
    assert.ok(!f6.includes("点击查看"), `结束后状态行应消失：\n${f6}`);
    assert.ok(!f6.includes("mock/flash"), `结束后子用量行应消失：\n${f6}`);
  } finally {
    h.unmount();
  }
});

test("App 交互：对已结束的子 agent 插话被拒绝并提示", async () => {
  resetBlockCache();
  const h = mountApp();
  try {
    // spawn 后立刻 cancel → done 路径走不通（runLoop 挂起），用受控 registry：
    // 直接构造 cancelled 状态。
    h.registry.spawn("worker", "干活", undefined);
    h.registry.cancel("s1");
    h.bridge.subagent();
    await h.flush();
    // 主视图输入（无运行中的子 agent，主 agent run 是空操作）
    h.write("试试插话\r");
    await h.flush();
    // steerSubAgent 只在子视图内触发；此处验证注册表层面拒绝
    assert.match(h.registry.steer("s1", "hi"), /已 cancelled，无法插话|已 cancelled/);
  } finally {
    h.unmount();
  }
});

test("App 交互：输入框 ↑/↓ 翻历史输入记录（含草稿保护）", async () => {
  resetBlockCache();
  const h = mountApp();
  /** 输入框内容行（两条边框线之间那行 `› …`）——历史断言必须看这里而非整帧（转录区也有 › 前缀的用户块）。 */
  const inputRow = (frame: string): string => {
    const m = frame.match(/─+\n(›[^\n]*)\n─+/);
    return m ? m[1]! : "";
  };
  try {
    await h.flush();
    // 发两条消息进历史
    h.write("第一条消息\r");
    await h.flush();
    h.write("第二条消息\r");
    await h.flush();
    assert.equal(inputRow(h.frame()), "›  Type a request · /exit to quit", "提交后输入应为空");

    // ↑ → 召回最近一条（第二条）
    h.write("\x1b[A");
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("第二条消息"), `↑ 应召回最近一条历史：\n${h.frame()}`);

    // 再 ↑ → 上一条（第一条）；↑ 到头后停留（不循环）
    h.write("\x1b[A");
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("第一条消息"), "再↑ 应到更早一条");
    h.write("\x1b[A");
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("第一条消息"), "到最早已历史应停留");

    // ↓ → 回到下一条（第二条）；再 ↓ 翻过最新 → 回到空草稿
    h.write("\x1b[B");
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("第二条消息"), "↓ 应翻回较新一条");
    h.write("\x1b[B");
    await h.flush();
    assert.match(inputRow(h.frame()), /Type a request/, "↓ 翻过最新一条应清回新草稿");

    // 草稿保护：输入未提交草稿 → ↑ 浏览历史 → ↓ 翻回最新 → 草稿原样恢复
    h.write("还没写完的草稿");
    await h.flush();
    h.write("\x1b[A"); // 进入浏览（存草稿）
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("第二条消息"), "浏览中显示历史");
    h.write("\x1b[B"); // 翻回最新 → 恢复草稿
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("还没写完的草稿"), `↓ 到底应恢复进入浏览前的草稿：\n${h.frame()}`);
  } finally {
    h.unmount();
  }
});

test("App 交互：/resume 恢复后 ↑/↓ 能召回历史会话中的用户消息", async () => {
  resetBlockCache();
  // 最小会话树：3 条用户消息 + 1 条 assistant（replayBlocks 与历史种子共用这些条目）
  const userMsg = (id: string, text: string) => ({
    id,
    parentId: null,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
  });
  const entries = [
    userMsg("e1", "历史消息一"),
    userMsg("e2", "历史消息二"),
    { id: "e3", parentId: null, type: "message", message: { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: Date.now() } },
    userMsg("e4", "历史消息三"),
  ];
  const h = mountApp({ resumedFrom: { id: "sess-1234567890" }, entries });
  const inputRow = (frame: string): string => {
    const m = frame.match(/─+\n(›[^\n]*)\n─+/);
    return m ? m[1]! : "";
  };
  try {
    await h.flush();
    // 恢复横幅 + 重放
    const f0 = h.frame();
    assert.ok(f0.includes("已恢复会话"), `应显示恢复提示：\n${f0}`);
    assert.ok(f0.includes("历史消息三"), "重放应包含历史用户消息");

    // ↑ → 召回恢复会话里的最后一条用户消息（无需先在本实例发过任何输入）
    h.write("\x1b[A");
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("历史消息三"), `↑ 应召回会话历史最新一条：\n${h.frame()}`);

    // 再 ↑ → 更早的消息
    h.write("\x1b[A");
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("历史消息二"), "再↑ 应到更早的会话历史");

    // 恢复后新发的消息接在历史之后：发一条新的，↑ 先到它、再↑ 到旧会话历史
    h.write("\x1b[B\x1b[B"); // ↓↓ 回到空草稿
    await h.flush();
    h.write("恢复后的新消息\r");
    await h.flush();
    h.write("\x1b[A");
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("恢复后的新消息"), "↑ 先到最近发出的一条");
    h.write("\x1b[A");
    await h.flush();
    assert.ok(inputRow(h.frame()).includes("历史消息三"), "再↑ 应衔接上恢复的会话历史");
  } finally {
    h.unmount();
  }
});

test("App 交互：模型信息行可拖选/双击选中复制，复制提示与模型信息同一行", async () => {
  resetBlockCache();
  const h = mountApp();
  try {
    await h.flush();
    // 空闲布局：chrome = 输入框(3 行) + 仪表盘(1 行) → 仪表盘在最后一行（ROWS-1）。
    const dashLineOf = (frame: string) => frame.split("\n").find((l) => l.includes("▌ main")) ?? "";
    assert.ok(dashLineOf(h.frame()), "仪表盘行应存在");
    assert.ok(!dashLineOf(h.frame()).includes("已复制"), "初始无复制提示");

    // 拖选仪表盘行的模型名一段 → 松开即复制 → toast 出现在同一行右端
    h.write(mouse.press(3, ROWS - 1) + mouse.motion(8, ROWS - 1) + mouse.release(8, ROWS - 1));
    await h.flush();
    const f1 = h.frame();
    const d1 = dashLineOf(f1);
    assert.ok(d1.includes("▌ main"), `仪表盘行仍在：\n${f1}`);
    assert.ok(d1.includes("已复制"), `复制提示应与模型信息同一行：\n${f1}`);

    // 双击模型名 → 选词复制（同格两次 <500ms）
    h.write(mouse.press(4, ROWS - 1) + mouse.release(4, ROWS - 1));
    await h.flush();
    h.write(mouse.press(4, ROWS - 1) + mouse.release(4, ROWS - 1));
    await h.flush();
    assert.ok(dashLineOf(h.frame()).includes("已复制"), "双击选词也应复制并提示");

    // 布局未变：复制提示不单独占行（帧内仍只有一行以 ▌ 开头且总数稳定）
    assert.equal(h.frame().split("\n").filter((l) => l.trim().startsWith("▌")).length, 1, "子用量行未运行不出现");
  } finally {
    h.unmount();
  }
});
