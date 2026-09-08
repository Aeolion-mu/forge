import { visibleWidth } from "./markdown.js";

/**
 * 输入框内鼠标定位/选区的纯坐标换算（屏幕行 × 可见列 ↔ value 字符下标）。
 *
 * 输入框渲染形态：首行 `› ` 前缀（占 2 可见列）+ 内容；多行输入的后续行从第 0 列起。
 * 中文等宽字符占 2 列——列→下标按「字符可见宽度累计 + 半宽命中」折算（与光标定位同一启发式）。
 * 注：超长行的终端折行不计（ink 自动折行），坐标按逻辑行近似——极端长行点击会有偏差。
 */

/** 输入框渲染行数（\n 分行；空值算 1 行）。 */
export function inputLineCount(value: string): number {
  return value.length === 0 ? 1 : value.split("\n").length;
}

/** 输入选区（value 的字符下标 anchor→active；渲染前归一化）。 */
export interface InputSelection {
  anchor: number;
  active: number;
}

/** 归一化选区为 [start, end)（start ≤ end）；退化（anchor==active）返回 null。 */
export function normalizeInputSelection(sel: InputSelection | null): { start: number; end: number } | null {
  if (!sel || sel.anchor === sel.active) return null;
  return { start: Math.min(sel.anchor, sel.active), end: Math.max(sel.anchor, sel.active) };
}

/**
 * （输入框内第 lineIdx 行，行内可见列 col）→ value 字符下标。
 * col 为 0-based、**已扣除**首行 `› ` 前缀（调用方换算）。越界行返回 null；
 * 列超出行尾 → 行尾（即换行符位置 / value 末尾），符合「拖到行尾选中到行末」直觉。
 */
export function inputCharAt(value: string, lineIdx: number, col: number): number | null {
  const lines = value.split("\n");
  if (lineIdx < 0 || lineIdx >= lines.length) return null;
  let start = 0;
  for (let i = 0; i < lineIdx; i++) start += lines[i]!.length + 1;
  const line = lines[lineIdx]!;
  let acc = 0;
  for (let i = 0; i < line.length; i++) {
    const w = visibleWidth(line[i]!);
    if (acc + Math.floor(w / 2) >= col) return start + i; // 命中字符 i（宽字符半宽即算点中）
    acc += w;
  }
  return start + line.length;
}

/**
 * 屏幕坐标（1-based 行列 + 输入框首行屏幕行号）→ value 字符下标。
 * 统一处理 `› ` 前缀扣减与越界钳制；行不在输入框内返回 null。
 */
export function inputCharAtScreen(value: string, inputRow: number, row: number, col: number): number | null {
  const lineIdx = row - inputRow;
  if (lineIdx < 0) return null;
  return inputCharAt(value, lineIdx, Math.max(0, col - 1 - (lineIdx === 0 ? 2 : 0)));
}
