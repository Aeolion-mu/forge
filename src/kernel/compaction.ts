/**
 * 完整压缩（Full Compaction）—— 自研内核模块。
 *
 * 设计前提（DeepSeek 纯前缀缓存、无 Cache Editing API）：单 session 严格 append-only，
 * 压缩是唯一一次「破缓存全量重建」，所以要 **少而狠**——高水位（90%）单次触发，
 * 一次释放一大片（压前 ~70%，留近端 K≈20% 窗口）。
 *
 * 本模块只管「怎么压」的纯逻辑 + orchestrator，可独立单测；
 * 「何时压」「接 hook / 落会话树 / 善后重注入」在 forge-agent 里接（④）。
 *
 * 与库的差异：库的 compact() 写死 DEFAULT_COMPACTION_SETTINGS、6 段模板。我们自研：
 *   · cut point 对齐 turn 边界（整 turn 保留/压缩，天然不拆 tool_use/tool_result 对）
 *   · 9 段 coding 向摘要模板 + 全量用户消息（防漂移），去掉 <analysis> 标签
 *     （deepseek-v4-pro 已开 reasoning，思维链走原生通道，再套标签是冗余）
 *   · prompt-too-long 用 map-reduce 兜底（分块各摘再合并），不盲丢最早组
 */

/** 压缩用的精简消息（从会话树 entry 转换而来，见 ④）。 */
export interface CompactMessage {
  role: "user" | "assistant" | "toolResult";
  /** 已序列化的文本内容。 */
  text: string;
}

/** 字符估算 token（4 char/token，与全项目一致）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 一条消息是否是「turn 起始」（真正的用户消息，而非工具结果）。 */
function isTurnStart(m: CompactMessage): boolean {
  return m.role === "user";
}

/**
 * 选裁剪点：从尾部按 token 预算累加到 >= keepRecentTokens，再**向前对齐到最近的 turn 起始**，
 * 保证整 turn 保留（天然不拆 tool 对 / thinking block）。返回首个保留消息的下标。
 *  · 返回 0 → 没有可压缩的前缀（会话太短或全在近端预算内），调用方应跳过压缩。
 */
export function selectCutPoint(messages: CompactMessage[], keepRecentTokens: number): number {
  if (messages.length === 0) return 0;
  let acc = 0;
  let idx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i].text);
    if (acc >= keepRecentTokens) {
      idx = i;
      break;
    }
  }
  // 向前对齐到 turn 起始（保留更完整、更连贯；宁可多留一点也不拆 turn）
  let cut = idx;
  while (cut > 0 && !isTurnStart(messages[cut])) cut--;
  return cut;
}

/** 按 turn 边界把消息分组（每组以一条真实用户消息开头）。用于 map-reduce 兜底。 */
export function groupByTurn(messages: CompactMessage[]): CompactMessage[][] {
  const groups: CompactMessage[][] = [];
  for (const m of messages) {
    if (isTurnStart(m) || groups.length === 0) groups.push([m]);
    else groups[groups.length - 1].push(m);
  }
  return groups;
}

/** 序列化为摘要 prompt 里的对话文本。 */
export function serializeConversation(messages: CompactMessage[]): string {
  const tag = { user: "User", assistant: "Assistant", toolResult: "ToolResult" } as const;
  return messages.map((m) => `[${tag[m.role]}]\n${m.text}`).join("\n\n");
}

/** 会话树 entry 的精简投影（forge-agent 把 SessionTreeEntry 转成它，保持本模块不依赖库类型）。 */
export interface PlanEntry {
  id: string;
  type: string;
  /** type==="message" 时的角色。 */
  role?: string;
  /** type==="message" 时已序列化的文本。 */
  text?: string;
  /** type==="compaction" 时的上次摘要。 */
  summary?: string;
}

export interface CompactionPlan {
  /** 压缩后首个保留 entry 的 id（交给库 appendCompaction）。 */
  firstKeptEntryId: string;
  /** 需要被摘要的前缀消息。 */
  messagesToSummarize: CompactMessage[];
  /** 保留的近端消息估算 token（供压缩后即时刷新仪表盘 ctx）。 */
  keptTokens: number;
  /** 上次压缩的摘要（滚动增量）。 */
  previousSummary?: string;
}

/**
 * 从会话树（一条 branch 的 entries）算出压缩计划：
 *  · 从最近一次 compaction 之后开始（滚动增量，previousSummary = 该次摘要）
 *  · 只看 message entries，用 selectCutPoint 选裁剪点（留近端 keepRecentTokens）
 *  · cut<=0（没有可压缩前缀）→ 返回 undefined，调用方跳过
 */
export function extractCompactionPlan(entries: PlanEntry[], keepRecentTokens: number): CompactionPlan | undefined {
  let startIdx = 0;
  let previousSummary: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "compaction") {
      startIdx = i + 1;
      previousSummary = entries[i].summary;
      break;
    }
  }
  const msgEntries = entries
    .slice(startIdx)
    .filter((e) => e.type === "message" && (e.role === "user" || e.role === "assistant" || e.role === "toolResult"));
  const messages: CompactMessage[] = msgEntries.map((e) => ({ role: e.role as CompactMessage["role"], text: e.text ?? "" }));
  const cut = selectCutPoint(messages, keepRecentTokens);
  if (cut <= 0) return undefined;
  const keptTokens = messages.slice(cut).reduce((s, m) => s + estimateTokens(m.text), 0);
  return { firstKeptEntryId: msgEntries[cut].id, messagesToSummarize: messages.slice(0, cut), keptTokens, previousSummary };
}

/**
 * 压缩后保留窗口的估算 token：从 firstKeptEntryId 起到末尾的所有 message entry 文本之和。
 *
 * 供压缩**完成后**即时重算「上下文用量」——压缩生效后不能再信任 `estimateContextTokens`，因为它把
 * 用量锚定在最后一条带 provider usage 的 assistant 上，而保留窗口里残留的那条旧 assistant 记的是
 * 压缩前的满窗 usage（如 187k），会让用量虚高不降、触发反复压缩。本函数按字符估算绕开该锚定。
 * firstKeptEntryId 不在 entries 中 → 返回 0（保守，等下一轮新 assistant 的真实 usage 校正）。
 */
export function keptTokensFrom(entries: PlanEntry[], firstKeptEntryId: string): number {
  const idx = entries.findIndex((e) => e.id === firstKeptEntryId);
  if (idx < 0) return 0;
  return entries.slice(idx).reduce((s, e) => s + (e.type === "message" ? estimateTokens(e.text ?? "") : 0), 0);
}

export const SUMMARIZATION_SYSTEM_PROMPT =
  "You are a context summarization assistant for a terminal coding agent. Read the conversation and produce ONE structured checkpoint that another instance will use to continue the work with no other memory of this conversation. Do NOT continue the conversation or answer any question inside it. Output ONLY the summary.";

/** 9 段模板（首次压缩）。 */
const FRESH_PROMPT = `Analyze the conversation chronologically, then write a checkpoint using EXACTLY these 9 sections:

1. Primary Request and Intent — All explicit user requests and the overall intent, in detail.
2. Key Technical Concepts — Technologies, frameworks, libraries, and patterns in play.
3. Files and Code Sections — Every file read/created/modified, with EXACT paths. For modified files include the key snippet and why it matters; preserve exact signatures and identifiers.
4. Errors and Fixes — Errors encountered (EXACT messages) and how each was fixed; record user corrections VERBATIM.
5. Problem Solving — Problems solved and the reasoning; open investigations.
6. All User Messages — List EVERY non-tool-result user message verbatim/near-verbatim, in order. (Anchors intent; prevents drift.)
7. Pending Tasks — Explicitly requested work not yet done.
8. Current Work — Precisely what was being done immediately before this summary, referencing the most recent messages and exact code/files.
9. Next Step — The single next action, DIRECTLY in line with the user's most recent explicit request and Current Work. Do not introduce tangential or already-completed work; if unclear, say so.

Rules: preserve security-relevant instructions/constraints VERBATIM; keep exact file paths, function names, error strings, and commands; write the summary in the SAME LANGUAGE as the conversation; each section concise but none omitted (use "(none)" if empty).`;

/** 9 段模板（滚动增量：在 previousSummary 上增补）。 */
const UPDATE_PROMPT = `Update the existing summary in <previous-summary> with the NEW messages. RULES: preserve all prior info; move items from In Progress/Pending to Done when completed; refresh Current Work and Next Step; preserve exact paths/errors/commands; keep the same 9 sections (Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and Fixes / Problem Solving / All User Messages / Pending Tasks / Current Work / Next Step); write in the SAME LANGUAGE as the conversation.`;

/** 构造摘要请求的 user prompt。 */
export function buildSummaryPrompt(conversationText: string, previousSummary?: string): string {
  let p = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) p += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  return p + (previousSummary ? UPDATE_PROMPT : FRESH_PROMPT);
}

/** 注入的「调一次模型做摘要」回调（④ 用 completeSimple 实现，单测用 fake）。 */
export interface SummarizeFn {
  (input: { systemPrompt: string; userPrompt: string }): Promise<SummarizeResult>;
}
export interface SummarizeResult {
  ok: boolean;
  text: string;
  /** 是否因 prompt 过长失败（触发 map-reduce 兜底）。 */
  tooLong?: boolean;
  errorMessage?: string;
}

/** errorMessage 是否表示「上下文/请求过长」。 */
export function isTooLongError(msg: string | undefined): boolean {
  return !!msg && /too long|context length|maximum context|context_length|prompt is too|exceeds?\s+the\s+(maximum|context)/i.test(msg);
}

export class CompactionFailed extends Error {}

/**
 * 跑一次完整压缩，产出摘要文本。
 *  · 正常：序列化 → 9 段 prompt → summarize。
 *  · prompt-too-long：map-reduce 兜底——按 turn 二分，各块独立摘要，再把块摘要合并摘要；
 *    递归加深直到 maxDepth；都不行则抛 CompactionFailed（不盲丢内容）。
 */
export async function runFullCompaction(opts: {
  messages: CompactMessage[];
  summarize: SummarizeFn;
  previousSummary?: string;
  /** map-reduce 最大递归深度（≈Claude Code「最多重试 3 次」），默认 3。 */
  maxDepth?: number;
  /** 进度状态回调（驱动 TUI 动态显示「正在干什么」）。 */
  onStatus?: (msg: string) => void;
}): Promise<string> {
  const { messages, summarize, previousSummary, onStatus } = opts;
  const maxDepth = opts.maxDepth ?? 3;
  if (messages.length === 0) throw new CompactionFailed("没有可压缩的消息");

  const once = async (msgs: CompactMessage[], prev?: string): Promise<SummarizeResult> => {
    const userPrompt = buildSummaryPrompt(serializeConversation(msgs), prev);
    return summarize({ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, userPrompt });
  };

  const first = await once(messages, previousSummary);
  if (first.ok) return first.text;
  if (!first.tooLong) throw new CompactionFailed(first.errorMessage || "摘要失败");

  // map-reduce 兜底
  onStatus?.("Context too long — summarizing in chunks…");
  const reduce = async (msgs: CompactMessage[], depth: number): Promise<string> => {
    const r = await once(msgs);
    if (r.ok) return r.text;
    if (!r.tooLong || depth >= maxDepth) {
      throw new CompactionFailed(`map-reduce 到深度 ${depth} 仍过长：${r.errorMessage ?? ""}`);
    }
    const groups = groupByTurn(msgs);
    if (groups.length < 2) throw new CompactionFailed("单 turn 仍过长，无法再分块");
    const mid = Math.ceil(groups.length / 2);
    const left = groups.slice(0, mid).flat();
    const right = groups.slice(mid).flat();
    const [ls, rs] = await Promise.all([reduce(left, depth + 1), reduce(right, depth + 1)]);
    // 合并两段块摘要：把左摘要当 previousSummary、右块文本当新增 → 走 UPDATE 模板增量合并
    const merged = await once(
      [{ role: "assistant", text: `Partial summary of later messages:\n${rs}` }],
      ls,
    );
    if (merged.ok) return merged.text;
    throw new CompactionFailed(`合并块摘要失败：${merged.errorMessage ?? ""}`);
  };
  return reduce(messages, 1);
}
