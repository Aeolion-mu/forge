/**
 * 调色板 / 火焰预览。两个独立维度：
 *   A 段 = 配色家族（换掉白·黄·橙·橙红）
 *   B 段 = 二维火焰算法（让 FORGE 不再是「每行一条色带」，而像一团火）
 *
 * 跑法：
 *   npx tsx scripts/palette.ts          # B 段用默认家族(冰蓝 #3)演示算法
 *   npx tsx scripts/palette.ts 5         # B 段改用家族 #5(紫焰) 演示算法
 *
 * 最终效果 = 你选的「家族编号」 ×「算法编号」。两个一起告诉我即可。
 */

const ART = [
  " ███████╗ ██████╗ ██████╗  ██████╗ ███████╗",
  " ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝",
  " █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ",
  " ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ",
  " ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗",
  " ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝",
];

const ROWS = ART.length;
const MAXCOL = Math.max(...ART.map((l) => l.length));
const CX = MAXCOL / 2;

const c256 = (code: number, ch: string) => `\x1b[38;5;${code}m${ch}`;
const RESET = "\x1b[0m";

// ── 配色家族：索引 0 = 最热/最亮，末位 = 最冷/最暗。6 阶 256 色。 ──
type Family = { name: string; ramp: number[] };
const FAMILIES: Family[] = [
  { name: "1) 白热烈焰 · 白→黄→橙红（现状，仅作参照）", ramp: [231, 228, 220, 214, 208, 202] },
  { name: "2) 熔岩余烬 · 暖白→琥珀→暗红", ramp: [231, 223, 215, 209, 167, 124] },
  { name: "3) 高温冰焰 · 白→冰蓝→深蓝", ramp: [231, 159, 123, 81, 39, 27] },
  { name: "4) 极光 · 白→青绿→深青", ramp: [231, 158, 121, 78, 42, 30] },
  { name: "5) 紫焰 · 亮粉→品红→深紫", ramp: [231, 219, 213, 177, 134, 92] },
  { name: "6) 翡翠 · 白→黄绿→深绿", ramp: [231, 194, 156, 114, 71, 28] },
  { name: "7) 赛博 · 品红↔青双色对撞", ramp: [201, 207, 177, 141, 79, 44] },
  { name: "8) 钢青冷光 · 白→钢蓝→石墨", ramp: [231, 189, 152, 110, 67, 240] },
];

// 把温度 t∈[0,1]（0=最热）映射到 ramp 的某一阶。
const pick = (t: number, ramp: number[]) =>
  ramp[Math.min(ramp.length - 1, Math.max(0, Math.floor(t * ramp.length)))];

// 稳定伪随机：同一 (r,c) 永远同一值，避免每次跑闪烁不一致。
function hash(r: number, c: number): number {
  const x = Math.sin(r * 127.1 + c * 311.7) * 43758.5453;
  return x - Math.floor(x); // [0,1)
}
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// ── 二维火焰算法：给定 (row,col) 返回温度 t（0=最热）。 ──
type Algo = { name: string; t: (r: number, c: number) => number };
const ALGOS: Algo[] = [
  {
    name: "A) 竖向渐变（现状基准：每行一色，无二维感）",
    t: (r) => r / (ROWS - 1),
  },
  {
    name: "B) 对角扫光：左下热 → 右上冷",
    t: (r, c) => (r / (ROWS - 1) + (1 - c / MAXCOL)) / 2,
  },
  {
    name: "C) 焰心放射：底部居中最白热，向上向两侧转冷（最像真火）",
    t: (r, c) => {
      const up = r / (ROWS - 1); // 越往下越热
      const side = 1 - 0.55 * Math.abs((c - CX) / CX); // 越居中越热
      return clamp01(1 - up * side);
    },
  },
  {
    name: "D) 火舌摇曳：竖向渐变叠正弦相位，热区像火苗左右舔动",
    t: (r, c) => clamp01(r / (ROWS - 1) + 0.3 * Math.sin(c * 0.5)),
  },
  {
    name: "E) 余烬飞溅：竖向渐变 + 逐字噪声扰动，像火星明灭",
    t: (r, c) => clamp01(r / (ROWS - 1) + (hash(r, c) - 0.5) * 0.45),
  },
  {
    name: "F) 等离子流：双频噪声场，整团色彩平滑流动",
    t: (r, c) =>
      clamp01(
        0.5 + 0.5 * (Math.sin(c * 0.35 + r * 0.4) * 0.6 + Math.sin(c * 0.13 - r * 0.9) * 0.4),
      ),
  },
];

// 逐字符渲染：颜色由 (row,col) 经算法定温、再映射到家族 ramp。
function render2(ramp: number[], algo: Algo): string {
  const out: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    const line = ART[r];
    let s = "";
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      s += ch === " " ? " " : c256(pick(algo.t(r, c), ramp), ch);
    }
    out.push(s + RESET);
  }
  return out.join("\n");
}

const dim = (s: string) => `\x1b[2m${s}${RESET}`;

// ===== A 段：配色家族（用竖向渐变看清调色）=====
process.stdout.write(`\n${dim("══════ A 段 · 配色家族（先挑一个色系编号）══════")}\n`);
for (const f of FAMILIES) {
  process.stdout.write(`\n${dim(f.name)}\n${render2(f.ramp, ALGOS[0])}\n`);
}

// ===== B 段：二维火焰算法（用选定家族看清「形状」）=====
const famIdx = Math.max(0, Math.min(FAMILIES.length - 1, (parseInt(process.argv[2] ?? "3", 10) || 3) - 1));
const showcase = FAMILIES[famIdx];
process.stdout.write(
  `\n\n${dim(`══════ B 段 · 二维火焰算法（用家族 #${famIdx + 1}「${showcase.name.replace(/^\d+\)\s*/, "")}」演示形状）══════`)}\n`,
);
for (const a of ALGOS) {
  process.stdout.write(`\n${dim(a.name)}\n${render2(showcase.ramp, a)}\n`);
}

process.stdout.write(
  `\n${dim("挑选方式：告诉我「家族编号 + 算法字母」，例如「家族 5 + 算法 C」。")}\n` +
    `${dim("想换 B 段演示色系：npx tsx scripts/palette.ts <家族编号>")}\n`,
);
