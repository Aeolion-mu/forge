import { spawn } from "node:child_process";

/**
 * 沙箱执行层 —— 工具（目前是 bash）在受限子进程里跑：
 *   · 擦除密钥的环境变量（防 `echo $env:XXX_API_KEY` 泄漏 / prompt 注入偷 key）
 *   · 关闭 stdin（不完整命令不再阻塞读 stdin 卡死）
 *   · 超时杀**整棵进程树**（Windows taskkill /T，POSIX 进程组）
 *   · 输出字节上限，超出即截断并终止
 *
 * 诚实边界（纯 Node + 无容器）：限不了 CPU/内存、拦不了网络、挡不住命令往任意
 * 绝对路径写。这不是对抗恶意代码的安全边界——那需要容器/VM。这里只做到
 * 「隔离 + 防密钥泄漏 + 健壮」。
 */

/** 变量名匹配到即从子进程环境剔除（密钥 / 令牌 / 口令类）。 */
const SECRET_NAME_RE = /(_KEY$|API_?KEY|_TOKEN|TOKEN$|_SECRET|SECRET$|PASSWORD|PASSWD|CREDENTIAL|ACCESS_KEY|_PAT$|BEARER)/i;

/** 复制一份环境，删掉任何像密钥的变量（保留 PATH / SystemRoot / TEMP 等命令所需）。 */
export function scrubbedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (SECRET_NAME_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface SandboxExecOptions {
  cwd: string;
  timeoutMs?: number;
  /** 输出字节上限，默认 1 MiB。 */
  maxBytes?: number;
  /** Ctrl+C → harness 透传的中止信号；触发即 kill 整棵进程树并立刻返回。 */
  signal?: AbortSignal;
}

export interface SandboxExecResult {
  out: string;
  code: number;
  timedOut: boolean;
  truncated: boolean;
  /** 因外部 AbortSignal 触发被杀（区别于超时 / 输出溢出）。 */
  aborted: boolean;
  ms: number;
}

/** 在受限子进程里执行一条命令（shell-string，经 PowerShell/sh）。 */
export function execSandboxed(cmd: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  // -NonInteractive：禁止 PowerShell 续行/交互提示（配合关闭 stdin，双保险防卡死）。
  const args = isWin ? ["-NoProfile", "-NonInteractive", "-Command", cmd] : ["-c", cmd];
  return spawnCaptured(shell, args, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, env: scrubbedEnv(), signal: opts.signal });
}

export interface SpawnCapturedOptions {
  cwd?: string;
  timeoutMs?: number;
  /** 输出字节上限，默认 1 MiB。 */
  maxBytes?: number;
  /** 子进程环境；默认 scrubbedEnv()（剔密钥）。 */
  env?: NodeJS.ProcessEnv;
  /** Ctrl+C → harness 透传的中止信号；触发即 kill 整棵进程树并立刻返回。 */
  signal?: AbortSignal;
}

/**
 * argv 形态的受限 spawn —— execSandboxed 与 ssh 工具共用：关 stdin（EOF 防卡死）、
 * 超时杀整棵进程树、输出字节上限。**直接 spawn 可执行文件 + argv，不经 shell**，
 * 故远程命令/参数无需再过 PowerShell 引号转义。stdout/stderr 合并到一份文本。
 */
export function spawnCaptured(file: string, args: string[], opts: SpawnCapturedOptions = {}): Promise<SandboxExecResult> {
  const started = Date.now();
  const isWin = process.platform === "win32";
  const timeoutMs = opts.timeoutMs ?? 15000;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;

  return new Promise<SandboxExecResult>((resolve) => {
    // 已经被中止：连 spawn 都不必发起，直接以 aborted 返回（避免「Ctrl+C 后还启一次子进程」的浪费）。
    if (opts.signal?.aborted) {
      resolve({ out: "(已中止)", code: 130, timedOut: false, truncated: false, aborted: true, ms: 0 });
      return;
    }

    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? scrubbedEnv(), // ← 关键：子进程拿不到 API key
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"], // ← 关键：stdin 直接 EOF，命令读不到输入也不会阻塞
      detached: !isWin, // POSIX：自成进程组，便于整组杀
    });

    let buf = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killTree = () => {
      try {
        if (isWin) {
          if (child.pid) spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
        } else if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        /* 进程可能已退出 */
      }
    };

    const onData = (d: Buffer) => {
      if (truncated) return;
      buf += d.toString("utf8");
      bytes += d.length;
      if (bytes > maxBytes) {
        truncated = true;
        buf = `${buf.slice(0, maxBytes)}\n…（输出超过 ${maxBytes} 字节，已截断并终止）`;
        killTree();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    // 外部 AbortSignal（Ctrl+C / harness abort）：立刻 kill 进程树并以 aborted=true 返回，
    // 不等 child 'close' —— taskkill 在 Windows 上有时落地慢，等下来用户感觉「Ctrl+C 没反应」。
    const onAbort = () => {
      aborted = true;
      killTree();
      finish(130); // 130 = 128 + SIGINT，约定俗成的「Ctrl+C 退出码」
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      let text = buf.trim() || "(无输出)";
      if (aborted) text += `\n（用户中止，已 kill 进程树）`;
      else if (timedOut) text += `\n（命令超时 ${timeoutMs}ms，已终止）`;
      resolve({ out: text, code, timedOut, truncated, aborted, ms: Date.now() - started });
    };

    child.on("close", (code) => finish(code ?? (timedOut ? 124 : aborted ? 130 : 0)));
    child.on("error", (e) => {
      buf += `启动失败: ${e.message}`;
      finish(127);
    });
  });
}
