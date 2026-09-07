import { createElement } from "react";
import { render } from "ink";
import { stdout } from "node:process";
import { loadConfig, type ForgeConfig } from "./config.js";
import { ForgeAgent } from "./kernel/forge-agent.js";
import { App, type AppBridge } from "./ui/app.js";
import { renderBanner, ansi } from "./ui/theme.js";
import { explainApiError } from "./kernel/errors.js";

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
  const yes = args.includes("-y") || args.includes("--yes");
  const prompt = args.filter((a) => !a.startsWith("-")).join(" ").trim();

  // 1) 一次性任务：forge "把 README 里的 TODO 列出来"（非 TUI，沿用流式渲染器）
  if (prompt) {
    banner(config, "One-shot task");
    const agent = await ForgeAgent.create(config, { autoApprove: yes, render: true });
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

  // 2) 交互式 REPL：渲染 Ink TUI（输出滚动区在上、输入框 + 仪表盘钉在底部）
  banner(config, "Type a request to begin  ·  /skills /compact /stats /pass-permissions  ·  /exit to quit");
  const bridge: AppBridge = { confirm: async () => true, notice: () => {}, status: () => {}, subagent: () => {}, resume: () => {}, convergentEvent: () => {} };
  const agent = await ForgeAgent.create(config, {
    autoApprove: yes,
    render: false, // 事件改由 Ink 消费，不写 stdout
    confirm: (t, a) => bridge.confirm(t, a),
    onNotice: (s) => bridge.notice(s),
    onStatus: (s) => bridge.status(s),
    onSubStatus: (s) => bridge.subagent(s),
    onResume: (t) => bridge.resume(t),
    onConvergentEvent: (e) => bridge.convergentEvent(e),
  });
  // exitOnCtrlC:false → 由 App 自己接管 Ctrl+C（运行中=中止 / 有输入=清空 / 空输入按两次=退出）
  const app = render(createElement(App, { agent, config, bridge }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  finish(agent, config);
  await agent.dispose(); // 关闭 LSP server 子进程
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
