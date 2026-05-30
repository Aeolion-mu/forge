/**
 * 极简 Markdown → 终端 ANSI 渲染器（无第三方依赖）。
 * 覆盖 LLM 输出常见元素：标题 / 粗体 / 行内代码 / 列表 / 引用 / 分隔线 / 代码块 / **表格**。
 * 表格按 CJK 双宽字符对齐，并按终端宽度收缩列宽 + 长单元格折行成多行。
 */

import { convertInlineMath, texToUnicode } from "./math.js";
import { highlightCode, normalizeLang } from "./highlight.js";

const E = "\x1b[";
// 暖色设计语言（白·黄·橙·橙红）：标题用金，列表标记用琥珀；不再用蓝/青。
const gold = (s: string) => `${E}38;5;220m${s}${E}39m`;
const amber = (s: string) => `${E}38;5;214m${s}${E}39m`;
// 次要文本：用浅灰色号(250)而非 ANSI dim 属性——dim 在多数终端被压得过暗、糊成一团。
const dim = (s: string) => `${E}38;5;250m${s}${E}39m`;
const bold = (s: string) => `${E}1m${s}${E}22m`;

/** 终端列宽（用满整宽，不再设 100 上限）。 */
function termCols(): number {
  return process.stdout.columns ?? 80;
}

/** 东亚宽字符 / emoji → 宽度 2，其余 1。 */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** 可见宽度（剔除 ANSI 转义后，按字符宽度求和）。 */
function vwidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let w = 0;
  for (const ch of plain) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return w;
}

/** 可见宽度（公开版，供 diff 色带对齐复用；CJK / emoji = 2，剔除 ANSI）。 */
export function visibleWidth(s: string): number {
  return vwidth(s);
}

/** 右侧补空格到指定可见宽度。 */
function padEnd(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - vwidth(s)));
}

/** 按可见宽度折行（纯文本，CJK=2；超宽即断，latin 也可能断词）。 */
function wrapByWidth(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  let w = 0;
  for (const ch of text) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > width && line !== "") {
      out.push(line);
      line = "";
      w = 0;
    }
    line += ch;
    w += cw;
  }
  if (line !== "") out.push(line);
  return out.length ? out : [""];
}

// ── ANSI 感知折行 ─────────────────────────────────────────────────────────
// 渲染层给每条消息加 2 空格悬挂缩进（`● ` 槽位 = 符号 + 1 空格）。正文折到 termCols-GUTTER：
// GUTTER = 2(缩进) + 1(右侧安全余量，防 Ink 因宽度测量误差把整宽行回折到第 0 列)。
// 折出的续行会被 .replace(/\n/g, "\n  ") 一并缩进，从而对齐到内容列、不顶到第 0 列。
const GUTTER = 3;
const RESET = "\x1b[0m";

interface Sgr {
  bold: boolean;
  dim: boolean;
  ul: boolean;
  fg: string | null; // 前景色参数，如 "38;5;220" / "97"
}

/** 把一段 SGR 序列（如 `\x1b[38;5;220m`）应用到样式状态。 */
function applySgr(st: Sgr, code: string): void {
  const body = code.slice(2, -1); // 去掉 ESC[ 与结尾 m
  const parts = body === "" ? ["0"] : body.split(";");
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p === "0" || p === "") { st.bold = false; st.dim = false; st.ul = false; st.fg = null; }
    else if (p === "1") st.bold = true;
    else if (p === "2") st.dim = true;
    else if (p === "4") st.ul = true;
    else if (p === "22") { st.bold = false; st.dim = false; }
    else if (p === "24") st.ul = false;
    else if (p === "39") st.fg = null;
    else if (p === "38") {
      if (parts[k + 1] === "5") { st.fg = `38;5;${parts[k + 2]}`; k += 2; }
      else if (parts[k + 1] === "2") { st.fg = `38;2;${parts[k + 2]};${parts[k + 3]};${parts[k + 4]}`; k += 4; }
    } else if (/^(3[0-7]|9[0-7])$/.test(p)) st.fg = p;
  }
}

/** 当前样式状态 → 续行开头需重开的 SGR 前缀。 */
function sgrPrefix(st: Sgr): string {
  let s = "";
  if (st.bold) s += "\x1b[1m";
  if (st.dim) s += "\x1b[2m";
  if (st.ul) s += "\x1b[4m";
  if (st.fg) s += `\x1b[${st.fg}m`;
  return s;
}

/** 单行折行（ANSI 感知）：保留并跨行续接颜色，优先在最后一个空格断词，CJK / 超长词硬断。 */
function wrapLine(line: string, width: number): string {
  const out: string[] = [];
  const st: Sgr = { bold: false, dim: false, ul: false, fg: null };
  const re = /\x1b\[[0-9;]*m/y;
  let cur = ""; // 当前续行内容（含 ANSI）
  let w = 0; // cur 的可见宽度
  let spaceAt = -1; // cur 中最后一个空格的下标（可断点）
  let i = 0;
  while (i < line.length) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m && m.index === i) {
      cur += m[0];
      applySgr(st, m[0]);
      i = re.lastIndex;
      continue;
    }
    const cp = line.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const cw = isWide(cp) ? 2 : 1;
    if (w + cw > width && w > 0) {
      const styled = st.bold || st.dim || st.ul || st.fg !== null;
      // 仅当溢出字符是窄字符（拉丁词内）且行内有空格时，才回退到空格断词避免拆词；
      // 宽字符（CJK）逐字皆可断，直接在边界硬断 —— 否则会把整段无空格的 CJK 推到下一行、
      // 把行首标记（如 `• `）孤立成一行。
      if (cw === 1 && spaceAt >= 0) {
        const head = cur.slice(0, spaceAt);
        const rest = cur.slice(spaceAt + 1); // 丢掉断点处的空格
        out.push(styled ? head + RESET : head);
        cur = sgrPrefix(st) + rest;
        w = vwidth(rest);
      } else {
        out.push(styled ? cur + RESET : cur);
        cur = sgrPrefix(st);
        w = 0;
      }
      spaceAt = -1;
    }
    cur += ch;
    w += cw;
    if (ch === " ") spaceAt = cur.length - 1;
    i += ch.length;
  }
  out.push(cur);
  return out.join("\n");
}

/** 按可见宽度折行整段渲染结果（逐行处理，保留已有换行与 ANSI 颜色）。width<8 时不折行。 */
export function wrapVisible(text: string, width: number): string {
  if (width < 8) return text;
  return text.split("\n").map((ln) => wrapLine(ln, width)).join("\n");
}

/** 正文可用宽度：终端列宽（上限 100）扣除渲染层 3 空格悬挂缩进。供 UI 折行复用。 */
export function contentWidth(): number {
  return termCols() - GUTTER;
}

/** 行内样式：粗体 / 行内代码 / 链接。用 null 字节占位保护代码段，避免误匹配数字。 */
function inline(text: string): string {
  const codes: string[] = [];
  let t = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\x00${codes.length - 1}\x00`;
  });
  t = convertInlineMath(t); // 行内公式 \(...\) $...$ 等 → Unicode（代码段已被占位保护）
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, b: string) => `${E}1m${b}${E}22m`);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string) => `${E}4m${label}${E}24m`);
  t = t.replace(/\x00(\d+)\x00/g, (_m, i: string) => `${E}33m${codes[Number(i)]}${E}39m`);
  return t;
}

function isTableSep(line: string | undefined): boolean {
  return Boolean(line && /\|/.test(line) && /^[\s|:-]+$/.test(line) && /-/.test(line));
}

/** 解析表格行 → 原始单元格文本（不预先上色，留到折行后逐行 inline）。 */
function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function renderTable(rows: string[][]): string {
  const ncol = Math.max(...rows.map((r) => r.length));
  const nat: number[] = [];
  for (let j = 0; j < ncol; j++) nat[j] = Math.max(1, ...rows.map((r) => vwidth(r[j] ?? "")));

  // 按终端宽度收缩列宽：water-filling 找一个上限 cap，使总内容宽 ≤ 预算。
  const budget = Math.max(20, termCols() - 5); // 留出渲染层 3 空格缩进 + 余量
  const availContent = budget - (3 * ncol + 1); // 扣掉边框与 padding
  const w = nat.slice();
  if (availContent >= ncol && nat.reduce((a, b) => a + b, 0) > availContent) {
    let lo = 1;
    let hi = Math.max(...nat);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const sum = nat.reduce((a, x) => a + Math.min(x, mid), 0);
      if (sum <= availContent) lo = mid;
      else hi = mid - 1;
    }
    for (let j = 0; j < ncol; j++) w[j] = Math.min(nat[j], lo);
  }

  const bar = (l: string, m: string, r: string) => dim(l + w.map((x) => "─".repeat(x + 2)).join(m) + r);
  const renderRow = (cells: string[]) => {
    const wrapped = w.map((width, j) => wrapByWidth(cells[j] ?? "", width));
    const h = Math.max(1, ...wrapped.map((c) => c.length));
    const lines: string[] = [];
    for (let k = 0; k < h; k++) {
      lines.push(dim("│") + w.map((width, j) => ` ${padEnd(inline(wrapped[j][k] ?? ""), width)} `).join(dim("│")) + dim("│"));
    }
    return lines.join("\n");
  };

  return [bar("┌", "┬", "┐"), renderRow(rows[0]), bar("├", "┼", "┤"), ...rows.slice(1).map(renderRow), bar("└", "┴", "┘")].join("\n");
}

export function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码块：左侧竖条 + 语法高亮（无语言标注 → text，原样亮色，不再整块压暗）
    if (/^\s*```/.test(line)) {
      const lang = normalizeLang(/^\s*```\s*([\w+#.-]*)/.exec(line)?.[1] ?? "");
      i += 1;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i += 1;
      const bar = `${E}38;5;240m│${E}39m`;
      out.push(code.map((cl) => `  ${bar} ${highlightCode(cl, lang)}`).join("\n"));
      continue;
    }

    // 块级公式：整行 \[ … \] / $$ … $$（单行），或定界符独占整行后跨多行
    const oneLine = /^\s*\\\[(.+?)\\\]\s*$/.exec(line) ?? /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
    if (oneLine) {
      out.push(`  ${bold(texToUnicode(oneLine[1]))}`);
      i += 1;
      continue;
    }
    if (/^\s*(\\\[|\$\$)\s*$/.test(line)) {
      const closer = line.includes("$$") ? "$$" : "\\]";
      i += 1;
      const buf: string[] = [];
      while (i < lines.length && !lines[i].includes(closer)) buf.push(lines[i++]);
      i += 1; // 跳过闭合行
      out.push(`  ${bold(texToUnicode(buf.join(" ")))}`);
      continue;
    }

    // 表格
    if (/\|/.test(line) && isTableSep(lines[i + 1])) {
      const rows: string[][] = [parseRow(line)];
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") rows.push(parseRow(lines[i++]));
      out.push(renderTable(rows));
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push(dim("─".repeat(Math.min(termCols() - GUTTER, 60))));
      i += 1;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const text = inline(h[2]);
      out.push(h[1].length <= 2 ? `${E}1m${gold(text)}${E}22m` : `${E}1m${text}${E}22m`);
      i += 1;
      continue;
    }

    // 无序列表
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      out.push(`${ul[1]}${amber("•")} ${inline(ul[2])}`);
      i += 1;
      continue;
    }

    // 有序列表
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      out.push(`${ol[1]}${amber(`${ol[2]}.`)} ${inline(ol[3])}`);
      i += 1;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      out.push(`${dim("│")} ${inline(line.replace(/^\s*>\s?/, ""))}`);
      i += 1;
      continue;
    }

    // 普通段落
    out.push(inline(line));
    i += 1;
  }
  // 折到 termCols-GUTTER：渲染层的 2 空格悬挂缩进会把折出的续行一并推到内容列，
  // 长行不再顶到终端第 0 列、与 `● / › / ✦` 状态符撞列（GUTTER 含 1 列右侧安全余量）。
  return wrapVisible(out.join("\n"), termCols() - GUTTER);
}
