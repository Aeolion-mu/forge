import {
  AgentHarness,
  JsonlSessionRepo,
  formatSkillsForSystemPrompt,
  calculateContextTokens,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type {
  AgentHarnessEvent,
  AgentTool,
  CompactionEntry,
  JsonlSessionMetadata,
  Session,
  SessionTreeEntry,
  Skill,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { completeSimple, getEnvApiKey } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { hasKey, resolveModel, type ForgeConfig, type ModelEntry } from "../config.js";
import { AuditLog } from "./audit.js";
import {
  estimateTokens,
  extractCompactionPlan,
  isTooLongError,
  runFullCompaction,
  keptTokensFrom,
  type PlanEntry,
  type SummarizeFn,
} from "./compaction.js";
import { Memory } from "./memory.js";
import { loadSkillsCrossPlatform } from "./skills-win.js";
import { FlightRecorder, FileFlightSink } from "./flight-recorder.js";
import { resolve } from "node:path";
import { PermissionPolicy } from "./permission.js";
import { WRITE_GUARD_SYSTEM_PROMPT, buildWriteGuardPrompt, parseWriteGuardVerdict } from "./write-guard.js";
import { Telemetry } from "./telemetry.js";
import { makeMemoryTools } from "../tools/memory-tool.js";
import { makeBashTool } from "../tools/bash.js";
import { makeFsTools } from "../tools/fs-tools.js";
import { makeSearchTools } from "../tools/search-tools.js";
import { makeApplyPatchTool } from "../tools/apply-patch.js";
import { makeDiagnosticsTool } from "../tools/diagnostics.js";
import { makeOutlineTool } from "../tools/outline.js";
import { makeRepoMapTool } from "../tools/repo-map.js";
import { makeLspTools } from "../tools/lsp-tools.js";
import { formatDiagnostics } from "../tools/diagnostics.js";
import { LspClient, lspLangForPath } from "./lsp-client.js";
import { makeSubAgentTools, type SubAgentInfo, type SubAgentOrchestrator, type SubAgentResult } from "../tools/subagent.js";
import { SubAgentRegistry, SUBAGENT_LOG_CAP, type SubAgentTask } from "./subagent-registry.js";
import {
  CONVERGENT_SYSTEM_PROMPT,
  CLASSIFIER_SYSTEM_PROMPT,
  ConvergeController,
  buildConvergentTask,
  buildClassifierPrompt,
  buildGoalKickoff,
  parseVerdict,
  parseClassification,
  type StopKind,
} from "./converge.js";
import { makeConvergeTools } from "../tools/converge-tool.js";
import { makeSshTool } from "../tools/ssh.js";
import { makeRenderer, summarizeToolArgs } from "../ui/render.js";

/** 子 agent 轮数上限（防跑飞，库无此护栏）。env 可覆盖。 */
const SUBAGENT_MAX_TURNS = Number(process.env.FORGE_SUBAGENT_MAX_TURNS) || 25;

/** Convergent 验收 agent 的轮数上限。env 可覆盖。 */
const CONVERGENT_MAX_TURNS = Number(process.env.FORGE_CONVERGENT_MAX_TURNS) || 30;

/**
 * 编辑后自动诊断的总时长上限。首次诊断会触发 LSP 预热（打开全工程同语言文件并等分析就绪），
 * 最坏 ~9s；超过预算就跳过本轮自检（预热在后台继续，下次编辑即快），避免把这一轮卡死。env 可覆盖。
 */
const AUTO_DIAGNOSE_TIMEOUT_MS = Number(process.env.FORGE_AUTO_DIAGNOSE_TIMEOUT_MS) || 4000;

const MAIN_SYSTEM_PROMPT = [
  "你是 Forge，一个运行在终端里的编程助手。",
  "你可以读写文件、执行命令、并把可独立完成的子任务派发给子 agent。",
  "写操作和命令执行会经过权限闸门，请只在必要时使用。完成后给出简洁结论。",
  "先理解后动手：拿到任务先用 repo_map / outline / grep / LSP 把根因定位清楚——在你能一句话说清『问题出在哪个文件、哪个函数、为什么』之前，不要编辑任何文件；不要在没理清现状时就猜着改。",
  "读代码前优先用 outline 看文件结构（符号 + 行范围），再用 read_file 的 offset/limit 精读相关函数；不要整文件通读，省上下文也更准。",
  "尤其大文件（>300 行）不要用 read_file 读全文——超长会被截断、中段丢失且你不会察觉；务必先 outline，再按符号的行范围分段读。",
  "理解陌生代码库先用 repo_map 看全局。追踪符号用 definition/references/hover（LSP，跨文件、比 grep 准）；这些不可用时再退回 grep。",
  "编辑代码后用 diagnostics(path) 自检该文件（语义级：类型错误/未定义/未用导入），确认没改坏再继续。",
  "改动最小化：只改修复所必需的代码，不碰无关文件；除非问题本身就在那里，否则不要改构建/依赖配置（pyproject.toml / setup.py / package.json / requirements 等）；不做顺手重构、不重排无关格式；能用 edit_file 局部修改就不要 write_file 整文件重写。",
  "收尾前自审：给出最终结论前回看本轮所有改动，删掉任何与本次修复无关的部分，确认每处改动都必要、且改过的文件 diagnostics 无 error。",
  "记忆要克制（失败模式是『记太多』）：只有会改变未来会话决策的持久事实（架构/命令/约定/用户偏好/反复纠正）才用 memory_write；一次性结果、巡检或测试输出、对话内临时信息一律不记。",
  "用与用户相同的语言回复：用户用英文则用英文，用中文则用中文。",
].join("\n");

/**
 * 本机环境特征 —— 注入系统提示，免得模型不知道自己在 PowerShell 里而频繁撞墙
 * （写 && / $VAR / ls 之类 POSIX 语法在 PowerShell 报错）。内容静态 → 不破坏前缀缓存。
 * 与 sandbox/exec.ts 的 shell 选择保持一致（win32 → powershell.exe）。
 */
export function environmentBlock(workdir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return [
      `【运行环境】Windows · shell = PowerShell 5.1（powershell.exe）· 工作目录 ${workdir}`,
      "bash 工具的命令实际在 PowerShell 里执行，请用 PowerShell 语法：用 `;` 或换行连接命令（5.1 不支持 `&&`/`||`）；环境变量是 `$env:NAME`（不是 `$NAME`）；用 cmdlet（Get-ChildItem / Get-Content / Remove-Item 等）而非 ls/cat/rm；路径含空格要加引号。读文件优先用 read_file 工具而非 Get-Content。",
    ].join("\n");
  }
  return [
    `【运行环境】${platform} · shell = /bin/sh · 工作目录 ${workdir}`,
    "bash 工具的命令在 /bin/sh 里执行，请用 POSIX sh 语法。读文件优先用 read_file 工具而非 cat。",
  ].join("\n");
}

/** 从 config 构造透传给库的 streamOptions（单请求退避重试 / 超时）。 */
function streamOptionsOf(config: ForgeConfig) {
  return {
    maxRetries: config.stream.maxRetries,
    maxRetryDelayMs: config.stream.maxRetryDelayMs,
    ...(config.stream.timeoutMs !== undefined ? { timeoutMs: config.stream.timeoutMs } : {}),
  };
}

export interface ForgeAgentOptions {
  /** 写/执行类工具自动放行（--yes）。 */
  autoApprove?: boolean;
  /** 交互式确认回调；返回 true 放行。不提供则 confirm 默认放行。 */
  confirm?: (toolName: string, args: unknown) => Promise<boolean>;
  /** 是否把事件渲染到终端（主 agent 用 true，子 agent 用 false）。Ink TUI 传 false。 */
  render?: boolean;
  /** 恢复已存在的会话（来自 /resume）。 */
  resume?: JsonlSessionMetadata;
  /** 框架通知（压缩等）输出回调；不提供则写 stdout。Ink 模式下用它改写为状态块，避免污染渲染。 */
  onNotice?: (msg: string) => void;
  /** 长操作（压缩）的实时状态回调：msg 显示「正在干什么」，null 表示结束。Ink 模式下驱动进度行。 */
  onStatus?: (msg: string | null) => void;
  /** 子 agent 实时状态回调：挂在仪表盘下方显示子 agent 在干什么；null 表示结束。 */
  onSubStatus?: (msg: string | null) => void;
  /** 后台子 agent 完成时，把结论作为新一轮喂回主 agent（不阻塞主循环）。 */
  onResume?: (text: string) => void;
  /** Convergent 验收 agent 的事件流：让它的活动像主 agent 一样实时显示（UI 加前缀区分）。 */
  onConvergentEvent?: (e: AgentHarnessEvent) => void;
}

/** 从一条 assistant 消息里取纯文本。 */
function textOf(msg: AssistantMessage | undefined): string {
  if (!msg || !Array.isArray(msg.content)) return "(no text output)";
  const t = msg.content
    .filter((c) => (c as { type?: string }).type === "text")
    .map((c) => (c as { text: string }).text)
    .join("")
    .trim();
  return t || "(no text output)";
}

/** 安全序列化 tool_call 参数为文本（循环引用等异常兜底为 String）。空/undefined → ""。 */
function safeJsonForText(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 把一条会话消息序列化成压缩用的纯文本：assistant 计入 thinking + tool_call 参数（不止标记），
 * 否则 token 估算严重偏小、压缩选点失准。导出供测试。
 */
export function textOfMessage(msg: Message): string {
  if (msg.role === "user") {
    const c = msg.content as unknown;
    if (typeof c === "string") return c;
    return (c as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n");
  }
  if (msg.role === "assistant") {
    // 必须计入 thinking 与 tool_call 参数——它们是编程 agent assistant 消息的主体
    // （write_file 全文 / patch / 命令 / deepseek 推理）。漏掉会让压缩的 token 估算严重偏小
    // （实测一次 150+ turn 的会话 assistant 只估出 ~7k，真实 ~180k），cut 点退到会话开头、
    // extractCompactionPlan 误判"无可压缩前缀"而每次退回库默认压缩，自研 9 段摘要永不生效。
    return msg.content
      .map((c) => {
        const x = c as { type: string; text?: string; name?: string; thinking?: string; arguments?: unknown };
        if (x.type === "text") return x.text ?? "";
        if (x.type === "thinking") return x.thinking ?? "";
        if (x.type === "toolCall") {
          const args = safeJsonForText(x.arguments);
          return args ? `[tool_call ${x.name ?? "?"}] ${args}` : `[tool_call ${x.name ?? "?"}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (msg.role === "toolResult") {
    return msg.content.filter((x) => (x as { type: string }).type === "text").map((x) => (x as { text: string }).text).join("\n");
  }
  return "";
}

/** 写类工具：成功后触发自动诊断。 */
const WRITE_TOOLS = new Set(["edit_file", "write_file", "apply_patch"]);

/** 从 tool_result 事件取被编辑的文件路径（apply_patch 可能多文件）。 */
export function editedPaths(e: { toolName: string; input?: Record<string, unknown>; details?: unknown }): string[] {
  if (e.toolName === "apply_patch") {
    const diffs = (e.details as { diffs?: { path: string }[] } | undefined)?.diffs ?? [];
    return diffs.map((d) => d.path);
  }
  const p = (e.input?.path ?? (e.details as { path?: string } | undefined)?.path) as string | undefined;
  return p ? [p] : [];
}

/** 把会话树 entries 投影成 compaction 模块的 PlanEntry[]（不把库类型泄漏进 compaction.ts）。导出供测试。 */
export function toPlanEntries(entries: SessionTreeEntry[]): PlanEntry[] {
  return entries.map((e) => {
    if (e.type === "message") return { id: e.id, type: "message", role: (e.message as Message).role, text: textOfMessage(e.message as Message) };
    if (e.type === "compaction") return { id: e.id, type: "compaction", summary: (e as CompactionEntry).summary };
    return { id: e.id, type: e.type };
  });
}

/**
 * ForgeAgent —— 阶段 0：直接包一层 pi-agent-core 自带的生产级 `AgentHarness`，
 * 作为「参照实现」。后续阶段会把它内部的库模块（会话树 / 压缩 / 沙箱 / skills /
 * subagent）逐个替换成自实现并对比差距。
 *
 * 注入点对照：
 *   on("tool_call")  ← 权限闸门 + 审计开始（旧 beforeToolCall）
 *   on("tool_result")← 审计结束（旧 afterToolCall）
 *   on("context")    ← 记录上下文 token，供压缩触发判定
 *   subscribe()      ← telemetry + 终端渲染（底层 AgentEvent 全量转发）
 *   maybeCompact()   ← 自接的压缩「触发策略」（库只给 compact() 原语，不自动触发）
 */
export class ForgeAgent {
  readonly telemetry: Telemetry;
  /** 子 agent（flash 模型）用量单独统计，仪表盘另起一行。 */
  readonly subTelemetry: Telemetry;
  readonly audit: AuditLog;
  /** 飞行记录仪：全量事件流落 JSONL（关闭时为 null）。 */
  private readonly flight: FlightRecorder | null;
  /** 本次运行的飞行日志文件路径（关闭时 null）。 */
  private readonly flightPath: string | null;
  private readonly harness: AgentHarness;
  private readonly policy: PermissionPolicy;
  private readonly env: NodeExecutionEnv;
  private readonly repo: JsonlSessionRepo;
  private live: boolean;
  private currentRef: string;
  private lastContextTokens = 0;
  /** 压缩进行中暂存的 branch（session_before_compact 写入），压缩完成后据实际保留点重算用量。 */
  private pendingBranchPlan?: PlanEntry[];
  /** 压缩连续失败计数 + 熔断标志（连续 3 次失败停用自动压缩，防空烧 API）。 */
  private compactionFailures = 0;
  private compactionDisabled = false;
  /** 压缩期间的中止控制器（Ctrl+C 时取消摘要 LLM 调用）。 */
  private currentAbort?: AbortController;
  /** 后台子 agent 注册表（异步编排：spawn 立即返回、后台运行、可查/撤销/收结果）。 */
  private readonly subagents: SubAgentRegistry;

  /** /converge 状态机（工作到目标达成 + Convergent 验收）。 */
  private readonly converge = new ConvergeController();
  /** 本次 converge 目标期间累计的改动文件（喂给 Convergent 的路径清单，便宜且难伪造）。 */
  private convergeChangedFiles = new Set<string>();
  /** 本轮 run 内成功写过的文件（无论 /converge 是否激活）——供 run() 收尾的 diff 自审。 */
  private runChangedFiles = new Set<string>();
  /** 主 agent 本轮是否调了 submit_for_review（及理由）；checkConverge 读后清空。 */
  private pendingSubmit?: { justification: string };
  /** 本轮的用户指令（喂给语义写守卫判断意图；run() / runConvergent 进入时更新）。 */
  private currentUserInstruction = "";

  private readonly lsp: LspClient;

  private constructor(
    private readonly config: ForgeConfig,
    private readonly opts: ForgeAgentOptions,
    deps: { harness: AgentHarness; env: NodeExecutionEnv; repo: JsonlSessionRepo; lsp: LspClient; flight: FlightRecorder | null; flightPath: string | null },
  ) {
    this.telemetry = new Telemetry(config.pricing);
    this.subTelemetry = new Telemetry(config.pricing);
    this.audit = new AuditLog(config.auditPath);
    this.flight = deps.flight;
    this.flightPath = deps.flightPath;
    this.policy = new PermissionPolicy({ autoApprove: opts.autoApprove, workdir: config.workdir, allowWriteOutside: config.allowWriteOutside });
    this.live = config.live;
    this.currentRef = config.modelRef;
    this.harness = deps.harness;
    this.env = deps.env;
    this.repo = deps.repo;
    this.lsp = deps.lsp;
    this.subagents = new SubAgentRegistry({
      runLoop: (role, task, maxTurns, signal, rec) => this.runSubAgentLoop(role, task, maxTurns, signal, rec),
      onResume: (text) => this.opts.onResume?.(text),
      onStatus: (msg) => this.subStatus(msg),
      onError: (role, message) => this.audit.write({ kind: "tool_end", tool: "spawn_subagent", isError: true, preview: `[${role}] ${message}` }),
    });

    // 权限闸门 + 审计开始（emitHook 取最后一个非 undefined 返回，故权限决策放这一个 handler）
    this.harness.on("tool_call", async (e) => {
      const decision = this.policy.check(e.toolName, e.input);
      this.audit.write({ kind: "permission", tool: e.toolName, args: e.input, verdict: decision.verdict, reason: decision.reason });
      if (decision.verdict === "deny") return { block: true, reason: decision.reason };
      if (decision.verdict === "review") {
        const g = await this.runWriteGuard(String((e.input as { cmd?: unknown })?.cmd ?? ""), this.currentUserInstruction);
        if (g) return g; // {block} 才拦；放行返回 undefined 继续后续流程
      }
      if (decision.verdict === "confirm" && this.opts.confirm) {
        const ok = await this.opts.confirm(e.toolName, e.input);
        if (!ok) return { block: true, reason: "用户拒绝了该操作" };
      }
      this.audit.write({ kind: "tool_start", tool: e.toolName, args: e.input });
      return undefined;
    });

    // 审计结束
    this.harness.on("tool_result", async (e) => {
      const preview = String((e.content?.[0] as { text?: string } | undefined)?.text ?? "");
      this.audit.write({ kind: "tool_end", tool: e.toolName, isError: e.isError, preview });
      // converge 目标进行中：累计改动文件路径（喂给 Convergent 的证据清单）。
      if (!e.isError && this.converge.active && WRITE_TOOLS.has(e.toolName)) {
        for (const p of editedPaths(e)) this.convergeChangedFiles.add(p);
      }
      // 本轮改动文件追踪（无论 converge 是否激活）——供 run() 收尾的 diff 自审（P1）。
      if (!e.isError && WRITE_TOOLS.has(e.toolName)) {
        for (const p of editedPaths(e)) this.runChangedFiles.add(p);
      }
      // 编辑后自动诊断：写类工具成功后，对受影响文件跑 LSP 诊断，有 error 就把报告追加进
      // 工具结果（模型立即看到，不靠它自觉调 diagnostics）。
      if (!e.isError && WRITE_TOOLS.has(e.toolName)) {
        const note = await this.autoDiagnose(editedPaths(e));
        if (note) {
          const text = String((e.content?.[0] as { text?: string } | undefined)?.text ?? "");
          return { content: [{ type: "text", text: text + note }] };
        }
      }
      return undefined;
    });

    // 上下文用量（供压缩触发判定 + 仪表盘）取自「最近一轮 assistant 的真实 provider usage」，
    // 在 turn 完成后记录。**不要**用压缩前的 context 钩子估算：estimateContextTokens 把用量锚定在
    // 最后一条带 usage 的 assistant 上，而压缩后保留窗口里残留的旧 assistant 记的是压缩前满窗 usage，
    // 会让用量虚高不降、每发一条消息都重复触发压缩（已修 bug）。turn_end 的 usage 在压缩后自然变小。
    this.harness.subscribe((e) => {
      if (e.type !== "turn_end") return;
      const usage = (e as { message?: AssistantMessage }).message?.usage;
      if (usage) {
        const t = calculateContextTokens(usage);
        if (t > 0) this.lastContextTokens = t;
      }
    });

    // 自研完整压缩接管：库只给 compact() 原语 + session_before_compact 钩子，
    // 我们用自己的 cut point（留 20% 窗口）+ 9 段摘要 + map-reduce 兜底产出结果，
    // 库负责把它落进会话树。返回 undefined 则回退库默认压缩。
    this.harness.on("session_before_compact", async (e) => {
      try {
        this.status("Analyzing conversation…");
        // 暂存本次 branch（含 entry id + 文本）：压缩完成后据实际 firstKeptEntryId 重算保留窗口、
        // 即时刷新上下文用量——无论走自研摘要还是回退库默认压缩都成立。
        this.pendingBranchPlan = toPlanEntries(e.branchEntries);
        const plan = extractCompactionPlan(this.pendingBranchPlan, Math.floor(0.2 * this.effectiveWindow));
        if (!plan) return undefined; // 没有可压缩前缀 → 让库默认处理
        this.status("Summarizing (calling model)…");
        const summary = await runFullCompaction({
          messages: plan.messagesToSummarize,
          previousSummary: plan.previousSummary,
          summarize: this.makeSummarizeFn(),
          onStatus: (m) => this.status(m),
        });
        // 飞行记录：压缩前后对比的精选记录（待压全文 + 产出摘要 + 保留量），一条 grep 即可评估压缩质量
        this.flight?.record("compact_detail", {
          tokensBefore: e.preparation.tokensBefore,
          keptTokens: plan.keptTokens,
          summaryChars: summary.length,
          summarizedMessages: plan.messagesToSummarize.length,
          summarizedChars: plan.messagesToSummarize.reduce((s, m) => s + m.text.length, 0),
          previousSummary: plan.previousSummary,
          summary,
          messagesToSummarize: plan.messagesToSummarize,
          firstKeptEntryId: plan.firstKeptEntryId,
        });
        const fileOps = (e.preparation as { fileOps?: { read: Set<string>; written: Set<string>; edited: Set<string> } }).fileOps;
        const details = fileOps
          ? { readFiles: [...fileOps.read], modifiedFiles: [...new Set([...fileOps.written, ...fileOps.edited])] }
          : undefined;
        return { compaction: { summary, firstKeptEntryId: plan.firstKeptEntryId, tokensBefore: e.preparation.tokensBefore, details } };
      } catch (err) {
        if (this.currentAbort?.signal.aborted) return { cancel: true }; // 用户 Ctrl+C → 取消压缩，不回退库默认（避免再发一次 LLM）
        this.audit.write({ kind: "tool_end", tool: "compact", isError: true, preview: (err as Error).message });
        return undefined; // 自研路径失败 → 回退库默认压缩
      }
    });

    this.harness.subscribe(this.telemetry.handle);
    // 飞行记录仪：订阅完整事件流，逐条全量落盘（只读观察，不干预 harness）。
    if (this.flight) this.harness.subscribe(this.flight.handle);
    if (opts.render !== false) {
      this.harness.subscribe(makeRenderer());
    }
  }

  /** 异步工厂：构造 env / session / skills / harness（构造函数不能 async）。 */
  static async create(config: ForgeConfig, opts: ForgeAgentOptions = {}): Promise<ForgeAgent> {
    const env = new NodeExecutionEnv({ cwd: config.workdir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: config.sessionsDir });
    const session: Session = opts.resume ? await repo.open(opts.resume) : await repo.create({ cwd: config.workdir });

    // 飞行记录仪：每次运行一个文件 <ts>-<sessionId>.jsonl（默认开）。
    let flight: FlightRecorder | null = null;
    let flightPath: string | null = null;
    if (config.flightLog.enabled) {
      const meta = await session.getMetadata();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      flightPath = resolve(config.flightLog.dir, `${ts}-${meta.id}.jsonl`);
      flight = new FlightRecorder(new FileFlightSink(flightPath), { contextMode: config.flightLog.contextMode });
      flight.record("session_start", {
        sessionId: meta.id,
        cwd: config.workdir,
        model: config.modelRef,
        contextMode: config.flightLog.contextMode,
        resumed: Boolean(opts.resume),
      });
    }

    const memory = new Memory(config.workdir);
    const { skills } = await loadSkillsCrossPlatform(env, config.skillsDirs);
    const lsp = new LspClient(config.workdir); // 惰性：构造不 spawn，首次查询才起 server

    let self!: ForgeAgent;
    const tools: AgentTool[] = [
      ...makeFsTools(config.workdir, config.allowReadOutsideWorkdir),
      ...makeSearchTools(config.workdir, config.allowReadOutsideWorkdir),
      makeOutlineTool(config.workdir, config.allowReadOutsideWorkdir),
      makeRepoMapTool(config.workdir, config.allowReadOutsideWorkdir),
      ...makeLspTools(config.workdir, lsp, config.allowReadOutsideWorkdir),
      makeBashTool(config.workdir),
      makeApplyPatchTool(config.workdir),
      makeDiagnosticsTool(config.workdir, lsp),
      ...makeMemoryTools(memory),
      ...makeSubAgentTools({
        spawn: (role, task, maxTurns) => self.spawnSubAgent(role, task, maxTurns),
        cancel: (id) => self.cancelSubAgent(id),
        list: () => self.listSubAgents(),
      } satisfies SubAgentOrchestrator),
      ...makeConvergeTools((justification) => self.onSubmitForReview(justification)),
      // ssh_run：常驻注册（只挂主 agent，不给子 agent/Convergent）。真正的授权边界是
      // 「profile 必须匹配 forge.config.json 配过的档案」——未配置时调用返回引导错误，连不上任何 host。
      makeSshTool(config.ssh),
    ];

    const harness = new AgentHarness({
      env,
      session,
      tools,
      resources: { skills },
      model: config.model,
      streamOptions: streamOptionsOf(config), // 单请求退避重试（OpenAI SDK 内置）
      thinkingLevel: config.thinkingLevel, // reasoning 拉满（DeepSeek → reasoning_effort:max）
      steeringMode: "all", // 忙时插话：当前 turn 边界一次性注入全部排队消息（库默认 one-at-a-time 会分多 turn 喂）
      systemPrompt: ({ resources }) => {
        const parts = [MAIN_SYSTEM_PROMPT, environmentBlock(config.workdir)];
        const sk = resources.skills ?? [];
        if (sk.length) parts.push(formatSkillsForSystemPrompt(sk));
        const memIndex = memory.indexBlock(); // 常驻注入记忆索引（具体记忆按需 memory_read）
        if (memIndex) parts.push(memIndex);
        return parts.join("\n\n");
      },
      getApiKeyAndHeaders: async (model: Model<Api>) => {
        const apiKey = getEnvApiKey(model.provider);
        return apiKey ? { apiKey } : undefined;
      },
    });

    self = new ForgeAgent(config, opts, { harness, env, repo, lsp, flight, flightPath });
    return self;
  }

  /** 列出当前 workdir 下的历史会话（供 /resume）。 */
  static async listSessions(config: ForgeConfig): Promise<JsonlSessionMetadata[]> {
    const env = new NodeExecutionEnv({ cwd: config.workdir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: config.sessionsDir });
    return repo.list({ cwd: config.workdir });
  }

  // ── 后台子 agent 编排（SubAgentOrchestrator → 委托 SubAgentRegistry）──────────

  /** 后台启动一个子 agent，立即返回 id（不阻塞）。 */
  spawnSubAgent(role: string, task: string, maxTurns: number | undefined): string {
    return this.subagents.spawn(role, task, maxTurns);
  }

  /** 中途撤销运行中的子 agent。 */
  cancelSubAgent(id: string): string {
    return this.subagents.cancel(id);
  }

  /** 列出所有子 agent 的状态快照。 */
  listSubAgents(): SubAgentInfo[] {
    return this.subagents.list();
  }

  /** 解析首选模型 ref；未知模型或缺 key → 回退主模型。返回 model + 对应 thinking。 */
  private resolvePreferredModel(ref: string): { model: Model<Api>; thinking: ThinkingLevel } {
    let model = this.harness.getModel();
    let thinking: ThinkingLevel = this.config.thinkingLevel;
    try {
      const r = resolveModel(ref);
      if (hasKey(r.provider)) {
        model = r.model;
        thinking = r.model.reasoning ? "xhigh" : "off";
      }
    } catch {
      /* 未知模型 → 回退主模型 */
    }
    return { model, thinking };
  }

  /** 只读取证工具集：fs(读/列) + 搜索 + outline + repo_map + LSP(−rename)。共享主 agent 的 LspClient(warm 复用)。 */
  private readonlyToolset(): AgentTool[] {
    const wd = this.config.workdir;
    const ro = this.config.allowReadOutsideWorkdir;
    return [
      ...makeFsTools(wd, ro).filter((t) => t.name === "read_file" || t.name === "list_dir"),
      ...makeSearchTools(wd, ro),
      makeOutlineTool(wd, ro),
      makeRepoMapTool(wd, ro),
      ...makeLspTools(wd, this.lsp, ro).filter((t) => t.name !== "rename"),
    ];
  }

  /** Convergent 验证 agent 的工具集：只读取证 + bash（能跑命令/复现）。不含写工具与 spawn(防递归)。 */
  private verifierToolset(): AgentTool[] {
    return [...this.readonlyToolset(), makeBashTool(this.config.workdir)];
  }

  /**
   * 临时 agent 内核：隔离会话 + 注入的工具集 + max-turns 护栏。
   * 子 agent（flash·只读）与 Convergent 验证 agent（pro·只读+bash）共用它，差异点（模型 / 工具 /
   * system prompt / 权限闸门 / 用量统计 / 进度回调）全部参数化注入。返回最终文本 + 轮数/工具数 + 是否触上限截断。
   */
  private async runEphemeralAgent(opts: {
    task: string;
    systemPrompt: string;
    model: Model<Api>;
    thinking: ThinkingLevel;
    tools: AgentTool[];
    /** 轮数上限；<=0 表示不限。 */
    maxTurns: number;
    signal: AbortSignal;
    /** 可选权限闸门（如 Convergent 跑 bash 时仍硬拦灾难命令 / 走语义写守卫）。返回 {block} 即拦截；可异步。 */
    gate?: (toolName: string, input: unknown) => ({ block: true; reason: string } | undefined) | Promise<{ block: true; reason: string } | undefined>;
    /** 用量统计订阅（如子 agent 计入 subTelemetry）。 */
    telemetry?: (e: AgentHarnessEvent) => void;
    /** 全量事件转发（如 Convergent 把活动实时显示到 UI）。 */
    onEvent?: (e: AgentHarnessEvent) => void;
    /** 每完成一轮回调（cumulative turns）。 */
    onTurn?: (turns: number) => void;
    /** 每次工具调用开始回调。 */
    onToolStart?: (toolName: string, args: unknown, turns: number, tools: number) => void;
    /** 飞行记录标签（如 `subagent:foo#3` / `convergent`）；传了且飞行记录开启则把该子 harness 的全量事件也落盘。 */
    flightTag?: string;
  }): Promise<SubAgentResult> {
    const { task, systemPrompt, model, thinking, signal, maxTurns: cap, tools } = opts;
    const unlimited = cap <= 0;
    const session = await this.repo.create({ cwd: this.config.workdir });
    const sub = new AgentHarness({
      env: this.env,
      session,
      tools,
      model,
      thinkingLevel: thinking,
      streamOptions: streamOptionsOf(this.config),
      systemPrompt,
      getApiKeyAndHeaders: async (m: Model<Api>) => {
        const apiKey = getEnvApiKey(m.provider);
        return apiKey ? { apiKey } : undefined;
      },
    });
    if (opts.gate) {
      const gate = opts.gate;
      sub.on("tool_call", (e) => gate(e.toolName, e.input));
    }
    signal.addEventListener("abort", () => void sub.abort(), { once: true });
    const unsubTel = opts.telemetry ? sub.subscribe(opts.telemetry) : () => {};
    const unsubEvt = opts.onEvent ? sub.subscribe(opts.onEvent) : () => {};
    // 飞行记录：把子 harness 的全量事件也落盘（带 agent 标签，独立 context 状态机）。
    const unsubFlight = opts.flightTag && this.flight ? sub.subscribe(this.flight.scope(opts.flightTag).handle) : () => {};

    let turns = 0;
    let toolCalls = 0;
    let hitLimit = false;
    const unsub = sub.subscribe((e) => {
      if (e.type === "turn_end") {
        turns += 1;
        opts.onTurn?.(turns);
        if (!unlimited && turns >= cap) {
          hitLimit = true;
          void sub.abort(); // 达上限：abort 子 harness（非 ac），故不算 cancelled
        }
      } else if (e.type === "tool_execution_start") {
        toolCalls += 1;
        opts.onToolStart?.(e.toolName, e.args, turns, toolCalls);
      }
    });

    try {
      const msg = await sub.prompt(task);
      await sub.waitForIdle();
      const text = hitLimit ? `（达到 ${cap} 轮上限被截断，以下为当时的部分结论）\n${textOf(msg)}` : textOf(msg);
      return { text, turns, tools: toolCalls, hitLimit };
    } catch (e) {
      if (hitLimit) return { text: `（达到 ${cap} 轮上限被截断，无最终结论）`, turns, tools: toolCalls, hitLimit: true };
      if (signal.aborted) return { text: `（已被撤销）`, turns, tools: toolCalls, hitLimit: false };
      throw e; // 真错误 → 交调用方处理
    } finally {
      unsub();
      unsubTel();
      unsubEvt();
      unsubFlight();
      try {
        await this.repo.delete(await session.getMetadata()); // 清理临时会话文件
      } catch {
        /* 删不掉就算了 */
      }
    }
  }

  /** 跑一个子 agent：flash 模型 + 只读工具 + 通用 prompt，进度写入 rec 并刷新仪表盘。runEphemeralAgent 的一层包装。 */
  private async runSubAgentLoop(
    role: string,
    task: string,
    maxTurns: number | undefined,
    signal: AbortSignal,
    rec: SubAgentTask,
  ): Promise<SubAgentResult> {
    const cap = maxTurns === undefined ? SUBAGENT_MAX_TURNS : maxTurns;
    const { model, thinking } = this.resolvePreferredModel("deepseek/deepseek-v4-flash");
    const pushLog = (s: string) => {
      rec.log.push(s);
      if (rec.log.length > SUBAGENT_LOG_CAP) rec.log.shift();
    };
    return this.runEphemeralAgent({
      task,
      systemPrompt: `SUBAGENT[${role}] 你是一个专职子 agent，只用只读工具完成被指派的子任务，最后用一句话给出结论。`,
      model,
      thinking,
      tools: this.readonlyToolset(),
      maxTurns: cap,
      signal,
      flightTag: `subagent:${role}#${rec.id}`,
      telemetry: this.subTelemetry.handle, // flash 用量计入子 agent 统计
      onTurn: (turns) => {
        rec.turns = turns;
        pushLog(`✓ turn ${turns}`);
        this.subagents.refresh();
      },
      onToolStart: (toolName, args, _turns, tools) => {
        rec.tools = tools;
        pushLog(`${toolName}(${summarizeToolArgs(toolName, args)})`);
        this.subagents.refresh();
      },
    });
  }

  // ── /converge：工作到目标达成 + Convergent 验收 ──────────────────────────────

  /** submit_for_review 工具回调：记下主 agent 本轮宣称完成（+理由），供 checkConverge 读取。 */
  private onSubmitForReview(justification: string): void {
    this.pendingSubmit = { justification };
  }

  /** 设定 /converge 目标并返回喂给主 agent 的首条 kickoff（由调用方入队执行）。 */
  startConverge(goal: string): string {
    this.converge.set(goal, CONVERGENT_MAX_TURNS);
    this.convergeChangedFiles = new Set();
    this.pendingSubmit = undefined;
    return buildGoalKickoff(goal);
  }

  /** 清除当前 /converge 目标。 */
  clearConverge(): string {
    if (!this.converge.active) return "当前没有进行中的 /converge 目标。";
    this.converge.clear();
    return "已清除 /converge 目标。";
  }

  /** /converge 状态（供 /converge 无参时查看）。 */
  convergeStatus(): string {
    if (!this.converge.active) return "当前没有进行中的 /converge 目标。用 /converge <目标> 设定。";
    const last = this.converge.lastReason ? `\n上轮 Convergent 判定：${this.converge.lastReason}` : "";
    return `/converge 目标进行中（已验收 ${this.converge.turns} 轮）：\n${this.converge.goal}${last}`;
  }

  get convergeActive(): boolean {
    return this.converge.active;
  }

  /** 跑一次 Convergent 验收：fresh pro session + 只读+bash 工具 + 怀疑式 prompt + 硬拦灾难命令。 */
  private async runConvergent(goal: string, changedFiles: string[], claim: string): Promise<{ verdict: "yes" | "no"; reason: string }> {
    const { model, thinking } = this.resolvePreferredModel("deepseek/deepseek-v4-pro");
    // 自主运行（autoApprove），但硬拒绝黑名单 + 写边界守卫仍生效（Convergent 的 bash 也不许写出 workdir）
    const policy = new PermissionPolicy({ autoApprove: true, workdir: this.config.workdir, allowWriteOutside: this.config.allowWriteOutside });
    const task = buildConvergentTask({ goal, changedFiles, agentClaim: claim });
    const ac = new AbortController();
    this.currentAbort = ac; // 允许 Ctrl+C 中止验收
    try {
      const r = await this.runEphemeralAgent({
        task,
        systemPrompt: CONVERGENT_SYSTEM_PROMPT,
        model,
        thinking,
        tools: this.verifierToolset(),
        maxTurns: CONVERGENT_MAX_TURNS,
        signal: ac.signal,
        flightTag: "convergent",
        telemetry: this.subTelemetry.handle, // 计入子用量（pro，会拉高该行均价）
        onEvent: (e) => this.opts.onConvergentEvent?.(e), // 活动实时显示（UI 加 ⟢ 前缀区分）
        gate: async (toolName, input) => {
          const d = policy.check(toolName, input);
          if (d.verdict === "deny") return { block: true, reason: d.reason };
          // review：Convergent 复现常 cd 进项目子目录跑只读分析，确定性层拿不准 → 交语义守卫
          // （以验收任务为意图上下文）。这正是修掉「只读命令被误判越界、Convergent 空烧轮数」的关键。
          if (d.verdict === "review") return await this.runWriteGuard(String((input as { cmd?: unknown })?.cmd ?? ""), goal);
          return undefined;
        },
        onTurn: (turns) => this.status(`Convergent 取证核验中… (第 ${turns} 轮)`),
      });
      return parseVerdict(r.text);
    } finally {
      this.currentAbort = undefined;
      this.status(null);
    }
  }

  /** 用 flash 给「主 agent 这一轮的最后消息」做三分类（claims_done / asking_user / blocked）。 */
  private async classifyStop(lastMessage: string): Promise<StopKind> {
    const { model } = this.resolvePreferredModel("deepseek/deepseek-v4-flash");
    const apiKey = getEnvApiKey(model.provider);
    if (!apiKey) return "asking_user"; // 没 key → 交回用户（保守）
    try {
      const messages = [{ role: "user", content: [{ type: "text", text: buildClassifierPrompt(lastMessage) }], timestamp: Date.now() }] as Message[];
      const resp = await completeSimple(model, { systemPrompt: CLASSIFIER_SYSTEM_PROMPT, messages }, { maxTokens: 16, apiKey });
      if (resp.stopReason === "error" || resp.stopReason === "aborted") return "asking_user";
      const text = resp.content.filter((c) => (c as { type: string }).type === "text").map((c) => (c as { text: string }).text).join("");
      return parseClassification(text);
    } catch {
      return "asking_user";
    }
  }

  /**
   * 语义写边界守卫：确定性层判 review（cd 到 workdir 外 + 含写信号）时调用。
   * 用 flash·非思考带最小上下文（命令 + workdir + 本轮指令，不喂工具结果/agent 叙述）判一次。
   * 返回 {block} 表示拦截；undefined 表示放行。fail-open：无 key / 报错 / 解析不到裁决 → 放行
   * （best-effort 边界，灾难命令已由 HARD_DENY 黑名单在确定性层硬拦，不会走到这里）。
   */
  private async runWriteGuard(command: string, instruction: string): Promise<{ block: true; reason: string } | undefined> {
    if (!command) return undefined;
    const { model } = this.resolvePreferredModel("deepseek/deepseek-v4-flash");
    const apiKey = getEnvApiKey(model.provider);
    if (!apiKey) return undefined; // 没 key → 放行（fail-open）
    try {
      const prompt = buildWriteGuardPrompt({ command, workdir: this.config.workdir, userInstruction: instruction });
      const messages = [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] as Message[];
      const resp = await completeSimple(model, { systemPrompt: WRITE_GUARD_SYSTEM_PROMPT, messages }, { maxTokens: 200, apiKey });
      if (resp.stopReason === "error" || resp.stopReason === "aborted") return undefined;
      const text = resp.content.filter((c) => (c as { type: string }).type === "text").map((c) => (c as { text: string }).text).join("");
      const v = parseWriteGuardVerdict(text);
      if (v.verdict === "deny") return { block: true, reason: `越界写入被拦截（语义守卫）：${v.reason}（确需可设 FORGE_ALLOW_WRITE_OUTSIDE=1）` };
      return undefined;
    } catch {
      return undefined; // 守卫自身故障不卡主流程
    }
  }

  /**
   * converge 循环的核心：一轮主 agent 结束后调用。
   *  · 无活动目标 → 直接返回。
   *  · 判定本轮是否「宣称完成」(显式 submit_for_review，或没调时 flash 分类为 claims_done)。
   *  · 宣称完成 → 跑 Convergent → done(清目标) / continue(把反馈入队再来一轮) / stop(达上限)。
   *  · 在问用户 / 卡住 → 暂停，控制权交回用户(目标保留，用户答复后下一轮继续)。
   */
  private async checkConverge(lastMessage: string): Promise<void> {
    if (!this.converge.active) return;
    const submitted = this.pendingSubmit;
    this.pendingSubmit = undefined;

    let claimsDone = submitted !== undefined;
    if (!claimsDone) {
      const kind = await this.classifyStop(lastMessage);
      if (kind !== "claims_done") {
        // 在问用户 / 卡住 → 不验收、不循环，交回用户（目标仍在，等用户答复后下一轮继续）
        this.notice(`\x1b[38;5;250m   ⎪ /converge 暂停：主 agent ${kind === "blocked" ? "似乎卡住了" : "在等你回应"}（目标仍在，回应后继续）\x1b[0m\n`);
        return;
      }
      claimsDone = true;
    }

    const claim = submitted?.justification ?? lastMessage;
    const verdict = await this.runConvergent(this.converge.goal, [...this.convergeChangedFiles], claim);
    const decision = this.converge.decide(verdict);
    if (decision.action === "done") {
      this.notice(`\x1b[38;5;42m   ✓ /converge 达成 — Convergent: ${decision.reason}\x1b[0m\n`);
    } else if (decision.action === "stop") {
      this.notice(`\x1b[38;5;208m   ⚠ /converge 停止 — ${decision.reason}\x1b[0m\n`);
    } else {
      this.notice(`\x1b[38;5;250m   ↻ /converge 未通过 — ${verdict.reason}\x1b[0m\n`);
      this.opts.onResume?.(decision.feedback); // 入队，主 agent 据此继续；下一轮再验收
    }
  }

  /**
   * 编辑后自动诊断：对受影响文件先 didChange（让 server 看到新内容）再取诊断，
   * 仅当有 error 时返回追加到工具结果的报告串；否则返回空（不打扰）。
   */
  private async autoDiagnose(paths: string[]): Promise<string> {
    const work = (async (): Promise<string> => {
      const reports: string[] = [];
      for (const p of paths) {
        if (!lspLangForPath(p)) continue; // 该语言无 LSP server
        try {
          await this.lsp.didChange(p); // 已打开的文件需通知变更，否则 server 持旧内容
          const diags = await this.lsp.diagnostics(p);
          if (diags && diags.some((d) => d.severity === "error")) reports.push(formatDiagnostics(p, diags));
        } catch {
          /* 诊断失败不影响主流程 */
        }
      }
      return reports.length ? `\n\n[自动诊断 · 编辑后自检]\n${reports.join("\n")}` : "";
    })();
    // 超时保护：首次 LSP 预热可能数秒，超预算就放弃本轮自检（预热在后台继续，下次编辑即快）。
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(""), AUTO_DIAGNOSE_TIMEOUT_MS);
      timer.unref?.(); // 别因这个计时器拖住进程退出
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 注入给 runFullCompaction 的「调一次模型做摘要」回调（用 pi-ai 的 completeSimple）。 */
  private makeSummarizeFn(): SummarizeFn {
    const model = this.harness.getModel();
    const reserve = this.config.compaction.reserveTokens;
    const thinking = this.config.thinkingLevel;
    return async ({ systemPrompt, userPrompt }) => {
      const apiKey = getEnvApiKey(model.provider);
      if (!apiKey) return { ok: false, text: "", errorMessage: "compaction needs an API key but the current provider has none" };
      const maxTokens = Math.min(Math.floor(0.8 * reserve), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
      const base = { maxTokens, apiKey, signal: this.currentAbort?.signal };
      const opts = model.reasoning && thinking !== "off" ? { ...base, reasoning: thinking } : base;
      const messages = [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }] as Message[];
      const resp = await completeSimple(model, { systemPrompt, messages }, opts);
      if (resp.stopReason === "aborted") return { ok: false, text: "", errorMessage: "summarization aborted" };
      if (resp.stopReason === "error") return { ok: false, text: "", tooLong: isTooLongError(resp.errorMessage), errorMessage: resp.errorMessage };
      const text = resp.content.filter((c) => (c as { type: string }).type === "text").map((c) => (c as { text: string }).text).join("\n");
      return { ok: true, text };
    };
  }

  /** 实际跑一次压缩（手动 / 自动共用），含熔断计数。 */
  private async runCompaction(): Promise<void> {
    this.status("Compacting context…");
    this.currentAbort = new AbortController();
    try {
      const r = await this.harness.compact(); // 触发 session_before_compact → 自研压缩
      this.compactionFailures = 0;
      // 压缩后即时重算上下文用量（摘要 + 实际保留窗口），不等下一轮 assistant usage——
      // 否则 session_compact 刷新仪表盘时仍读到压缩前的旧值。用 r.firstKeptEntryId（实际生效的，
      // 自研 / 库默认两条路径都对）在暂存的 branch 上求保留 token。
      this.lastContextTokens = estimateTokens(r.summary) + keptTokensFrom(this.pendingBranchPlan ?? [], r.firstKeptEntryId);
      this.pendingBranchPlan = undefined;
      // TODO(rehydrate): 压缩后重注入最近访问文件全文（≤5 个 / ~50k token 预算）。
      // 依赖：先建「最近访问文件追踪」基础设施。当前先靠摘要第 3 段 Files & Code
      // Sections 保留路径/片段 + 工具截断使按需重读廉价。
      // 注意：DeepSeek 非顶尖模型，往上下文猛塞反而抬高幻觉率，rehydrate 要克制、按预算注入。
      this.notice(`\x1b[38;5;250m   ↻ Context compaction: ~${r.tokensBefore} tokens → 9-section summary (kept from ${r.firstKeptEntryId.slice(0, 8)})\x1b[0m\n`);
    } catch (e) {
      if (this.currentAbort?.signal.aborted) {
        this.notice(`\x1b[38;5;250m   ⎪ Compaction aborted\x1b[0m\n`); // 用户 Ctrl+C，不计入熔断
      } else {
        this.compactionFailures += 1;
        this.audit.write({ kind: "tool_end", tool: "compact", isError: true, preview: (e as Error).message });
        if (this.compactionFailures >= 3) {
          this.compactionDisabled = true;
          this.notice(`\x1b[38;5;208m   ⚠ Compaction failed 3× in a row — auto-compaction disabled (/compact to retry)\x1b[0m\n`);
        }
      }
    } finally {
      this.currentAbort = undefined;
      this.status(null); // 关闭进度行
    }
  }

  /** 压缩触发策略：上下文用量 > 90% 窗口即自动压缩（已熔断则跳过）。 */
  private async maybeCompact(): Promise<void> {
    if (this.compactionDisabled) return;
    const win = this.effectiveWindow;
    if (win <= 0 || this.lastContextTokens <= 0.9 * win) return;
    await this.runCompaction();
  }

  /** 当前模型 ref（provider/model）。 */
  get modelRef(): string {
    return this.currentRef;
  }

  /** 当前 provider 是否有 key。 */
  get isLive(): boolean {
    return this.live;
  }

  /** 最近一次送入模型的上下文 token 估算（供仪表盘）。 */
  get contextTokens(): number {
    return this.lastContextTokens;
  }

  /** 当前模型的上下文窗口大小。 */
  get contextWindow(): number {
    return this.harness.getModel().contextWindow;
  }

  /** 压缩用的「有效窗口」：配了 maxContextTokens（且小于真实窗口）就用它，否则用真实窗口。
   *  触发(0.9)与保留(0.2)都按它算——这样压测时降到 200K 能整体生效。 */
  private get effectiveWindow(): number {
    const real = this.contextWindow;
    const m = this.config.maxContextTokens;
    return m && m > 0 && m < real ? m : real;
  }

  /** 订阅底层事件流（供 Ink TUI 把事件喂进 React state）。返回取消订阅函数。 */
  subscribe(listener: (event: AgentHarnessEvent) => void): () => void {
    return this.harness.subscribe(listener);
  }

  /** 框架通知输出：有 onNotice 走它（Ink），否则写 stdout。 */
  private notice(msg: string): void {
    if (this.opts.onNotice) this.opts.onNotice(msg);
    else process.stdout.write(msg);
  }

  /** 长操作实时状态：Ink 模式驱动进度行；非 Ink 模式忽略（避免污染流式输出）。 */
  private status(msg: string | null): void {
    this.opts.onStatus?.(msg);
  }

  /** 子 agent 实时状态：挂仪表盘下方。 */
  private subStatus(msg: string | null): void {
    this.opts.onSubStatus?.(msg);
  }

  /** 配置文件里可切换的模型清单。 */
  listModels(): ModelEntry[] {
    return this.config.models;
  }

  /** 当前可用 skills 清单（供 /skills）。 */
  listSkills(): Skill[] {
    return this.harness.getResources().skills ?? [];
  }

  /** 打开「跳过所有权限确认」（供 /pass-permissions）。灾难性命令的硬拦截仍生效。 */
  passPermissions(): void {
    this.policy.passAll();
  }

  /** 当前是否处于跳过确认模式（供仪表盘显示）。 */
  get bypassingPermissions(): boolean {
    return this.policy.bypassing;
  }

  /** 手动触发一次完整压缩（供 /compact）。用户主动介入 → 清除熔断、允许重试一次。 */
  async compactNow(): Promise<void> {
    this.compactionDisabled = false;
    this.compactionFailures = 0;
    await this.runCompaction();
  }

  /** 运行时切换模型。 */
  async switchModel(ref: string): Promise<{ ref: string; provider: string; live: boolean }> {
    const { provider, model } = resolveModel(ref);
    await this.harness.setModel(model);
    await this.harness.setThinkingLevel(model.reasoning ? "xhigh" : "off"); // 新模型也拉满 reasoning
    this.live = hasKey(provider);
    this.currentRef = ref;
    return { ref, provider, live: this.live };
  }

  /** 中止当前操作：取消进行中的压缩摘要调用 + 后台子 agent + 中止 agent 主循环（供 Ctrl+C）。 */
  async abort(): Promise<void> {
    this.subagents.abortAllRunning();
    this.currentAbort?.abort();
    try {
      await this.harness.abort();
    } catch {
      /* 非流式态 abort 可能抛错，忽略 */
    }
  }

  /** 释放资源（中止后台子 agent + 关闭 LSP server 子进程 + 收尾飞行日志）。退出前调用。 */
  async dispose(): Promise<void> {
    this.subagents.abortAllRunning();
    this.flight?.record("session_end");
    this.flight?.close();
    await this.lsp.dispose();
  }

  /** 本次运行的飞行日志文件路径（关闭时 null）。供 UI 提示用户落点。 */
  get flightLogPath(): string | null {
    return this.flightPath;
  }

  /**
   * 忙时插话：把用户输入排进 steering 队列，由库在当前 turn 工具执行完毕、下一次 LLM 调用前注入
   * （不打断当前步、不撕裂 tool_result 配对）。同步入队、立即返回；无 run 在跑时该消息会等到下次 run。
   */
  steer(text: string): void {
    this.audit.write({ kind: "prompt", preview: `[steer] ${text}` });
    void this.harness.steer(text);
  }

  /** 跑一轮用户输入，按需压缩，再做 /converge 验收检查（若有活动目标）。 */
  async run(input: string): Promise<void> {
    this.audit.write({ kind: "prompt", preview: input });
    this.currentUserInstruction = input; // 供语义写守卫判断本轮意图
    this.runChangedFiles.clear();
    const msg = await this.harness.prompt(input);
    await this.harness.waitForIdle();
    await this.maybeSelfReview(); // P1：本轮有写 → 强制一次 diff 自审，剔除无关改动（防过度编辑）
    await this.maybeCompact();
    await this.checkConverge(textOf(msg)); // 有 active 目标才会真正动作
  }

  /**
   * 收尾 diff 自审（P1）：本轮若改过文件，在下结论前强制 agent 回看改动、剔除与修复无关的部分。
   * 提示词是软约束，这是硬兜底——专治「多改无关文件 / 过度重写」（如误改 build 配置致补丁失败）。
   * 只跑一次：先清空 runChangedFiles，自审过程里的还原/再编辑不会触发二次自审。
   */
  private async maybeSelfReview(): Promise<void> {
    if (this.runChangedFiles.size === 0) return; // 本轮没用编辑工具改过文件
    this.runChangedFiles.clear(); // 先清空：自审过程里的还原/再编辑不再触发二次自审
    const review = [
      "[收尾自审] 在给出最终结论前，对本轮改动做一次最小化复查：",
      "先运行 `git diff --stat`（不在 git 仓库则用 `git status` 或回看本轮改动）查看你本轮改过的**全部**文件——务必涵盖你用 bash/命令（如 sed、重定向）改的，不只是用编辑工具改的。",
      "然后逐一自查：",
      "1) 有没有与本次任务无关的改动？——尤其构建/依赖配置（pyproject.toml / setup.py / package.json / requirements 等）、无关文件、纯格式重排、顺手重构。有就还原（`git checkout -- <文件>` 或 edit_file），只保留修复所必需的最小改动。",
      "2) 每处保留的改动是否都是解决问题所必需的？",
      "3) 改过的文件 diagnostics 是否无 error？",
      "若有需还原的改动，先还原再给结论。",
    ].join("\n");
    this.audit.write({ kind: "prompt", preview: "[收尾自审] 最小化复查(git diff)" });
    await this.harness.prompt(review);
    await this.harness.waitForIdle();
  }
}
