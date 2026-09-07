import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { renderMarkdown } from "./markdown.js";
import { summarizeToolArgs, readFileResultLine } from "./render.js";
import { theme, ansi, sparkFrame, SPARK_REST, renderBanner } from "./theme.js";
import { renderFileDiff, type FileDiff } from "./diff.js";
import { matchCommands, menuShouldOpen, resolveSubmitted } from "./commands.js";
import { createRunQueue } from "./run-queue.js";
import { ctrlCAction } from "./keybinds.js";
import { getSandboxStatus } from "../sandbox/exec.js";
import { explainApiError } from "../kernel/errors.js";
import { defaultCollapsed, flattenBlocks, resetBlockCache, type Block, type NewBlock, type ToolBody } from "./blocks.js";
import { visible, scrollBy } from "./viewport.js";
import type { MouseEvent, MouseStdin } from "./terminal-io.js";
import { wrapVisible, visibleWidth } from "./markdown.js";
import { MultilineInput } from "./multiline-input.js";
import { normalizeRange, lineRangeInSel, highlightRange, plainOf, expandWord, wholeLine, selectedText } from "./selection.js";
import { copyText } from "./clipboard.js";
import { replayBlocks, firstUserPreviewSync } from "./session-replay.js";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";

// 写类工具在 tool_start 显示的动词表头（diff 详情在 end 补上）。
const WRITE_VERB: Record<string, string> = { edit_file: "Update", write_file: "Write" };
import { ForgeAgent } from "../kernel/forge-agent.js";
import type { ForgeConfig } from "../config.js";

/** 是否为中止类错误（Ctrl+C 触发，不当作错误提示）。 */
function isAbortErr(e: unknown): boolean {
  const x = e as { name?: string; code?: string; message?: string } | null;
  return x?.name === "AbortError" || x?.code === "ABORT_ERR" || /abort/i.test(x?.message ?? "");
}

/** 相对时间（会话列表用）。 */
function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

function human(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
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
  convergentEvent: (e: HarnessEvent) => void;
  /** /resume 选中会话 → 通知 index 重启循环换会话（App 随即 exit）。 */
  requestResume?: (meta: JsonlSessionMetadata) => void;
}

/**
 * 全屏 TUI（Claude Code 式）：备用屏 + 虚拟视口 + 鼠标。
 *
 * 渲染模型：block 只存原始数据（blocks.ts），渲染时按当前宽度展开成行（记忆化），
 * 视口只画可见切片 → 树高恒 ≤ 终端行数，Ink 逐帧替换即全屏。resize 时 useWindowSize
 * 触发全部 block 按新宽度重排（旧追加式 TUI 的「宽度冻死 + 擦除错位」问题根治）。
 * 鼠标：滚轮滚动（上滚暂停自动跟随 + 底部 Jump 按钮计数新消息）、点击折叠的工具结果
 * 展开/再折叠、点击菜单项选中、点击输入框定位光标。
 */
export function App({
  agent,
  config,
  bridge,
  mouseStdin,
  resumedFrom,
}: {
  agent: ForgeAgent;
  config: ForgeConfig;
  bridge: AppBridge;
  mouseStdin: MouseStdin;
  /** 恢复来源会话（新会话为 undefined）——挂载时逐字重放其条目。 */
  resumedFrom?: JsonlSessionMetadata;
}) {
  const { exit } = useApp();
  const { columns: termCols, rows: termRows } = useWindowSize();  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [confirm, setConfirm] = useState<ConfirmReq | null>(null);
  const [bypass, setBypass] = useState(agent.bypassingPermissions); // 启动默认 pass-permissions 开
  const [, setTick] = useState(0);
  const [dash, setDash] = useState({ turns: 0, inTok: 0, outTok: 0, cost: 0, ctxUsed: 0, cacheHit: 0 });
  // 长操作进度（压缩等）：非 null 时在输入框上方显示动态状态行。
  const [working, setWorking] = useState<string | null>(null);
  // 子 agent 实时状态：挂仪表盘下方。
  const [subStatus, setSubStatus] = useState<string | null>(null);
  // 斜杠命令菜单当前选中项下标。
  const [menuIdx, setMenuIdx] = useState(0);
  // 视口滚动：offset = 视口底边之上的隐藏行数（0 = 跟随底部）。
  const [scrollOffset, setScrollOffset] = useState(0);
  // 跟随暂停期间累计的新行数（Jump 按钮「N new」）。
  const [newCount, setNewCount] = useState(0);
  // 鼠标点击输入框 → 请求把光标移到该列（消费后置 null）。
  const [cursorCol, setCursorCol] = useState<number | null>(null);
  // /resume · /rewind 的选择器（输入框上方浮层）：↑↓ 选择、Enter 确认、Esc 取消、点击行确认。
  const [picker, setPicker] = useState<{
    kind: "resume" | "rewind";
    items: Array<{ key: string; label: string; meta?: JsonlSessionMetadata; turn?: { parentTip: string | null; text: string } }>;
    sel: number;
  } | null>(null);
  const pickerRef = useRef(picker);
  pickerRef.current = picker;
  // 右下角浮动 toast（复制提示等）：单条、右对齐、自动消失、不进会话记录；新提示替换旧的。
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);
  // 应用内选区（全局行号 + 可见列；anchor→active 归一化后渲染高亮）。单击清空、拖拽/双击/三击建立。
  const [sel, setSel] = useState<{ anchor: { line: number; col: number }; active: { line: number; col: number } } | null>(null);
  const selRef = useRef<typeof sel>(sel);
  selRef.current = sel;
  // 拖拽进行时：起点与「是否真的拖动了」（没动 = 单击，动 = 选择）
  const dragRef = useRef<{ startRow: number; startLine: number; startCol: number; moved: boolean } | null>(null);
  // 双击/三击计数（<500ms 同格）
  const lastClickRef = useRef<{ ts: number; row: number; col: number; count: number }>({ ts: 0, row: 0, col: 0, count: 0 });
  // 鼠标捕获开关：关掉后终端原生「拖拽选择 + 复制」恢复（forge 内滚轮/点击随之失效，
  // 键盘 PgUp/PgDn 滚动不受影响）。FORGE_NO_MOUSE=1 启动即关。
  const [mouseOn, setMouseOn] = useState(process.env.FORGE_NO_MOUSE !== "1");

  // 鼠标捕获切换 → 写终端上报开关（TerminalIo.restore 退出时无条件关，幂等安全）
  const { stdout: ioOut } = useStdout();
  useEffect(() => {
    ioOut.write(mouseOn ? "\x1b[?1000h\x1b[?1002h\x1b[?1006h" : "\x1b[?1006l\x1b[?1002l\x1b[?1000l"); // 1002=拖选
  }, [mouseOn, ioOut]);

  // 命令历史：↑/↓ 翻看已发出的命令。histIdx=null 表示在编辑新输入。
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
  const prevTotalRef = useRef(0); // 上一帧总行数（跟随暂停时累加新行数）
  const scrollOffsetRef = useRef(0);
  scrollOffsetRef.current = scrollOffset;

  const pushBlock = useCallback((b: NewBlock) => {
    setBlocks((prev) => [...prev, { ...b, id: idRef.current++ } as Block]);
  }, []);
  const push = useCallback((text: string) => pushBlock({ kind: "plain", text }), [pushBlock]);

  // working 从无到有 → 记起始；归零 → 复位（phase 更新不重置计时）
  useEffect(() => {
    if (working && workStartRef.current === 0) workStartRef.current = Date.now();
    if (!working) workStartRef.current = 0;
  }, [working]);

  // 串行 run 队列：用户输入与「后台子 agent 完成喂回」都走它，单线执行，互不冲突、永不撞 busy。
  const queueRef = useRef(
    createRunQueue(
      (text) => agent.run(text),
      (err) => {
        if (isAbortErr(err)) return;
        const ex = explainApiError(err);
        pushBlock({ kind: "error", text: ex.message, hint: ex.transient ? "(press ↑ then Enter to retry)" : undefined });
      },
      (text) => agent.steer(text), // 忙时插话：注入当前 run，不打断当前步
    ),
  );
  const runMain = useCallback((text: string) => queueRef.current.enqueue(text), []);

  // 启动横幅（备用屏内的第一个 block，取代旧版 stdout 直写）
  useEffect(() => {
    const sb = getSandboxStatus();
    const live = config.live ? "\x1b[32m● LIVE\x1b[0m" : "\x1b[31m● no key\x1b[0m";
    const lines = [
      ...renderBanner().split("\n"), // ← 整体是单个多行字符串：split 出行，而非逐字符展开（曾致左列竖条乱码）
      "",
      ` ${ansi.dim("Terminal Coding Agent ·")} ${config.modelRef} ${ansi.dim("·")} ${live}`,
    ];
    if (sb.backend === "none" && sb.enabled) {
      lines.push(` ${ansi.amber("⚠ sandbox: NO BACKEND")} ${ansi.dim(`— 命令未沙箱（仅环境白名单清洗）。${sb.reason}`)}`);
    } else if (sb.backend !== "none") {
      lines.push(` ${ansi.dim(`sandbox: ${sb.backend} (${sb.reason})`)}`);
    }
    if (config.allowReadOutsideWorkdir) {
      lines.push(` ${ansi.amber("⚠ read-outside-workdir ON")} ${ansi.dim("— read-only tools may read outside workdir")}`);
    }
    lines.push("");
    pushBlock({ kind: "banner", lines });
    // 恢复会话：逐字重放全部条目（新会话为空数组，零成本）
    void (async () => {
      const entries = await agent.conversationEntries();
      for (const b of replayBlocks(entries)) pushBlock(b);
      if (resumedFrom) pushBlock({ kind: "plain", text: ansi.dim(`⏵ 已恢复会话 ${resumedFrom.id.slice(0, 8)}（${entries.length} 条消息）——继续对话即可`) });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 事件流 → block
  useEffect(() => {
    return agent.subscribe((e: HarnessEvent) => {
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
          const ev = e.event as { type: string; delta?: string }; // 0.85：delta 字段改名 event
          if (ev.type === "text_delta" && ev.delta) bufRef.current += ev.delta;
          else if (ev.type === "thinking_delta" && ev.delta) thinkRef.current += ev.delta;
          break;
        }
        case "message_end":
          if ((e.message as { role?: string }).role === "assistant") {
            const think = thinkRef.current.trim();
            if (think) pushBlock({ kind: "thinking", tokens: Math.round(think.length / 4) });
            const t = bufRef.current.trim();
            if (t) pushBlock({ kind: "markdown", source: t });
            bufRef.current = "";
            thinkRef.current = "";
          }
          break;
        case "turn_end": {
          const secs = ((Date.now() - turnStartRef.current) / 1000).toFixed(1);
          const out = (e.message as AssistantMessage | undefined)?.usage?.output ?? 0;
          pushBlock({ kind: "turn", secs, out });
          const t = agent.telemetry;
          setDash({ turns: t.turns, inTok: t.inputTokens, outTok: t.outputTokens, cost: t.costRmb, ctxUsed: agent.contextTokens, cacheHit: t.cacheHitRate() });
          break;
        }
        case "tool_start": {
          const verb = WRITE_VERB[e.toolName];
          const path = (e.args as { path?: string } | undefined)?.path;
          const header =
            verb && path
              ? `${ansi.tool("●")} ${ansi.bold(`${verb}(${path})`)}`
              : e.toolName === "apply_patch"
                ? `${ansi.tool("●")} ${ansi.bold("Patch")}`
                : `${ansi.tool("●")} ${ansi.bold(e.toolName)}${ansi.dim(`(${summarizeToolArgs(e.toolName, e.args)})`)}`;
          pushBlock({ kind: "tool", toolCallId: e.toolCallId, header });
          break;
        }
        case "tool_end": {
          const details = (e.result as { details?: { diff?: FileDiff; diffs?: FileDiff[] } } | undefined)?.details;
          const fullText = String((e.result?.content?.[0] as { text?: string } | undefined)?.text ?? "");
          const body: ToolBody | undefined = details?.diff
            ? { kind: "diff", diffs: [details.diff] }
            : Array.isArray(details?.diffs)
              ? { kind: "diff", diffs: details.diffs }
              : fullText
                ? {
                    kind: "text",
                    preview:
                      (readFileResultLine(details) ?? fullText.split("\n")[0] ?? "").slice(0, 80) || "(无输出)",
                    full: fullText,
                    isError: e.isError,
                  }
                : undefined;
          // 找到 tool_start 留下的 block，补上结果体（头部+结果同 block → 点击一起折叠）
          setBlocks((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              const b = prev[i];
              if (b.kind === "tool" && b.toolCallId === e.toolCallId && !b.body) {
                const next = [...prev];
                next[i] = { ...b, body, collapsed: body ? defaultCollapsed(body) : false };
                return next;
              }
            }
            // 没找到（理论上不会）：单push一个结果 block
            return body
              ? [...prev, { id: idRef.current++, kind: "tool" as const, toolCallId: e.toolCallId, header: ansi.dim("(tool)"), body, collapsed: defaultCollapsed(body) }]
              : prev;
          });
          break;
        }
        case "compaction_end": {
          // 压缩完成：lastContextTokens 已被 forge-agent 即时回填，刷新仪表盘
          const t = agent.telemetry;
          setDash({ turns: t.turns, inTok: t.inputTokens, outTok: t.outputTokens, cost: t.costRmb, ctxUsed: agent.contextTokens, cacheHit: t.cacheHitRate() });
          break;
        }
        case "run_end":
          setBusy(false);
          break;
        default:
          break;
      }
    });
  }, [agent, pushBlock]);

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
    bridge.convergentEvent = (e: HarnessEvent) => {
      switch (e.type) {
        case "message_update": {
          const ev = e.event as { type: string; delta?: string };
          if (ev.type === "text_delta" && ev.delta) convBufRef.current += ev.delta;
          break;
        }
        case "message_end":
          if ((e.message as { role?: string }).role === "assistant") {
            const t = convBufRef.current.trim();
            if (t) pushBlock({ kind: "markdown", source: t, prefix: ansi.amber("⟢ Convergent") });
            convBufRef.current = "";
          }
          break;
        case "tool_start":
          push(`${ansi.amber("⟢")} ${ansi.bold(e.toolName)}${ansi.dim(`(${summarizeToolArgs(e.toolName, e.args)})`)}`);
          break;
        case "tool_end": {
          const preview = String((e.result?.content?.[0] as { text?: string } | undefined)?.text ?? "").split("\n")[0].slice(0, 80);
          push(`  ${e.isError ? ansi.error("✗") : ansi.dim("⎿")} ${ansi.dim(preview)}`);
          break;
        }
        default:
          break;
      }
    };
  }, [bridge, push, pushBlock, runMain]);

  // busy 或长操作进行中：驱动 spinner / 状态行 / 计时刷新
  useEffect(() => {
    if (!busy && !working) return;
    const id = setInterval(() => setTick((x) => x + 1), 120);
    return () => clearInterval(id);
  }, [busy, working]);

  // Ctrl+C 接管（始终生效）：确认中=拒绝 / 运行中=中止回到输入 / 有输入=清空 / 空输入按两次=退出
  useInput((ch, key) => {
    if (!(key.ctrl && ch === "c")) return;
    // 选区激活且空闲 → Ctrl+C = 复制（Claude Code 语义）；运行中仍优先中止
    const cur = selRef.current;
    if (cur && !busy && working === null && confirm === null) {
      void copySelectionNow(cur.anchor, cur.active);
      setSel(null);
      return;
    }
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

  // 选区键盘互作：Esc 清选区；打字清选区；Shift+←/→ 移动活动端扩展（跨行边界）
  useInput(
    (input, key) => {
      const cur = selRef.current;
      if (key.escape) {
        setSel(null);
        return;
      }
      if (key.shift && (key.leftArrow || key.rightArrow)) {
        if (!cur) return;
        const lines = flatRef.current.lines;
        let { line, col } = cur.active;
        if (key.leftArrow) {
          if (col > 0) col -= 1;
          else if (line > 0) {
            line -= 1;
            col = visibleWidth(plainOf(lines[line] ?? ""));
          }
        } else {
          const w = visibleWidth(plainOf(lines[line] ?? ""));
          if (col < w) col += 1;
          else if (line < lines.length - 1) {
            line += 1;
            col = 0;
          }
        }
        setSel({ anchor: cur.anchor, active: { line, col } });
        return;
      }
      // 任何可打印输入清选区（开始打字 = 放弃选择）
      if (input && !key.ctrl && !key.meta && !key.return && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.tab && !key.backspace && !key.delete) {
        setSel(null);
      }
    },
    { isActive: confirm === null },
  );

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

  // 菜单打开时 ↑↓/Tab 控制菜单（↑↓ 循环选择 · Tab 补全）。
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

  // 选择器键盘：↑↓ 选择、Enter 确认、Esc 取消（打开期间 MultilineInput 整体失活）
  const confirmPicker = useCallback(async () => {
    const pk = pickerRef.current;
    if (!pk) return;
    const item = pk.items[pk.sel]!;
    setPicker(null);
    if (pk.kind === "resume") {
      if (item.meta && bridge.requestResume) {
        bridge.requestResume(item.meta);
        exit(); // index 循环重建 agent + App（挂载重放选中会话）
      }
      return;
    }
    // rewind：回退 → 重建 transcript → 原文放回输入框
    try {
      await agent.rewindTo(item.turn!.parentTip);
      const entries = await agent.conversationEntries();
      resetBlockCache(); // block id 从头重计：不翻新代数会撞旧缓存 key、渲染出旧内容
      const banner = blocksRef.current[0]; // banner block 保留
      idRef.current = 1;
      const replayed = replayBlocks(entries).map((b) => ({ ...b, id: idRef.current++ }) as Block);
      setBlocks(banner ? [banner, ...replayed] : replayed);
      setInput(item.turn!.text);
      histIdxRef.current = null;
      setToast("⏪ 已回退，消息已放回输入框（编辑后重发）");
      setScrollOffset(0);
      setNewCount(0);
    } catch (err) {
      push(ansi.error(`rewind 失败：${(err as Error).message}`));
    }
  }, [agent, bridge, exit, push]);

  useInput(
    (_ch, key) => {
      const pk = pickerRef.current;
      if (!pk) return;
      if (key.escape) return setPicker(null);
      if (key.upArrow || key.downArrow) {
        const next = key.upArrow ? pk.sel - 1 : pk.sel + 1;
        setPicker({ ...pk, sel: (next + pk.items.length) % pk.items.length });
        return;
      }
      if (key.return) void confirmPicker();
    },
    { isActive: picker !== null },
  );

  // 视口滚动键：PgUp/PgDn 半屏，Shift+↑/↓ 单行，Ctrl+End 跳底恢复跟随
  useInput(
    (_ch, key) => {
      const height = viewportHeightRef.current;
      const total = flatRef.current.lines.length;
      if (key.pageUp) return setScrollOffset(scrollBy({ total, height, offset: scrollOffsetRef.current }, Math.max(3, Math.floor(height / 2))));
      if (key.pageDown) return scrollEnd(-Math.max(3, Math.floor(height / 2)));
      if (key.upArrow && key.shift) return setScrollOffset(scrollBy({ total, height, offset: scrollOffsetRef.current }, 1));
      if (key.downArrow && key.shift) return scrollEnd(-1);
      if (key.end && key.ctrl) return jumpToBottom();
    },
    { isActive: confirm === null },
  );

  const jumpToBottom = useCallback(() => {
    setScrollOffset(0);
    setNewCount(0);
  }, []);
  const scrollEnd = useCallback((delta: number) => {
    setScrollOffset((prev) => {
      const next = scrollBy({ total: flatRef.current.lines.length, height: viewportHeightRef.current, offset: prev }, delta);
      if (next === 0) setNewCount(0);
      return next;
    });
  }, []);

  // 命令历史翻页（MultilineInput 在首行↑ / 尾行↓ 时回调）。histIdx=null 表示在编辑新输入。
  const historyPrev = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const cur = histIdxRef.current;
    const idx = cur === null ? h.length - 1 : Math.max(0, cur - 1);
    histIdxRef.current = idx;
    setInput(h[idx]!);
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
      setInput(h[idx]!);
    }
  }, []);

  // 斜杠命令分发表：加命令 = 这里加一条 + commands.ts 的 COMMANDS 加一条。
  const slashHandlers = useMemo<Record<string, () => void | Promise<void>>>(
    () => ({
      "/stats": () => push(agent.telemetry.summary()),
      "/pass-permissions": () => {
        agent.passPermissions(); // 默认已开：此命令现在只是显式确认（幂等）
        setBypass(true);
        push(ansi.dim("Permission bypass 已默认开启（--confirm 可回到逐次确认）。灾难命令仍被硬拦。"));
      },
      "/skills": () => {
        const sk = agent.listSkills();
        push(sk.length ? sk.map((s) => `  · \x1b[1m${s.name}\x1b[0m ${s.description}`).join("\n") : ansi.dim("(no skills loaded)"));
      },
      "/resume": async () => {
        if (busy || working !== null) return push(ansi.dim("运行中不可 /resume（先 Ctrl+C 中止）"));
        const all = await ForgeAgent.listSessions(config);
        const sessions = all
          .filter((x) => x.id !== agent.sessionId)
          .sort((a, b) => b.modifiedAt - a.modifiedAt)
          .slice(0, 15);
        // 过滤空壳会话（崩溃/强杀残留：只有 header 没有用户消息）
        const items = sessions
          .map((m) => ({ key: m.id, label: `${relTime(m.modifiedAt)} · ${firstUserPreviewSync(m.path)}`, meta: m }))
          .filter((x) => x.label.includes("· ") && !x.label.endsWith("· "))
          .slice(0, 10);
        if (!items.length) return push(ansi.dim("没有可恢复的历史会话"));
        setPicker({ kind: "resume", items, sel: 0 });
      },
      "/rewind": async () => {
        if (busy || working !== null) return push(ansi.dim("运行中不可 /rewind（先 Ctrl+C 中止）"));
        const turns = await agent.userTurns();
        if (!turns.length) return push(ansi.dim("没有可回退的用户消息"));
        setPicker({
          kind: "rewind",
          items: turns.map((t) => ({ key: t.entryId, label: `#${t.index + 1} ${t.text.replace(/\s+/g, " ").slice(0, 50)}`, turn: { parentTip: t.parentTip, text: t.text } })),
          sel: 0,
        });
      },
      "/mouse": () => {
        const next = !mouseOn;
        setMouseOn(next);
        push(
          next
            ? ansi.dim("鼠标捕获已开启（滚轮/点击可用）。原生选择需按住修饰键：Terminal.app=Fn · iTerm2=Option · VSCode/多数终端=Shift。")
            : ansi.dim("鼠标捕获已关闭——现在可以拖拽选择文本、Cmd+C 复制（滚轮/点击失效，键盘 PgUp/PgDn 仍可滚动）。/mouse 重新开启。"),
        );
      },
      "/compact": async () => {
        try {
          await agent.compactNow();
        } catch (err) {
          push(ansi.error(`Compaction failed: ${(err as Error).message}`));
        }
      },
    }),
    [agent, push, mouseOn],
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
      pushBlock({ kind: "user", text: line });
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
    [agent, exit, push, pushBlock, menuIdx, runMain, slashHandlers],
  );

  // ── 视口与布局（每帧重算；block 行渲染有 (id,width) 记忆化兜底）──────────────────
  const secs = busy ? Math.floor((Date.now() - turnStartRef.current) / 1000) : 0;
  const wsecs = working && workStartRef.current ? Math.floor((Date.now() - workStartRef.current) / 1000) : 0;
  const estTok = Math.round(bufRef.current.length / 4);
  const win = agent.contextWindow;
  const pct = win ? Math.min(100, Math.round((dash.ctxUsed / win) * 100)) : 0;
  const model = config.modelRef.split("/")[1] ?? config.modelRef;
  const sb = getSandboxStatus();
  const frame = sparkFrame();

  const width = Math.max(20, termCols);
  const flat = useMemo(() => flattenBlocks(blocks, width), [blocks, width]);

  // chrome（视口之下的固定区）各段行数，自上而下：
  const reasoningLines =
    busy && thinkRef.current && !bufRef.current
      ? wrapVisible(thinkRef.current.trim(), width - 4).split("\n").slice(-8)
      : [];
  const jumpLine = scrollOffset > 0 ? 1 : 0;
  const menuLines = menuOpen && !confirm ? menuMatches.length + 1 : 0;
  const pickerLines = picker ? picker.items.length + 1 : 0;
  const subDashLines = agent.subTelemetry.turns > 0 ? 1 : 0;
  const subStatusLines = subStatus ? 1 : 0;
  const toastLine = toast ? 1 : 0;
  const chromeHeight =
    toastLine +
    jumpLine +
    reasoningLines.length +
    (busy ? 1 : 0) +
    (working ? 1 : 0) +
    menuLines +
    pickerLines +
    3 + // 输入框：上下边框 + 内容行
    1 + // 仪表盘
    subDashLines +
    subStatusLines;
  // 视口高度 = 终端行数 − chrome − 1 安全行：帧高恰好顶满终端时，写最后一行会引发
  // 屏幕上滚一格 → 整帧错位级联（实测 PTY 里字符逐行炸开）。留 1 行余量根治。
  const viewportHeight = Math.max(0, termRows - chromeHeight - 1);

  const vis = visible({ total: flat.lines.length, height: viewportHeight, offset: scrollOffset });
  // offset 被钳制（resize/内容缩短）时同步回 state
  if (vis.clampedOffset !== scrollOffset) setScrollOffset(vis.clampedOffset);

  // 跟随暂停时累计新行；恢复跟随时清零
  useEffect(() => {
    const total = flat.lines.length;
    const delta = total - prevTotalRef.current;
    prevTotalRef.current = total;
    if (delta > 0 && scrollOffsetRef.current > 0) setNewCount((n) => n + delta);
    else if (scrollOffsetRef.current === 0) setNewCount(0);
  }, [flat.lines.length]);

  // 供输入处理闭包读的「本帧」值
  const flatRef = useRef(flat);
  flatRef.current = flat;
  const viewportHeightRef = useRef(viewportHeight);
  viewportHeightRef.current = viewportHeight;

  // 可见行 → blockId 映射 + chrome 各可点区行号（屏幕 1-based 行）——每次渲染后更新供鼠标命中
  const zonesRef = useRef<{ viewportRows: number; jumpRow: number | null; menuTop: number | null; pickerTop: number | null; inputRow: number | null }>({
    viewportRows: 0,
    jumpRow: null,
    menuTop: null,
    pickerTop: null,
    inputRow: null,
  });
  zonesRef.current = (() => {
    let row = viewportHeight; // 视口占 1..viewportHeight
    const z = { viewportRows: viewportHeight, jumpRow: null as number | null, menuTop: null as number | null, pickerTop: null as number | null, inputRow: null as number | null };
    row += toastLine;
    row += jumpLine;
    if (jumpLine) z.jumpRow = row;
    row += reasoningLines.length;
    row += busy ? 1 : 0;
    row += working ? 1 : 0;
    if (menuLines) {
      z.menuTop = row + 1; // 菜单第一项（1-based）
      row += menuLines;
    }
    if (pickerLines) {
      z.pickerTop = row + 1;
      row += pickerLines;
    }
    row += 1; // 输入框上边框
    z.inputRow = row + 1;
    return z;
  })();

  // ── 鼠标 ────────────────────────────────────────────────────────────────────
  const toggleToolBlock = useCallback((toolCallIdOrBlockId: number) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === toolCallIdOrBlockId && b.kind === "tool" && b.body ? { ...b, collapsed: !b.collapsed } : b)),
    );
    setSel(null); // 折叠切换会让行号重排，选区失效
  }, []);

  /** 复制当前选区（copy-on-select；FORGE_COPY_ON_SELECT=0 关闭自动、只留 Ctrl+C 手动）。 */
  const copySelectionNow = useCallback(
    async (anchor: { line: number; col: number }, active: { line: number; col: number }) => {
      if (process.env.FORGE_COPY_ON_SELECT === "0") return;
      const text = selectedText(flatRef.current.lines, normalizeRange(anchor, active));
      if (!text.trim()) return;
      const r = await copyText(text);
      setToast(`⧉ 已复制 ${text.length} 字符 → ${r.path}`);
    },
    [push],
  );

  useEffect(() => {
    return mouseStdin.onMouseEvent((ev: MouseEvent) => {
      const total = flatRef.current.lines.length;
      if (ev.kind === "wheel") {
        const delta = ev.button === 64 ? 3 : -3; // 64=上滚(看历史) 65=下滚
        setScrollOffset((prev) => {
          const next = scrollBy({ total, height: viewportHeightRef.current, offset: prev }, delta);
          if (next === 0) setNewCount(0);
          return next;
        });
        return;
      }
      if (ev.button !== 0) return; // v1 只处理左键（选择/点击）
      const z = zonesRef.current;
      const inViewport = ev.row >= 1 && ev.row <= z.viewportRows;
      /** 屏幕行 → 全局行（可带 offset 覆盖：边缘自动滚后按新视口算） */
      const lineUnder = (row: number, offsetOverride?: number) => {
        const v = visible({ total, height: viewportHeightRef.current, offset: offsetOverride ?? scrollOffsetRef.current });
        return v.start + (row - 1);
      };
      const textCol = (col: number) => Math.max(0, col - 1); // 屏幕 1-based → 行内 0-based 可见列

      // ── 按下：记拖拽起点（视口内才可能拖选；先不动作，等松开区分单击/拖拽）──
      if (ev.kind === "press") {
        dragRef.current = inViewport
          ? { startRow: ev.row, startLine: lineUnder(ev.row), startCol: textCol(ev.col), moved: false }
          : null;
        return;
      }

      // ── 拖动：跨格才算选择；拖到视口上下边缘自动滚 1 行 ──
      if (ev.kind === "motion") {
        const d = dragRef.current;
        if (!d) return;
        if (!d.moved && (ev.row !== d.startRow || ev.col !== d.startCol)) d.moved = true;
        if (!d.moved) return;
        let offset = scrollOffsetRef.current;
        if (ev.row <= 1) {
          offset = scrollBy({ total, height: viewportHeightRef.current, offset }, 1);
          setScrollOffset(offset);
        } else if (ev.row >= z.viewportRows) {
          offset = scrollBy({ total, height: viewportHeightRef.current, offset }, -1);
          if (offset === 0) setNewCount(0);
          setScrollOffset(offset);
        }
        setSel({ anchor: { line: d.startLine, col: d.startCol }, active: { line: lineUnder(ev.row, offset), col: textCol(ev.col) } });
        return;
      }

      // ── 松开 ──
      if (ev.kind === "release") {
        const d = dragRef.current;
        dragRef.current = null;
        if (d?.moved) {
          // 拖拽结束：定格选区 + 松开即复制
          const anchor = { line: d.startLine, col: d.startCol };
          const active = { line: lineUnder(ev.row), col: textCol(ev.col) };
          setSel({ anchor, active });
          void copySelectionNow(anchor, active);
          return;
        }
        // 单击：先双击/三击判定（同格 <500ms）——二击选词、三击选行，选中即复制
        const lc = lastClickRef.current;
        const same = lc.row === ev.row && lc.col === ev.col && Date.now() - lc.ts < 500;
        const count = same ? lc.count + 1 : 1;
        lastClickRef.current = { ts: Date.now(), row: ev.row, col: ev.col, count: count >= 3 ? 0 : count };
        if (inViewport) {
          const lineIdx = lineUnder(ev.row);
          const lineText = flatRef.current.lines[lineIdx];
          if (lineText !== undefined && count >= 2) {
            const plain = plainOf(lineText);
            const [c0, c1] = count === 2 ? expandWord(plain, textCol(ev.col)) : wholeLine(plain);
            const anchor = { line: lineIdx, col: c0 };
            const active = { line: lineIdx, col: c1 };
            setSel({ anchor, active });
            void copySelectionNow(anchor, active);
            return;
          }
          setSel(null); // 普通单击清选区
        }
        // 既有单击路由：Jump 按钮 / 菜单 / 输入框定位 / 工具折叠
        if (z.jumpRow === ev.row) return jumpToBottom();
        if (z.pickerTop !== null && ev.row >= z.pickerTop && ev.row < z.pickerTop + (pickerRef.current?.items.length ?? 0)) {
          const idx = ev.row - z.pickerTop;
          if (pickerRef.current && idx === pickerRef.current.sel) void confirmPicker(); // 点选中项 = 确认
          else setPicker({ ...pickerRef.current!, sel: idx });
          return;
        }
        if (z.menuTop !== null && ev.row >= z.menuTop && ev.row < z.menuTop + menuMatches.length) {
          setMenuIdx(ev.row - z.menuTop);
          return;
        }
        if (z.inputRow === ev.row && confirm === null) {
          setCursorCol(Math.max(0, ev.col - 2)); // `› ` 前缀占 2 列
          return;
        }
        if (inViewport) {
          const lineIdx = lineUnder(ev.row);
          const blockId = flatRef.current.owner[lineIdx];
          if (blockId !== undefined) {
            const b = blocksRef.current.find((x) => x.id === blockId);
            if (b?.kind === "tool" && b.body) toggleToolBlock(b.id);
          }
        }
      }
    });
  }, [mouseStdin, confirm, menuMatches.length, jumpToBottom, toggleToolBlock, copySelectionNow]);

  const visStartRef = useRef(vis.start);
  visStartRef.current = vis.start;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // 视口行 + 选区高亮（区间内选择性反显；中间行整行 = [0, ∞)）
  const selRange = sel ? normalizeRange(sel.anchor, sel.active) : null;
  const viewportText = flat.lines
    .slice(vis.start, vis.start + vis.count)
    .map((l, i) => {
      if (!selRange) return l;
      const rng = lineRangeInSel(selRange, vis.start + i);
      return rng ? highlightRange(l, rng[0], rng[1]) : l;
    })
    .join("\n");

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={viewportHeight}>
        <Text>{viewportText}</Text>
      </Box>

      {toast && (
        <Box justifyContent="flex-end">
          <Text color={theme.muted}>{toast}</Text>
        </Box>
      )}

      {scrollOffset > 0 && (
        <Box>
          <Text color={theme.amber}>
            {`↺ ${newCount > 0 ? `${newCount} new · ` : ""}Jump to bottom（点击 / 滚到底 / Ctrl+End）`}
          </Text>
        </Box>
      )}

      {reasoningLines.length > 0 && (
        <Box flexDirection="column">
          <Text color={theme.muted}>{`${frame} Reasoning`}</Text>
          {reasoningLines.map((l, i) => (
            <Text key={i} color={theme.muted}>
              {`  ${l}`}
            </Text>
          ))}
        </Box>
      )}

      {busy && (
        <Box>
          <Text color={theme.muted}>
            {`${frame} Thinking (${secs}s${estTok > 0 ? ` · ~${estTok} tokens` : ""})`}
          </Text>
        </Box>
      )}

      {working && (
        <Box>
          <Text color={theme.amber}>{`↻ ${working}`}</Text>
          <Text color={theme.muted}>{` (${wsecs}s)`}</Text>
        </Box>
      )}

      {menuOpen && !confirm && (
        <Box flexDirection="column">
          {menuMatches.map((c, i) => (
            <Text key={c.name} color={i === menuSel ? theme.prompt : theme.muted}>
              {`${i === menuSel ? "❯" : " "} ${c.name}   ${c.desc}`}
            </Text>
          ))}
          <Text color={theme.muted}>{"  ↑↓ select · Tab complete · Enter run"}</Text>
        </Box>
      )}

      {picker && (
        <Box flexDirection="column">
          {picker.items.map((it, i) => (
            <Text key={it.key} color={i === picker.sel ? theme.prompt : theme.muted}>
              {`${i === picker.sel ? "❯" : " "} ${it.label}`}
            </Text>
          ))}
          <Text color={theme.muted}>{`  ↑↓ 选择 · Enter 确认 · Esc 取消（${picker.kind === "resume" ? "恢复该会话" : "回退到该消息"}）`}</Text>
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
              menuOpen={menuOpen || picker !== null}
              isActive={confirm === null && picker === null}
              cursorRequest={cursorCol}
              onCursorRequestHandled={() => setCursorCol(null)}
            />
            {!input && <Text color={theme.muted}>Type a request · /exit to quit</Text>}
          </Box>
        )}
      </Box>

      <Box>
        <Text color={theme.muted}>
          ▌ {model} · ctx {human(dash.ctxUsed)}/{human(win)} ({pct}%) · {dash.turns} turns · ↑{human(dash.inTok)} ↓
          {human(dash.outTok)} tok · cache {Math.round(dash.cacheHit * 100)}% · ¥{dash.cost.toFixed(4)}
          {bypass ? <Text color={theme.error}> · bypass</Text> : ""}
          {sb.backend === "none"
            ? sb.enabled
              ? <Text color={theme.amber}> · ⚠ 未沙箱</Text>
              : ""
            : ` · ${sb.backend}`}
        </Text>
      </Box>

      {agent.subTelemetry.turns > 0 && (
        <Box>
          <Text color={theme.muted}>
            ▌ {agent.subTelemetry.model || "subagent"} · {agent.subTelemetry.turns} turns · ↑{human(agent.subTelemetry.inputTokens)} ↓
            {human(agent.subTelemetry.outputTokens)} tok · ¥{agent.subTelemetry.costRmb.toFixed(4)}
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
