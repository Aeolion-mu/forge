import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { costRmb, type Rate } from "./pricing.js";

/**
 * 可观测 —— 订阅 agent 事件流，沉淀 token / 时延 / 工具调用指标。
 * 对应「agent 可观测性 / trace」八股：每一轮、每一次工具调用都可度量。
 */

export interface ToolStat {
  calls: number;
  errors: number;
  totalMs: number;
}

export class Telemetry {
  turns = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  /** 累计成本（人民币元，按真实定价算，见 pricing.ts）。 */
  costRmb = 0;
  /** 最近一次回复的模型 id（如 deepseek-v4-flash），供仪表盘显示真实模型名。 */
  model = "";
  private readonly tools = new Map<string, ToolStat>();
  private readonly toolStart = new Map<string, number>();
  private readonly startedAt = Date.now();

  /** 定价表（来自 config，已合并内置默认）；不传则 costRmb 用内置默认。 */
  constructor(private readonly rates?: Record<string, Rate>) {}

  /** 直接作为 harness.subscribe 的 listener（事件类型已扩到 AgentHarnessEvent）。 */
  handle = (event: AgentHarnessEvent): void => {
    switch (event.type) {
      case "turn_end": {
        this.turns += 1;
        const msg = event.message as AssistantMessage;
        if (msg?.usage) {
          this.inputTokens += msg.usage.input ?? 0;
          this.outputTokens += msg.usage.output ?? 0;
          this.cacheReadTokens += msg.usage.cacheRead ?? 0;
          this.cacheWriteTokens += msg.usage.cacheWrite ?? 0;
          this.costRmb += costRmb(`${msg.provider}/${msg.model}`, msg.usage, this.rates);
          if (msg.model) this.model = msg.model;
        }
        break;
      }
      case "tool_execution_start":
        this.toolStart.set(event.toolCallId, Date.now());
        break;
      case "tool_execution_end": {
        const s = this.tools.get(event.toolName) ?? { calls: 0, errors: 0, totalMs: 0 };
        s.calls += 1;
        if (event.isError) s.errors += 1;
        const t0 = this.toolStart.get(event.toolCallId);
        if (t0) {
          s.totalMs += Date.now() - t0;
          this.toolStart.delete(event.toolCallId);
        }
        this.tools.set(event.toolName, s);
        break;
      }
      default:
        break;
    }
  };

  /**
   * 会话级 prompt 缓存命中率 = cacheRead / 总 prompt tokens(input+cacheRead+cacheWrite)。
   * DeepSeek/openai-completions 语义：cacheRead=prompt_cache_hit_tokens，input=miss 部分。
   * 命中率越高说明 append-only 策略越奏效（前缀复用，便宜又快）。无 prompt 时返回 0。
   */
  cacheHitRate(): number {
    const prompt = this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens;
    return prompt > 0 ? this.cacheReadTokens / prompt : 0;
  }

  summary(): string {
    const wall = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const lines = [
      "── trace metrics ─────────────────────────",
      `turns              : ${this.turns}`,
      `tokens in/out      : ${this.inputTokens} / ${this.outputTokens}`,
      `prompt cache hit   : ${this.cacheReadTokens} tok (${(this.cacheHitRate() * 100).toFixed(1)}%)`,
      `est. cost          : ¥${this.costRmb.toFixed(5)}`,
      `wall time          : ${wall}s`,
      "tool calls:",
    ];
    if (this.tools.size === 0) {
      lines.push("  (no tool calls this run)");
    } else {
      for (const [name, s] of this.tools) {
        const avg = s.calls ? Math.round(s.totalMs / s.calls) : 0;
        lines.push(`  ${name.padEnd(16)} calls=${s.calls} errors=${s.errors} avg=${avg}ms`);
      }
    }
    lines.push("───────────────────────────────────────");
    return lines.join("\n");
  }
}
