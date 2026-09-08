/**
 * CLI 参数的纯解析（可单测）。
 *
 * 位置参数 = 一次性任务 prompt；`--confirm` 关掉默认放行；`--resume <id>` 的 id 值
 * 不进 prompt（否则会被当任务文本）。曾因裸写 `i !== resumeIdx + 1`（无 --resume 时
 * resumeIdx=-1 → -1+1=0）把**首个位置参数永远丢掉**——单参数一次性任务静默进 REPL。
 */
export interface CliArgs {
  /** false = 逐次确认模式（--confirm）。 */
  autoApprove: boolean;
  /** --resume 的 id 值；未给为 null（调用方可再走 FORGE_RESUME 环境变量）。 */
  resumeId: string | null;
  /** 一次性任务文本（空串 = 进交互式 TUI）。 */
  prompt: string;
}

export function parseCliArgs(args: string[]): CliArgs {
  const resumeIdx = args.indexOf("--resume");
  const resumeValue = resumeIdx >= 0 ? args[resumeIdx + 1] : undefined;
  const promptSkip = new Set(resumeValue ? [resumeValue] : []);
  const prompt = args
    .filter((a, i) => !a.startsWith("-") && !(resumeIdx >= 0 && i === resumeIdx + 1) && !promptSkip.has(a))
    .join(" ")
    .trim();
  return { autoApprove: !args.includes("--confirm"), resumeId: resumeValue ?? null, prompt };
}
