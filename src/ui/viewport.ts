/**
 * 虚拟视口的纯滚动数学（不碰 React / 终端，可单测）。
 *
 * 模型：offset = 「视口底边之上有多少行没显示」（0 = 钉在底部跟随最新输出）。
 * 用户上滚 → offset 增大 → 自动跟随暂停，新输出只计数（newCount）；
 * 滚回底部 / Jump 按钮把 offset 归零恢复跟随。
 */
export interface ViewState {
  /** 总行数（block 展开后）。 */
  total: number;
  /** 视口可用行数（终端高 − 底部 chrome）。 */
  height: number;
  /** 底边之上的隐藏行数；0 = 跟随底部。 */
  offset: number;
}

export interface Visible {
  /** lines 的起始下标（含）。 */
  start: number;
  /** 实际可显示行数（total 不足 height 时取 total）。 */
  count: number;
  /** 钳制后的 offset（resize 后总行数变化时修正）。 */
  clampedOffset: number;
}

/** 计算可见窗口 + 钳制 offset（offset 至多 total，且总行数 ≤ height 时必为 0）。 */
export function visible(v: ViewState): Visible {
  const maxOffset = Math.max(0, v.total - Math.min(v.height, v.total));
  const offset = Math.min(v.offset, maxOffset);
  const count = Math.min(v.height, Math.max(0, v.total - offset));
  const start = Math.max(0, v.total - offset - count);
  return { start, count, clampedOffset: offset };
}

/** 滚动增量（正=向上看历史）。返回钳制后的新 offset。 */
export function scrollBy(v: ViewState, delta: number): number {
  const { clampedOffset } = visible(v);
  const maxOffset = Math.max(0, v.total - Math.min(v.height, v.total));
  return Math.max(0, Math.min(maxOffset, clampedOffset + delta));
}

/**
 * 追随暂停期间新到了几行（Jump 按钮的「N new」）。
 * 语义：newArrived = 本次新增行数；offset 不为 0 时累加，归零（跟随）时清零。
 */
export function accumulateNew(prevNew: number, offset: number, newArrived: number): number {
  return offset > 0 ? prevNew + newArrived : 0;
}
