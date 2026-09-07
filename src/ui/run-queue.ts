/**
 * 串行 run 队列（纯逻辑，与 Ink 解耦，可独立单测）。
 *
 * 用户输入与「后台子 agent 完成喂回」都走它：**单线执行、FIFO、互不冲突、永不并发**。
 * 一次只跑一个 run；跑的过程中入队的会排队，前一个结束后自动 drain 下一个。
 * 单个 run 抛错不会卡死队列（交给 onError 后继续 drain）。
 */

export interface RunQueue {
  /** 入队一个新 run（立即返回，不阻塞）。后台子 agent 完成喂回走它。 */
  enqueue: (text: string) => void;
  /**
   * 提交一条用户输入：**忙**（已有 run 在跑）时插话到当前 run（steer，当前 turn 工具执行完、
   * 下一次 LLM 调用前注入，不打断当前步）；**闲**时作为新 run 入队。返回实际走向供 UI 回显区分。
   * 未配置 steer 时退化为 enqueue（始终排队）。
   */
  submit: (text: string) => "steered" | "queued";
  /** 当前是否有 run 在执行。 */
  readonly running: boolean;
  /** 当前排队中（未开始）的数量。 */
  readonly pending: number;
}

/**
 * @param run     实际执行一次 run 的异步函数（生产传 agent.run）。
 * @param onError run 抛出非中止错误时回调（生产用来 push 错误块）。
 * @param steer   忙时插话的回调（生产传 agent.steer）。不传则 submit 退化为排队。
 */
export function createRunQueue(
  run: (text: string) => Promise<void>,
  onError?: (err: unknown) => void,
  steer?: (text: string) => void,
): RunQueue {
  const pending: string[] = [];
  let running = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    const next = pending.shift();
    if (next === undefined) return;
    running = true;
    try {
      await run(next);
    } catch (err) {
      onError?.(err);
    } finally {
      running = false;
      void drain();
    }
  };

  // enqueue 同步把 running 置真（drain 的同步段在首个 await 前完成），故 submit 里读 running 可靠。
  const enqueue = (text: string) => {
    pending.push(text);
    void drain();
  };

  return {
    enqueue,
    submit(text: string) {
      if (running && steer) {
        steer(text);
        return "steered";
      }
      enqueue(text);
      return "queued";
    },
    get running() {
      return running;
    },
    get pending() {
      return pending.length;
    },
  };
}
