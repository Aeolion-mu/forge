/**
 * 多行输入编辑器纯核 —— 不依赖 ink/react，全部纯函数，可独立单测。
 *
 * 状态 = { text, cursor }，cursor 是字符偏移（0..text.length）。
 * 「行」指**逻辑行**（按 `\n` 切分），不含视觉折行——↑/↓ 的换行/翻历史判定按逻辑行，
 * 与用户「首行↑翻上条、尾行↓翻下条」的直觉一致。
 */

export interface EditorState {
  text: string;
  cursor: number;
}

/** 把 cursor 夹在 [0, text.length]。 */
export function clampCursor(text: string, cursor: number): number {
  return Math.max(0, Math.min(text.length, cursor));
}

/** CRLF / 裸 CR 归一成 LF（粘贴文本常带 \r\n）。 */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

/** 在光标处插入字符串，光标移到插入末尾。 */
export function insert(s: EditorState, str: string): EditorState {
  const cursor = clampCursor(s.text, s.cursor);
  return { text: s.text.slice(0, cursor) + str + s.text.slice(cursor), cursor: cursor + str.length };
}

/** 删除光标前一个字符（Backspace）。 */
export function backspace(s: EditorState): EditorState {
  const cursor = clampCursor(s.text, s.cursor);
  if (cursor === 0) return { text: s.text, cursor: 0 };
  return { text: s.text.slice(0, cursor - 1) + s.text.slice(cursor), cursor: cursor - 1 };
}

/** 光标处的行号 / 列号（按 `\n` 逻辑行，均从 0 起）。 */
export function cursorRowCol(text: string, cursor: number): { row: number; col: number } {
  const c = clampCursor(text, cursor);
  const before = text.slice(0, c);
  let row = 0;
  let lineStart = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === "\n") {
      row += 1;
      lineStart = i + 1;
    }
  }
  return { row, col: c - lineStart };
}

/** 每条逻辑行的起始偏移。 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * 上移一行（保持列、夹到目标行长）。已在首行 → 返回 null（调用方据此翻上一条历史）。
 */
export function moveUp(text: string, cursor: number): number | null {
  const { row, col } = cursorRowCol(text, cursor);
  if (row === 0) return null;
  const starts = lineStarts(text);
  const lens = text.split("\n").map((l) => l.length);
  const target = row - 1;
  return starts[target] + Math.min(col, lens[target]);
}

/**
 * 下移一行（保持列、夹到目标行长）。已在尾行 → 返回 null（调用方据此翻下一条历史）。
 */
export function moveDown(text: string, cursor: number): number | null {
  const { row, col } = cursorRowCol(text, cursor);
  const lens = text.split("\n").map((l) => l.length);
  if (row >= lens.length - 1) return null;
  const starts = lineStarts(text);
  const target = row + 1;
  return starts[target] + Math.min(col, lens[target]);
}

/** 当前逻辑行行首偏移（Ctrl+A）。 */
export function lineHome(text: string, cursor: number): number {
  const c = clampCursor(text, cursor);
  return text.slice(0, c).lastIndexOf("\n") + 1;
}

/** 当前逻辑行行尾偏移（Ctrl+E）。 */
export function lineEnd(text: string, cursor: number): number {
  const c = clampCursor(text, cursor);
  const nl = text.indexOf("\n", c);
  return nl === -1 ? text.length : nl;
}
