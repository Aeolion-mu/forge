import { renderMarkdown, wrapVisible } from "./markdown.js";
import { renderFileDiff, type FileDiff } from "./diff.js";
import { ansi, SPARK_REST } from "./theme.js";

/**
 * Block 模型 —— 全屏虚拟视口的内容单元。
 *
 * 关键设计：block **只存原始数据**（markdown 源 / FileDiff / 文本），渲染成行时
 * （renderBlock）按「当时」的终端宽度现算并按 (id, width) 记忆化。旧 TUI 把渲染
 * 结果在 push 时按当刻宽度冻成 ANSI 串，resize 后全部错位（横线/表格/diff 色带）。
 *
 * 折叠：tool 结果带 full/diffs 时可折叠（默认折叠只留预览行），点击头部行切换 —— 鼠标
 * 点击折叠的工具结果是 Claude Code 全屏的核心交互之一。
 */

export interface ToolBody {
  /** 工具结果正文形态。 */
  kind: "diff" | "text";
  /** diff 形态：单/多文件 diff（collapsed 时仍展示 —— 改动本身要看）。 */
  diffs?: FileDiff[];
  /** text 形态：折叠时显示的预览（首行/摘要行）。 */
  preview?: string;
  /** text 形态：完整输出（有则可折叠）。 */
  full?: string;
  isError?: boolean;
}

export type Block =
  | { id: number; kind: "banner"; lines: string[] }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "markdown"; source: string; prefix?: string }
  | { id: number; kind: "thinking"; tokens: number }
  | { id: number; kind: "turn"; secs: string; out: number }
  | {
      id: number;
      kind: "tool";
      toolCallId: string;
      /** 头部行（`● Update(path)` / `● bash(cmd)` 等，含 ANSI）。 */
      header: string;
      body?: ToolBody;
      collapsed?: boolean;
    }
  | { id: number; kind: "plain"; text: string }
  | { id: number; kind: "error"; text: string; hint?: string };

/** pushBlock 的入参类型：Block 去掉 id（分布式 Omit——直接 Omit 联合会塌成公共键）。 */
export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type NewBlock = DistributiveOmit<Block, "id">;

/** 折叠规则：有完整文本的工具结果默认折叠（diff 除外——改动本身要可见）。 */
export function defaultCollapsed(body: ToolBody): boolean {
  return body.kind === "text" && Boolean(body.full) && body.full !== body.preview;
}

/**
 * block → 渲染行（ANSI 字符串数组）。纯函数；按 (id,width) 记忆化见 renderLines。
 * width = 终端列数（渲染期值）。
 */
export function renderBlockLines(b: Block, width: number): string[] {
  const content = Math.max(10, width - 3); // 与旧 GUTTER=3 对齐：2 悬挂缩进 + 1 安全列
  switch (b.kind) {
    case "banner":
      return b.lines;
    case "user":
      // `› ` 槽位 + 2 空格悬挂缩进
      return wrapVisible(b.text, content - 2).split("\n").map((l, i) => (i === 0 ? `\x1b[97m›\x1b[0m ${l}` : `  ${l}`));
    case "markdown": {
      const prefix = b.prefix ?? ansi.assistant("●");
      const md = renderMarkdown(b.source, width).split("\n").map((l, i) => (i === 0 ? `${prefix} ${l}` : `  ${l}`));
      return md;
    }
    case "thinking":
      return [ansi.dim(`${SPARK_REST} Thinking · ~${b.tokens} tokens (collapsed)`)];
    case "turn":
      return [ansi.dim(`  ${b.secs}s · ${b.out} tokens`)];
    case "tool": {
      const head = [b.header];
      if (!b.body) return head;
      const { kind, diffs, preview, full, isError } = b.body;
      if (kind === "diff" && diffs?.length) {
        const rendered = diffs.map((d) => `  \x1b[1m${d.verb}(${d.path})\x1b[0m\n${renderFileDiff(d, "  ", content)}`);
        return [...head, ...rendered];
      }
      if (b.collapsed) {
        const mark = isError ? ansi.error("✗") : ansi.dim("⎿");
        return [...head, ...(preview ? [`${mark} ${ansi.dim(preview.slice(0, Math.max(20, content - 4)))}`] : [])];
      }
      // 展开的完整文本
      const mark = isError ? ansi.error("✗") : ansi.dim("⎿");
      const text = (full ?? preview ?? "").trim() || "(无输出)";
      return [...head, ...wrapVisible(text, content - 2).split("\n").map((l) => `  ${mark} ${ansi.dim(l)}`)];
    }
    case "plain":
      return wrapVisible(b.text, content).split("\n");
    case "error":
      return [
        ansi.error(`Error: ${b.text}`) + (b.hint ? ansi.dim(`  ${b.hint}`) : ""),
      ];
  }
}

/** (id, width) → 行 的记忆化缓存：resize 只重算一次，滚动/重绘零成本。block 列表只增不删，缓存随之增长（行字符串，可接受）。 */
const cache = new Map<string, string[]>();
/** 缓存代数：/rewind 重建 transcript 时 block id 从头重计，会与旧 block 撞 key 拿到
 *  渲染错内容的旧行（实测"复述上一轮回复"的根因）。重建前 bump 代数使旧缓存全部失效。 */
let generation = 0;

/** 丢弃全部缓存行（block 列表整体重建时调用——目前仅 /rewind）。 */
export function resetBlockCache(): void {
  generation += 1;
  cache.clear();
}

export function renderLines(b: Block, width: number, ns = "main"): string[] {
  const key = `${generation}:${ns}:${b.id}:${width}:${b.kind === "tool" ? (b.collapsed ? "c" : "e") : ""}`;
  let lines = cache.get(key);
  if (!lines) {
    lines = renderBlockLines(b, width);
    cache.set(key, lines);
  }
  return lines;
}

/** 展开全部 block → 行数组 + 每行的 blockId 映射（鼠标命中测试用）。
 *  ns = 命名空间（主转录 "main" / 各子 agent "sub:<id>"）：各上下文 block id 独立计数，靠 ns 隔离缓存键。 */
export function flattenBlocks(blocks: Block[], width: number, ns = "main"): { lines: string[]; owner: number[] } {
  const lines: string[] = [];
  const owner: number[] = [];
  for (const b of blocks) {
    for (const l of renderLines(b, width, ns)) {
      lines.push(l);
      owner.push(b.id);
    }
    // block 间距（旧 TUI 每个 block marginBottom=1）
    lines.push("");
    owner.push(b.id);
  }
  return { lines, owner };
}

/** 工具函数：app.tsx 组装 tool block 头部用（与旧渲染保持一致的动词表）。 */
export function toolHeader(toolName: string, argsSummary: string): string {
  return `${ansi.tool("●")} \x1b[1m${toolName}\x1b[0m${ansi.dim(`(${argsSummary})`)}`;
}
