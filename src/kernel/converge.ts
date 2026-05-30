/**
 * /converge —— 「工作到目标达成 + 自主取证验证」的纯逻辑内核（可独立单测）。
 *
 * 思路（agentic verification，见 README ⑤）：主 agent 宣称完成时，派一个独立的验收 agent
 * **Convergent**（fresh session + 与主 agent 同级权限：能读、能 grep、能跑命令复现）**自己去拉/跑出证据**
 * 核验目标是否真的达成 —— 而不是把一坨 diff 推给它、也不是听它转述。这样同时抗「自利叙述造假」
 * 与「大改动上下文爆炸」。
 *
 * 关键取向（用户拍板）：Convergent 也可能看走眼，所以**拿不准就放行**——只在「确证未达成」时判 NO；
 * 复现不出 / 超出能核验范围 → 判 YES，留给用户亲自复核。它的职责是拦住「确凿没完成」，不是拦住「无法证明完成」。
 *
 * 本模块只管纯逻辑：Convergent 的提示词 + 裁决解析 + 状态机 + 完成检测分类器。
 * 「跑 Convergent（pro + 全权限 agent）」「接 run() 主循环」「submit_for_review 工具」在 forge-agent 里接。
 */

// ── Convergent 验证 agent ─────────────────────────────────────────────────────

/**
 * Convergent 的 system prompt（人格 + 判定原则）。核心两条：
 *   ① 只认自己拉到/跑出来的证据，不信实现 agent 的叙述；
 *   ② 判 NO 需明确反证，拿不准就放行（用户兜底）。
 * 这段是整套机制成败的关键 —— Convergent 会不会被骗、会不会乱拦，全看这里。
 */
export const CONVERGENT_SYSTEM_PROMPT = [
  "你是 Convergent —— 一个独立的验收 agent。一个实现 agent 刚宣称它达成了用户设定的目标，",
  "但实现 agent 有强烈动机宣称成功。你的职责是用**证据**判断它是否真的达成了目标，而不是听它怎么说。",
  "",
  "你的权限与主 agent 一样高：除只读检索（read_file / list_dir / glob / grep / outline / repo_map / definition / references / hover / diagnostics）外，",
  "你还能用 bash **实际运行命令** —— 跑测试、复现实现 agent 声称的事实、执行它文档里给的命令、亲自验证某处实现。",
  "主动去查、去跑、去复现，不要等别人把证据喂给你。",
  "",
  "用户只给你「改动文件清单」和实现 agent 的「自我声明」：清单告诉你去哪看；声明只是待核验的说法，**不得作为通过依据**。",
  "核验路径：把目标拆成可检查的具体判据 → 对每条，自己读代码 / grep / 跑命令复现找直接证据 → 据证据下结论。",
  "",
  "判定原则：",
  "1. 只认你亲自拉到 / 跑出来的证据（读到的代码、grep 命中、诊断输出、命令退出码）。实现 agent 的叙述、注释、它自己写的总结/交付文档一律不算证据。",
  "2. 警惕「叙述造假」：声称「已迁移全部调用」就去 grep 旧用法还在不在；声称「测试通过」就自己跑测试看退出码，而不是看它说通过。",
  "3. **判 NO 需要明确反证**：只有当你**确证**某条判据未达成、或亲自复现出了问题时才判 NO，并指出具体反证。",
  "4. **拿不准就放行**：某些东西你复现不出、超出你能核验的范围、或证据不足以下定论 —— **判 YES 放行**，并在 REASON 写清你没能核验的部分。",
  "   （用户会亲自复核；你的职责是拦住「确凿未完成」，不是拦住「无法证明完成」。）",
  "",
  "输出（最后一条消息，必须严格遵守此格式，供程序解析）：",
  "VERDICT: YES   或   VERDICT: NO",
  "REASON: 一句话结论。判 NO 必须给出你拿到的**具体反证 / 哪条判据确证未达成**，让实现 agent 能据此继续；判 YES 简述你核验/复现了什么，以及（若有）留给用户复核的部分。",
].join("\n");

/** forge 可代跑的硬指标检查结果（机器产出、可信，作为 Convergent 的起点证据之一；它也可自己再跑）。 */
export interface CheckResult {
  command: string;
  exitCode: number;
  /** 输出摘要（已截断）。 */
  output: string;
}

/** 构造 Convergent 本次核验的任务（user prompt）：只给路径 + 硬指标 + 待核验声明，其余让它自己去读/去跑。 */
export function buildConvergentTask(input: {
  goal: string;
  changedFiles: string[];
  checks?: CheckResult[];
  agentClaim?: string;
}): string {
  const parts: string[] = [];
  parts.push(`【验收目标（用户原文，逐字）】\n${input.goal.trim()}`);

  parts.push(
    input.changedFiles.length
      ? `【本次改动的文件（只给路径 —— 去读 / 去跑你需要的，别假设没列出的文件就没问题）】\n${input.changedFiles.map((f) => `- ${f}`).join("\n")}`
      : "【本次改动的文件】\n（本轮没有任何文件改动 —— 这本身可能就是「没真正干活」的信号，重点核实目标是否真能在零改动下达成。）",
  );

  if (input.checks?.length) {
    const body = input.checks.map((c) => `$ ${c.command}\nexit=${c.exitCode}\n${c.output}`).join("\n\n");
    parts.push(`【forge 已代跑的硬指标检查结果（机器产出，可信；你也可自己重跑）】\n${body}`);
  }

  parts.push(
    `【实现 agent 的自我声明（仅供参考，需核验，不得作为通过依据）】\n${input.agentClaim?.trim() || "（未提供声明）"}`,
  );

  parts.push("现在：自己去拉/跑证据核验目标是否**真的**达成，按系统提示的判定原则与输出格式给出 VERDICT。");
  return parts.join("\n\n");
}

export interface Verdict {
  verdict: "yes" | "no";
  reason: string;
}

/**
 * 解析 Convergent 最后一条消息里的裁决。
 * 失败取向（与「拿不准放行」一致）：解析不到明确 VERDICT → 按 "yes" 放行
 * （Convergent 输出异常视同它没能给出否决，用户会复核；不因验证器自身故障卡住主 agent）。
 */
export function parseVerdict(text: string): Verdict {
  const m = /VERDICT:\s*(YES|NO)\b/i.exec(text);
  // 没有可解析的 VERDICT → Convergent 输出异常，按放行处理（不因验证器自身故障卡住主 agent）。
  if (!m) return { verdict: "yes", reason: "Convergent 未给出可解析裁决，按放行处理（请用户自行复核）。" };

  const verdict: Verdict["verdict"] = m[1].toUpperCase() === "YES" ? "yes" : "no";
  const rm = /REASON:\s*([\s\S]+?)\s*$/i.exec(text);
  let reason = rm ? rm[1].trim() : "";
  if (!reason) {
    // 有 VERDICT 无 REASON 行：取除 VERDICT 行外的末段非空文本兜底
    reason =
      text
        .replace(/VERDICT:\s*(YES|NO)\b/i, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() ?? (verdict === "yes" ? "已核验通过。" : "确证未达成。");
  }
  return { verdict, reason };
}

// ── 完成检测分类器（agent 停下但没调 submit_for_review 时的兜底）─────────────────

export type StopKind = "claims_done" | "asking_user" | "blocked";

export const CLASSIFIER_SYSTEM_PROMPT =
  "你是一个分类器。一个编程 agent 刚结束一轮但没有显式声明完成。只判断它最后一条消息属于哪一类，只回一个词。";

/** 构造分类器 prompt（只喂最后一条消息，便宜的 flash 调用）。 */
export function buildClassifierPrompt(lastMessage: string): string {
  return [
    "判断下面这条「编程 agent 的最后消息」属于哪一类：",
    "- claims_done：它认为任务已经做完了",
    "- asking_user：它在向用户提问 / 等用户确认或决策",
    "- blocked：它卡住了 / 报错 / 缺信息无法继续",
    "",
    "最后消息：",
    "```",
    lastMessage.trim(),
    "```",
    "",
    "只回一个词：claims_done / asking_user / blocked",
  ].join("\n");
}

/**
 * 解析分类结果。保守取向：辨认不出 → "asking_user"（交回用户，不触发昂贵的 Convergent、不空转循环；
 * 万一漏判真完成，用户会看到循环停下、手动再触发即可，错误可恢复）。
 */
export function parseClassification(text: string): StopKind {
  const t = text.toLowerCase();
  if (/claims?_?done|done\b|complete/.test(t)) return "claims_done";
  if (/block/.test(t)) return "blocked";
  if (/ask|user|question|confirm|clarif/.test(t)) return "asking_user";
  return "asking_user";
}

// ── 状态机 ───────────────────────────────────────────────────────────────────

/** 默认验收轮数上限（防 Convergent↔主 agent 来回拉锯空烧）。 */
export const DEFAULT_CONVERGE_MAX_TURNS = 10;

export type ConvergeDecision =
  | { action: "done"; reason: string }
  | { action: "continue"; feedback: string }
  | { action: "stop"; reason: string };

/** /converge 启动时喂给主 agent 的首条消息：说清目标 + 「完成必须调 submit_for_review」。 */
export function buildGoalKickoff(goal: string): string {
  return [
    `【目标 /converge】${goal.trim()}`,
    "请朝这个目标工作。当你认为目标已达成时，**必须调用 submit_for_review 工具**并附简短理由说明为何达成；不要只是停下来。",
    "一个独立的验收 agent（Convergent）会核验你的声明，没通过会带着具体反馈让你继续。",
    "若你需要用户澄清才能继续，正常提问即可（不要调 submit_for_review）。",
  ].join("\n");
}

/** 喂回主 agent 的「未通过、请继续」消息。 */
export function buildContinueFeedback(goal: string, reason: string): string {
  return [
    "[验收未通过（Convergent）] 你宣称达成了目标，但独立验收没通过。",
    `目标：${goal}`,
    `Convergent 的判定：${reason}`,
    "请据此继续修复；完成后再次调用 submit_for_review。",
  ].join("\n");
}

/**
 * /converge 的状态机：持有当前目标 + 验收轮数 + 上限，吃进 Convergent 裁决推进并决定下一步。
 * 纯状态，不做任何 IO。
 */
export class ConvergeController {
  private state: { goal: string; turns: number; maxTurns: number } | null = null;
  private _lastReason = "";

  set(goal: string, maxTurns = DEFAULT_CONVERGE_MAX_TURNS): void {
    this.state = { goal: goal.trim(), turns: 0, maxTurns };
    this._lastReason = "";
  }

  clear(): void {
    this.state = null;
    this._lastReason = "";
  }

  get active(): boolean {
    return this.state !== null;
  }
  get goal(): string {
    return this.state?.goal ?? "";
  }
  get turns(): number {
    return this.state?.turns ?? 0;
  }
  get lastReason(): string {
    return this._lastReason;
  }

  /** 吃进一次 Convergent 裁决：推进轮数、更新 lastReason、决定 done/continue/stop。无活动目标则抛错。 */
  decide(verdict: Verdict): ConvergeDecision {
    if (!this.state) throw new Error("没有进行中的 converge 目标");
    this.state.turns += 1;
    this._lastReason = verdict.reason;
    if (verdict.verdict === "yes") {
      const reason = verdict.reason;
      this.clear();
      return { action: "done", reason };
    }
    if (this.state.maxTurns > 0 && this.state.turns >= this.state.maxTurns) {
      const reason = `达到 ${this.state.maxTurns} 轮验收上限仍未通过：${verdict.reason}`;
      this.clear();
      return { action: "stop", reason };
    }
    return { action: "continue", feedback: buildContinueFeedback(this.state.goal, verdict.reason) };
  }
}
