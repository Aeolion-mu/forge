import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

/**
 * Linux 硬沙箱（bubblewrap + cgroups/rlimits）—— exec.ts 的 POSIX 强化层。
 *
 * 为什么要它（exec.ts 自己已坦白）：软沙箱「限不了 CPU/内存、挡不住往任意绝对路径写」。
 * bwrap 用内核原语补上这两块：
 *   · `--ro-bind / /` 只读根 + 仅 workdir/缓存可写 → **内核级**写边界（命令再花也绕不过，
 *     比 permission.ts 解析命令串的 detectWriteEscape 强）。
 *   · `--clearenv` + 白名单 `--setenv` → 比 scrubbedEnv 黑名单正则更稳（漏命名古怪 key 的风险消失）。
 *   · 命名空间隔离（pid/ipc/uts，可选 net）。
 *   · 资源限额：有 systemd 用户实例就走 cgroup v2（MemoryMax/MemorySwapMax=0/TasksMax），
 *     否则回退 ulimit rlimits。
 *
 * 诚实边界：bwrap 共享宿主内核，**不防内核 0-day 提权**——那是 gVisor/microVM 的活。
 * 对 forge（category-1 本地工具、跑模型生成的命令）这是**相称**的选择：覆盖删文件/偷 key/
 * 失控进程这些现实风险，不为「模型蓄意打内核漏洞」这种极低概率威胁过度设计。
 *
 * Windows / 无 bwrap 的 Linux：本模块不介入，exec.ts 回退原有软沙箱（优雅降级）。
 */

/** 沙箱策略（来自 config.sandbox，已填好默认值后传入）。 */
export interface SandboxPolicy {
  /** 总开关。Windows/无 bwrap 时即便 true 也自动降级。 */
  enabled: boolean;
  /** 沙箱内是否联网（D1，默认 true：npm/pip/git 要用）。false → --unshare-net。 */
  network: boolean;
  /** workdir 之外额外可写的绝对路径（D2，如 /tmp、~/.cache、~/.npm）。 */
  writePaths: string[];
  /** 内存上限（cgroup MemoryMax / rlimit；"" = 不限），如 "2G"。 */
  memMax: string;
  /** 进程数上限（cgroup TasksMax / rlimit nproc；0 = 不限）。 */
  pidsMax: number;
}

/** 探测到的宿主能力（注入进纯函数 → 可单测，不碰真环境）。 */
export interface SandboxCaps {
  bwrap: boolean;
  /** systemd-run --user --scope 真能用（headless root 常没有 user manager → false）。 */
  systemdRun: boolean;
}

/** --clearenv 后用 --setenv 放行的变量名白名单（值从传入 env 取；密钥类天然不在内）。 */
export const ENV_WHITELIST = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TZ", "TMPDIR", "SHELL", "PWD", "HOSTNAME",
] as const;

/** D2 默认额外可写目录：/tmp + HOME 下常用缓存（构建/包管理器要写）。 */
export function defaultWritePaths(home: string = homedir()): string[] {
  return ["/tmp", `${home}/.cache`, `${home}/.npm`, `${home}/.cargo`, `${home}/.config`];
}

/** "2G"/"512M"/"1024K" → KiB（ulimit -v 用）；解析不了返回 null。 */
export function memToKiB(s: string): number | null {
  const m = /^(\d+)\s*([gmk])?i?b?$/i.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const u = (m[2] || "").toLowerCase();
  if (u === "g") return n * 1024 * 1024;
  if (u === "m") return n * 1024;
  if (u === "k") return n;
  return Math.ceil(n / 1024); // 无单位按字节
}

/**
 * 纯函数：构造 bwrap 参数前缀（到 `--` 为止，不含内层命令）。
 * rwPaths/env 由调用方注入（含 workdir、且应已做存在性过滤）→ 本函数不碰 fs，可单测。
 */
export function buildBwrapArgs(workdir: string, network: boolean, rwPaths: string[], env: NodeJS.ProcessEnv): string[] {
  const a: string[] = [
    "--die-with-parent",     // 父进程死→沙箱全死，杜绝孤儿
    "--unshare-pid",         // 独立 PID 命名空间（看不到/杀不到宿主进程）
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",         // 断开控制终端，防 TIOCSTI 注入
    "--ro-bind", "/", "/",   // 只读根 = 内核级写守卫
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",       // 干净、独立、可写的 /tmp
  ];
  if (!network) a.push("--unshare-net");
  // 可写口（/tmp 已由 --tmpfs 提供，去重避免重复挂载报错）
  for (const p of rwPaths) {
    if (p === "/tmp") continue;
    a.push("--bind", p, p);
  }
  a.push("--clearenv");
  for (const k of ENV_WHITELIST) {
    const v = env[k];
    if (v !== undefined && v !== "") a.push("--setenv", k, v);
  }
  a.push("--chdir", workdir, "--");
  return a;
}

/**
 * 纯函数：组装最终 spawn 的 {file, args}，把「资源限额层 → bwrap 层 → 内层 sh -c cmd」缝起来。
 * caps 注入 → 可对 systemd-run / rlimits / 无限额 三条分支单测。
 */
export function buildSandboxedCommand(
  cmd: string,
  workdir: string,
  policy: SandboxPolicy,
  caps: SandboxCaps,
  rwPaths: string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } {
  const bwrapArgs = buildBwrapArgs(workdir, policy.network, rwPaths, env);
  const wantLimit = Boolean(policy.memMax) || policy.pidsMax > 0;

  // 分支 A：有 systemd 用户实例 → 外层 systemd-run --scope 套 cgroup v2（最强）
  if (wantLimit && caps.systemdRun) {
    const props: string[] = [];
    if (policy.memMax) props.push("-p", `MemoryMax=${policy.memMax}`, "-p", "MemorySwapMax=0");
    if (policy.pidsMax > 0) props.push("-p", `TasksMax=${policy.pidsMax}`);
    return {
      file: "systemd-run",
      args: ["--user", "--scope", "-q", ...props, "--", "bwrap", ...bwrapArgs, "/bin/sh", "-c", cmd],
    };
  }

  // 分支 B：无 systemd → 回退 rlimits（在内层 sh 里 ulimit；弱一些但免 root、universal）
  if (wantLimit) {
    const lims: string[] = [];
    const kib = policy.memMax ? memToKiB(policy.memMax) : null;
    if (kib) lims.push(`ulimit -v ${kib} 2>/dev/null || true;`);
    if (policy.pidsMax > 0) lims.push(`ulimit -u ${policy.pidsMax} 2>/dev/null || true;`);
    const inner = `${lims.join(" ")} ${cmd}`;
    return { file: "bwrap", args: [...bwrapArgs, "/bin/sh", "-c", inner] };
  }

  // 分支 C：不限额，只做隔离
  return { file: "bwrap", args: [...bwrapArgs, "/bin/sh", "-c", cmd] };
}

/** workdir + policy.writePaths 里**真实存在**的绝对路径（bwrap bind 不存在的路径会报错）。 */
export function resolveRwPaths(workdir: string, policy: SandboxPolicy): string[] {
  return [workdir, ...policy.writePaths].filter((p) => existsSync(p));
}

let _caps: SandboxCaps | null = null;
/** 探测宿主沙箱能力（缓存）。Windows 直接 false；systemd-run 会真探一次 --user scope。 */
export function detectSandboxCaps(): SandboxCaps {
  if (_caps) return _caps;
  if (process.platform === "win32") return (_caps = { bwrap: false, systemdRun: false });
  const bwrap = hasBin("bwrap");
  let systemdRun = false;
  if (hasBin("systemd-run")) {
    const r = spawnSync("systemd-run", ["--user", "--scope", "-q", "--", "true"], { stdio: "ignore", timeout: 4000 });
    systemdRun = r.status === 0;
  }
  return (_caps = { bwrap, systemdRun });
}

function hasBin(name: string): boolean {
  const r = spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore", timeout: 3000 });
  return r.status === 0;
}
