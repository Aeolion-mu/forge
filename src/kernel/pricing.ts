import type { Usage } from "@earendil-works/pi-ai";

/**
 * 计费 —— pi-ai 内置定价表对国产模型不准，这里按各家**真实定价**自己算（人民币）。
 * usage 语义（见 pi-ai parseChunkUsage）：
 *   input     = 缓存未命中的输入 token（prompt − 命中 − 写入）
 *   cacheRead = 缓存命中 token
 *   output    = 输出 token
 */

/** 每百万 token 的价格（人民币元）。 */
export interface Rate {
  cacheHit: number; // 命中缓存的输入
  miss: number; // 未命中的输入（含写缓存）
  output: number;
}

/** 内置定价（可被 forge.config.json 的 pricing 覆盖/扩充）。每百万 token，人民币。 */
export const DEFAULT_RMB_PER_M: Record<string, Rate> = {
  // 官方定价。Pro 为 2.5 折促销价（原价 0.1 / 12 / 24）。
  // DeepSeek V4 Pro：命中 ¥0.025 / 未命中 ¥3 / 输出 ¥6
  "deepseek/deepseek-v4-pro": { cacheHit: 0.025, miss: 3, output: 6 },
  // DeepSeek V4 Flash（子 agent 用）：命中 ¥0.02 / 未命中 ¥1 / 输出 ¥2
  "deepseek/deepseek-v4-flash": { cacheHit: 0.02, miss: 1, output: 2 },
};

/** 美元→人民币粗略汇率（仅用于未知模型的兜底估算）。 */
const USD_TO_RMB = 7.2;

/** 按真实定价计算一次调用的成本（人民币元）。未知模型用 pi-ai 的 USD 成本 × 汇率兜底。 */
export function costRmb(modelRef: string, usage: Usage, rates: Record<string, Rate> = DEFAULT_RMB_PER_M): number {
  const r = rates[modelRef];
  if (r) {
    const inputCost = (usage.cacheRead ?? 0) * r.cacheHit + ((usage.input ?? 0) + (usage.cacheWrite ?? 0)) * r.miss;
    return (inputCost + (usage.output ?? 0) * r.output) / 1e6;
  }
  return (usage.cost?.total ?? 0) * USD_TO_RMB;
}
