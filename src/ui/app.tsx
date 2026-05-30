import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Box, Text, Static, useApp, useInput } from "ink";
import { MultilineInput } from "./multiline-input.js";
import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { renderMarkdown, wrapVisible, contentWidth } from "./markdown.js";
import { summarizeToolArgs, readFileResultLine } from "./render.js";
import { theme, ansi, sparkFrame, SPARK_REST } from "./theme.js";
import { renderFileDiff, type FileDiff } from "./diff.js";
import { matchCommands, menuShouldOpen, resolveSubmitted } from "./commands.js";
import { createRunQueue } from "./run-queue.js";
import { ctrlCAction } from "./keybinds.js";
import { explainApiError } from "../kernel/errors.js";

// 写类工具在 tool_execution_start 显示的动词表头（diff 详情在 end 补上）。
const WRITE_VERB: Record<string, string> = { edit_file: "Update", write_file: "Write" };
import type { ForgeAgent } from "../kernel/forge-agent.js";
import type { ForgeConfig } from "../config.js";

/** 是否为中止类错误（Ctrl+C 触发，不当作错误提示）。 */
function isAbortErr(e: unknown): boolean {
  const x = e as { name?: string; code?: string; message?: string } | null;
  return x?.name === "AbortError" || x?.code === "ABORT_ERR" || /abort/i.test(x?.message ?? "");
}

function human(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

interface Block {
  id: number;
  body: string;
}
interface ConfirmReq {
  tool: string;
  args: unknown;
  resolve: (ok: boolean) => void;
}

/** index.ts 与 App 之间的桥：把 agent 的 confirm / notice / status 路由进 React。 */
export interface AppBridge {
  confirm: (tool: string, args: unknown) => Promise<boolean>;
  notice: (msg: string) => void;
  /** 长操作实时状态（压缩进度等）；null 关闭进度行。 */
  status: (msg: string | null) => void;
  /** 子 agent 实时状态（挂仪表盘下方）；null 关闭。 */
  subagent: (msg: string | null) => void;
  /** 后台子 agent 完成 → 作为新一轮喂回主 agent（串行调度，不阻塞）。 */
  resume: (text: string) => void;
  /** Convergent 验收 agent 的事件流：渲染成带 ⟢ 前缀的活动块。 */
  convergentEvent: (e: AgentHarnessEvent) => void;
}

export function App({ agent, config, bridge }: { agent: ForgeAgent; config: ForgeConfig; bridge: AppBridge }) {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [confirm, setConfirm] = useState<ConfirmReq | null>(null);
  const [bypass, setBypass] = useState(false);
  const [, setTick] = useState(0);
  const [dash, setDash] = useState({ turns: 0, inTok: 0, outTok: 0, cost: 0, ctxUsed: 0, cacheHit: 0 });
  // 长操作进度（压缩等）：非 null 时在输入框上方显示动态状态行。
  const [working, setWorking] = useState<string | null>(null);
  // 子 agent 实时状态：挂仪表盘下方。
  const [subStatus, setSubStatus] = useState<string | null>(null);
  // 斜杠命令菜单当前选中项下标。
  const [menuIdx, setMenuIdx] = useState(0);

  // 命令历史：↑/↓ 翻看已发出的命令。histIdx=null 表示在编辑新输入。
  // 召回/清空时由 MultilineInput 检测 value 外部变化、自动把光标移到末尾（无需重挂）。
  const historyRef = useRef<string[]>([]);
  // histIdx 用 ref（不参与渲染）：避免历史回调里的 stale 闭包 / setState-内副作用。null = 在编辑新输入。
  const histIdxRef = useRef<number | null>(null);

  const idRef = useRef(0);
  const lastCtrlCRef = useRef(0); // 空输入下两次 Ctrl+C 才退出：记上次按键时刻
  const bufRef = useRef("");
  const thinkRef = useRef(""); // 推理过程缓冲（思考完成即折叠）
  const convBufRef = useRef(""); // Convergent 文本缓冲（与主 agent 分开）
  const turnStartRef = useRef(0);
  const workStartRef = useRef(0); // 长操作（压缩）起始时刻，用于进度行计时

  // working 从无到有 → 记起始；归零 → 复位（phase 更新不重置计时）
  useEffect(() => {
    if (working && workStartRef.current === 0) workStartRef.current = Date.now();
    if (!working) workStartRef.current = 0;
  }, [working]);

  const push = useCallback((body: string) => {
    setBlocks((b) => [...b, { id: idRef.current++, body }]);
  }, []);

  // 串行 run 队列：用户输入与「后台子 agent 完成喂回」都走它，单线执行，互不冲突、永不撞 busy。
  const queueRef = useRef(
    createRunQueue(
      (text) => agent.run(text),
      (err) => {
        if (isAbortErr(err)) return;
        const ex = explainApiError(err);
        push(ansi.error(`Error: ${ex.message}`) + (ex.transient ? ansi.dim("  (press ↑ then Enter to retry)") : ""));
      },
      (text) => agent.steer(text), // 忙时插话：注入当前 run，不打断当前步
    ),
  );
  const runMain = useCallback((text: string) => queueRef.current.enqueue(text), []);

  // 事件流 → 状态
  useEffect(() => {
    return agent.subscribe((e: AgentHarnessEvent) => {
      switch (e.type) {
        case "message_start":
          if ((e.message as { role?: string }).role === "assistant") {
            bufRef.current = "";
            thinkRef.current = "";
            turnStartRef.current = Date.now();
            setBusy(true);
          }
          break;
        case "message_update": {
          const ev = e.assistantMessageEvent as { type: string; delta?: string };
          if (ev.type === "text_delta" && ev.delta) bufRef.current += ev.delta;
          else if (ev.type === "thinking_delta" && ev.delta) thinkRef.current += ev.delta;
          break;
        }
        case "message_end":
          if ((e.message as { role?: string }).role === "assistant") {
            const think = thinkRef.current.trim();
            if (think) push(ansi.dim(`${SPARK_REST} Thinking · ~${Math.round(think.length / 4)} tokens (collapsed)`));
            const t = bufRef.current.trim();
            if (t) push(`${ansi.assistant("●")} ${renderMarkdown(t).replace(/\n/g, "\n  ")}`);
            bufRef.current = "";
            thinkRef.current = "";
          }
          break;
        case "turn_end": {
          const secs = ((Date.now() - turnStartRef.current) / 1000).toFixed(1);
          const out = (e.message as AssistantMessage | undefined)?.usage?.output ?? 0;
          push(ansi.dim(`  ${secs}s · ${out} tokens`));
          const t = agent.telemetry;
          setDash({ turns: t.turns, inTok: t.inputTokens, outTok: t.outputTokens, cost: t.costRmb, ctxUsed: agent.contextTokens, cacheHit: t.cacheHitRate() });
          break;
        }
        case "tool_execution_start": {
          const verb = WRITE_VERB[e.toolName];
          const path = (e.args as { path?: string } | undefined)?.path;
          if (verb && path) push(`${ansi.tool("●")} ${ansi.bold(`${verb}(${path})`)}`);
          else if (e.toolName === "apply_patch") push(`${ansi.tool("●")} ${ansi.bold("Patch")}`);
          else push(`${ansi.tool("●")} ${ansi.bold(e.toolName)}${ansi.dim(`(${summarizeToolArgs(e.toolName, e.args)})`)}`);
          break;
        }
        case "tool_execution_end": {
          const details = (e.result as { details?: { diff?: FileDiff; diffs?: FileDiff[] } } | undefined)?.details;
          // 写类工具成功 → 渲染 Claude-Code 风格 diff（单文件 details.diff / 多文件 details.diffs）
          if (!e.isError && details?.diff) {
            push(renderFileDiff(details.diff));
            break;
          }
          if (!e.isError && Array.isArray(details?.diffs)) {
            for (const fd of details.diffs) push(`  ${ansi.bold(`${fd.verb}(${fd.path})`)}\n${renderFileDiff(fd)}`);
            break;
          }
          // read_file：显示读取的行范围，而非文件内容首行
          const readLine = !e.isError && e.toolName === "read_file" ? readFileResultLine(details) : null;
          const preview =
            readLine ??
            String((e.result?.content?.[0] as { text?: string } | undefined)?.text ?? "")
              .split("\n")[0]
              .slice(0, 80);
          const mark = e.isError ? ansi.error("✗") : ansi.dim("⎿");
          push(`  ${mark} ${ansi.dim(preview)}`);
          break;
        }
        case "session_compact": {
          // 压缩完成：lastContextTokens 已被 forge-agent 即时回填，刷新仪表盘 ctx + token/成本
          const t = agent.telemetry;
          setDash({ turns: t.turns, inTok: t.inputTokens, outTok: t.outputTokens, cost: t.costRmb, ctxUsed: agent.contextTokens, cacheHit: t.cacheHitRate() });
          break;
        }
        case "agent_end":
          setBusy(false);
          break;
        default:
          break;
      }
    });
  }, [agent, push]);

  // 注册 confirm / notice / status 桥
  useEffect(() => {
    bridge.confirm = (tool, args) => new Promise<boolean>((resolve) => setConfirm({ tool, args, resolve }));
    bridge.notice = (msg) => push(msg.replace(/\n+$/, ""));
    bridge.status = (msg) => setWorking(msg);
    bridge.subagent = (msg) => setSubStatus(msg);
    bridge.resume = (text) => {
      push(ansi.dim("↳ 收到结果，主 agent 继续…"));
      runMain(text);
    };
    // Convergent 活动流：和主 agent 一样实时展示，但每行加 ⟢ 前缀区分（amber）。
    bridge.convergentEvent = (e: AgentHarnessEvent) => {
      switch (e.type) {
        case "message_update": {
          const ev = e.assistantMessageEvent as { type: string; delta?: string };
          if (ev.type === "text_delta" && ev.delta) convBufRef.current += ev.delta;
          break;
        }
        case "message_end":
          if ((e.message as { role?: string }).role === "assistant") {
            const t = convBufRef.current.trim();
            if (t) push(`${ansi.amber("⟢ Convergent")} ${renderMarkdown(t).replace(/\n/g, "\n  ")}`);
            convBufRef.current = "";
          }
          break;
        case "tool_execution_start":
          push(`${ansi.amber("⟢")} ${ansi.bold(e.toolName)}${ansi.dim(`(${summarizeToolArgs(e.toolName, e.args)})`)}`);
          break;
        case "tool_execution_end": {
          const preview = String((e.result?.content?.[0] as { text?: string } | undefined)?.text ?? "").split("\n")[0].slice(0, 80);
          push(`  ${e.isError ? ansi.error("✗") : ansi.dim("⎿")} ${ansi.dim(preview)}`);
          break;
        }
        default:
          break;
      }
    };
  }, [bridge, push, runMain]);

  // busy 或长操作进行中：驱动 spinner / 状态行 / 计时刷新
  useEffect(() => {
    if (!busy && !working) return;
    const id = setInterval(() => setTick((x) => x + 1), 120);
    return () => clearInterval(id);
  }, [busy, working]);

  // Ctrl+C 接管（始终生效）：确认中=拒绝 / 运行中=中止回到输入 / 有输入=清空 / 空输入按两次=退出
  useInput((ch, key) => {
    if (!(key.ctrl && ch === "c")) return;
    const action = ctrlCAction({
      confirm: confirm !== null,
      running: busy || working !== null,
      hasInput: input.length > 0,
      armedRecently: Date.now() - lastCtrlCRef.current < 1500,
    });
    switch (action) {
      case "deny":
        confirm?.resolve(false);
        setConfirm(null);
        push(ansi.dim("⎪ Denied"));
        break;
      case "abort":
        void agent.abort();
        push(ansi.dim("⎪ Aborted — back to input"));
        break;
      case "clear":
        setInput("");
        histIdxRef.current = null;
        break;
      case "exit":
        exit();
        break;
      case "arm":
        lastCtrlCRef.current = Date.now();
        push(ansi.dim("(press Ctrl+C again to exit)"));
        break;
    }
  });

  // 确认提示按键：回车/Y = 同意，n = 拒绝
  useInput(
    (ch, key) => {
      if (!confirm) return;
      if (key.return || ch.toLowerCase() === "y") {
        confirm.resolve(true);
        setConfirm(null);
      } else if (ch.toLowerCase() === "n") {
        confirm.resolve(false);
        setConfirm(null);
      }
    },
    { isActive: confirm !== null },
  );

  // 斜杠命令菜单：输入以 / 开头时按子串模糊匹配命令。
  const menuMatches = matchCommands(input);
  const menuOpen = menuShouldOpen(input);
  const menuSel = Math.min(menuIdx, menuMatches.length - 1);

  // 菜单打开时 ↑↓/Tab 控制菜单（↑↓ 循环选择 · Tab 补全）。菜单关闭时这些键交给
  // MultilineInput（行内移动光标 / 边界翻历史），故本 hook 仅在菜单打开时生效。
  useInput(
    (_ch, key) => {
      if (key.tab) {
        setInput(menuMatches[menuSel].name);
        return;
      }
      if (key.upArrow || key.downArrow) {
        setMenuIdx(() => {
          const next = key.upArrow ? menuSel - 1 : menuSel + 1;
          return (next + menuMatches.length) % menuMatches.length; // 循环选择
        });
      }
    },
    { isActive: menuOpen && confirm === null },
  );

  // 命令历史翻页（MultilineInput 在首行↑ / 尾行↓ 时回调）。histIdx=null 表示在编辑新输入。
  const historyPrev = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const cur = histIdxRef.current;
    const idx = cur === null ? h.length - 1 : Math.max(0, cur - 1);
    histIdxRef.current = idx;
    setInput(h[idx]);
  }, []);
  const historyNext = useCallback(() => {
    const h = historyRef.current;
    const cur = histIdxRef.current;
    if (cur === null) return; // 已是最新草稿
    if (cur >= h.length - 1) {
      histIdxRef.current = null;
      setInput("");
    } else {
      const idx = cur + 1;
      histIdxRef.current = idx;
      setInput(h[idx]);
    }
  }, []);

  // 斜杠命令分发表（{name → handler}）：加命令 = 这里加一条 + commands.ts 的 COMMANDS 加一条。
  // /exit、/quit 在 onSubmit 里先于回显特判（直接退出、不回显）。
  const slashHandlers = useMemo<Record<string, () => void | Promise<void>>>(
    () => ({
      "/stats": () => push(agent.telemetry.summary()),
      "/pass-permissions": () => {
        agent.passPermissions();
        setBypass(true);
        push(ansi.amber("Permission bypass ON — write/exec tools auto-approved. Catastrophic commands (rm -rf /, fork bombs, raw disk writes) are still blocked."));
      },
      "/skills": () => {
        const sk = agent.listSkills();
        push(sk.length ? sk.map((s) => `  · \x1b[1m${s.name}\x1b[0m ${s.description}`).join("\n") : ansi.dim("(no skills loaded)"));
      },
      "/compact": async () => {
        try {
          await agent.compactNow();
        } catch (err) {
          push(ansi.error(`Compaction failed: ${(err as Error).message}`));
        }
      },
    }),
    [agent, push],
  );

  const onSubmit = useCallback(
    async (value: string) => {
      // 斜杠菜单开着且输入非精确命令 → Enter 执行当前选中项（避免把 "/comp" 当聊天发出）
      const line = resolveSubmitted(value, menuIdx);
      setInput("");
      if (!line) return;
      // 记入历史（跳过与上一条完全相同的），并退出历史浏览态
      const h = historyRef.current;
      if (h[h.length - 1] !== line) h.push(line);
      histIdxRef.current = null;
      if (line === "/exit" || line === "/quit") {
        exit();
        return;
      }
      push(`\x1b[97m›\x1b[0m ${line}`); // › + 1 空格 = 2 列槽位，与 ● / ✦ 对齐
      // /converge 是带参命令（/converge <目标> · /converge · /converge clear），单独处理
      if (line === "/converge" || line.startsWith("/converge ")) {
        const arg = line.slice("/converge".length).trim();
        if (!arg) push(agent.convergeStatus());
        else if (arg === "clear") push(agent.clearConverge());
        else {
          push(ansi.amber(`/converge 目标已设定，将持续工作直到 Convergent 验收通过：${arg}`));
          runMain(agent.startConverge(arg));
        }
        return;
      }
      const handler = slashHandlers[line];
      if (handler) {
        await handler();
        return;
      }
      // 忙时插话(steer 注入当前 run) / 闲时新任务(enqueue)，均不阻塞输入
      if (queueRef.current.submit(line) === "steered") push(ansi.dim("↳ 已插入当前任务 — 本步完成后送达"));
    },
    [agent, exit, push, menuIdx, runMain, slashHandlers],
  );

  const secs = busy ? Math.floor((Date.now() - turnStartRef.current) / 1000) : 0;
  const wsecs = working && workStartRef.current ? Math.floor((Date.now() - workStartRef.current) / 1000) : 0;
  const estTok = Math.round(bufRef.current.length / 4);
  const win = agent.contextWindow;
  const pct = win ? Math.min(100, Math.round((dash.ctxUsed / win) * 100)) : 0;
  const model = config.modelRef.split("/")[1] ?? config.modelRef;
  const frame = sparkFrame();

  return (
    <Box flexDirection="column">
      <Static items={blocks}>
        {(b) => (
          <Box key={b.id} marginBottom={1}>
            <Text>{b.body}</Text>
          </Box>
        )}
      </Static>

      {busy && thinkRef.current && !bufRef.current && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.muted}>{`${sparkFrame()} Reasoning`}</Text>
          {/* 先按内容宽折行再取末 8 行：长行不顶到第 0 列，且高度恒定 ≤8 行 */}
          <Text color={theme.muted}>{"  " + wrapVisible(thinkRef.current.trim(), contentWidth()).split("\n").slice(-8).join("\n  ")}</Text>
        </Box>
      )}

      {busy && (
        <Box marginBottom={1}>
          <Text color={theme.spinner}>{frame}</Text>
          <Text color={theme.muted}>
            {" "}
            Thinking ({secs}s{estTok > 0 ? ` · ~${estTok} tokens` : ""})
          </Text>
        </Box>
      )}

      {working && (
        <Box marginBottom={1}>
          <Text color={theme.spinner}>{frame}</Text>
          <Text color={theme.amber}>{` ↻ ${working}`}</Text>
          <Text color={theme.muted}>{` (${wsecs}s)`}</Text>
        </Box>
      )}

      {menuOpen && !confirm && (
        <Box flexDirection="column" marginBottom={1}>
          {menuMatches.map((c, i) => (
            <Text key={c.name}>
              <Text color={i === menuSel ? theme.prompt : theme.muted}>{`${i === menuSel ? "❯" : " "} ${c.name}`}</Text>
              <Text color={theme.muted}>{`   ${c.desc}`}</Text>
            </Text>
          ))}
          <Text color={theme.muted}>{"  ↑↓ select · Tab complete · Enter run"}</Text>
        </Box>
      )}

      <Box borderStyle="single" borderColor={theme.muted} borderLeft={false} borderRight={false}>
        {confirm ? (
          <Text>
            <Text color={theme.confirm}>▸ Allow </Text>
            <Text bold>{confirm.tool}</Text>
            <Text color={theme.muted}> ({summarizeToolArgs(confirm.tool, confirm.args)}) ? [Y/n]</Text>
          </Text>
        ) : (
          <Box>
            <Text color={theme.prompt}>{"› "}</Text>
            <MultilineInput
              value={input}
              onChange={(v) => { setInput(v); setMenuIdx(0); }}
              onSubmit={onSubmit}
              onHistoryPrev={historyPrev}
              onHistoryNext={historyNext}
              menuOpen={menuOpen}
              isActive={confirm === null}
            />
            {/* 占位提示：浅灰，仅空输入时 */}
            {!input && <Text color={theme.muted}>Type a request · /exit to quit</Text>}
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>
          ▌ {model} · ctx {human(dash.ctxUsed)}/{human(win)} ({pct}%) · {dash.turns} turns · ↑{human(dash.inTok)} ↓
          {human(dash.outTok)} tok · cache {Math.round(dash.cacheHit * 100)}% · ¥{dash.cost.toFixed(4)}
          {bypass ? <Text color={theme.error}> · bypass</Text> : ""}
        </Text>
      </Box>

      {agent.subTelemetry.turns > 0 && (
        <Box>
          <Text color={theme.muted}>
            ▌ {agent.subTelemetry.model || "subagent"} · {agent.subTelemetry.turns} turns · ↑{human(agent.subTelemetry.inputTokens)} ↓
            {human(agent.subTelemetry.outputTokens)} tok · cache {Math.round(agent.subTelemetry.cacheHitRate() * 100)}% · ¥
            {agent.subTelemetry.costRmb.toFixed(4)}
          </Text>
        </Box>
      )}

      {subStatus && (
        <Box>
          <Text color={theme.amber}>{subStatus}</Text>
        </Box>
      )}
    </Box>
  );
}
