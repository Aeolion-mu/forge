import { spawn } from "node:child_process";

/**
 * 剪贴板写入 —— Claude Code 的路径矩阵（决策与 IO 均可注入，纯逻辑可单测）：
 *  · tmux 内（$TMUX）→ `tmux load-buffer -w -`（本地剪贴板路径同时照走）
 *  · 本地 macOS → `pbcopy`；Linux → wl-copy / xclip / xsel（按在位顺序取首个）
 *  · **OSC52 永远兜底**：`ESC]52;c;<base64>ESC\` 写 stdout——SSH 远端会话里由本地终端
 *    代写剪贴板（iTerm2 需开「Applications in terminal may access clipboard」）
 * 失败不抛错：返回 {path, ok, note}，由 UI toast 呈现。
 */

/** 子进程的最小门面（真实 spawn / 单测假件都满足）。 */
export interface SpawnLike {
  stdin: { write(s: string): void; end(): void };
  on(ev: "error", cb: (e: Error) => void): void;
}

export interface CopyDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** 注入 spawn（单测用）；不可用返回 null。 */
  spawnFn?: (cmd: string, args: string[]) => SpawnLike | null;
  /** 注入 stdout 写（OSC52 用）。 */
  write?: (s: string) => void;
}

export interface CopyResult {
  /** 实际成功的首选路径（toast 显示）。 */
  path: "pbcopy" | "wl-copy" | "xclip" | "xsel" | "tmux" | "osc52" | "none";
  ok: boolean;
  note?: string;
}

function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x1b\\`;
}

/** 经子进程命令写剪贴板（stdin 喂入）。失败返回 false。 */
function viaCommand(deps: CopyDeps, cmd: string, args: string[], text: string): Promise<boolean> {
  const spawnFn = deps.spawnFn ?? ((c: string, a: string[]) => spawn(c, a) as unknown as SpawnLike);
  return new Promise((resolve) => {
    let child: SpawnLike | null;
    try {
      child = spawnFn(cmd, args);
    } catch {
      resolve(false);
      return;
    }
    if (!child?.stdin) {
      resolve(false);
      return;
    }
    let failed = false;
    child.on("error", () => {
      failed = true;
      resolve(false);
    });
    try {
      child.stdin.write(text);
      child.stdin.end();
    } catch {
      resolve(false);
      return;
    }
    // error 已挂；无 error 即视为写入成功（pbcopy 类工具读 stdin 即完成）
    setTimeout(() => {
      if (!failed) resolve(true);
    }, 0);
  });
}

const LINUX_TOOLS: Array<{ cmd: string; args: string[]; path: CopyResult["path"] }> = [
  { cmd: "wl-copy", args: [], path: "wl-copy" },
  { cmd: "xclip", args: ["-selection", "clipboard"], path: "xclip" },
  { cmd: "xsel", args: ["--clipboard", "--input"], path: "xsel" },
];

/** 把文本写进剪贴板（多路径并试 + OSC52 兜底）。返回首个成功路径。 */
export async function copyText(text: string, deps: CopyDeps = {}): Promise<CopyResult> {
  if (!text) return { path: "none", ok: false, note: "空选区" };
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const write = deps.write ?? ((s: string) => process.stdout.write(s));

  const tried: CopyResult["path"][] = [];
  const inTmux = Boolean(env.TMUX);

  // OSC52 兜底永远发（终端可能拒绝静默忽略，无害）
  try {
    write(osc52(text));
  } catch {
    /* 写失败不影响其它路径 */
  }

  if (inTmux) {
    if (await viaCommand(deps, "tmux", ["load-buffer", "-w", "-"], text)) return { path: "tmux", ok: true };
    tried.push("tmux");
  }
  if (platform === "darwin") {
    if (await viaCommand(deps, "pbcopy", [], text)) return { path: "pbcopy", ok: true };
    tried.push("pbcopy");
  } else if (platform === "linux") {
    for (const t of LINUX_TOOLS) {
      if (await viaCommand(deps, t.cmd, t.args, text)) return { path: t.path, ok: true };
      tried.push(t.path);
    }
  }
  // 命令路径全失败：OSC52 已发，仍报可用（终端支持即成功）
  return { path: "osc52", ok: true, note: tried.length ? `本地工具不可用（${tried.join("/")}），已走 OSC52` : undefined };
}
