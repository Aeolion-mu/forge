import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { SandboxPolicy } from "./policy.js";
import { ENV_WHITELIST } from "./policy-env.js";

/**
 * Linux 硬沙箱（bubblewrap + cgroups）—— exec.ts 的 Linux 后端（macOS 对应物见 seatbelt.ts）。
 *
 * bwrap 用内核原语补上软沙箱的缺口：
 *  · `--ro-bind / /` 只读根 + 仅 workdir/缓存可写 → **内核级**写边界。
 *  · readDeny：空 tmpfs 盖住敏感目录（~/.ssh 等）——读都读不到，防「读 key 走网络外传」。
 *  · `--clearenv` + 白名单 `--setenv` → 环境清洗的白名单模型（policy-env.ts 三端共用）。
 *  · 命名空间隔离（pid/ipc/uts，可选 net）。
 *  · 资源限额：有 systemd 用户实例走 cgroup v2（MemoryMax/TasksMax）；**没有就只隔离不限额**
 *    ——旧分支 B 的 `ulimit -v` 兜底会限制 V8 地址空间、把 `npx tsc` 这类 node 命令直接
 *    ENOMEM 弄死，已删（诚实没有 > 假装有限制；pidsMax 仍可用 ulimit -u，它在 Linux 真生效）。
 *
 * 诚实边界：bwrap 共享宿主内核，**不防内核 0-day 提权**——那是 gVisor/microVM 的活。
 * 对 forge（跑模型生成的命令的本地工具）这是相称的选择。
 */
export interface SandboxCaps {
  bwrap: boolean;
  /** systemd-run --user --scope 真能用（headless root 常没有 user manager → false）。 */
  systemdRun: boolean;
}

/** --clearenv 后用 --setenv 放行的变量名白名单（值从传入 env 取；密钥类天然不在内）。 */
export { ENV_WHITELIST } from "./policy-env.js";

/**
 * 纯函数：构造 bwrap 参数前缀（到 `--` 为止，不含内层命令）。
 * rwPaths/readDeny 由调用方注入（已存在性过滤）→ 本函数不碰 fs，可单测。
 */
export function buildBwrapArgs(workdir: string, network: boolean, rwPaths: string[], readDeny: string[], env: NodeJS.ProcessEnv): string[] {
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
  // 读隐藏：空 tmpfs 盖住敏感目录（存在与否都无害——不存在则造出空目录）
  for (const p of readDeny) {
    if (p === "/tmp") continue;
    a.push("--tmpfs", p);
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
 * 纯函数：组装最终 spawn 的 {file, args}。
 * 分支 A：有 systemd 用户实例 → 外层 systemd-run --scope 套 cgroup v2（Memory+Tasks 限额）。
 * 分支 B（无 systemd）：纯 bwrap 隔离 + 内层 `ulimit -u`（RLIMIT_NPROC 在 Linux 真生效；
 * 内存无可用机制 → 只隔离不限额，文档如实说）。
 */
export function buildSandboxedCommand(
  cmd: string,
  workdir: string,
  policy: SandboxPolicy,
  caps: SandboxCaps,
  rwPaths: string[],
  readDeny: string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } {
  const bwrapArgs = buildBwrapArgs(workdir, policy.network, rwPaths, readDeny, env);
  const wantMemory = Boolean(policy.memMax);
  const wantPids = policy.pidsMax > 0;

  // 分支 A：systemd-run + cgroup（唯一能给内存限额的路）
  if ((wantMemory || wantPids) && caps.systemdRun) {
    const props: string[] = [];
    if (wantMemory) props.push("-p", `MemoryMax=${policy.memMax}`, "-p", "MemorySwapMax=0");
    if (wantPids) props.push("-p", `TasksMax=${policy.pidsMax}`);
    return {
      file: "systemd-run",
      args: ["--user", "--scope", "-q", ...props, "--", "bwrap", ...bwrapArgs, "/bin/sh", "-c", cmd],
    };
  }

  // 分支 B：无 systemd → 纯隔离；pidsMax 用 ulimit -u 兜底（Linux 真生效），内存不限（诚实）。
  const inner = wantPids ? `ulimit -u ${policy.pidsMax} 2>/dev/null || true; ${cmd}` : cmd;
  return { file: "bwrap", args: [...bwrapArgs, "/bin/sh", "-c", inner] };
}

/** workdir + policy.writePaths 里**真实存在**的绝对路径（bwrap bind 不存在的路径会报错）。 */
export function resolveRwPaths(workdir: string, policy: SandboxPolicy): string[] {
  return [workdir, ...policy.writePaths].filter((p) => existsSync(p));
}

/** readDeny 里真实存在的绝对路径（不存在的盖帽无意义，跳过）。 */
export function resolveReadDeny(policy: SandboxPolicy): string[] {
  return policy.readDeny.filter((p) => existsSync(p));
}

let _caps: SandboxCaps | null = null;
/** 探测宿主沙箱能力（缓存）。systemd-run 会真探一次 --user scope。 */
export function detectSandboxCaps(): SandboxCaps {
  if (_caps) return _caps;
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
