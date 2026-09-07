import { isWide } from "./markdown.js";

/**
 * 应用内选择模型（纯函数，可单测）——Claude Code 式拖选/双击选词/三击选行的数学层。
 *
 * 坐标约定：行 = 视口展开后的全局行号；列 = 该行的**可见列**（0-based；ANSI 转义占 0 列，
 * CJK/emoji 占 2 列——与 markdown.ts 的 wrapLine 同一宽度观）。
 * app 层负责把 {blockId, lineInBlock} 的稳定存储坐标换算成全局行号（新 block 追加、
 * 其他 block 折叠切换都不会挪动既有行）。
 */

/** 归一化后的选区：start ≤ end；startCol/endCol 为该行可见列（0-based，end 不含）。 */
export interface SelRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export function normalizeRange(a: { line: number; col: number }, b: { line: number; col: number }): SelRange {
  const [start, end] = a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a];
  return { startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col };
}

/** 某全局行在选区中的可见列区间 [start, end)（不在选区返回 null）。首尾行截断、中间行整行。 */
export function lineRangeInSel(r: SelRange, line: number): [number, number] | null {
  if (line < r.startLine || line > r.endLine) return null;
  const start = line === r.startLine ? r.startCol : 0;
  const end = line === r.endLine ? r.endCol : Number.POSITIVE_INFINITY;
  return end <= start ? null : [start, end];
}

const SGR = /\x1b\[[0-9;]*m/g;

/**
 * 按可见列切出纯文本（复制用）。ANSI 占 0 列直接跳过；宽字符与区间有任何交集即计入
 * （与终端按格选中的直觉一致）。导出供单测。
 */
export function plainSlice(ansiLine: string, colStart: number, colEnd: number): string {
  let out = "";
  let col = 0;
  let i = 0;
  while (i < ansiLine.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(ansiLine);
    if (m && m.index === i) {
      i = SGR.lastIndex;
      continue;
    }
    const cp = ansiLine.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = isWide(cp) ? 2 : 1;
    // 字符占据可见列 [col, col+w)：与 [colStart, colEnd) 有交集即选中
    if (col + w > colStart && col < colEnd) out += ch;
    col += w;
    i += ch.length;
  }
  return out;
}

/** 剥掉 ANSI 的纯文本（列坐标与原行一致：转义占 0 列）。 */
export function plainOf(ansiLine: string): string {
  return ansiLine.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 给 ANSI 行的可见列区间套反显高亮：区间内字符前插 `\x1b[7m`、出区间插 `\x1b[27m`
 * （选择性反显——与已有前景/背景色叠加，不撕裂转义序列）。列语义同 plainSlice。
 */
export function highlightRange(ansiLine: string, colStart: number, colEnd: number): string {
  let out = "";
  let col = 0;
  let i = 0;
  let on = false;
  while (i < ansiLine.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(ansiLine);
    if (m && m.index === i) {
      out += m[0];
      i = SGR.lastIndex;
      continue;
    }
    const cp = ansiLine.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = isWide(cp) ? 2 : 1;
    const inRange = col + w > colStart && col < colEnd;
    if (inRange && !on) {
      out += "\x1b[7m";
      on = true;
    } else if (!inRange && on) {
      out += "\x1b[27m";
      on = false;
    }
    out += ch;
    col += w;
    i += ch.length;
  }
  if (on) out += "\x1b[27m";
  return out;
}

// ── 双击选词（iTerm2 词边界）────────────────────────────────────────────────

type CharClass = "word" | "cjk" | "punct" | "space";

/** 词字符连成一段（含路径分隔/点/横线 → **路径整选**）；CJK 逐字一段；标点一段；空白分隔。 */
function charClass(ch: string): CharClass {
  if (/\s/.test(ch)) return "space";
  const cp = ch.codePointAt(0) ?? 0;
  if (isWide(cp)) return "cjk";
  if (/[\w./~@+\-]/.test(ch)) return "word";
  return "punct";
}

/**
 * 双击选词：从可见列 col 出发向两侧扩展到同类字符边界（iTerm2 行为）。
 * 输入应为纯文本行（列坐标与 ANSI 行一致）；返回 [startCol, endCol)。
 * punct 与 word 不互粘（`foo(bar)` 三段）；CJK 相邻汉字互不粘（逐字）——
 * 但 CJK 旁边的标点按 punct 段处理。
 */
export function expandWord(plainLine: string, col: number): [number, number] {
  // 找到 col 所在的字符与可见列起点（宽字符点在右半格时归到该字符）
  let idx = 0;
  let c = 0;
  let startCol = 0;
  let ch = "";
  while (idx < plainLine.length) {
    const cp = plainLine.codePointAt(idx) ?? 0;
    ch = String.fromCodePoint(cp);
    const w = isWide(cp) ? 2 : 1;
    if (col < c + w) {
      startCol = c;
      break;
    }
    c += w;
    idx += ch.length;
  }
  if (idx >= plainLine.length) return [col, Math.max(col + 1, visibleEnd(plainLine))]; // 越界：空区间兜底
  const cls = charClass(ch);
  // CJK：逐字（只选该字符）
  if (cls === "cjk") return [startCol, startCol + (isWide(ch.codePointAt(0) ?? 0) ? 2 : 1)];
  // word/punct：同类向两侧扩展
  let lo = idx;
  let hi = idx + ch.length;
  while (lo > 0) {
    const prev = String.fromCodePoint(plainLine.codePointAt(lo - 1) ?? 0);
    if (charClass(prev) !== cls) break;
    lo -= prev.length;
  }
  while (hi < plainLine.length) {
    const next = String.fromCodePoint(plainLine.codePointAt(hi) ?? 0);
    if (charClass(next) !== cls) break;
    hi += next.length;
  }
  const colOf = (i: number) => {
    let w = 0;
    for (let k = 0; k < i; ) {
      const cp = plainLine.codePointAt(k) ?? 0;
      w += isWide(cp) ? 2 : 1;
      k += String.fromCodePoint(cp).length;
    }
    return w;
  };
  return [colOf(lo), colOf(hi)];
}

function visibleEnd(s: string): number {
  let w = 0;
  for (let k = 0; k < s.length; ) {
    const cp = s.codePointAt(k) ?? 0;
    w += isWide(cp) ? 2 : 1;
    k += String.fromCodePoint(cp).length;
  }
  return w;
}

/** 三击选行：整行的可见列区间。 */
export function wholeLine(plainLine: string): [number, number] {
  return [0, visibleEnd(plainLine)];
}

/** 从选区提取全部纯文本（跨行 \n 连接；输入为视口行数组）。 */
export function selectedText(lines: string[], r: SelRange): string {
  const out: string[] = [];
  for (let l = r.startLine; l <= r.endLine && l < lines.length; l++) {
    const rng = lineRangeInSel(r, l);
    if (rng) out.push(plainSlice(lines[l]!, rng[0], rng[1] === Number.POSITIVE_INFINITY ? Number.MAX_SAFE_INTEGER : rng[1]));
  }
  return out.join("\n");
}
