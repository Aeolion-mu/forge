import type { AgentHarnessEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { renderMarkdown } from "./markdown.js";
import { renderFileDiff, type FileDiff } from "./diff.js";
import { SPARK_FRAMES } from "./theme.js";

// 写类工具在 tool_execution_start 显示的动词表头（diff 详情在 end 补上）。
const WRITE_VERB: Record<string, string> = { edit_file: "Update", write_file: "Write" };

/**
 * 终端渲染 —— Claude-Code 风格：
 *   · 生成期间显示 spinner，标签带实时「秒数 · token 估算」
 *   · 助手文本先缓冲，message_end 时整体按 Markdown 渲染（表格才能算列宽对齐）
 *   · 工具调用 ● + 摘要参数；结果 ⎿ + 耗时
 *   · turn_end 打一行 dim footer（真实耗时 · 真实 tokens）
 */

const E = "\x1b[";
const K = `${E}K`;
// 暖色设计语言（白·黄·橙·橙红），与 ui/theme.ts 对齐。
const c = {
  dim: (s: string) => `${E}38;5;250m${s}${E}0m`, // 浅灰：比 ANSI dim 亮，黑底可读
  bold: (s: string) => `${E}1m${s}${E}0m`,
  spinner: (s: string) => `${E}38;5;214m${s}${E}0m`, // 琥珀
  assistant: (s: string) => `${E}38;5;220m${s}${E}0m`, // 金
  tool: (s: string) => `${E}38;5;208m${s}${E}0m`, // 橙
  error: (s: string) => `${E}38;5;202m${s}${E}0m`, // 橙红
};

function clip(s: string, n = 64): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/** 把工具参数压成一行人类可读摘要（也给确认提示复用）。 */
export function summarizeToolArgs(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "read_file": {
      // 显示「读了哪些部分」：有 offset/limit 时标出行范围，否则标全文。
      const p = String(a.path ?? "");
      const from = a.offset ? Number(a.offset) : 1;
      if (a.limit) return `${p} · L${from}–${from + Number(a.limit) - 1}`;
      if (a.offset) return `${p} · L${from}+`;
      return `${p} · full`;
    }
    case "list_dir":
    case "write_file":
    case "edit_file":
    case "outline":
      return String(a.path ?? "");
    case "repo_map":
      return String(a.path ?? ".");
    case "definition":
    case "references":
    case "hover":
      // 语义工具：显示「符号 in 文件」，比截断的 JSON 可读
      return a.path ? `${a.symbol ?? "?"} · ${a.path}` : String(a.symbol ?? "");
    case "rename":
      return `${a.symbol ?? "?"} → ${a.newName ?? "?"} · ${a.path ?? ""}`;
    case "diagnostics":
      return a.path ? String(a.path) : "(整项目 tsc)";
    case "bash":
      return clip(String(a.cmd ?? ""), 140); // 少截断：文件路径 + Get-Content/-Tail 范围要看得见
    case "spawn_subagent":
      return String(a.role ?? "");
    default:
      return clip(JSON.stringify(a));
  }
}

/** read_file 结果行：「读取 N 行 (L from–to)」+ 截断标记。无 details 时返回 null。 */
export function readFileResultLine(details: unknown): string | null {
  const d = details as { path?: string; lines?: number; from?: number; truncated?: boolean } | undefined;
  if (!d || typeof d.lines !== "number" || typeof d.from !== "number") return null;
  const to = d.from + d.lines - 1;
  // 注意：truncated 表示整体超 8KB 被砍成头+尾、**中段已省略**（不是行尾被剪），
  // 必须说清楚否则模型/用户误以为全看了。
  return `read ${d.lines} lines (L${d.from}–${to})${d.truncated ? " · ⚠ truncated: middle omitted, re-read with offset to see the rest" : ""}`;
}

function makeSpinner() {
  const tty = Boolean(process.stdout.isTTY);
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let labelFn: () => string = () => "";
  let active = false;
  const paint = () => {
    process.stdout.write(`\r${c.spinner(SPARK_FRAMES[frame % SPARK_FRAMES.length])} ${c.dim(labelFn())}${K}`);
    frame += 1;
  };
  return {
    start(fn: () => string) {
      labelFn = fn;
      if (!tty || active) return;
      active = true;
      frame = 0;
      paint();
      timer = setInterval(paint, 120);
    },
    stop() {
      if (!active) return;
      active = false;
      if (timer) clearInterval(timer);
      process.stdout.write(`\r${K}`);
    },
  };
}

export function makeRenderer(): (event: AgentHarnessEvent) => void {
  const spin = makeSpinner();
  let buffer = ""; // 助手文本缓冲，message_end 时整体渲染
  let turnStart = 0;
  const toolStart = new Map<string, number>();

  return (event: AgentHarnessEvent) => {
    switch (event.type) {
      case "message_start":
        if ((event.message as { role?: string }).role === "assistant") {
          buffer = "";
          turnStart = Date.now();
          process.stdout.write("\n"); // 思考中上方留白
          spin.start(() => {
            const secs = ((Date.now() - turnStart) / 1000).toFixed(0);
            const toks = Math.round(buffer.length / 4);
            return toks > 0 ? `Thinking (${secs}s · ~${toks} tokens)` : `Thinking (${secs}s)`;
          });
        }
        break;

      case "message_update": {
        const ev = event.assistantMessageEvent as { type: string; delta?: string };
        if (ev.type === "text_delta" && ev.delta) buffer += ev.delta; // 只缓冲，不直接打印
        break;
      }

      case "message_end":
        if ((event.message as { role?: string }).role === "assistant") {
          spin.stop();
          const text = buffer.trim();
          if (text) process.stdout.write(`\n${c.assistant("●")} ${renderMarkdown(text).replace(/\n/g, "\n  ")}\n`);
          buffer = "";
        }
        break;

      case "turn_end": {
        if (turnStart) {
          const secs = ((Date.now() - turnStart) / 1000).toFixed(1);
          const usage = (event.message as AssistantMessage | undefined)?.usage;
          const toks = usage?.output ?? 0;
          process.stdout.write(c.dim(`  ${secs}s · ${toks} tokens\n`));
          turnStart = 0;
        }
        break;
      }

      case "tool_execution_start": {
        // 不启动 spinner：tool_execution_start 在确认钩子(rl.question [y/N])之前发，
        // spinner 的 \r 重绘会把确认提示擦掉导致「假死」。
        spin.stop();
        toolStart.set(event.toolCallId, Date.now());
        const verb = WRITE_VERB[event.toolName];
        const path = (event.args as { path?: string } | undefined)?.path;
        if (verb && path) process.stdout.write(`\n${c.tool("●")} ${c.bold(`${verb}(${path})`)}\n`);
        else if (event.toolName === "apply_patch") process.stdout.write(`\n${c.tool("●")} ${c.bold("Patch")}\n`);
        else
          process.stdout.write(
            `\n${c.tool("●")} ${c.bold(event.toolName)}${c.dim(`(${summarizeToolArgs(event.toolName, event.args)})`)}\n`,
          );
        break;
      }

      case "tool_execution_end": {
        spin.stop();
        const t0 = toolStart.get(event.toolCallId);
        const ms = t0 ? Date.now() - t0 : undefined;
        toolStart.delete(event.toolCallId);
        const dur = ms !== undefined ? c.dim(` · ${ms}ms`) : "";
        const details = (event.result as { details?: { diff?: FileDiff; diffs?: FileDiff[] } } | undefined)?.details;
        if (!event.isError && details?.diff) {
          process.stdout.write(`${renderFileDiff(details.diff)}${dur}\n`);
          break;
        }
        if (!event.isError && Array.isArray(details?.diffs)) {
          for (const fd of details.diffs) process.stdout.write(`  ${c.bold(`${fd.verb}(${fd.path})`)}\n${renderFileDiff(fd)}\n`);
          break;
        }
        // read_file：显示读取的行范围，而非文件内容首行
        const readLine = !event.isError && event.toolName === "read_file" ? readFileResultLine(details) : null;
        const preview =
          readLine ??
          String((event.result?.content?.[0] as { text?: string } | undefined)?.text ?? "")
            .split("\n")[0]
            .slice(0, 80);
        const body = event.isError ? `${c.error("✗")} ${c.error(preview)}` : c.dim(preview);
        process.stdout.write(`  ${c.dim("⎿")} ${body}${dur}\n`);
        break;
      }

      case "agent_end":
        spin.stop();
        break;

      default:
        break;
    }
  };
}
