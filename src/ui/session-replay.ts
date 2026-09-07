import type { Entry } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { defaultCollapsed, type NewBlock } from "./blocks.js";
import { ansi } from "./theme.js";

/**
 * 会话条目 → Block[] 逐字重放 —— /resume 恢复与 /rewind 重建共用的渲染器。
 *
 * 「逐字节一致」的数据面保证：user/assistant 文本**原样**入 block（不截不译不重排）；
 * 会话树本体不动（同一 JSONL 继续追加）。宽度层面的折行由 blocks.ts 渲染期现算，
 * 跟随当前终端宽度（这是显示，不是数据）。
 *
 * 已知近似（诚实边界）：session 里没有 UI 的 FileDiff details，diff 类工具结果按
 * 纯文本回放（toolResult.content 全文在，折叠展开可用）；turn 页脚（N 秒 · N token）
 * 属瞬态数据不重放。
 */

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
};

const previewOf = (s: string, n = 80): string => s.split("\n")[0]?.slice(0, n) ?? "";

/** 条目 → Block[]。id 由调用方（pushBlock）分配；这里返回不带 id 的净荷。 */
export function replayBlocks(entries: Entry[]): NewBlock[] {
  const out: NewBlock[] = [];
  /** 等待结果回填的 tool block 下标（toolCallId → out 下标）。 */
  const pending = new Map<string, number>();

  for (const e of entries) {
    if (e.type === "compaction") {
      out.push({ kind: "plain", text: ansi.dim(`↻ 已压缩会话前段（保留摘要 ${e.summary.length} 字）`) });
      pending.clear(); // 压缩前的 tool 配对已无意义
      continue;
    }
    if (e.type !== "message") continue; // branch_summary/custom 不重放
    const msg = e.message as Message;

    if (msg.role === "user") {
      out.push({ kind: "user", text: textOfContent(msg.content) });
      continue;
    }
    if (msg.role === "toolResult") {
      const idx = pending.get(msg.toolCallId);
      const text = textOfContent(msg.content);
      if (idx !== undefined) {
        const b = out[idx]!;
        if (b.kind === "tool") {
          const body = text ? { kind: "text" as const, preview: previewOf(text), full: text, isError: msg.isError } : undefined;
          out[idx] = { ...b, body, collapsed: body ? defaultCollapsed(body) : false };
        }
        pending.delete(msg.toolCallId);
      } else {
        // 孤儿结果（理论上不出现）：单独落一条，不丢数据
        out.push({ kind: "plain", text: `  ${msg.isError ? ansi.error("✗") : ansi.dim("⎿")} ${ansi.dim(previewOf(text))}` });
      }
      continue;
    }
    if (msg.role === "assistant") {
      for (const c of msg.content) {
        const x = c as { type: string; text?: string; thinking?: string; name?: string; id?: string; arguments?: unknown };
        if (x.type === "thinking" && x.thinking) {
          out.push({ kind: "thinking", tokens: Math.round(x.thinking.length / 4) });
        } else if (x.type === "text" && x.text) {
          out.push({ kind: "markdown", source: x.text });
        } else if (x.type === "toolCall" && x.name) {
          const argsSummary = summarizeArgs(x.name, x.arguments);
          out.push({
            kind: "tool",
            toolCallId: x.id ?? "",
            header: `${ansi.tool("●")} \x1b[1m${x.name}\x1b[0m${ansi.dim(`(${argsSummary})`)}`,
          });
          if (x.id) pending.set(x.id, out.length - 1);
        }
      }
    }
  }
  return out;
}

/** 与 render.ts 的 summarizeToolArgs 同源的极简参数摘要（不 import 以免拖入 agent 依赖）。 */
function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  const pick = a.cmd ?? a.path ?? a.pattern ?? a.query ?? a.name ?? a.command ?? a.task ?? a.goal;
  if (typeof pick === "string") return pick.length > 60 ? `${pick.slice(0, 60)}…` : pick;
  try {
    return JSON.stringify(args).slice(0, 60);
  } catch {
    return "";
  }
}

/** 读会话 JSONL 取首条用户消息做 /resume 列表预览；空串 = 无用户消息（空壳会话，调用方过滤）。 */
export function firstUserPreviewSync(path: string): string {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        // v4 存储行：header 对象 / commit 数组 [{entry}, {value-op}, …]——消息在数组元素里
        const candidates: unknown[] = Array.isArray(j) ? j : [j];
        for (const el of candidates) {
          const msg = (el as { kind?: string; message?: { role?: string; content?: unknown } }).message;
          if (msg?.role === "user") {
            const c = msg.content;
            const t = typeof c === "string"
              ? c
              : Array.isArray(c)
                ? (c as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("")
                : "";
            const clean = t.replace(/\s+/g, " ").trim();
            if (clean) return clean.slice(0, 50);
          }
        }
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 读不了就算了 */
  }
  return "";
}

/** async 包装（保持既有签名）。 */
export async function firstUserPreview(path: string): Promise<string> {
  return firstUserPreviewSync(path);
}
