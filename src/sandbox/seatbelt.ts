import { existsSync, realpathSync } from "node:fs";
import type { SandboxPolicy } from "./policy.js";
import { ENV_WHITELIST } from "./policy-env.js";

/**
 * macOS 硬沙箱（sandbox-exec / Seatbelt / SBPL）—— bwrap.ts 的 Darwin 对应物。
 *
 * 形态选 Bazel 式 `(allow default)` + 显式 deny（而非 Anthropic 的 deny-default + 长枚举白名单）：
 * 对系统漂移免疫（macOS 26 的 zsh 5.9 读未放行 sysctl 静默退出那类坑），维护税低。
 * Claude Code / Cursor / Bazel / Homebrew 在 macOS 上都是这个原语。
 *
 * 能力对照（诚实边界）：
 *  · 写边界：(deny file-write*) + subpath 白名单 = bwrap --ro-bind / / + --bind 的内核级等价 ✓
 *  · 读隐藏：(deny file-read* (subpath …)) —— 比 bwrap 强（bwrap 得靠 tmpfs 盖）✓
 *  · 断网：(deny network*) = --unshare-net ✓
 *  · 内存上限：**无**（SBPL 无资源限制原语；ulimit -v 在 macOS 确认失效）——policy.memMax 标 Linux-only
 *  · 进程数：ulimit -u 部分生效（fork EAGAIN，受 kern.maxprocperuid 封顶）
 *  · 内层 shell 钉死 /bin/bash：zsh 5.9 在 Darwin 25+ 读未放行 hw.* sysctl 会静默死
 *  · 嵌套：沙箱内不能跑自带沙箱的工具（brew 等）——policy.excluded 豁免名单放行 + 警告
 *  · 运行时拒绝只进 unified log（EPERM 静默）——规则带 (with message) 便于 log stream 归因
 */
export function seatbeltAvailable(): boolean {
  return existsSync("/usr/bin/sandbox-exec");
}

/** 路径解析成 SBPL 匹配用的真实绝对路径（/tmp → /private/tmp；符号链接展开）。不存在 → null。 */
function resolved(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 纯函数：生成 SBPL profile。rwPaths/readDeny 由调用方传**已存在性过滤、已 ~ 展开**的绝对路径。
 * 规则顺序：allow default → deny 写 → 允许写白名单 → /dev 字符设备豁免 → readDeny → 断网。
 */
export function buildSeatbeltProfile(opts: { rwPaths: string[]; readDeny: string[]; network: boolean }): string {
  const lines: string[] = [
    "(version 1)",
    "(allow default)", // Bazel 式：默认放行，只显式收紧（对系统更新加入的新 syscall 免疫）
    "(deny file-write*)", // 内核级只读根
  ];
  for (const p of opts.rwPaths) {
    lines.push(`(allow file-write* (subpath "${p}"))`);
  }
  // /dev/null 重定向是最常见的「假越界写」；只开字符设备（不开整个 /dev——块设备裸写必须拦）
  lines.push('(allow file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))');
  lines.push('(allow file-ioctl (literal "/dev/null"))');
  for (const p of opts.readDeny) {
    lines.push(`(deny file-read* (subpath "${p}") (with message "forge-sandbox-read-deny"))`);
  }
  if (!opts.network) {
    lines.push('(deny network* (with message "forge-sandbox-net-off"))');
  }
  return lines.join("\n");
}

/**
 * 纯函数：组装最终 spawn 的 {file, args}。
 * `env -i 白名单` 前置（sandbox-exec 自己不碰环境 → 白名单模型在这里统一，与 bwrap --clearenv 同源）。
 * pidsMax 经内层 `ulimit -u`（部分生效）；**任何地方不出现 ulimit -v**（macOS 上静默失效，假装有限制不如诚实没有）。
 */
export function buildSeatbeltCommand(
  cmd: string,
  policy: SandboxPolicy,
  rwPaths: string[],
  readDeny: string[],
  env: NodeJS.ProcessEnv,
): { file: string; args: string[] } {
  const profile = buildSeatbeltProfile({ rwPaths, readDeny, network: policy.network });
  const inner = policy.pidsMax > 0 ? `ulimit -u ${policy.pidsMax} 2>/dev/null || true; ${cmd}` : cmd;
  const whitelist: string[] = [];
  for (const k of ENV_WHITELIST) {
    const v = env[k];
    if (v !== undefined && v !== "") whitelist.push(`${k}=${v}`);
  }
  return {
    file: "/usr/bin/env",
    args: ["-i", ...whitelist, "/usr/bin/sandbox-exec", "-p", profile, "/bin/bash", "-c", inner],
  };
}

/** rwPaths/readDeny 里真实存在的已解析路径（bwrap bind / SBPL subpath 都要求路径存在）。 */
export function resolveSeatbeltPaths(workdir: string, policy: SandboxPolicy): { rwPaths: string[]; readDeny: string[] } {
  const rw = [workdir, ...policy.writePaths].map(resolved).filter((p): p is string => p !== null);
  const deny = policy.readDeny.map(resolved).filter((p): p is string => p !== null);
  return { rwPaths: [...new Set(rw)], readDeny: [...new Set(deny)] };
}
