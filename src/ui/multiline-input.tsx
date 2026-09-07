import { useState, useEffect, useRef } from "react";
import { Text, useInput } from "ink";
import * as ed from "./text-editor.js";
import { visibleWidth } from "./markdown.js";

/**
 * 多行输入框 —— 取代单行的 ink-text-input（其多行渲染会糊、且 ↑/↓ 一律翻历史）。
 *
 * · 受控 value（父持有文本，供菜单匹配/占位/清空/历史召回）；cursor 内部维护。
 *   外部改 value（历史召回 / 清空 / Tab 补全）→ 光标自动移到末尾（替代旧的 inputKey 重挂）。
 * · ↑/↓：在多行内移动光标；仅当光标在首行按↑、尾行按↓时才翻命令历史（onHistoryPrev/Next）。
 * · 粘贴：ink 批量投递为一段含 \n 的 input，整段插入（不会逐行误触发提交）。
 * · 回车提交；Alt/Shift+回车插入换行（终端支持时）。菜单打开时把 ↑/↓/Tab 让给菜单（父另接）。
 */
export function MultilineInput({
  value,
  onChange,
  onSubmit,
  onHistoryPrev,
  onHistoryNext,
  menuOpen,
  isActive,
  cursorRequest,
  onCursorRequestHandled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHistoryPrev: () => void;
  onHistoryNext: () => void;
  menuOpen: boolean;
  isActive: boolean;
  /** 鼠标点击输入框的列号（1-based，相对 `› ` 前缀之后）→ 请求把光标移到该列。消费后调 onCursorRequestHandled 清空。 */
  cursorRequest?: number | null;
  onCursorRequestHandled?: () => void;
}) {
  const [cursor, setCursor] = useState(value.length);
  const emittedRef = useRef(value); // 最近一次「我们自己」改出去的 value
  // 键处理读同步镜像而非闭包 prop/state：同一 tick 内连续到达的键事件（代理把合并的
  // chunk 拆开后一次喂多个，或极端快速连打）会读到未提交的旧闭包——曾致 onSubmit("") 丢输入。
  const valueRef = useRef(value);
  const cursorRef = useRef(value.length);

  // 外部改 value（非本组件编辑）→ 光标移到末尾
  useEffect(() => {
    valueRef.current = value;
    if (value !== emittedRef.current) {
      emittedRef.current = value;
      moveCursor(value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 鼠标点击定位：列号 → 字符下标（按可见宽度折算，中文占 2 列）
  useEffect(() => {
    if (cursorRequest == null) return;
    let acc = 0;
    let idx = value.length;
    for (let i = 0; i < value.length; i++) {
      const w = visibleWidth(value[i]!);
      if (acc + Math.floor(w / 2) >= cursorRequest) {
        idx = i;
        break;
      }
      acc += w;
    }
    moveCursor(idx);
    onCursorRequestHandled?.();
  }, [cursorRequest, value, onCursorRequestHandled]);

  const apply = (s: ed.EditorState) => {
    emittedRef.current = s.text;
    valueRef.current = s.text;
    const c = ed.clampCursor(s.text, s.cursor);
    cursorRef.current = c;
    setCursor(c);
    onChange(s.text);
  };
  const moveCursor = (c: number) => {
    cursorRef.current = c;
    setCursor(c);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return; // 留给专用 Ctrl+C 处理
      if (key.tab) return; // Tab 不入框：菜单开时父处理，菜单关时忽略
      if (menuOpen && (key.upArrow || key.downArrow)) return; // ↑↓ 让给菜单

      const v = valueRef.current;
      const cur = cursorRef.current;
      if (key.return) {
        if (key.meta || key.shift) apply(ed.insert({ text: v, cursor: cur }, "\n"));
        else onSubmit(v);
        return;
      }
      if (key.upArrow) {
        const t = ed.moveUp(v, cur);
        if (t === null) onHistoryPrev();
        else moveCursor(t);
        return;
      }
      if (key.downArrow) {
        const t = ed.moveDown(v, cur);
        if (t === null) onHistoryNext();
        else moveCursor(t);
        return;
      }
      if (key.leftArrow) return moveCursor(ed.clampCursor(v, cur - 1));
      if (key.rightArrow) return moveCursor(ed.clampCursor(v, cur + 1));
      if (key.backspace || key.delete) return apply(ed.backspace({ text: v, cursor: cur }));
      if (key.ctrl && input === "a") return moveCursor(ed.lineHome(v, cur));
      if (key.ctrl && input === "e") return moveCursor(ed.lineEnd(v, cur));
      // 可打印（含批量粘贴，可能带换行）；排除控制/修饰组合
      if (input && !key.ctrl && !key.meta) apply(ed.insert({ text: v, cursor: cur }, ed.normalizeNewlines(input)));
    },
    { isActive },
  );

  // 渲染：before + 反显光标块 + after。光标处是换行/末尾时，用空格块代显示。
  const c = ed.clampCursor(value, cursor);
  const before = value.slice(0, c);
  const at = value.slice(c, c + 1);
  const atNewlineOrEnd = at === "" || at === "\n";
  const block = atNewlineOrEnd ? " " : at;
  const after = atNewlineOrEnd ? at + value.slice(c + 1) : value.slice(c + 1);
  return (
    <Text>
      {before}
      <Text inverse>{block}</Text>
      {after}
    </Text>
  );
}
