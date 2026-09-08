#!/usr/bin/env node
/**
 * forge 全局启动器（package.json bin → 此文件；npm link 后任意目录可用 `forge`）。
 *
 * · 以子进程运行 `node --import tsx/esm src/index.ts`——TUI 的备用屏/raw mode/鼠标
 *   经 stdio:inherit 直通；tsx 的路径从**本文件位置**解析（createRequire），与用户
 *   当前目录无关（别的项目 node_modules 里没有 tsx 也能跑）。
 * · **不改 cwd**：工作区 = 用户启动目录（config.ts 按启动目录发现 .env /
 *   forge.config.json，缺省再兜底 ~/.forge/）。
 * · 前台 Ctrl+C/SIGTERM 由 forge 自己接管（TerminalIo 分级处理并还原终端），
 *   父进程吞掉信号只等子进程退出，避免终端被父进程先行归还。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxEsm = createRequire(import.meta.url).resolve("tsx/esm");
const child = spawn(process.execPath, ["--import", tsxEsm, join(root, "src", "index.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
  // tsx 的 loader 按 cwd 发现 tsconfig——从别的项目启动时找不到 → JSX 回退经典运行时
  // （"React is not defined"）。钉死本仓库的 tsconfig（jsx: react-jsx 等）。
  env: { ...process.env, TSX_TSCONFIG_PATH: join(root, "tsconfig.json") },
});

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});
child.on("error", (e) => {
  console.error(`forge 启动失败：${e.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
