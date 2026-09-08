import { useState, useEffect, useRef } from "react";
import { Text, useInput, usePaste } from "ink";
import * as ed from "./text-editor.js";
import { normalizeInputSelection, type InputSelection } from "./input-selection.js";
import { SEL_ON, SEL_OFF } from "./theme.js";

/**
 * 多行输入框 —— 取代单行的 ink-text-input（其多行渲染会糊、且 ↑/↓ 一律翻历史）。
 *
 * · 受控 value（父持有文本，供菜单匹配/占位/清空/历史召回）；cursor 内部维护。
 *   外部改 value（历史召回 / 清空 / Tab 补全）→ 光标自动移到末尾（替代旧的 inputKey 重挂）。
 * · ↑/↓：在多行内移动光标；仅当光标在首行按↑、尾行按↓时才翻命令历史（onHistoryPrev/Next）。
 * · 粘贴：ink 批量投递为一段含 \n 的 input，整段插入（不会逐行误触发提交）。
 * · 回车提交；Alt/Shift+回车插入换行（终端支持时）。菜单打开时把 ↑/↓/Tab 让给菜单（父另接）。
 * · 鼠标：点击定位光标（父换算好字符下标经 cursorRequest 传入）；拖选建立选区
 *   （selection 蓝底高亮，父持有状态——打字/删除即替换选中区间并清空）。
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
  selection,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onHistoryPrev: () => void;
  onHistoryNext: () => void;
  menuOpen: boolean;
  isActive: boolean;
  /** 鼠标点击输入框的目标字符下标（父已按 `› ` 前缀与宽度折算好）→ 请求把光标移到该处。消费后调 onCursorRequestHandled 清空。 */
  cursorRequest?: number | null;
  onCursorRequestHandled?: () => void;
  /** 输入选区（value 字符下标 anchor→active）；非退化时选中段套蓝底，光标块隐藏。 */
  selection?: InputSelection | null;
}) {
  const [cursor, setCursor] = useState(value.length);
  const emittedRef = useRef(value); // 最近一次「我们自己」改出去的 value
  // 键处理读同步镜像而非闭包 prop/state：同一 tick 内连续到达的键事件（代理把合并的
  // chunk 拆开后一次喂多个，或极端快速连打）会读到未提交的旧闭包——曾致 onSubmit("") 丢输入。
  const valueRef = useRef(value);
  const cursorRef = useRef(value.length);

  // 外部改 value（非本组件编辑）→ 光标移到末尾
  // render 期间同步镜像 valueRef（latest-ref 惯用法）。曾放 effect 里：提交路径
  // apply("X")→onChange("X")→同 tick Enter→onSubmit→setInput("")，React 19 批处理
  // 合并两次 setState 后 value prop 从未以 "X" 渲染，[value] dep 不触发、effect 不跑，
  // valueRef 滞留旧文本 → 下次输入拼接到已提交的消息后面。
  valueRef.current = value;
  useEffect(() => {
    if (value !== emittedRef.current) {
      emittedRef.current = value;
      moveCursor(value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // 鼠标点击定位：父已换算好字符下标，直接移动（消费后清空请求）。
  useEffect(() => {
    if (cursorRequest == null) return;
    moveCursor(ed.clampCursor(value, cursorRequest));
    onCursorRequestHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorRequest, onCursorRequestHandled]);

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

  // 括号粘贴（Ink 自动开 2004h）：整段插入为多行文本，绝不逐行触发提交——
  // 没这个钩子时终端走裸粘贴，多行里的 \r 会被当逐个回车、全部提交/steer。
  usePaste(
    (text) => {
      apply(ed.insert({ text: valueRef.current, cursor: cursorRef.current }, ed.normalizeNewlines(text)));
    },
    { isActive },
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") return; // 留给专用 Ctrl+C 处理
      if (key.tab) return; // Tab 不入框：菜单开时父处理，菜单关时忽略
      if (menuOpen && (key.upArrow || key.downArrow)) return; // ↑↓ 让给菜单

      const v = valueRef.current;
      const cur = cursorRef.current;
      // 选中区间（打字/删除先吃掉选中段——编辑器惯例）；有选区时替换后光标在 start。
      const sel = normalizeInputSelection(selection ?? null);
      const st: ed.EditorState = sel ? { text: v, cursor: sel.start } : { text: v, cursor: cur };
      if (key.return) {
        if (key.meta || key.shift) apply(ed.insert(sel ? ed.removeRange(st, sel.start, sel.end) : st, "\n"));
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
      if (key.backspace || key.delete) {
        // 有选区 → 删除选中段；无选区 → 删光标前一字符
        apply(sel ? ed.removeRange(st, sel.start, sel.end) : ed.backspace(st));
        return;
      }
      if (key.ctrl && input === "a") return moveCursor(ed.lineHome(v, cur));
      if (key.ctrl && input === "e") return moveCursor(ed.lineEnd(v, cur));
      // 可打印（含批量粘贴，可能带换行）；排除控制/修饰组合。有选区 → 替换选中段。
      if (input && !key.ctrl && !key.meta) {
        apply(ed.insert(sel ? ed.removeRange(st, sel.start, sel.end) : st, ed.normalizeNewlines(input)));
      }
    },
    { isActive },
  );

  // 渲染：有选区 → 选中段套蓝底（与视口选区同一对 SEL 常量；Ink 不转义字符串内的
  // ANSI 序列，直接拼接即可）；否则 before + 反显光标块 + after。
  const sel = normalizeInputSelection(selection ?? null);
  if (sel) {
    return (
      <Text>
        {value.slice(0, sel.start) + SEL_ON + value.slice(sel.start, sel.end) + SEL_OFF + value.slice(sel.end)}
      </Text>
    );
  }
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
