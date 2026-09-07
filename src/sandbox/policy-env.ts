/**
 * 子进程环境白名单 —— 三处共用（bwrap --clearenv 后 --setenv、seatbelt 前置 env -i、
 * 无后端降级时的兜底 env 清洗）。白名单模型取代旧 scrubbedEnv 黑名单正则：
 * 漏命名古怪 key 的风险消失（不在单子上的变量一律不给）。
 * 密钥类（*_KEY / *_TOKEN / *_SECRET…）天然不在内。
 */
export const ENV_WHITELIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "TMPDIR",
  "SHELL",
  "PWD",
  "HOSTNAME",
] as const;

/** 从 base 复制出白名单环境（额外变量由调用方在其上合并，如 ssh 的 askpass 三件套）。 */
export function whitelistEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_WHITELIST) {
    const v = base[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out;
}
