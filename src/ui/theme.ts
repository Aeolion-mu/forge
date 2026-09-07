/**
 * forge 设计语言：白 · 黄 · 橙 · 橙红 暖色系。
 * banner 火焰与全局强调色都从这里取，改色只动这一处。
 */

// 暖色 ramp：索引 0 = 最热/最白，末位 = 最冷/橙红。
// 256 色阶（写 stdout 的 ANSI 用）与其 hex 等价（Ink <Text color> 用），两者一一对应。
const RAMP = [231, 228, 220, 214, 208, 202];
const HEX = ["#ffffff", "#ffff87", "#ffd700", "#ffaf00", "#ff8700", "#ff5f00"];

/** Ink <Text color> 用的 hex。语义角色全部取自暖色 ramp，保持设计语言统一。 */
export const theme = {
  white: HEX[0],
  paleYellow: HEX[1],
  gold: HEX[2],
  amber: HEX[3],
  orange: HEX[4],
  orangeRed: HEX[5],
  // 语义角色
  spinner: HEX[3], // 琥珀
  assistant: HEX[2], // 金
  tool: HEX[4], // 橙
  error: HEX[5], // 橙红（仍在暖色内，热 = 警示）
  prompt: HEX[0], // 白
  confirm: HEX[2], // 黄
  muted: "#bcbcbc", // 次要/状态文本：浅灰（256 色 250），比 ANSI dim 亮、仍弱于正文白
} as const;

/** 写 stdout 的 push() 行用的原始 ANSI 包装，色值与 theme 对齐。 */
const wrap = (code: number) => (s: string) => `\x1b[38;5;${code}m${s}\x1b[0m`;
export const ansi = {
  assistant: wrap(220),
  tool: wrap(208),
  error: wrap(202),
  amber: wrap(214),
  add: wrap(220), // diff 新增行：金（暖色内，与删除的橙红区分）
  del: wrap(202), // diff 删除行：橙红
  // 次要/状态文本：用浅灰色号(250)而非 ANSI dim 属性——dim 在多数终端被压得过暗。
  dim: wrap(250),
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

// 思考/推理动态图标「火花闪烁」：实时 Reasoning 表头按帧闪动，折叠历史行用静止字形。
export const SPARK_FRAMES = ["⋆", "✦", "✧", "✵", "✷", "✸", "✷", "✵", "✧", "✦"];
export const SPARK_REST = "✦";
/** 按时间取当前火花帧（每 120ms 一帧，配合 busy 期间的重渲染）。 */
export const sparkFrame = (): string => SPARK_FRAMES[Math.floor(Date.now() / 120) % SPARK_FRAMES.length];

export const FORGE_ART = [
  " ███████╗ ██████╗ ██████╗  ██████╗ ███████╗",
  " ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝",
  " █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ",
  " ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ",
  " ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗",
  " ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const pick = (t: number) => RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor(t * RAMP.length)))];

// 二维火焰 · 算法 D「火舌摇曳」：竖向渐变叠正弦相位，热区随列位置左右舔动。
// 颜色同时取决于行与列，故不再是「每行一条色带」。
const temp = (r: number, c: number, rows: number) => clamp01(r / (rows - 1) + 0.3 * Math.sin(c * 0.5));

/** 把 FORGE 大字渲染成逐字符上色的二维火焰字符串。 */
export function renderBanner(): string {
  const rows = FORGE_ART.length;
  return FORGE_ART.map(
    (line, r) =>
      [...line].map((ch, c) => (ch === " " ? " " : `\x1b[38;5;${pick(temp(r, c, rows))}m${ch}`)).join("") + "\x1b[0m",
  ).join("\n");
}
