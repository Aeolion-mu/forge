/**
 * 权限策略 —— 最新一代编程 agent（Claude Code / Codex）的安全内核。
 *
 * 思路：工具调用不是“模型说了算”，而是过一道**确定性策略闸门**。
 *  - allowlist：只读工具放行；写/执行类工具需确认。
 *  - 危险命令模式匹配：rm -rf /、fork bomb、curl|sh 等直接拒绝。
 *  - bash 写边界守卫：尽力拦住「往 workdir 外写文件」（自主写代码的边界）。
 * 这道闸门挂在 pi-agent-core 的 beforeToolCall 钩子上，模型无法绕过。
 */

import { homedir } from "node:os";
import { resolve, sep } from "node:path";

// "review"：确定性层拿不准（cd 到 workdir 外 + 命令含写信号），交上层的语义守卫（flash）裁决。
// 调用方未接语义守卫时按 fail-open 放行——这是 best-effort 边界，不是安全墙。
export type Verdict = "allow" | "confirm" | "deny" | "review";

export interface PermissionDecision {
  verdict: Verdict;
  reason: string;
}

/**
 * 即便用户点了确认也绝不放行的命令模式（不可逆 / 自毁 / 远程执行）。
 * forge 同时跑在 Linux(bash) 与 Windows(PowerShell)，两套 shell 的灾难命令都要拦。
 */
const HARD_DENY_PATTERNS: { re: RegExp; why: string }[] = [
  // ── Unix / bash ──
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*)/i, why: "递归删除根 / 家目录" },
  { re: /\bmkfs(\.\w+)?\b/i, why: "格式化文件系统" },
  { re: /\bdd\s+.*of=\/dev\/(sd|nvme|disk)/i, why: "裸写块设备" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, why: "fork bomb" },
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: "下载脚本直接管道执行" },
  { re: />\s*\/dev\/(sd|nvme|disk)/i, why: "重定向覆盖块设备" },
  { re: /\bchmod\s+-R\s+777\s+\//i, why: "对根目录放开全部权限" },

  // ── Windows / PowerShell / cmd ──
  // 递归删除 盘符根 / 系统目录 / 家目录（Remove-Item 及别名 rm/ri/rd/rmdir/del/erase + -Recurse + 危险目标）
  {
    re: /(?=[\s\S]*\b(?:remove-item|ri|rd|rmdir|del|erase|rm)\b)(?=[\s\S]*-r[a-z]*\b)(?=[\s\S]*(?:[A-Za-z]:\\(?:\*|\s|"|'|;|$)|[A-Za-z]:\\(?:windows|users|program ?files)\\?(?:\*|\s|"|'|;|$)|\$env:(?:systemroot|windir|userprofile|programfiles)|\$home\b|\$profile\b|~[\\/]))/i,
    why: "PowerShell 递归删除盘符根 / 系统 / 家目录",
  },
  // cmd 风格递归删除盘符 / 系统目录（rd /s、del /s）
  { re: /\b(?:rd|rmdir|del|erase)\b[\s\S]*\/s\b[\s\S]*(?:[A-Za-z]:\\(?:\*|\s|"|'|;|$)|[A-Za-z]:\\(?:windows|users|program ?files)\\?(?:\*|\s|"|'|;|$)|%(?:systemroot|userprofile|windir)%)/i, why: "cmd 递归删除盘符 / 系统目录" },
  // 格式化卷 / 清空磁盘
  { re: /\b(?:format-volume|clear-disk)\b/i, why: "PowerShell 格式化卷 / 清空磁盘" },
  { re: /\bdiskpart\b[\s\S]*\bclean\b/i, why: "diskpart 清空磁盘" },
  { re: /\bformat\s+[A-Za-z]:/i, why: "格式化磁盘分区" },
  // 下载内容直接执行（curl|sh 的 PowerShell 等价：| iex / iex(下载)）
  { re: /\b(?:iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod)\b[\s\S]*\|\s*(?:iex|invoke-expression)\b/i, why: "下载脚本直接执行（| iex）" },
  { re: /\b(?:iex|invoke-expression)\b[\s\S]*(?:downloadstring|downloadfile|net\.webclient|iwr\b|irm\b|invoke-webrequest|invoke-restmethod)/i, why: "下载脚本直接执行（iex）" },
  // 递归删除注册表项
  { re: /(?=[\s\S]*\bremove-item\b)(?=[\s\S]*-r[a-z]*\b)(?=[\s\S]*\bhk(?:lm|cu|cr|cc|u):\\)/i, why: "递归删除注册表项" },
  // 删除启动配置 / fork bomb（无限派生进程）
  { re: /\bbcdedit\b[\s\S]*\/delete/i, why: "删除启动配置（bcdedit /delete）" },
  { re: /while\s*\(\s*(?:\$true|1)\s*\)\s*\{[\s\S]*start-(?:process|job)\b/i, why: "PowerShell fork bomb（无限派生进程）" },
];

/** 默认放行的只读工具（无副作用）。code-intel/LSP 查询类均只读；rename 会改文件不在此列。 */
const READONLY_TOOLS = new Set([
  "read_file", "list_dir", "glob", "grep", "diagnostics", "memory_read", "memory_list",
  "outline", "repo_map", "definition", "references", "hover",
  // 子 agent 控制类（不写文件）：查看/收结果/撤销放行；spawn_subagent 仍需确认（会起进程跑 LLM）
  "subagent_list", "subagent_cancel",
  // 提交验收只是给 /converge 发个「我宣称完成」信号，不写文件 → 放行
  "submit_for_review",
]);

// ── bash 写边界守卫（best-effort，非安全边界）─────────────────────────────────
//
// 自主写代码时，写文件的「工具」（write_file/edit_file/apply_patch）已被 safePath 锁死在
// workdir；但 bash 能 `cd ..`、写绝对路径、重定向到外面 —— execSandboxed 不锁文件系统。
// 这里尽力拦住「往 workdir 外写」的常见手滑：① 重定向(> >>) 目标解析后出界；② 写命令 + 出界
// 绝对路径共现；③ 先 cd 出 workdir 再写。
//
// 诚实边界：shell 解析是对抗性难题，**这不是真墙**。已知拦不住：`curl -o /外面`、`git config
// --global`/`npm -g` 这类隐式写家目录、env 变量/子壳/符号链接混淆的路径。要真 airtight 需 OS 级
// 隔离（容器/VM）。配合「每条 bash 全量落审计」与用户复核作兜底。设 FORGE_ALLOW_WRITE_OUTSIDE=1 关闭。

const WRITE_CMD_RE =
  /\b(cp|mv|dd|ln|install|rsync|tee|touch|mkdir)\b|\b(out-file|set-content|add-content|new-item|copy-item|move-item|rename-item|tee-object|export-csv|export-clixml)\b|\b(copy|move|xcopy|robocopy)\b/i;

/** 把命令里的一个路径 token 解析成绝对路径；null sink / 文件描述符 → null（不算路径）。 */
function resolvePathToken(token: string, workdir: string): string | null {
  let t = token.trim().replace(/^["']|["']$/g, "");
  if (!t || /^&?\d*$/.test(t) || /^&\d+$/.test(t)) return null; // 2>&1 / >&2 之类的 fd
  if (/^(\/dev\/null|nul)$/i.test(t)) return null; // 空洞
  const home = homedir();
  t = t
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/\$HOME\b/g, home)
    .replace(/\$env:USERPROFILE/gi, home)
    .replace(/%USERPROFILE%/gi, home);
  return resolve(workdir, t);
}

/** 绝对路径是否在 workdir 之外（win32 大小写不敏感）。 */
function isOutsideWorkdir(abs: string, workdir: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const a = norm(abs);
  const w = norm(workdir);
  return a !== w && !a.startsWith(w + sep);
}

/** 抽出命令里像「绝对路径」的 token（Windows 盘符 / UNC / POSIX 绝对路径，排除 // 开头的 URL/UNC 误判）。 */
function absPathTokens(cmd: string): string[] {
  const out: string[] = [];
  for (const re of [/[A-Za-z]:[\\/][^\s"'|;&>]*/g, /\\\\[^\s"'|;&>]+/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmd))) out.push(m[0]);
  }
  const posix = /(?:^|[\s=:"'(])(\/(?!\/)[^\s"'|;&>]*)/g; // 前导 / 但非 //（避开 http:// 与 UNC）
  let m: RegExpExecArray | null;
  while ((m = posix.exec(cmd))) out.push(m[1]);
  return out;
}

/** 命令里是否出现「写信号」：写命令关键字，或像 shell 重定向的 `>`/`>>`（best-effort，可能误命中代码里的 `>`）。 */
function hasWriteSignal(cmd: string): boolean {
  return WRITE_CMD_RE.test(cmd) || /(?:^|[^0-9&])>>?/.test(cmd);
}

/**
 * 命令里是否有 `cd`/`pushd` 等把工作目录切到 **workdir 之外** 的目标。
 * 关键：**解析 cd 目标的真实路径再判**，而不是看「是不是绝对盘符路径」这种语法形状——
 * 否则 `cd C:\…\workdir\sub`（进 workdir 子目录，Windows 上最自然的写法）会被误判成逃逸。
 */
function cdEscapesWorkdir(cmd: string, workdir: string): boolean {
  const re = /\b(?:cd|chdir|pushd|set-location|sl)\b\s+("[^"]*"|'[^']*'|[^\s;|&]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const abs = resolvePathToken(m[1], workdir);
    if (abs && isOutsideWorkdir(abs, workdir)) return true; // 任一 cd 目标出界即算逃逸（保守）
  }
  return false;
}

/** detectWriteEscape 的结果：deny=确证越界写（硬拦）；review=拿不准（cd 到外面+有写信号），交语义守卫。 */
export type WriteEscape = { kind: "deny" | "review"; reason: string };

/**
 * 尽力检测「bash 命令是否要往 workdir 外写文件」。命中返回 {kind,reason}，否则 null。
 * 导出供单测（明确记录拦得住 / 交裁决哪些）。
 *
 * ①② 解析出**确实在 workdir 外的具体写目标** → 低误判，直接 deny。
 * ③ 只知道「cd 出了 workdir 且命令含写信号」，但写目标解析不可靠（如 `python -c "<任意代码>"`
 *    里的 `>` 可能只是比较符）→ 交语义守卫（flash）带上下文裁决，而不是凭 cd 语法形状硬拦（旧实现的误判源）。
 */
export function detectWriteEscape(cmd: string, workdir: string): WriteEscape | null {
  // ① 重定向(> >>) 目标解析后出界（含相对 ../ 与绝对路径）
  const redir = /(?:^|[^0-9&])>>?\s*("[^"]*"|'[^']*'|[^\s|;&>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redir.exec(cmd))) {
    const abs = resolvePathToken(m[1], workdir);
    if (abs && isOutsideWorkdir(abs, workdir)) return { kind: "deny", reason: `重定向写入 workdir 外：${m[1].replace(/^["']|["']$/g, "")}` };
  }
  // ② 写命令 + 出界绝对路径 共现
  if (WRITE_CMD_RE.test(cmd)) {
    for (const tok of absPathTokens(cmd)) {
      const abs = resolvePathToken(tok, workdir);
      if (abs && isOutsideWorkdir(abs, workdir)) return { kind: "deny", reason: `写命令的目标在 workdir 外：${tok}` };
    }
  }
  // ③ cd 到 workdir 外 + 命令含写信号 → 拿不准，交语义守卫裁决（不再凭 cd 语法形状硬拦）
  if (cdEscapesWorkdir(cmd, workdir) && hasWriteSignal(cmd)) {
    return { kind: "review", reason: "cd 到 workdir 外且命令含写动作" };
  }
  return null;
}

export interface PermissionPolicyOptions {
  /** 写/执行类工具是否自动放行（--yes / demo 自动模式用）。默认 false → confirm。 */
  autoApprove?: boolean;
  /** workdir：传了才启用 bash 写边界守卫（拦往 workdir 外写）。 */
  workdir?: string;
  /** 关闭 bash 写边界守卫（FORGE_ALLOW_WRITE_OUTSIDE=1）。 */
  allowWriteOutside?: boolean;
}

export class PermissionPolicy {
  private autoApprove: boolean;
  private readonly workdir?: string;
  private readonly allowWriteOutside: boolean;

  constructor(opts: PermissionPolicyOptions = {}) {
    this.autoApprove = opts.autoApprove ?? false;
    this.workdir = opts.workdir;
    this.allowWriteOutside = opts.allowWriteOutside ?? false;
  }

  /** 运行时打开「跳过确认」（/pass-permissions）。硬拒绝黑名单仍然生效。 */
  passAll(): void {
    this.autoApprove = true;
  }

  /** 当前是否处于跳过确认模式。 */
  get bypassing(): boolean {
    return this.autoApprove;
  }

  check(toolName: string, args: unknown): PermissionDecision {
    // 1) bash：先过硬拒绝黑名单，再过写边界守卫
    if (toolName === "bash") {
      const cmd = String((args as { cmd?: unknown } | undefined)?.cmd ?? "");
      for (const { re, why } of HARD_DENY_PATTERNS) {
        if (re.test(cmd)) {
          return { verdict: "deny", reason: `危险命令被拦截：${why}` };
        }
      }
      // 写边界守卫（best-effort）：拦往 workdir 外写文件。deny 即便 autoApprove 也拦（这是边界）。
      // review：确定性层拿不准 → 上层接语义守卫裁决；未接则按 fail-open 放行。
      if (this.workdir && !this.allowWriteOutside) {
        const escape = detectWriteEscape(cmd, this.workdir);
        if (escape?.kind === "deny") return { verdict: "deny", reason: `越界写入被拦截：${escape.reason}（确需可设 FORGE_ALLOW_WRITE_OUTSIDE=1）` };
        if (escape?.kind === "review") return { verdict: "review", reason: escape.reason };
      }
    }

    // 1b) ssh_run：远程命令也过硬拒绝黑名单（连 prod 也别 rm -rf /，即便 autoApprove 也拦），
    //     但**不套本地写边界守卫**——远程写不归本地 workdir 管，否则正常远程运维全被误杀。
    if (toolName === "ssh_run") {
      const cmd = String((args as { command?: unknown } | undefined)?.command ?? "");
      for (const { re, why } of HARD_DENY_PATTERNS) {
        if (re.test(cmd)) return { verdict: "deny", reason: `远程危险命令被拦截：${why}` };
      }
    }

    // 2) 只读工具直接放行
    if (READONLY_TOOLS.has(toolName)) {
      return { verdict: "allow", reason: "只读工具" };
    }

    // 3) 其余（write_file / bash / spawn_subagent 等）需要确认
    if (this.autoApprove) {
      return { verdict: "allow", reason: "自动放行（autoApprove）" };
    }
    return { verdict: "confirm", reason: "写/执行类工具，需用户确认" };
  }
}
