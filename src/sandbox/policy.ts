import { homedir } from "node:os";

/**
 * 沙箱策略（bwrap / seatbelt 共用）—— 写边界、读隐藏、断网、资源限额、豁免名单。
 *
 * 设计原则（2026-09 重构）：
 *  · 写边界由**内核**保证（Linux bwrap 只读根 + 可白名单；macOS seatbelt deny file-write* +
 *    subpath 白名单）——正则写边界/语义守卫两层已删，这里是唯一的写边界事实源。
 *  · readDeny：默认禁读敏感目录（~/.ssh 等）。bwrap 用空 tmpfs 盖住；seatbelt 用
 *    (deny file-read* (subpath …))。防的是「沙箱内命令读 key 后经网络外传」（全盘默认可读
 *    + 默认联网的组合是真实外泄面）。
 *  · memMax/pidsMax：**仅 Linux** 有 systemd cgroup 时生效；macOS 无内核级资源限额机制
 *    （SBPL 无资源限制原语，ulimit -v 在 macOS 失效）——诚实标注，不假装。
 *  · excluded：沙箱内不可嵌套沙箱（brew/swift test 等自带沙箱的工具在 seatbelt/bwrap 里
 *    会失败）——命中头 token 的命令不沙箱执行 + 大声警告 + 审计 sandbox=exempt。
 */
export interface SandboxPolicy {
  /** 总开关。无后端可用时自动降级为不沙箱（大声警告，见 exec.ts initSandbox）。 */
  enabled: boolean;
  /** 沙箱内是否联网（npm/pip/git 要用，默认 true）。false → bwrap --unshare-net / seatbelt (deny network*)。 */
  network: boolean;
  /** 只读根之外额外可写的绝对路径（支持 ~ 展开；不存在的路径在 resolve 时跳过）。 */
  writePaths: string[];
  /** 禁读的绝对路径（支持 ~ 展开）——敏感目录读隐藏，防密钥外传。 */
  readDeny: string[];
  /** 内存上限（Linux systemd cgroup MemoryMax；macOS 不支持）。"" = 不限。 */
  memMax: string;
  /** 进程数上限（Linux cgroup TasksMax；macOS 无对应机制）。0 = 不限。 */
  pidsMax: number;
  /** 豁免沙箱的命令头 token（如 brew、swift）。命中则不沙箱执行 + 警告 + 审计。 */
  excluded: string[];
}

/** D2 默认可写目录：/tmp + HOME 下常用缓存。**不含 ~/.config**（git config --global / gh
 *  hosts.yml 都在里面——内核写边界收紧后它应回到「显式配置才可写」，旧正则层拦的就是这类）。 */
export function defaultWritePaths(home: string = homedir()): string[] {
  return ["/tmp", `${home}/.cache`, `${home}/.npm`, `${home}/.cargo`];
}

/** 默认禁读的敏感目录：SSH 密钥 / 云凭证 / GPG 私钥。 */
export function defaultReadDeny(home: string = homedir()): string[] {
  return [`${home}/.ssh`, `${home}/.aws`, `${home}/.gnupg`];
}

/** ~ / ~/ 前缀展开成绝对路径（配置里可写 ~ 方便人读）。 */
export function expandHomePaths(paths: string[], home: string = homedir()): string[] {
  return paths.map((p) => (p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p));
}

/** 命令的头部 token（豁免名单匹配用）：取第一个非空白段，剥掉路径前缀与环境前缀。 */
export function headToken(cmd: string): string {
  const m = /^\s*(?:env\s+\S+\s+)*([^\s]+)/.exec(cmd);
  if (!m) return "";
  return m[1]!.split("/").pop() ?? m[1]!;
}

/** 命令是否命中豁免名单（不沙箱执行）。 */
export function isExcluded(cmd: string, policy: SandboxPolicy): boolean {
  if (!policy.excluded.length) return false;
  return policy.excluded.includes(headToken(cmd));
}
