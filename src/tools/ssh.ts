import { homedir, tmpdir } from "node:os";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawnCaptured, scrubbedEnv } from "../sandbox/exec.js";
import { truncateForContext } from "../kernel/artifacts.js";
import type { SshProfile } from "../config.js";

/**
 * ssh_run —— 通过 SSH 在**预配置的**远程主机上执行命令。
 *
 * 为什么是专用工具而非 bash 硬连：
 *   · 本地写边界守卫（permission.ts detectWriteEscape）只认命令字符串，分不清本地/远程，
 *     会把 `ssh host "x > /etc/y"` 当越界写误杀；专用工具不走该守卫（远程写不归本地 workdir 管）。
 *   · 强制 BatchMode + accept-new + ConnectTimeout，配合沙箱关 stdin → 不会卡在密码/host-key 提示。
 *   · 只能连 forge.config.json `ssh` 里声明过的档案 = 显式授权，模型不能 ssh 到任意地址。
 *
 * 安全：HARD_DENY 黑名单（rm -rf / 等）在 permission.ts 里**也覆盖 ssh_run 的远程命令**
 * （即便 /pass-permissions 自动放行时也拦）；默认每条远程命令仍需用户确认 + 全量审计/飞行记录。
 */

const makeSchema = (profileNames: string[]) =>
  Type.Object({
    profile: Type.String({
      description: profileNames.length
        ? `连接档案名（forge.config.json ssh.<name>）。可用：${profileNames.join(", ")}`
        : "连接档案名。当前未配置任何档案——需先在 forge.config.json 的 ssh 段添加。",
    }),
    command: Type.String({ description: "在远程主机上执行的命令（作为单个参数传给 ssh，无需为本地 shell 转义）" }),
    timeoutMs: Type.Optional(Type.Number({ description: "超时毫秒，默认 30000" })),
  });

/** 未配置 / 未知档案的引导文案。 */
const NO_PROFILES_HINT =
  '未配置任何 ssh 档案。请在 forge.config.json 的 "ssh" 段添加，例如：' +
  '"ssh": { "deploy": { "host": "1.2.3.4", "user": "ubuntu", "port": 22, "key": "~/.ssh/id_ed25519" } }，然后重启 forge。';

/** ~ / ~/ 展开成用户主目录（Windows OpenSSH 不一定认 ~）。 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return homedir() + p.slice(1);
  return p;
}

/** 喂密码用的环境变量名（askpass 脚本从这里读，避免把密码写进脚本文件 / 命令行）。 */
const ASKPASS_PW_ENV = "FORGE_SSH_ASKPASS_PW";

/**
 * 构造 ssh 的 argv（纯函数，可单测）。统一：StrictHostKeyChecking=accept-new（首连不卡）+ ConnectTimeout=10。
 * 两种认证模式：
 *  · 密码档案（有 password）：开交互（SSH_ASKPASS 要靠提示喂密码，**不能 BatchMode**）+ 强制密码认证、跳过 pubkey。
 *  · 密钥/默认：BatchMode=yes（绝不提示），有 key 则 -i。
 * 远程命令作为**单个 argv 元素**，由 ssh 原样交给远程 shell。
 */
export function buildSshArgs(profile: SshProfile, command: string): string[] {
  const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10"];
  if (profile.port) args.push("-p", String(profile.port));
  if (profile.password) {
    args.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no");
  } else {
    args.push("-o", "BatchMode=yes");
    if (profile.key) args.push("-i", expandHome(profile.key));
  }
  args.push(profile.user ? `${profile.user}@${profile.host}` : profile.host, command);
  return args;
}

/** 惰性写出 askpass 助手（从 ASKPASS_PW_ENV 读密码并原样输出；不含密码本身）。返回其路径。 */
let askpassPath: string | null = null;
function ensureAskpass(): string {
  if (askpassPath) return askpassPath;
  if (process.platform === "win32") {
    const p = join(tmpdir(), "forge-ssh-askpass.cmd");
    // PowerShell 读 env 原样输出：彻底避开 batch 对 & ! % ^ 等特殊字符的引号地狱
    writeFileSync(p, `@powershell -NoProfile -Command "[Console]::Out.Write($env:${ASKPASS_PW_ENV})"\r\n`, "ascii");
    askpassPath = p;
  } else {
    const p = join(tmpdir(), "forge-ssh-askpass.sh");
    writeFileSync(p, `#!/bin/sh\nprintf '%s' "$${ASKPASS_PW_ENV}"\n`, "ascii");
    chmodSync(p, 0o700);
    askpassPath = p;
  }
  return askpassPath;
}

/** 密码模式下，给子进程环境注入 SSH_ASKPASS 三件套 + 密码（密码只在子进程 env，不落盘、不进日志）。 */
function passwordEnv(password: string): NodeJS.ProcessEnv {
  const base = scrubbedEnv();
  return {
    ...base,
    SSH_ASKPASS: ensureAskpass(),
    SSH_ASKPASS_REQUIRE: "force", // 即便有终端也强制用 askpass（OpenSSH 8.4+）
    DISPLAY: base.DISPLAY ?? "localhost:0", // 部分构建仍以 DISPLAY 是否存在作为启用 askpass 的门槛
    [ASKPASS_PW_ENV]: password,
  };
}

/**
 * 注册 ssh_run 工具。`profiles` 为空时调用方不应注册本工具（见 forge-agent）。
 * 未知档案 → 返回可读错误（不抛），引导模型用已配置的档案。
 */
export function makeSshTool(
  profiles: Record<string, SshProfile>,
): AgentTool<ReturnType<typeof makeSchema>, { exitCode: number; ms: number; timedOut: boolean; truncated: boolean; profile: string; host: string; artifact?: string }> {
  const names = Object.keys(profiles);
  const schema = makeSchema(names);
  return {
    name: "ssh_run",
    label: "SSH 远程执行",
    description: names.length
      ? `通过 SSH 在预配置的远程主机执行命令（非交互：BatchMode + 免密钥认证）。可用档案：${names.join(", ")}。返回远程命令的 stdout/stderr 合并输出 + 退出码。`
      : "通过 SSH 在远程主机执行命令。当前 forge.config.json 未配置任何 ssh 档案——需先在 ssh 段添加才能用。",
    parameters: schema,
    execute: async (_id, params, signal) => {
      const profile = profiles[params.profile];
      if (!profile) {
        const text = names.length
          ? `未知 ssh 档案 "${params.profile}"。可用：${names.join(", ")}。`
          : NO_PROFILES_HINT;
        return {
          content: [{ type: "text", text }],
          details: { exitCode: 127, ms: 0, timedOut: false, truncated: false, profile: params.profile, host: "" },
        };
      }
      const args = buildSshArgs(profile, params.command);
      const env = profile.password ? passwordEnv(profile.password) : scrubbedEnv();
      const r = await spawnCaptured("ssh", args, { timeoutMs: params.timeoutMs ?? 30000, env, signal });
      const t = truncateForContext(r.out, { workdir: process.cwd(), save: true });
      return {
        content: [{ type: "text", text: `[ssh ${params.profile} → ${profile.host}] exit=${r.code}\n${t.text}` }],
        details: {
          exitCode: r.code,
          ms: r.ms,
          timedOut: r.timedOut,
          truncated: r.truncated || t.truncated,
          profile: params.profile,
          host: profile.host,
          artifact: t.artifact,
        },
      };
    },
  };
}
