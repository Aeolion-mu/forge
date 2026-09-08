/**
 * 权限策略 —— 最新一代编程 agent（Claude Code / Codex）的安全内核。
 *
 * 思路：工具调用不是“模型说了算”，而是过一道**确定性策略闸门**。
 *  - allowlist：只读工具放行；写/执行类工具需确认。
 *  - 危险命令模式匹配：rm -rf /、fork bomb、curl|sh 等直接拒绝（用户确认也不放行）。
 *  - **写边界不在这里**：2026-09 重构后写边界由内核保证（Linux bwrap 只读根 /
 *    macOS seatbelt deny file-write*，见 sandbox/）——旧的「正则写边界 + flash 语义守卫」
 *    两层已删（best-effort 假墙 + 每次多烧一次 LLM，内核边界取而代之）。
 *    被拒的写在 bash 输出里以 EPERM/Operation not permitted 出现，模型看得见并会反应。
 * 这道闸门挂在 pi-agent-core 的 before_tool 钩子上，模型无法绕过。
 */

// "review" 档已随写守卫一并删除——确定性层不再有「拿不准交语义裁决」的路径。
export type Verdict = "allow" | "confirm" | "deny";

export interface PermissionDecision {
  verdict: Verdict;
  reason: string;
}

/**
 * 即便用户点了确认也绝不放行的命令模式（不可逆 / 自毁 / 远程执行）。
 */
const HARD_DENY_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\*)/i, why: "递归删除根 / 家目录" },
  { re: /\bmkfs(\.\w+)?\b/i, why: "格式化文件系统" },
  { re: /\bdd\s+.*of=\/dev\/(sd|nvme|disk)/i, why: "裸写块设备" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, why: "fork bomb" },
  { re: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: "下载脚本直接管道执行" },
  { re: />\s*\/dev\/(sd|nvme|disk)/i, why: "重定向覆盖块设备" },
  { re: /\bchmod\s+-R\s+777\s+\//i, why: "对根目录放开全部权限" },
];

/** 默认放行的只读工具（无副作用）。code-intel/LSP 查询类均只读；rename 会改文件不在此列。 */
const READONLY_TOOLS = new Set([
  "read_file", "list_dir", "glob", "grep", "diagnostics", "memory_read", "memory_list", "skill_read",
  "outline", "repo_map", "definition", "references", "hover",
  // 子 agent 控制类（不写文件）：查看/收结果/撤销放行；spawn_subagent 仍需确认（会起进程跑 LLM）
  "subagent_list", "subagent_cancel",
  // 提交验收只是给 /converge 发个「我宣称完成」信号，不写文件 → 放行
  "submit_for_review",
]);

export interface PermissionPolicyOptions {
  /** 写/执行类工具是否自动放行（--yes / demo 自动模式用）。默认 false → confirm。 */
  autoApprove?: boolean;
}

export class PermissionPolicy {
  private autoApprove: boolean;

  constructor(opts: PermissionPolicyOptions = {}) {
    this.autoApprove = opts.autoApprove ?? false;
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
    // 1) bash：过硬拒绝黑名单（写边界在沙箱内核层，不在这里——见文件头注释）
    if (toolName === "bash") {
      const cmd = String((args as { cmd?: unknown } | undefined)?.cmd ?? "");
      for (const { re, why } of HARD_DENY_PATTERNS) {
        if (re.test(cmd)) {
          return { verdict: "deny", reason: `危险命令被拦截：${why}` };
        }
      }
    }

    // 1b) ssh_run：远程命令也过硬拒绝黑名单（连 prod 也别 rm -rf /，即便 autoApprove 也拦）
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
