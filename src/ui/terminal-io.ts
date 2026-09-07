import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

/**
 * 终端生命周期 + 鼠标 —— Claude Code 式全屏 TUI 的底座。
 *
 * · TerminalIo.enter/restore：备用屏（1049，同 vim/htop）+ 鼠标上报（1000 点击 + 1006 SGR 坐标）
 *   + 藏光标（25l）。restore 幂等，挂 process exit/SIGINT/SIGTERM/SIGHUP——崩溃也要把终端
 *   还回去（否则用户的终端卡在备用屏 + 鼠标捕获态，原生选区失灵）。
 * · createMouseStdin：**Ink 的 parse-keypress 零鼠标处理**（SGR 序列会漏成乱码输入），
 *   所以给 render() 喂一个过滤代理：鼠标序列剥出成 MouseEvent，其余字节原样透传。
 *   tmux 无 mouse 时滚轮被终端转成 ↑/↓ 方向键——天然走键盘流，这里不用管。
 * · v1 只开 1000+1006（点击 + 滚轮）；拖拽选择要 1002，v2 再开。
 * · 防闪烁不用自己做：Ink 7 内置同步输出（ESC[?2026h/l，TTY 自动启用）。
 */

export interface MouseEvent {
  /** press=按下（v1 的动作触发点）；wheel=滚轮；release=松开（v1 忽略）。 */
  kind: "press" | "release" | "wheel";
  /** SGR 编码原始按键号：0=左键 1=中键 2=右键；滚轮 64=上 65=下。 */
  button: number;
  /** 1-based 列。 */
  col: number;
  /** 1-based 行。 */
  row: number;
  mods: { shift: boolean; alt: boolean; ctrl: boolean };
}

const ESC = "\x1b";

/** SGR 鼠标序列：`ESC[<b;x;yM`（按下/滚轮）或 `…m`（松开）。b = 按键-1 + 修饰位(4/8/16)。 */
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

/** 解析一条完整 SGR 鼠标序列；不是鼠标序列返回 null。纯函数，导出供单测。 */
export function parseMouseSequence(s: string): MouseEvent | null {
  const m = SGR_MOUSE.exec(s);
  if (!m) return null;
  const b = Number(m[1]);
  const base = b & 3; // 低 2 位 = 按键（0=左 1=中 2=右）
  return {
    kind: m[4] === "M" ? (b >= 64 ? "wheel" : "press") : "release",
    button: b >= 64 ? b : base,
    col: Number(m[2]),
    row: Number(m[3]),
    mods: { shift: (b & 4) !== 0, alt: (b & 8) !== 0, ctrl: (b & 16) !== 0 },
  };
}

/** 其他 CSI 序列（方向键/功能键/括号粘贴…）：ESC [ 参数 终止符，整段透传给 Ink 自己解析。 */
const CSI = /^\x1b\[[0-9;?<>=]*[ -/]*[@-~]/;
/** ESC + 单字符（Alt 组合键等）。 */
const ESC_CHAR = /^\x1b./;

/** splitMouseSequences 的结果：透传 / 剥出的事件 / 断裂序列的余料（拼到下一片前面）。 */
export interface MouseSplit {
  passthrough: string;
  events: MouseEvent[];
  leftover: string;
}

/**
 * 从一段字节流里剥鼠标序列。导出供单测；生产入口是 createMouseStdin。
 * 原则：**只剥确定认识的**（SGR 鼠标）；其余 ESC 序列按 CSI/ESC+字符整段透传——
 * 认不全宁可透传（Ink 会忽略未知键）也不能吞键盘事件。
 * 孤零零的 ESC（可能断在 chunk 边界）留作 leftover 等下一片。
 */
export function splitMouseSequences(buf: string): MouseSplit {
  let s = buf;
  const events: MouseEvent[] = [];
  let passthrough = "";
  while (s.length > 0) {
    const esc = s.indexOf(ESC);
    if (esc === -1) {
      passthrough += s;
      return { passthrough, events, leftover: "" };
    }
    if (esc > 0) {
      passthrough += s.slice(0, esc);
      s = s.slice(esc);
    }
    const m = SGR_MOUSE.exec(s);
    if (m) {
      const ev = parseMouseSequence(m[0]);
      if (ev) events.push(ev);
      s = s.slice(m[0].length);
      continue;
    }
    const csi = CSI.exec(s);
    if (csi) {
      passthrough += csi[0];
      s = s.slice(csi[0].length);
      continue;
    }
    // ESC[ 开头但没等到终止字节（序列断在 chunk 边界，鼠标/方向键/粘贴都可能）→ leftover
    if (s.startsWith(`${ESC}[`)) {
      return { passthrough, events, leftover: s };
    }
    const escChar = ESC_CHAR.exec(s);
    if (escChar) {
      passthrough += escChar[0];
      s = s.slice(escChar[0].length);
      continue;
    }
    // 只剩孤零零一个 ESC：同样可能断在 chunk 边界，留作 leftover
    return { passthrough, events, leftover: s };
  }
  return { passthrough, events, leftover: "" };
}

/** 过滤代理：Ink 看到的 stdin（无鼠标噪声）；鼠标事件经 onMouseEvent 送出。 */
export interface MouseStdin extends Readable {
  /** 鼠标事件订阅；返回退订函数。 */
  onMouseEvent(listener: (e: MouseEvent) => void): () => void;
}

/**
 * 把透传文本按控制字符（\r \t）切开：终端/PTY 可能把连续击打合并成一个 chunk
 * （实测 "e" + 回车合并为 "e\r"），而 Ink 的解析器不拆文本段里的 \r —— 整段会被
 * 当文本插入、回车失灵。切开后 \r 独立成键。纯可打印段保持整体（括号粘贴的内容
 * 含 \n 时必须作为一个事件进「插入」路径，不能逐字符）。
 */
export function splitControls(s: string): string[] {
  if (!s) return [];
  if (!/[\r\t]/.test(s)) return [s];
  const out: string[] = [];
  let buf = "";
  for (const ch of s) {
    if (ch === "\r" || ch === "\t") {
      if (buf) out.push(buf);
      out.push(ch);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 造一个给 Ink 的 stdin 代理：真实 stdin 的 data 剥掉鼠标序列后入队，鼠标走 onMouseEvent。
 *
 * 关键：**Ink 7 不监听 'data'，而是 'readable' + read() 拉取**（App.js 的
 * attachReadableListener/handleReadable）——所以代理必须实现流的可读语义：
 * 入队后 emit('readable')，read() 出队；addListener('readable') 时若已有积压数据，
 * 下一拍补发 readable（覆盖「数据先到、Ink 后挂监听」的窗口）。
 */
export function createMouseStdin(real: Readable): MouseStdin {
  const bus = new EventEmitter();
  const queue: string[] = [];
  const proxy = new EventEmitter() as unknown as MouseStdin & EventEmitter;
  let carry = "";

  const anyProxy = proxy as unknown as Record<string, unknown>;
  anyProxy.read = (_size?: number) => {
    const v = queue.shift() ?? null;
    return v;
  };
  const origAddListener = proxy.addListener.bind(proxy);
  const wrappedAddListener = (event: string | symbol, listener: (...a: unknown[]) => void, ...rest: unknown[]) => {
    origAddListener(event, listener as never, ...(rest as []));
    if (event === "readable" && queue.length > 0) {
      process.nextTick(() => proxy.emit("readable"));
    }
    return proxy;
  };
  anyProxy.addListener = wrappedAddListener;
  anyProxy.on = wrappedAddListener;

  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const { passthrough, events, leftover } = splitMouseSequences(carry + text);
    carry = leftover;
    for (const e of events) bus.emit("mouse", e);
    for (const piece of splitControls(passthrough)) {
      queue.push(piece);
    }
    if (passthrough) proxy.emit("readable");
  };
  real.on("data", onData);
  real.resume();

  // 退出时解除：对真实 stdin 的 data 监听会保持事件循环存活（进程退不干净）。
  anyProxy.detach = () => {
    real.removeListener("data", onData);
    try {
      real.pause();
    } catch {
      /* 非流实现忽略 */
    }
  };

  proxy.onMouseEvent = (listener: (e: MouseEvent) => void) => {
    bus.on("mouse", listener);
    return () => bus.off("mouse", listener);
  };
  const realAny = real as unknown as Record<string, unknown>;
  for (const method of ["setRawMode", "setEncoding", "ref", "unref", "pause", "destroy"]) {
    if (typeof realAny[method] === "function") {
      anyProxy[method] = (...args: unknown[]) => (realAny[method] as (...a: unknown[]) => unknown)(...args);
    }
  }
  Object.defineProperties(proxy, {
    isTTY: { get: () => (real as { isTTY?: boolean }).isTTY },
    isRaw: { get: () => (real as { isRaw?: boolean }).isRaw },
    readable: { get: () => real.readable || queue.length > 0 },
  });
  return proxy;
}

/** 终端状态进出。enter 与 restore 幂等；信号钩子防崩溃留脏终端。 */
export class TerminalIo {
  private active = false;
  private readonly out: NodeJS.WriteStream;
  private readonly handlers: [NodeJS.Signals | "exit", () => void][] = [];

  constructor(out: NodeJS.WriteStream = process.stdout) {
    this.out = out;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** mouse=false 时不开鼠标上报（FORGE_NO_MOUSE=1：保留终端原生选择/复制）。 */
  enter(opts: { mouse?: boolean } = {}): void {
    if (this.active) return;
    this.active = true;
    // 顺序：先切备用屏（保存光标），再开鼠标/藏光标
    const mouse = opts.mouse !== false ? `${ESC}[?1000h${ESC}[?1006h` : "";
    this.out.write(`${ESC}[?1049h${mouse}${ESC}[?25l`);
    const onSignal = () => {
      this.restore();
      process.exit(0);
    };
    const onExit = () => this.restore();
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      this.handlers.push([sig, onSignal]);
      process.on(sig, onSignal);
    }
    this.handlers.push(["exit", onExit]);
    process.on("exit", onExit);
  }

  /** 幂等还原：出备用屏、关鼠标、显示光标。 */
  restore(): void {
    if (!this.active) return;
    this.active = false;
    for (const [name, h] of this.handlers) {
      process.removeListener(name, h);
    }
    this.handlers.length = 0;
    this.out.write(`${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
  }
}
