/**
 * 行级 diff（LCS）+ Claude-Code 风格渲染。供工具产出结构化 diff、TUI 与一次性渲染器共用。
 * 渲染：新增行铺深绿底、删除行铺深红底（整行色带，与 Claude Code 一致），代码做语法高亮，
 * `+`/`-` 标记用亮绿/亮红，行号/上下文走浅灰。
 */
import { ansi } from "./theme.js";
import { highlightCode, langForPath } from "./highlight.js";
import { contentWidth, visibleWidth } from "./markdown.js";

const RESET = "\x1b[0m";
const BG_ADD = "\x1b[48;2;19;42;26m"; // 深绿底（新增）
const BG_DEL = "\x1b[48;2;55;25;27m"; // 深红底（删除）
const SIGN_ADD = "\x1b[38;5;78m"; // 亮绿 +
const SIGN_DEL = "\x1b[38;5;203m"; // 亮红 -
const NO = "\x1b[38;5;245m"; // 行号（色带内不能用含 \x1b[0m 的 ansi.dim，会抹掉背景）

export interface DiffLine {
  tag: " " | "-" | "+"; // 上下文 / 删除 / 新增
  oldNo?: number; // 旧文件行号（上下文、删除有）
  newNo?: number; // 新文件行号（上下文、新增有）
  text: string;
}

export interface FileDiff {
  verb: string; // Update / Create / Write / Delete
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[]; // 已裁成 hunk（含上下文），跨 hunk 处用 newNo 不连续表示
}

const MAX_LINES = 4000; // 超大文件不做 O(n·m) LCS，只给计数

/** 经典 LCS 行差分，产出完整的 上下文/增/删 序列。 */
function lcs(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tag: " ", oldNo: oldNo++, newNo: newNo++, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ tag: "-", oldNo: oldNo++, text: a[i++] });
    } else {
      out.push({ tag: "+", newNo: newNo++, text: b[j++] });
    }
  }
  while (i < n) out.push({ tag: "-", oldNo: oldNo++, text: a[i++] });
  while (j < m) out.push({ tag: "+", newNo: newNo++, text: b[j++] });
  return out;
}

/** 只保留改动行 ± context 行上下文，丢弃远处未改动的大段。 */
function toHunks(all: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(all.length).fill(false);
  for (let k = 0; k < all.length; k++) {
    if (all[k].tag !== " ") {
      for (let d = Math.max(0, k - context); d <= Math.min(all.length - 1, k + context); d++) keep[d] = true;
    }
  }
  return all.filter((_, k) => keep[k]);
}

/** 计算单文件 diff（已裁成 hunk）。before/after 为整文件文本。 */
export function computeFileDiff(before: string, after: string, verb: string, path: string): FileDiff {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    // 太大：不逐行 diff，给近似计数
    const added = Math.max(0, b.length - a.length);
    const removed = Math.max(0, a.length - b.length);
    return { verb, path, added, removed, lines: [] };
  }
  const all = lcs(a, b);
  const added = all.filter((l) => l.tag === "+").length;
  const removed = all.filter((l) => l.tag === "-").length;
  return { verb, path, added, removed, lines: toHunks(all) };
}

/** 把 FileDiff 渲染成多行字符串（供 push 到输出流）。indent 为整体缩进（2 列槽位，与 ● / ⎿ 对齐）。 */
export function renderFileDiff(d: FileDiff, indent = "  "): string {
  const head = `${indent}${ansi.dim("⎿")}  ${ansi.dim(`Added ${d.added} lines, removed ${d.removed} lines`)}`;
  if (d.lines.length === 0) return head;

  const gw = Math.max(
    ...d.lines.map((l) => String(l.tag === "+" ? l.newNo : l.oldNo).length),
    3,
  );
  const lang = langForPath(d.path);
  const band = Math.max(20, contentWidth()); // 色带可见宽度（终端宽 - 悬挂缩进）
  const body: string[] = [];
  let prevNew = -1;
  for (const l of d.lines) {
    const ref = l.tag === "+" ? l.newNo : l.oldNo; // 删除/上下文用旧号，新增用新号
    // 跨 hunk 断点：行号跳跃时插一条省略提示
    if (prevNew >= 0 && l.newNo !== undefined && l.newNo > prevNew + 1) body.push(`${indent}   ${ansi.dim("⋮")}`);
    if (l.newNo !== undefined) prevNew = l.newNo;
    const no = String(ref ?? "").padStart(gw);
    const hl = highlightCode(l.text, lang);
    if (l.tag === " ") {
      // 上下文行：无色带，浅灰行号 + 高亮代码
      body.push(`${indent}   ${ansi.dim(no)}  ${hl}`);
      continue;
    }
    // 增/删行：整行铺背景色带。色带内只用 39m 重置前景（不用 0m），末尾统一 RESET 收尾背景。
    const bg = l.tag === "+" ? BG_ADD : BG_DEL;
    const sign = l.tag === "+" ? `${SIGN_ADD}+\x1b[39m` : `${SIGN_DEL}-\x1b[39m`;
    const pad = Math.max(0, band - visibleWidth(` ${no} ${l.tag} ${l.text}`));
    const inner = ` ${NO}${no}\x1b[39m ${sign} ${hl}${" ".repeat(pad)}`;
    body.push(`${indent}${bg}${inner}${RESET}`);
  }
  return `${head}\n${body.join("\n")}`;
}
