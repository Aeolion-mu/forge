import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildSandboxedCommand, resolveReadDeny, resolveRwPaths, detectSandboxCaps, type SandboxCaps } from "./bwrap.js";
import { buildSeatbeltCommand, resolveSeatbeltPaths, seatbeltAvailable } from "./seatbelt.js";
import { whitelistEnv } from "./policy-env.js";
import { isExcluded, headToken, type SandboxPolicy } from "./policy.js";

/**
 * 沙箱执行层 —— 工具（bash/diagnostics）在受限子进程里跑：
 *   · 平台策略路由：Linux → bwrap(+cgroup)；macOS → sandbox-exec(Seatbelt)；无后端 → 大声降级
 *   · 统一白名单环境（policy-env.ts，三端同源）——子进程拿不到任何密钥类变量
 *   · 关闭 stdin（不完整命令不再阻塞卡死）
 *   · 超时杀**整棵进程树**（POSIX 进程组）
 *   · 输出字节上限，超出即截断并终止
 *
 * 降级是**大声**的：initSandbox 探测后端，无后端时状态可查（getSandboxStatus），
 * 启动横幅 / TUI 仪表盘都会显示「未沙箱」——旧版静默 no-op 的问题不再。
 * 豁免命令（policy.excluded，如 brew——沙箱内不可嵌套沙箱）：不沙箱执行，但输出前置警告。
 */
export type SandboxBackend = "bwrap" | "seatbelt" | "none";

export interface SandboxStatus {
  backend: SandboxBackend;
  /** 人类可读的原因（降级时说明为什么）。 */
  reason: string;
  /** 策略是否开启（false = 用户显式关闭）。 */
  enabled: boolean;
}

/** 进程级默认沙箱策略（forge-agent 启动时 setSandboxPolicy(config.sandbox) 注入一次）。 */
let activePolicy: SandboxPolicy | null = null;
let activeStatus: SandboxStatus = { backend: "none", reason: "尚未初始化", enabled: false };
let sessionTmp: string | null = null;

/** 设置默认沙箱策略并探测后端（大声降级的落点）。传 null 关闭。单测可给 execSandboxed 传 opts.policy 覆盖。 */
export function setSandboxPolicy(p: SandboxPolicy | null): void {
  activePolicy = p;
  activeStatus = p ? pickBackend(p, detectSandboxCaps()) : { backend: "none", reason: "策略未配置", enabled: false };
  // 会话级私有临时目录（macOS 侧替代 bwrap 的 --tmpfs /tmp：seatbelt 只能限制共享目录，
  // 给每会话独立 $TMPDIR 才有「私有 /tmp」语义）
  if (sessionTmp) {
    try {
      rmSync(sessionTmp, { recursive: true, force: true });
    } catch {
      /* 清不掉就算了 */
    }
  }
  sessionTmp =
    p?.enabled && activeStatus.backend === "seatbelt" ? realpathSync(mkdtempSync(`${tmpdir()}/forge-sandbox-`)) : null; // realpath：/var → /private/var（SBPL 按解析后路径匹配）
}

/** 当前沙箱状态（启动横幅 / TUI 仪表盘用）。 */
export function getSandboxStatus(): SandboxStatus {
  return activeStatus;
}

/** 纯函数：按平台 + 能力探测选后端。 */
export function pickBackend(policy: SandboxPolicy, caps: SandboxCaps & { seatbelt?: boolean } = detectSandboxCaps()): SandboxStatus {
  if (!policy.enabled) return { backend: "none", reason: "FORGE_SANDBOX=0 用户关闭", enabled: false };
  if (process.platform === "linux" && caps.bwrap) {
    return { backend: "bwrap", reason: caps.systemdRun ? "bwrap + systemd cgroup" : "bwrap（无 systemd：仅隔离，不限内存）", enabled: true };
  }
  if (process.platform === "darwin" && (caps.seatbelt ?? seatbeltAvailable())) {
    return { backend: "seatbelt", reason: "sandbox-exec (Seatbelt)；macOS 无内存限额", enabled: true };
  }
  return {
    backend: "none",
    reason: process.platform === "linux" ? "未安装 bwrap（brew/apt 装 bubblewrap 后自动启用）" : "该平台无硬沙箱后端",
    enabled: true,
  };
}

export interface SandboxExecOptions {
  cwd: string;
  timeoutMs?: number;
  /** 输出字节上限，默认 1 MiB。 */
  maxBytes?: number;
  /** Ctrl+C → harness 透传的中止信号；触发即 kill 整棵进程树并立刻返回。 */
  signal?: AbortSignal;
  /** Linux 硬沙箱策略；不传则用 setSandboxPolicy 注入的进程级默认（单测可在此覆盖）。 */
  policy?: SandboxPolicy;
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

/** 在受限子进程里执行一条命令（Linux 叠 bwrap+cgroup；macOS 叠 sandbox-exec；否则白名单 env + /bin/sh）。 */
export function execSandboxed(cmd: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
  const policy = opts.policy ?? activePolicy;
  const env = whitelistEnv(); // ← 统一白名单：三端同源，子进程拿不到 API key

  if (policy?.enabled) {
    // 豁免名单：沙箱内不可嵌套沙箱（brew / swift test 等自带沙箱的工具）——不沙箱执行 + 大声警告。
    if (isExcluded(cmd, policy)) {
      return spawnCaptured("/bin/sh", ["-c", cmd], { ...opts, env }).then((r) => ({
        ...r,
        out: `[sandbox] 命令 "${headToken(cmd)}" 在豁免名单（沙箱内无法运行自带沙箱的工具），本次未沙箱执行。\n${r.out}`,
      }));
    }
    const status = pickBackend(policy);
    if (status.backend === "seatbelt" && sessionTmp) {
      const { rwPaths, readDeny } = resolveSeatbeltPaths(opts.cwd, policy);
      rwPaths.push(sessionTmp); // 每会话私有 $TMPDIR = 「私有 /tmp」语义
      const { file, args } = buildSeatbeltCommand(cmd, policy, rwPaths, readDeny, { ...env, TMPDIR: sessionTmp });
      return spawnCaptured(file, args, { ...opts, env });
    }
    if (status.backend === "bwrap") {
      const rwPaths = resolveRwPaths(opts.cwd, policy);
      const readDeny = resolveReadDeny(policy);
      const { file, args } = buildSandboxedCommand(cmd, opts.cwd, policy, detectSandboxCaps(), rwPaths, readDeny, {
        ...env,
        TMPDIR: "/tmp", // bwrap 已给独立 tmpfs /tmp
      });
      return spawnCaptured(file, args, { ...opts, env });
    }
  }

  // 无策略 / 无后端：白名单 env 的 /bin/sh（降级状态由 getSandboxStatus 暴露，启动时大声提示）
  return spawnCaptured("/bin/sh", ["-c", cmd], { ...opts, env });
}

/**
 * 从 0.85 的库 Context 里取取消信号（工具六参签名里 signal 没了，取消走 context）。
 * Context 来自 @earendil-works/chord，abortSignal 可能不存在。
 */
export function signalOf(context: { abortSignal?: AbortSignal | undefined } | undefined): AbortSignal | undefined {
  return context?.abortSignal;
}

export interface SpawnCapturedOptions {
  cwd?: string;
  timeoutMs?: number;
  /** 输出字节上限，默认 1 MiB。 */
  maxBytes?: number;
  /** 子进程环境；默认 whitelistEnv()。 */
  env?: NodeJS.ProcessEnv;
  /** Ctrl+C → harness 透传的中止信号；触发即 kill 整棵进程树并立刻返回。 */
  signal?: AbortSignal;
}

/**
 * argv 形态的受限 spawn —— execSandboxed 与 ssh 工具共用：关 stdin（EOF 防卡死）、
 * 超时杀整棵进程树、输出字节上限。**直接 spawn 可执行文件 + argv，不经 shell**，
 * 故远程命令/参数无需再过引号转义。stdout/stderr 合并到一份文本。
 */
export function spawnCaptured(file: string, args: string[], opts: SpawnCapturedOptions = {}): Promise<SandboxExecResult> {
  const started = Date.now();
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
      env: opts.env ?? whitelistEnv(), // ← 统一白名单：子进程拿不到 API key
      stdio: ["ignore", "pipe", "pipe"], // ← 关键：stdin 直接 EOF，命令读不到输入也不会阻塞
      detached: true, // 自成进程组，便于整组杀
    });

    let buf = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
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
    // 不等 child 'close' —— 免得「close 迟迟不来，用户感觉 Ctrl+C 没反应」。
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
