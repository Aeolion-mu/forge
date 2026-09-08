import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import type { HarnessEvent } from "@earendil-works/pi-agent-core";
import { renderMarkdown } from "./markdown.js";
import { summarizeToolArgs, readFileResultLine } from "./render.js";
import { theme, ansi, sparkFrame, SPARK_REST, renderBanner } from "./theme.js";
import { renderFileDiff, type FileDiff } from "./diff.js";
import { matchCommands, menuShouldOpen, resolveSubmitted } from "./commands.js";
import { createRunQueue } from "./run-queue.js";
import { ctrlCAction } from "./keybinds.js";
import { getSandboxStatus } from "../sandbox/exec.js";
import { explainApiError } from "../kernel/errors.js";
import { readSkillContent } from "../kernel/skills.js";
import { defaultCollapsed, flattenBlocks, resetBlockCache, type Block, type NewBlock, type ToolBody, type ThoughtTool } from "./blocks.js";
import { visible, scrollBy } from "./viewport.js";
import type { MouseEvent, MouseStdin } from "./terminal-io.js";
import { wrapVisible, visibleWidth, truncateVisible } from "./markdown.js";
import { MultilineInput } from "./multiline-input.js";
import { normalizeRange, lineRangeInSel, highlightRange, plainOf, expandWord, wholeLine, selectedText } from "./selection.js";
import { copyText } from "./clipboard.js";
import { replayBlocks, firstUserPreviewSync } from "./session-replay.js";
import { inputLineCount, inputCharAtScreen, normalizeInputSelection, type InputSelection } from "./input-selection.js";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";

// 写类工具在 tool_start 显示的动词表头（diff 详情在 end 补上）。
const WRITE_VERB: Record<string, string> = { edit_file: "Update", write_file: "Write" };
import { ForgeAgent } from "../kernel/forge-agent.js";
import type { SubAgentInfo } from "../tools/subagent.js";
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

/** tool_end 事件 → 结果体（主 agent 与子 agent transcript 共用的构造）。 */
function buildToolBody(e: { result?: unknown; isError?: boolean }): ToolBody | undefined {
  const details = (e.result as { details?: { diff?: FileDiff; diffs?: FileDiff[] } } | undefined)?.details;
  const fullText = String((e.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? "");
  if (details?.diff) return { kind: "diff", diffs: [details.diff] };
  if (Array.isArray(details?.diffs)) return { kind: "diff", diffs: details.diffs };
  return fullText
    ? {
        kind: "text",
        preview: (readFileResultLine(details) ?? fullText.split("\n")[0] ?? "").slice(0, 80) || "(无输出)",
        full: fullText,
        isError: e.isError,
      }
    : undefined;
}

/** tool_start 事件 → 头部行（主 agent 与子 agent transcript 共用的构造）。 */
function buildToolHeader(e: { toolName: string; args?: unknown }): string {
  const verb = WRITE_VERB[e.toolName];
  const path = (e.args as { path?: string } | undefined)?.path;
  if (verb && path) return `${ansi.tool("●")} ${ansi.bold(`${verb}(${path})`)}`;
  if (e.toolName === "apply_patch") return `${ansi.tool("●")} ${ansi.bold("Patch")}`;
  return `${ansi.tool("●")} ${ansi.bold(e.toolName)}${ansi.dim(`(${summarizeToolArgs(e.toolName, e.args)})`)}`;
}

/** tool_end 结果体 → thought 展开明细的结果首行（diff 块本身保持可见，无需预览）。 */
function thoughtPreview(body: ToolBody | undefined): string | undefined {
  if (!body || body.kind !== "text") return undefined;
  return body.preview ?? body.full?.split("\n")[0];
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
  /** 子 agent 注册表有变化（spawn/进度/结束）时 ping；App 重读 listSubAgents 渲染状态行。 */
  subagent: () => void;
  /** 后台子 agent 完成 → 作为新一轮喂回主 agent（串行调度，不阻塞）。 */
  resume: (text: string) => void;
  /** 后台子 agent 的事件流（id + 事件）：App 维护每个子 agent 的 transcript，供上下文切换。 */
  subagentEvent: (id: string, e: HarnessEvent) => void;
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
 * 选择：视口与 chrome 信息行（模型信息 / 子 agent 状态行等）同一套拖选/双击选词/
 * 三击选行管线（松开即复制，Ctrl+C 手动复制）；输入框内容为字符级拖选（打字替换选中段）。
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
  const [dash, setDash] = useState({ turns: 0, inTok: 0, outTok: 0, cost: 0, ctxUsed: 0, cacheHit: 0 });
  // 长操作进度（压缩等）：非 null 时在输入框上方显示动态状态行。
  const [working, setWorking] = useState<string | null>(null);
  // 子 agent 重绘信号：注册表 ping / transcript 新 block / 秒级走时 → bump 触发重渲染
  //（状态行与子 transcript 都从 ref/live 数据读，不进 React state）。
  const [subTick, setSubTick] = useState(0);
  const bumpSub = useCallback(() => setSubTick((x) => x + 1), []);
  // 当前查看的上下文：主 agent 或某个子 agent（点击状态行 / /agents <id> 进入，Esc 返回）。
  const [view, setView] = useState<{ kind: "main" } | { kind: "sub"; id: string }>({ kind: "main" });
  const viewRef = useRef(view);
  viewRef.current = view;
  // running 子 agent 清单的同步镜像（鼠标命中闭包读，避免 stale）。
  const subRunningRef = useRef<SubAgentInfo[]>([]);
  const subAgentsRef = useRef<SubAgentInfo[]>([]);
  // 每个子 agent 的 transcript（block 列表 + 流式文本缓冲）。block id 用独立计数器，
  // 与主转录靠 flattenBlocks 的 ns（"sub:<id>"）隔离渲染缓存键。
  const subTranscriptsRef = useRef(new Map<string, { blocks: Block[]; buf: string }>());
  const subIdRef = useRef(0);
  // 斜杠命令菜单当前选中项下标。
  const [menuIdx, setMenuIdx] = useState(0);
  // 视口滚动：offset = 视口底边之上的隐藏行数（0 = 跟随底部）。
  const [scrollOffset, setScrollOffset] = useState(0);
  // 跟随暂停期间累计的新行数（Jump 按钮「N new」）。
  const [newCount, setNewCount] = useState(0);
  // 鼠标点击输入框 → 请求把光标移到该字符下标（消费后置 null）。
  const [cursorCol, setCursorCol] = useState<number | null>(null);
  // 输入框内鼠标拖选（value 字符下标 anchor→active）；打字/删除即替换并清空（MultilineInput 内处理）。
  const [inputSel, setInputSel] = useState<InputSelection | null>(null);
  const inputSelRef = useRef<InputSelection | null>(null);
  inputSelRef.current = inputSel;
  const inputRef = useRef(input);
  inputRef.current = input;
  // 输入区拖拽进行时：起点字符下标 + 是否真的拖动了（没动 = 单击定位光标）。
  const inputDragRef = useRef<{ startChar: number; moved: boolean } | null>(null);
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
    ioOut.write(mouseOn ? "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h" : "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l"); // 1002=拖选 1003=悬停
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
  // 回合累积器（Claude Code 式「Thought for …」摘要块的 live 数据面）：message_start 建、
  // tool_start/end 记工具、message_end 收思考、turn_end 折叠成块。中止（无 turn_end）即弃——
  // 半途的现场块保持原样，诚实呈现「这回合没跑完」。
  const thoughtRef = useRef<{ thinking: string; tools: ThoughtTool[] } | null>(null);
  // 鼠标悬停中的 thought block id（折叠摘要行变白）。变化才 setState，避免逐像素重渲染。
  const [hoverId, setHoverId] = useState<number | null>(null);
  const hoverIdRef = useRef<number | null>(null);
  hoverIdRef.current = hoverId;

  const pushBlock = useCallback((b: NewBlock) => {
    setBlocks((prev) => [...prev, { ...b, id: idRef.current++ } as Block]);
  }, []);
  const push = useCallback((text: string) => pushBlock({ kind: "plain", text }), [pushBlock]);

  // ── 子 agent transcript（上下文切换查看）────────────────────────────────────
  /** 取/建某子 agent 的 transcript；首次访问时先种一条「指派任务」user block。 */
  const subTranscriptOf = useCallback(
    (id: string): { blocks: Block[]; buf: string } => {
      const map = subTranscriptsRef.current;
      let t = map.get(id);
      if (!t) {
        t = { blocks: [], buf: "" };
        const info = agent.listSubAgents().find((x) => x.id === id);
        t.blocks.push({ id: subIdRef.current++, kind: "user", text: info ? `${info.task}\n${ansi.dim(`（子任务 · ${info.id}[${info.role}]）`)}` : "(任务原文不可用)" });
        map.set(id, t);
      }
      return t;
    },
    [agent],
  );
  const pushSubBlock = useCallback(
    (id: string, b: NewBlock) => {
      const t = subTranscriptOf(id);
      t.blocks.push({ ...b, id: subIdRef.current++ } as Block);
      bumpSub();
    },
    [subTranscriptOf, bumpSub],
  );
  /** 子 agent 事件流 → 其 transcript 的 block（比主流程轻：无 spinner/仪表盘，turn 行收尾）。 */
  const handleSubEvent = useCallback(
    (id: string, e: HarnessEvent) => {
      const t = subTranscriptOf(id);
      switch (e.type) {
        case "message_start":
          if ((e.message as { role?: string }).role === "assistant") t.buf = "";
          break;
        case "message_update": {
          const ev = e.event as { type: string; delta?: string };
          if (ev.type === "text_delta" && ev.delta) t.buf += ev.delta;
          break;
        }
        case "message_end":
          if ((e.message as { role?: string }).role === "assistant") {
            const txt = t.buf.trim();
            if (txt) t.blocks.push({ id: subIdRef.current++, kind: "markdown", source: txt });
            t.buf = "";
            bumpSub();
          }
          break;
        case "tool_start":
          t.blocks.push({ id: subIdRef.current++, kind: "tool", toolCallId: e.toolCallId, header: buildToolHeader(e) });
          bumpSub();
          break;
        case "tool_end": {
          const body = buildToolBody(e);
          for (let i = t.blocks.length - 1; i >= 0; i--) {
            const b = t.blocks[i]!;
            if (b.kind === "tool" && b.toolCallId === e.toolCallId) {
              t.blocks[i] = { ...b, body, collapsed: body ? defaultCollapsed(body) : false };
              break;
            }
          }
          bumpSub();
          break;
        }
        default:
          break;
      }
    },
    [subTranscriptOf, bumpSub],
  );
  /** 切到某子 agent 的上下文（点击状态行 / /agents <id>）；重置滚动钉底。 */
  const openSubView = useCallback(
    (id: string) => {
      subTranscriptOf(id); // 确保 transcript 存在（种任务 block）
      setView({ kind: "sub", id });
      setScrollOffset(0);
      setNewCount(0);
    },
    [subTranscriptOf],
  );
  /** 返回主上下文（Esc / 点击子视图头部）。 */
  const closeSubView = useCallback(() => {
    setView({ kind: "main" });
    setScrollOffset(0);
    setNewCount(0);
  }, []);

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
      if (resumedFrom) {
        pushBlock({ kind: "plain", text: ansi.dim(`⏵ 已恢复会话 ${resumedFrom.id.slice(0, 8)}（${entries.length} 条消息）——继续对话即可`) });
        // 种输入历史：会话里已有的用户消息按时间序进 ↑/↓ 历史——否则 resume 后
        // 重建的 App 历史为空，之前的消息无法用 ↑ 召回（斜杠命令不曾入会话树，天然缺席）。
        const past: string[] = [];
        for (const e of entries) {
          if (e.type !== "message") continue;
          const msg = e.message as { role?: string; content?: unknown };
          if (msg.role !== "user") continue;
          const c = msg.content;
          const text = typeof c === "string" ? c : Array.isArray(c)
            ? (c as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("")
            : "";
          if (text.trim()) past.push(text);
        }
        historyRef.current = past.slice(-500); // 上限防超长会话拖内存
      }
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
            // 整回合计时：首条消息定锚（中途工具循环的 message_start 不重置）
            if (!turnStartRef.current) turnStartRef.current = Date.now();
            if (!thoughtRef.current) thoughtRef.current = { thinking: "", tools: [] };
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
            // 思考全文收进回合累积器（多段以空行相接）——不再丢弃，摘要行可展开查看
            const think = thinkRef.current.trim();
            if (think && thoughtRef.current) {
              thoughtRef.current.thinking += (thoughtRef.current.thinking ? "\n\n" : "") + think;
            }
            const t = bufRef.current.trim();
            if (t) pushBlock({ kind: "markdown", source: t });
            bufRef.current = "";
            thinkRef.current = "";
          }
          break;
        case "turn_end": {
          const th = thoughtRef.current;
          thoughtRef.current = null;
          const secs = turnStartRef.current ? (Date.now() - turnStartRef.current) / 1000 : 0;
          turnStartRef.current = 0;
          // 折叠成 Claude Code 式摘要行：读类（非 diff）工具块收进 thought（点开才见），
          // 写类 diff 块保持可见；摘要行插在回合最终回复之前（无回复文本则追加末尾）。
          setBlocks((prev) => {
            const kept = prev.filter(
              (b) =>
                !(b.kind === "tool" && b.body?.kind !== "diff" && th?.tools.some((t) => t.toolCallId === b.toolCallId)),
            );
            if (!th || (!th.thinking && !th.tools.length)) return kept;
            const blk: Block = { id: idRef.current++, kind: "thought", secs, thinking: th.thinking, tools: th.tools };
            const last = kept[kept.length - 1];
            const at = last?.kind === "markdown" ? kept.length - 1 : kept.length;
            return [...kept.slice(0, at), blk, ...kept.slice(at)];
          });
          const t = agent.telemetry;
          setDash({ turns: t.turns, inTok: t.inputTokens, outTok: t.outputTokens, cost: t.costRmb, ctxUsed: agent.contextTokens, cacheHit: t.cacheHitRate() });
          break;
        }
        case "tool_start": {
          const header = buildToolHeader(e);
          pushBlock({ kind: "tool", toolCallId: e.toolCallId, header });
          thoughtRef.current?.tools.push({ name: e.toolName, header, toolCallId: e.toolCallId });
          break;
        }
        case "tool_end": {
          const body = buildToolBody(e);
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
          // 结果首行回填回合累积器（摘要行展开明细用）
          const rec = thoughtRef.current?.tools.find((t) => t.toolCallId === e.toolCallId);
          if (rec) rec.preview = thoughtPreview(body);
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
          turnStartRef.current = 0;
          thoughtRef.current = null; // 中止（无 turn_end）：累积器弃用，现场块保持原样
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
    bridge.subagent = () => bumpSub(); // 注册表变化 → 重读 listSubAgents 重画状态行
    bridge.subagentEvent = (id, e) => handleSubEvent(id, e);
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
  }, [bridge, push, pushBlock, runMain, bumpSub, handleSubEvent]);

  // busy 或长操作进行中：驱动 spinner / 状态行 / 计时/思考流刷新
  const [tick, setTick] = useState(0);
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
    // 输入框选区激活且空闲 → Ctrl+C = 复制输入选区；运行中仍优先中止
    const isel = inputSelRef.current;
    if (normalizeInputSelection(isel) && !busy && working === null && confirm === null) {
      void copyInputSelectionNow(isel!.anchor, isel!.active);
      setInputSel(null);
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

  // 选区键盘互作：Esc 返回主上下文（子视图中）/ 清选区；打字清选区；Shift+←/→ 移动活动端扩展
  useInput(
    (input, key) => {
      const cur = selRef.current;
      if (key.escape) {
        if (viewRef.current.kind === "sub") closeSubView(); // 先返回主上下文
        else setSel(null);
        return;
      }
      if (key.shift && (key.leftArrow || key.rightArrow)) {
        if (!cur) return;
        const lines = screenRef.current.lines; // 视口行 + chrome 文本行（选区可跨两者）
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
  // 历史浏览期间暂存草稿：↑ 进入浏览时记住未提交的输入，↓ 翻回最新时原样恢复（不丢字）。
  const draftRef = useRef<string | null>(null);
  const historyPrev = useCallback(() => {
    const h = historyRef.current;
    if (h.length === 0) return;
    const cur = histIdxRef.current;
    if (cur === null) draftRef.current = inputRef.current; // 首次进入浏览：存草稿
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
      setInput(draftRef.current ?? ""); // 翻回最新：恢复进入浏览前的草稿
      draftRef.current = null;
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
        const rs = agent.skillsRegistry.records;
        if (!rs.length) return push(ansi.dim("(no skills loaded)"));
        push(
          rs
            .map((r) => {
              const tags = [r.source, r.origin ?? r.layer, ...(r.targets.length ? [r.targets.join(",")] : []), ...(r.nameOnly ? ["name-only"] : []), ...(r.invocation.model ? [] : ["user-only"])];
              return `  · ${ansi.bold(r.name)} ${r.description}${ansi.dim(` 〔${tags.join(" · ")}〕`)}`;
            })
            .join("\n") +
            ansi.dim(
              `\n  共 ${rs.length} 个 · 索引快照 ≈${Math.round(agent.skillsRegistry.indexBlock.length / 4)} tok · 会话内锁定（文件变更下个会话生效） · /skills <name> 显式注入`,
            ) +
            (agent.skillsRegistry.availableTargets.filter((t) => !config.skills.targets.includes(t)).length
              ? ansi.amber(
                  `\n  ⚠ 未激活的 target：${agent.skillsRegistry.availableTargets.filter((t) => !config.skills.targets.includes(t)).join(", ")} —— forge.config.json → skills.targets 加入并重启生效`,
                )
              : "") +
            (agent.skillsRegistry.diagnostics.length
              ? ansi.error(`\n  ⚠ ${agent.skillsRegistry.diagnostics.length} 条诊断（覆盖/缺 vendor 等）`)
              : ""),
        );
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
      "/agents": () => {
        const xs = agent.listSubAgents();
        if (!xs.length) return push(ansi.dim("暂无子 agent——主 agent spawn_subagent 后会出现在底部状态行（可点击查看）。"));
        push(
          xs.map((x) => `  ${x.id} [${x.role}] ${x.status} · ${x.turns} 轮 / ${x.tools} 工具 · ${x.elapsedSec}s`).join("\n") +
            ansi.dim("\n  /agents <id> 查看其上下文；运行中的也可点击底部状态行进入；子视图内输入 = 插话"),
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
    [agent, config, push, mouseOn],
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
      draftRef.current = null;
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
      // /agents 也是带参命令（/agents · /agents <id>），单独处理
      if (line === "/agents" || line.startsWith("/agents ")) {
        const arg = line.slice("/agents".length).trim();
        if (!arg) {
          const xs = agent.listSubAgents();
          if (viewRef.current.kind === "sub") setToast("命令输出在主上下文");
          push(xs.length ? xs.map((x) => `  ${x.id} [${x.role}] ${x.status} · ${x.turns} 轮 / ${x.tools} 工具 · ${x.elapsedSec}s`).join("\n") + ansi.dim("\n  /agents <id> 查看其上下文（Esc 返回；子视图内输入 = 插话）") : ansi.dim("暂无子 agent——主 agent spawn_subagent 后会出现在底部状态行（可点击查看）。"));
        } else if (agent.listSubAgents().some((x) => x.id === arg)) openSubView(arg);
        else push(ansi.error(`无此子 agent：${arg}（/agents 查看清单）`));
        return;
      }
      // /skills 带参命令（/skills · /skills <name>：正文作为用户消息注入——append-only 天然合规）
      if (line === "/skills" || line.startsWith("/skills ")) {
        const arg = line.slice("/skills".length).trim();
        if (!arg) {
          await slashHandlers["/skills"]!();
        } else {
          const rec = agent.skillsRegistry.get(arg);
          if (!rec) push(ansi.error(`无此 skill：${arg}${agent.skillsRegistry.suggest(arg).length ? `（相近：${agent.skillsRegistry.suggest(arg).join(", ")}）` : ""}（/skills 查看清单）`));
          else if (rec.invocation.user === false) push(ansi.error(`skill「${arg}」不可由用户调用（user-invocable: false）`));
          else {
            const { body } = readSkillContent(rec);
            push(ansi.amber(`[skill: ${arg}] 已注入（${rec.origin ?? rec.source}${rec.filePath}）`));
            if (queueRef.current.submit(`[skill: ${arg}]\n\n${body.trim()}`) === "steered") push(ansi.dim("↳ 已插入当前任务 — 本步完成后送达"));
          }
        }
        if (viewRef.current.kind === "sub") setToast("命令输出在主上下文");
        return;
      }
      const handler = slashHandlers[line];
      if (handler) {
        await handler();
        if (viewRef.current.kind === "sub") setToast("命令输出在主上下文");
        return;
      }
      // 子 agent 视图内：普通输入 = 对该子 agent 插话（steer，当前步后送达）
      const v = viewRef.current;
      if (v.kind === "sub") {
        const rec = agent.listSubAgents().find((x) => x.id === v.id);
        pushSubBlock(v.id, { kind: "user", text: line });
        if (rec?.status === "running") {
          pushSubBlock(v.id, { kind: "plain", text: ansi.dim(`↳ ${agent.steerSubAgent(v.id, line)}`) });
        } else {
          pushSubBlock(v.id, { kind: "plain", text: ansi.error(`该子 agent 已${rec ? ` ${rec.status}` : "不存在"}，无法插话——按 Esc 返回主上下文`) });
        }
        return;
      }
      // 忙时插话(steer 注入当前 run) / 闲时新任务(enqueue)，均不阻塞输入
      if (queueRef.current.submit(line) === "steered") push(ansi.dim("↳ 已插入当前任务 — 本步完成后送达"));
    },
    [agent, exit, push, pushBlock, pushSubBlock, openSubView, menuIdx, runMain, slashHandlers],
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
  const flat = useMemo(() => flattenBlocks(blocks, width, "main", hoverId ?? undefined), [blocks, width, hoverId]);
  // 子 agent 实时清单（渲染期直读注册表；bumpSub/秒级 tick 驱动重渲染）。
  const subAgents = agent.listSubAgents();
  const subRunning = subAgents.filter((a) => a.status === "running");
  const subViewInfo = view.kind === "sub" ? subAgents.find((x) => x.id === view.id) : undefined;
  subRunningRef.current = subRunning;
  subAgentsRef.current = subAgents;

  // 当前查看上下文对应的 flat：主转录或某子 agent 的 transcript（ns 隔离渲染缓存）。
  // subTick 进 deps：transcript 只存在 ref 里，靠它感知新增 block。
  const baseFlat = useMemo(() => {
    if (view.kind !== "sub") return flat;
    return flattenBlocks(subTranscriptsRef.current.get(view.id)?.blocks ?? [], width, `sub:${view.id}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, flat, width, subTick]);

  // 主上下文思考流：**跟随转录滚动**（追加在转录尾部，视口自动跟随）。此前它钉在输入框
  // 上方的 chrome 段——流式增长让 chrome 高度每帧变化、视口边界来回挪动，与 Ink 差分
  // 重绘叠加导致行间互相覆盖。现在 chrome 高度整个回合恒定；回合结束这些瞬态行随
  // thought 折叠消失（思考全文在 thoughtRef 管线里）。tick（120ms）驱动流式刷新；
  // owner=-1：不可点击/悬停，但可拖选复制（真实存在于 screen 行模型）。
  const activeFlat = useMemo(() => {
    if (view.kind !== "sub" && busy && thinkRef.current && !bufRef.current) {
      const rl = wrapVisible(thinkRef.current.trim(), width - 4).split("\n").slice(-8);
      if (rl.length) {
        const extra = [ansi.dim(`${sparkFrame()} Reasoning`), ...rl.map((l) => ansi.dim(`  ${l}`)), ""];
        return { lines: [...baseFlat.lines, ...extra], owner: [...baseFlat.owner, ...extra.map(() => -1)] };
      }
    }
    return baseFlat;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFlat, busy, tick, view]);

  // 状态行的已运行秒数走秒（无 running 时不开计时器——行也全部消失）。
  const anySubRunning = subRunning.length > 0;
  useEffect(() => {
    if (!anySubRunning) return;
    const id = setInterval(() => setSubTick((x) => x + 1), 500);
    return () => clearInterval(id);
  }, [anySubRunning]);

  // ── chrome 文本行模型 ───────────────────────────────────────────────────────
  // 视口上下的静态信息行统一转成 ANSI 文本行（aLines 在输入框上方、bLines 子视图头、
  // cLines 在输入框下方），与视口共用同一套拖选/双击选词/三击选行/复制管线——
  // 整个屏幕没有选择死区：菜单/选择器/权限确认行也转成 ANSI 行入同一管线
  // （单击路由仍按 zones 行号走，交互不变）。输入框本体走独立的字符下标选区。
  // 注意：行数在整个回合内保持恒定（思考流在转录尾部流动，见 activeFlat）——
  // chrome 高度变化会让视口边界每帧挪动，与 Ink 差分重绘叠加会互相覆盖。
  // 菜单/选择器/确认行：按可见宽度截断防 Ink 折行打乱行号映射。
  const menuA: string[] =
    menuOpen && !confirm
      ? [
          ...menuMatches.map((c, i) =>
            truncateVisible(i === menuSel ? ansi.white(`❯ ${c.name}   ${c.desc}`) : ansi.dim(`  ${c.name}   ${c.desc}`), width),
          ),
          ansi.dim("  ↑↓ select · Tab complete · Enter run"),
        ]
      : [];
  const pickerA: string[] = picker
    ? [
        ...picker.items.map((it, i) =>
          truncateVisible(i === picker.sel ? ansi.white(`❯ ${it.label}`) : ansi.dim(`  ${it.label}`), width),
        ),
        ansi.dim(`  ↑↓ 选择 · Enter 确认 · Esc 取消（${picker.kind === "resume" ? "恢复该会话" : "回退到该消息"}）`),
      ]
    : [];
  const confirmA: string[] = confirm
    ? [
        truncateVisible(
          ansi.confirm("▸ Allow ") + ansi.bold(confirm.tool) + ansi.dim(` (${summarizeToolArgs(confirm.tool, confirm.args)}) ? [Y/n]`),
          width,
        ),
      ]
    : [];
  // 输入框内容行数（多行输入时随之增高；超长行的终端折行不计——点击列映射按逻辑行近似）。
  const inputLines = inputLineCount(input);
  // 子 agent 用量行与状态行只在「有 running」时出现——全部结束后随状态行一起消失。
  const subDashLines = agent.subTelemetry.turns > 0 && anySubRunning ? 1 : 0;

  const aLines: string[] = [];
  if (scrollOffset > 0) aLines.push(ansi.amber(`↺ ${newCount > 0 ? `${newCount} new · ` : ""}Jump to bottom（点击 / 滚到底 / Ctrl+End）`));
  if (busy) aLines.push(ansi.dim(`${frame} Thinking (${secs}s${estTok > 0 ? ` · ~${estTok} tokens` : ""})`));
  if (working) aLines.push(ansi.amber(`↻ ${working}`) + ansi.dim(` (${wsecs}s)`));

  const bLines: string[] =
    view.kind === "sub"
      ? [
          ansi.bold("‹ Esc / 点击返回主上下文") +
            ansi.dim(
              ` · ${view.id}[${subViewInfo?.role ?? "?"}] ${subViewInfo?.status ?? "未知"} · t${subViewInfo?.turns ?? 0} · ${
                subViewInfo?.status === "running" ? "输入=对该子 agent 插话" : "已结束（输入不可插话）"
              }`,
            ),
        ]
      : [];

  // 仪表盘行：模型/上下文/成本信息 + 复制提示（toast）右对齐在同一行——不再单独占一行。
  const dashLeft =
    ansi.dim(
      `▌ ${model} · ctx ${human(dash.ctxUsed)}/${human(win)} (${pct}%) · ${dash.turns} turns · ↑${human(dash.inTok)} ↓${human(dash.outTok)} tok · cache ${Math.round(dash.cacheHit * 100)}% · ¥${dash.cost.toFixed(4)}`,
    ) +
    (bypass ? ansi.error(" · bypass") : "") +
    (sb.backend === "none" ? (sb.enabled ? ansi.amber(" · ⚠ 未沙箱") : "") : ansi.dim(` · ${sb.backend}`));
  let dashLine = dashLeft;
  if (toast) {
    // 右对齐并入仪表盘行。全部按**可见宽度**计算（中文占 2 列——用字符数会多算留白、
    // 整行超宽被 ink 折行）；剩余宽度不足就按可见宽度截断（带 …），极窄就放弃。
    const room = width - visibleWidth(plainOf(dashLeft)) - 2;
    let t: string | null = toast;
    if (visibleWidth(t) > room) {
      t = null;
      let s = toast;
      while (s.length > 1 && visibleWidth(`${s}…`) > room) s = s.slice(0, -1);
      if (s.length > 1) t = `${s}…`;
    }
    if (t) dashLine += " ".repeat(Math.max(1, room - visibleWidth(t))) + ansi.amber(t);
  }
  const cLines: string[] = [dashLine];
  if (agent.subTelemetry.turns > 0 && anySubRunning) {
    cLines.push(ansi.dim(`▌ ${agent.subTelemetry.model || "subagent"} · ${agent.subTelemetry.turns} turns · ↑${human(agent.subTelemetry.inputTokens)} ↓${human(agent.subTelemetry.outputTokens)} tok · ¥${agent.subTelemetry.costRmb.toFixed(4)}`));
  }
  for (const a of subRunning) {
    cLines.push(view.kind === "sub" && view.id === a.id ? `↳ ${a.id}[${a.role}] · t${a.turns} · ${a.elapsedSec}s · 点击查看/插话` : ansi.amber(`↳ ${a.id}[${a.role}] · t${a.turns} · ${a.elapsedSec}s · 点击查看/插话`));
  }

  // chrome 全量行序（与屏幕视觉顺序一致）：a → 菜单 → 选择器 → b → 确认行（输入框边框内）→ c。
  // 各段 base = 在全量 chrome 行数组中的起始下标——zones 命中换算与渲染高亮共用同一组常量。
  const menuBase = aLines.length;
  const pickerBase = menuBase + menuA.length;
  const bBase = pickerBase + pickerA.length;
  const confirmBase = bBase + bLines.length;
  const cBase = confirmBase + confirmA.length;

  const chromeHeight =
    aLines.length +
    menuA.length +
    pickerA.length +
    bLines.length +
    2 + // 输入框上下边框
    (confirm ? 1 : inputLines) + // 内容行：确认行恒 1 行；输入随多行变高
    cLines.length;
  // 视口高度 = 终端行数 − chrome − 1 安全行：帧高恰好顶满终端时，写最后一行会引发
  // 屏幕上滚一格 → 整帧错位级联（实测 PTY 里字符逐行炸开）。留 1 行余量根治。
  const viewportHeight = Math.max(0, termRows - chromeHeight - 1);

  const vis = visible({ total: activeFlat.lines.length, height: viewportHeight, offset: scrollOffset });
  // offset 被钳制（resize/内容缩短）时同步回 state
  if (vis.clampedOffset !== scrollOffset) setScrollOffset(vis.clampedOffset);

  // 跟随暂停时累计新行；恢复跟随时清零
  useEffect(() => {
    const total = activeFlat.lines.length;
    const delta = total - prevTotalRef.current;
    prevTotalRef.current = total;
    if (delta > 0 && scrollOffsetRef.current > 0) setNewCount((n) => n + delta);
    else if (scrollOffsetRef.current === 0) setNewCount(0);
  }, [activeFlat.lines.length]);

  // 供输入处理闭包读的「本帧」值（flat = 当前查看上下文的行）
  const flatRef = useRef(activeFlat);
  flatRef.current = activeFlat;
  const viewportHeightRef = useRef(viewportHeight);
  viewportHeightRef.current = viewportHeight;

  // 可见行 → blockId 映射 + chrome 各可点区行号（屏幕 1-based 行）——每次渲染后更新供鼠标命中。
  // textRanges：chrome 文本段的行号映射（段首屏幕行 + 行数 + 段在 chrome 文本数组中的基址），
  // 供「屏幕行 → 全局行号（视口行数 + chrome 基址 + 段内偏移）」的拖选命中换算。
  const zonesRef = useRef<{
    viewportRows: number;
    flatLen: number;
    textRanges: Array<{ top: number; lines: number; base: number }>;
    jumpRow: number | null;
    menuTop: number | null;
    pickerTop: number | null;
    inputRow: number | null;
    subHeaderRow: number | null;
    subTop: number | null;
  }>({
    viewportRows: 0,
    flatLen: 0,
    textRanges: [],
    jumpRow: null,
    menuTop: null,
    pickerTop: null,
    inputRow: null,
    subHeaderRow: null,
    subTop: null,
  });
  zonesRef.current = (() => {
    let row = viewportHeight; // 视口占 1..viewportHeight（row 为 0-based「下一行」游标）
    const z = {
      viewportRows: viewportHeight,
      flatLen: activeFlat.lines.length,
      textRanges: [] as Array<{ top: number; lines: number; base: number }>,
      jumpRow: null as number | null,
      menuTop: null as number | null,
      pickerTop: null as number | null,
      inputRow: null as number | null,
      subHeaderRow: null as number | null,
      subTop: null as number | null,
    };
    if (aLines.length) {
      z.textRanges.push({ top: row + 1, lines: aLines.length, base: 0 });
      if (scrollOffset > 0) z.jumpRow = row + 1; // aLines 首行是 Jump 按钮
      row += aLines.length;
    }
    if (menuA.length) {
      z.menuTop = row + 1; // 菜单第一项（1-based）
      z.textRanges.push({ top: row + 1, lines: menuA.length, base: menuBase }); // 菜单行可拖选
      row += menuA.length;
    }
    if (pickerA.length) {
      z.pickerTop = row + 1;
      z.textRanges.push({ top: row + 1, lines: pickerA.length, base: pickerBase }); // 选择器行可拖选
      row += pickerA.length;
    }
    if (bLines.length) {
      z.textRanges.push({ top: row + 1, lines: bLines.length, base: bBase });
      z.subHeaderRow = row + 1; // 子视图头部（点击返回主上下文）
      row += bLines.length;
    }
    row += 1; // 输入框上边框
    z.inputRow = row + 1;
    if (confirmA.length) z.textRanges.push({ top: row + 1, lines: 1, base: confirmBase }); // 确认行可拖选
    row += (confirm ? 1 : inputLines) + 1; // 内容行（确认恒 1 行 / 输入可能多行）+ 下边框
    if (cLines.length) {
      z.textRanges.push({ top: row + 1, lines: cLines.length, base: cBase });
      // cLines 内部顺序：仪表盘、子用量行（可选）、各 running 子 agent 状态行。
      if (subRunning.length) z.subTop = row + 1 + 1 + subDashLines; // 跳过仪表盘与子用量行
      row += cLines.length;
    }
    return z;
  })();
  // 屏幕行全量模型（视口行 + 全部 chrome 文本行）：选区文本提取/键盘扩展共用。
  const screenRef = useRef<{ lines: string[] }>({ lines: [] });
  screenRef.current.lines = [...activeFlat.lines, ...aLines, ...menuA, ...pickerA, ...bLines, ...confirmA, ...cLines];

  // ── 鼠标 ────────────────────────────────────────────────────────────────────
  const toggleToolBlock = useCallback((toolCallIdOrBlockId: number) => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === toolCallIdOrBlockId && b.kind === "tool" && b.body ? { ...b, collapsed: !b.collapsed } : b)),
    );
    setSel(null); // 折叠切换会让行号重排，选区失效
  }, []);

  /** 复制当前选区（copy-on-select；FORGE_COPY_ON_SELECT=0 关闭自动、只留 Ctrl+C 手动）。
   *  行号空间 = 视口行 + chrome 文本行（模型信息行等也可选）。 */
  const copySelectionNow = useCallback(
    async (anchor: { line: number; col: number }, active: { line: number; col: number }) => {
      if (process.env.FORGE_COPY_ON_SELECT === "0") return;
      const text = selectedText(screenRef.current.lines, normalizeRange(anchor, active));
      if (!text.trim()) return;
      await copyText(text); // 路径（pbcopy/OSC52/…）不进提示——用户只关心复制成功
      setToast(`⧉ 已复制 ${text.length} 字符`);
    },
    [],
  );

  /** 复制输入框选区（拖选松开即复制 / Ctrl+C 手动）。 */
  const copyInputSelectionNow = useCallback(
    async (anchor: number, active: number) => {
      if (process.env.FORGE_COPY_ON_SELECT === "0") return;
      const text = inputRef.current.slice(Math.min(anchor, active), Math.max(anchor, active));
      if (!text.trim()) return;
      await copyText(text);
      setToast(`⧉ 已复制输入框 ${text.length} 字符`);
    },
    [],
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
      const z = zonesRef.current;
      const inViewport = ev.row >= 1 && ev.row <= z.viewportRows;
      // 无按键移动（1003h 悬停，button=3）：必须在「只处理左键」过滤前接——悬停摘要行变白；
      // 目标变化才 setState（逐像素 motion 不逐帧重渲染）。
      if (ev.kind === "motion" && ev.button === 3) {
        let id: number | null = null;
        if (inViewport) {
          const v = visible({ total, height: viewportHeightRef.current, offset: scrollOffsetRef.current });
          const owner = flatRef.current.owner[v.start + (ev.row - 1)];
          const b = owner !== undefined ? blocksRef.current.find((x) => x.id === owner) : undefined;
          if (b?.kind === "thought" && !b.expanded) id = b.id;
        }
        if (hoverIdRef.current !== id) setHoverId(id);
        return;
      }
      if (ev.button !== 0) return; // 只处理左键（选择/点击）；悬停已在上面单独接走
      /** 屏幕（视口）行 → 全局行（可带 offset 覆盖：边缘自动滚后按新视口算） */
      const lineUnder = (row: number, offsetOverride?: number) => {
        const v = visible({ total, height: viewportHeightRef.current, offset: offsetOverride ?? scrollOffsetRef.current });
        return v.start + (row - 1);
      };
      /** chrome 文本行（模型信息 / 子 agent 状态行等）→ 全局行（flatLen + 段基址 + 段内偏移）。 */
      const chromeLineUnder = (row: number): number | null => {
        for (const t of z.textRanges) {
          if (row >= t.top && row < t.top + t.lines) return z.flatLen + t.base + (row - t.top);
        }
        return null;
      };
      /** 任意屏幕行 → 全局行（视口或 chrome 文本行；JSX 交互区返回 null）。 */
      const globalLineAt = (row: number): number | null => (inViewport ? lineUnder(row) : chromeLineUnder(row));
      const textCol = (col: number) => Math.max(0, col - 1); // 屏幕 1-based → 行内 0-based 可见列
      // 输入区行命中 + 屏幕坐标 → 输入 value 字符下标（`› ` 前缀 / 多行 / CJK 宽度统一换算）。
      const inInputRows = (row: number) => z.inputRow !== null && row >= z.inputRow && row < z.inputRow + inputLineCount(inputRef.current);
      const charAtInput = (row: number, col: number): number | null => inputCharAtScreen(inputRef.current, z.inputRow ?? row, row, col);

      // ── 按下：记拖拽起点（视口/chrome 文本行/输入区可拖选；等松开区分单击/拖拽）──
      if (ev.kind === "press") {
        const gl = globalLineAt(ev.row);
        dragRef.current = gl !== null
          ? { startRow: ev.row, startLine: gl, startCol: textCol(ev.col), moved: false }
          : null;
        inputDragRef.current = gl === null && !inViewport && inInputRows(ev.row)
          ? { startChar: charAtInput(ev.row, ev.col) ?? 0, moved: false }
          : null;
        return;
      }

      // ── 拖动：跨格才算选择；拖到视口上下边缘自动滚 1 行 ──
      if (ev.kind === "motion") {
        // 输入区拖选：字符下标变化才算移动；选中段实时蓝底。
        const idr = inputDragRef.current;
        if (idr) {
          const ch = charAtInput(ev.row, ev.col);
          if (ch !== null) {
            if (!idr.moved && ch !== idr.startChar) idr.moved = true;
            if (idr.moved) setInputSel({ anchor: idr.startChar, active: ch });
          }
          return;
        }
        const d = dragRef.current;
        if (!d) return;
        if (!d.moved && (ev.row !== d.startRow || ev.col !== d.startCol)) d.moved = true;
        if (!d.moved) return;
        let offset = scrollOffsetRef.current;
        // 边缘自动滚只对「视口拖选」有意义（chrome 拖选不动视口）。
        if (d.startLine < total) {
          if (ev.row <= 1) {
            offset = scrollBy({ total, height: viewportHeightRef.current, offset }, 1);
            setScrollOffset(offset);
          } else if (ev.row >= z.viewportRows) {
            offset = scrollBy({ total, height: viewportHeightRef.current, offset }, -1);
            if (offset === 0) setNewCount(0);
            setScrollOffset(offset);
          }
        }
        const activeLine = inViewport ? lineUnder(ev.row, offset) : (chromeLineUnder(ev.row) ?? d.startLine);
        setSel({ anchor: { line: d.startLine, col: d.startCol }, active: { line: activeLine, col: textCol(ev.col) } });
        return;
      }

      // ── 松开 ──
      if (ev.kind === "release") {
        const d = dragRef.current;
        dragRef.current = null;
        const idr = inputDragRef.current;
        inputDragRef.current = null;
        if (d?.moved) {
          // 拖拽结束：定格选区 + 松开即复制
          const anchor = { line: d.startLine, col: d.startCol };
          const active = { line: inViewport ? lineUnder(ev.row) : (chromeLineUnder(ev.row) ?? d.startLine), col: textCol(ev.col) };
          setSel({ anchor, active });
          void copySelectionNow(anchor, active);
          return;
        }
        // 输入区拖选结束：定格输入选区 + 松开即复制（与视口 copy-on-select 一致）
        if (idr?.moved) {
          const ch = charAtInput(ev.row, ev.col) ?? idr.startChar;
          setInputSel({ anchor: idr.startChar, active: ch });
          void copyInputSelectionNow(idr.startChar, ch);
          return;
        }
        // 单击：先双击/三击判定（同格 <500ms）——二击选词、三击选行，选中即复制（视口与 chrome 文本行同权）
        const lc = lastClickRef.current;
        const same = lc.row === ev.row && lc.col === ev.col && Date.now() - lc.ts < 500;
        const count = same ? lc.count + 1 : 1;
        lastClickRef.current = { ts: Date.now(), row: ev.row, col: ev.col, count: count >= 3 ? 0 : count };
        {
          const gl = globalLineAt(ev.row);
          const lineText = gl !== null ? screenRef.current.lines[gl] : undefined;
          if (gl !== null && lineText !== undefined && count >= 2) {
            const plain = plainOf(lineText);
            const [c0, c1] = count === 2 ? expandWord(plain, textCol(ev.col)) : wholeLine(plain);
            const anchor = { line: gl, col: c0 };
            const active = { line: gl, col: c1 };
            setSel({ anchor, active });
            void copySelectionNow(anchor, active);
            return;
          }
          setSel(null); // 普通单击清选区
        }
        // 既有单击路由：Jump 按钮 / 菜单 / 输入框定位 / 子 agent 切换 / 工具折叠
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
        if (z.inputRow !== null && inInputRows(ev.row) && confirm === null) {
          setInputSel(null); // 单击清输入选区（与视口单击清选区一致）
          const ch = charAtInput(ev.row, ev.col);
          if (ch !== null) setCursorCol(ch); // `› ` 前缀/多行/CJK 已在换算内处理
          return;
        }
        // 子 agent 状态行：点击切换到该子 agent 的上下文（查看/插话）
        if (z.subTop !== null && ev.row >= z.subTop && ev.row < z.subTop + subRunningRef.current.length) {
          openSubView(subRunningRef.current[ev.row - z.subTop]!.id);
          return;
        }
        // 子视图头部：点击返回主上下文
        if (z.subHeaderRow === ev.row) return closeSubView();
        if (inViewport) {
          const lineIdx = lineUnder(ev.row);
          const blockId = flatRef.current.owner[lineIdx];
          if (blockId !== undefined) {
            // 工具块折叠切换作用于「当前查看的上下文」（主转录或某子 agent transcript）
            if (viewRef.current.kind === "sub") {
              const t = subTranscriptsRef.current.get(viewRef.current.id);
              const b = t?.blocks.find((x) => x.id === blockId);
              if (b?.kind === "tool" && b.body) {
                t!.blocks = t!.blocks.map((x) => (x.id === b.id && x.kind === "tool" && x.body ? { ...x, collapsed: !x.collapsed } : x));
                setSel(null); // 折叠切换会让行号重排，选区失效
                bumpSub();
              }
            } else {
              const b = blocksRef.current.find((x) => x.id === blockId);
              if (b?.kind === "thought") {
                setBlocks((prev) => prev.map((x) => (x.id === b.id ? { ...b, expanded: !b.expanded } : x)));
                setSel(null); // 展开改变行数，选区失效
              } else if (b?.kind === "tool" && b.body) toggleToolBlock(b.id);
            }
          }
        }
      }
    });
  }, [mouseStdin, confirm, menuMatches.length, jumpToBottom, toggleToolBlock, copySelectionNow, copyInputSelectionNow, openSubView, closeSubView, bumpSub]);

  const visStartRef = useRef(vis.start);
  visStartRef.current = vis.start;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  // 视口行 + 选区高亮（区间内蓝底替换；中间行整行 = [0, ∞)）
  const selRange = sel ? normalizeRange(sel.anchor, sel.active) : null;
  const viewportText = activeFlat.lines
    .slice(vis.start, vis.start + vis.count)
    .map((l, i) => {
      if (!selRange) return l;
      const rng = lineRangeInSel(selRange, vis.start + i);
      return rng ? highlightRange(l, rng[0], rng[1]) : l;
    })
    .join("\n");
  /** chrome 文本行按全局行号套选区高亮（与视口 viewportText 同一管线；base = 段首全局行号）。 */
  const hlLines = (lines: string[], base: number) =>
    lines
      .map((l, i) => {
        if (!selRange) return l;
        const rng = lineRangeInSel(selRange, base + i);
        return rng ? highlightRange(l, rng[0], rng[1]) : l;
      })
      .join("\n");

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={viewportHeight}>
        <Text>{viewportText}</Text>
      </Box>

      {/* chrome 文本段（可选中的信息行）：拖选/双击选词与视口同一套管线。 */}
      {aLines.length > 0 && <Text>{hlLines(aLines, activeFlat.lines.length)}</Text>}

      {/* 菜单/选择器：ANSI 行（可拖选/复制；单击路由仍按 zones.menuTop/pickerTop）。 */}
      {menuA.length > 0 && <Text>{hlLines(menuA, activeFlat.lines.length + menuBase)}</Text>}
      {pickerA.length > 0 && <Text>{hlLines(pickerA, activeFlat.lines.length + pickerBase)}</Text>}

      {bLines.length > 0 && <Text>{hlLines(bLines, activeFlat.lines.length + bBase)}</Text>}

      <Box borderStyle="single" borderColor={theme.muted} borderLeft={false} borderRight={false}>
        {confirm ? (
          <Text>{hlLines(confirmA, activeFlat.lines.length + confirmBase)}</Text>
        ) : (
          <Box>
            <Text color={theme.prompt}>{"› "}</Text>
            <MultilineInput
              value={input}
              onChange={(v) => { setInput(v); setMenuIdx(0); setInputSel(null); }}
              onSubmit={onSubmit}
              onHistoryPrev={historyPrev}
              onHistoryNext={historyNext}
              menuOpen={menuOpen || picker !== null}
              isActive={confirm === null && picker === null}
              cursorRequest={cursorCol}
              onCursorRequestHandled={() => setCursorCol(null)}
              selection={inputSel}
            />
            {!input && (
              <Text color={theme.muted}>
                {view.kind === "sub" ? "插话该子 agent · Esc 返回主上下文" : "Type a request · /exit to quit"}
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* 仪表盘（含右端复制提示）/ 子用量 / 子 agent 状态行：同为可选中文本。 */}
      <Text>{hlLines(cLines, activeFlat.lines.length + cBase)}</Text>
    </Box>
  );
}
