/** Ctrl+C 行为决策（与 Ink 解耦，便于单测）。 */

export type CtrlCAction =
  | "deny" // 确认提示中 → 拒绝该工具
  | "abort" // agent 运行中（思考/工具/压缩）→ 中止，回到输入
  | "clear" // 输入框有内容 → 清空
  | "exit" // 空输入且刚按过一次 → 退出 Forge
  | "arm"; // 空输入首次 → 武装（提示再按一次退出）

/**
 * 决定一次 Ctrl+C 该做什么。优先级：确认 > 运行中 > 有输入 > 双击退出。
 * 这样运行中按 Ctrl+C 是「停止操作回到输入」、输入框里是「清空」，
 * 只有空输入连按两次才真正退出。
 */
export function ctrlCAction(s: {
  confirm: boolean;
  running: boolean;
  hasInput: boolean;
  armedRecently: boolean;
}): CtrlCAction {
  if (s.confirm) return "deny";
  if (s.running) return "abort";
  if (s.hasInput) return "clear";
  return s.armedRecently ? "exit" : "arm";
}
