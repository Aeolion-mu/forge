import { createElement } from "react";
import { render } from "ink";
import { stdout } from "node:process";
import { loadConfig, type ForgeConfig } from "./config.js";
import { ForgeAgent } from "./kernel/forge-agent.js";
import { App, type AppBridge } from "./ui/app.js";
import { renderBanner, ansi } from "./ui/theme.js";
import { explainApiError } from "./kernel/errors.js";
import { getSandboxStatus } from "./sandbox/exec.js";
import { TerminalIo, createMouseStdin } from "./ui/terminal-io.js";
import type { JsonlSessionMetadata } from "@earendil-works/pi-agent-core";

/** Ctrl+C / EOF 触发的中断。 */
function isAbort(e: unknown): boolean {
  const x = e as { name?: string; code?: string } | null;
  return x?.name === "AbortError" || x?.code === "ABORT_ERR";
}

function banner(config: ForgeConfig, mode: string): void {
  // 二维火焰 banner（算法 D 火舌摇曳，暖色系），见 ui/theme.ts。
  const live = config.live ? "\x1b[32m● LIVE\x1b[0m" : "\x1b[31m● no key\x1b[0m";
  stdout.write(`\n${renderBanner()}\n\n`);
  stdout.write(` ${ansi.dim("Terminal Coding Agent ·")} ${config.modelRef} ${ansi.dim("·")} ${live}\n`);
  // 沙箱状态大声呈现（旧版静默降级的问题不再：没后端一眼可见）
  const sb = getSandboxStatus();
  if (sb.backend === "none" && sb.enabled) {
    stdout.write(` ${ansi.amber("⚠ sandbox: NO BACKEND")} ${ansi.dim(`— 命令未沙箱（仅环境白名单清洗）。${sb.reason}`)}\n`);
  } else if (sb.backend !== "none") {
    stdout.write(` ${ansi.dim("sandbox:")} ${sb.backend} ${ansi.dim(`(${sb.reason})`)}\n`);
  }
  if (config.allowReadOutsideWorkdir) stdout.write(` ${ansi.amber("⚠ read-outside-workdir ON")} ${ansi.dim("— read-only tools may read outside workdir (writes still locked)")}\n`);
  stdout.write(` ${ansi.dim(mode)}\n\n`);
}

function finish(agent: ForgeAgent, config: ForgeConfig): void {
  stdout.write("\n" + agent.telemetry.summary() + "\n");
  stdout.write(`${ansi.dim(`Audit log: ${config.auditPath}`)}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  // LIVE-only：目标 provider 无 key 直接报错（不再有 mock 兜底）
  if (!config.live) {
    stdout.write(
      `\x1b[31mNo API key for provider "${config.provider}" (model ${config.modelRef}).\x1b[0m\n` +
        `Set the corresponding key in .env or your environment (e.g. DEEPSEEK_API_KEY / ANTHROPIC_API_KEY) and retry.\n`,
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  // 默认跳过写/执行确认（/pass-permissions 常开）：灾难命令仍有 HARD_DENY 硬拦、
  // 写边界在沙箱内核层，确认弹窗只剩打断价值。--confirm 可回到逐次确认模式。
  const autoApprove = !args.includes("--confirm");
  // --resume <id> 的 id 值不进 prompt（否则会被当一次性任务文本）
  const resumeIdx = args.indexOf("--resume");
  const promptSkip = new Set(resumeIdx >= 0 && args[resumeIdx + 1] ? [args[resumeIdx + 1]!] : []);
  const prompt = args.filter((a, i) => !a.startsWith("-") && i !== resumeIdx + 1 && !promptSkip.has(a)).join(" ").trim();

  // 1) 一次性任务：forge "把 README 里的 TODO 列出来"（非 TUI，沿用流式渲染器）
  if (prompt) {
    banner(config, "One-shot task");
    const agent = await ForgeAgent.create(config, { autoApprove, render: true });
    try {
      await agent.run(prompt);
    } catch (err) {
      if (isAbort(err)) throw err; // 交给 main().catch 静默退出
      const ex = explainApiError(err);
      stdout.write(`\x1b[31mError: ${ex.message}\x1b[0m\n`);
    }
    finish(agent, config);
    await agent.dispose(); // 关闭 LSP server 子进程
    return;
  }

  // 2) 交互式 REPL：全屏 TUI（备用屏 + 虚拟视口 + 鼠标，Claude Code 式）。
  // 循环支持 /resume 热切换：App exit + requestResume(meta) → 本循环用 resume 重建 agent+App。
  const io = new TerminalIo(stdout);
  const mouseStdin = createMouseStdin(process.stdin);
  let resumeMeta: JsonlSessionMetadata | undefined = undefined;
  // --resume <id> / FORGE_RESUME=<id> 直启（id 前缀匹配）
  const resumeArg = (() => {
    const i = args.indexOf("--resume");
    if (i >= 0 && args[i + 1]) return args[i + 1]!;
    return process.env.FORGE_RESUME;
  })();
  if (resumeArg) {
    const all = await ForgeAgent.listSessions(config);
    const hit = all.find((x) => x.id === resumeArg || x.id.startsWith(resumeArg));
    if (hit) resumeMeta = hit;
    else stdout.write(`\x1b[33m未找到会话 ${resumeArg}\x1b[0m\n`);
  }

  for (;;) {
    let pendingResume: JsonlSessionMetadata | undefined;
    const bridge: AppBridge = {
      confirm: async () => true,
      notice: () => {},
      status: () => {},
      subagent: () => {},
      resume: () => {},
      convergentEvent: () => {},
      requestResume: (m) => {
        pendingResume = m;
      },
    };
    const agent = await ForgeAgent.create(config, {
      autoApprove,
      render: false, // 事件改由 Ink 消费，不写 stdout
      resume: resumeMeta,
      confirm: (t, a) => bridge.confirm(t, a),
      onNotice: (s) => bridge.notice(s),
      onStatus: (s) => bridge.status(s),
      onSubStatus: (s) => bridge.subagent(s),
      onResume: (t) => bridge.resume(t),
      onConvergentEvent: (e) => bridge.convergentEvent(e),
    });
    io.enter({ mouse: process.env.FORGE_NO_MOUSE !== "1" }); // 幂等；FORGE_NO_MOUSE=1 不开鼠标捕获
    // exitOnCtrlC:false → App 自己接管 Ctrl+C；stdin 断言：Ink 只要 on/setRawMode/isTTY
    const app = render(createElement(App, { agent, config, bridge, mouseStdin, resumedFrom: resumeMeta }), {
      stdin: mouseStdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
    });
    await app.waitUntilExit();
    io.restore(); // 出备用屏、关鼠标、恢复光标（下一轮循环会重新 enter）
    await agent.dispose();
    if (!pendingResume) {
      finish(agent, config); // 真退出：主屏打印摘要
      break;
    }
    resumeMeta = pendingResume; // /resume 热切换：重建会话（挂载逐字重放）
  }
  (mouseStdin as unknown as { detach?: () => void }).detach?.(); // 解除真实 stdin 监听，放行进程退出
}

main().catch((err) => {
  if (isAbort(err)) {
    stdout.write("\n"); // 中断（Ctrl+C）→ 静默正常退出
    process.exit(0);
  }
  // 配置/启动类错误打干净的消息；真正意外的错误才带栈
  const msg = err instanceof Error ? err.message : String(err);
  const detail = err instanceof Error && /unexpected|cannot read|undefined is not/i.test(msg) ? `\n${err.stack}` : "";
  stdout.write(`\x1b[31mFatal: ${msg}\x1b[0m${detail}\n`);
  process.exit(1);
});
