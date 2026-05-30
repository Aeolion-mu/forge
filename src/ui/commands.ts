/**
 * 斜杠命令的纯逻辑（与 Ink 渲染解耦，便于单测）：清单 + 模糊匹配 + 提交解析。
 */

export interface SlashCommand {
  name: string;
  desc: string;
}

/** 斜杠命令清单（供 `/` 自动补全菜单）。 */
export const COMMANDS: SlashCommand[] = [
  { name: "/converge", desc: "Work until a goal holds (Convergent verifies)" },
  { name: "/compact", desc: "Compact context (9-section summary)" },
  { name: "/skills", desc: "List loaded skills" },
  { name: "/stats", desc: "Show session metrics" },
  { name: "/pass-permissions", desc: "Bypass write/exec confirms (dangerous cmds still blocked)" },
  { name: "/exit", desc: "Exit Forge" },
];

/** 输入以 / 开头时，按去掉斜杠后的子串模糊匹配命令；否则返回空（非菜单态）。 */
export function matchCommands(input: string, commands: SlashCommand[] = COMMANDS): SlashCommand[] {
  if (!input.startsWith("/")) return [];
  const q = input.slice(1).toLowerCase();
  return commands.filter((c) => c.name.slice(1).toLowerCase().includes(q));
}

/** 菜单是否应展开：有匹配且尚未精确补全到首项（精确则收起，避免冗余）。 */
export function menuShouldOpen(input: string, commands: SlashCommand[] = COMMANDS): boolean {
  const m = matchCommands(input, commands);
  return m.length > 0 && input !== m[0]?.name;
}

/**
 * 提交解析：若输入是「部分斜杠命令」（非精确匹配但有候选），用当前选中项替换；
 * 否则原样返回 trim 后的输入。这样 Enter 一个 "/comp" 会执行选中的 /compact，
 * 而不是把 "/comp" 当聊天发出去。
 */
export function resolveSubmitted(input: string, selIdx: number, commands: SlashCommand[] = COMMANDS): string {
  const line = input.trim();
  if (line.startsWith("/") && !commands.some((c) => c.name === line)) {
    const m = matchCommands(line, commands);
    if (m.length) return m[Math.min(Math.max(selIdx, 0), m.length - 1)].name;
  }
  return line;
}
