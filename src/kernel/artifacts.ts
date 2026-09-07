import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 工具输出的「上下文友好截断」 —— append-only 时代的输入侧精打细算。
 *
 * 背景：DeepSeek 是纯前缀磁盘缓存、无 Cache Editing API，单 session 内严格
 * append-only（进了上下文就不再改，否则破缓存）。所以唯一能防「一条日志/大文件
 * 把上下文撑爆」的时机，是**在内容进入上下文之前就截断**。截断后内容是稳定前缀，
 * 不违反 append-only。
 *
 * 策略：超过 maxChars 就保留首尾、中间用一行指针省略。
 *   · save=true（bash/grep 这类临时输出）：完整内容落 .forge/artifacts/<hash>.txt，
 *     指针告诉模型用 read_file 取回。
 *   · save=false（read_file，原文件本身就是来源）：只截断 + 提示用 offset/limit 续读。
 */

/** 单条工具结果默认字符上限（~2000 token，4 char/token 估算）。 */
export const MAX_OUTPUT_CHARS = 8000;
const HEAD_CHARS = 4000;
const TAIL_CHARS = 3000;

export function artifactsDir(workdir: string): string {
  return resolve(workdir, ".forge", "artifacts");
}

/** 把完整文本落盘到 .forge/artifacts/<hash>.txt，返回相对 workdir 的 posix 路径。 */
export function saveArtifact(workdir: string, text: string): string {
  const dir = artifactsDir(workdir);
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 12);
  const rel = `.forge/artifacts/${hash}.txt`;
  writeFileSync(resolve(dir, `${hash}.txt`), text, "utf8");
  return rel;
}

export interface TruncateResult {
  /** 截断后（或原样）的文本。 */
  text: string;
  /** 是否发生了截断。 */
  truncated: boolean;
  /** save=true 且发生截断时，完整内容的 artifact 相对路径。 */
  artifact?: string;
}

export interface TruncateOptions {
  workdir: string;
  /** true：临时输出，完整内容落 artifacts；false：原文件即来源，只提示 offset 续读。 */
  save: boolean;
  /** 字符上限，默认 MAX_OUTPUT_CHARS。 */
  maxChars?: number;
  /** save=false 时指针里的续读提示。 */
  hint?: string;
}

/** 超 maxChars 则保留首尾、中间插一行指针；否则原样返回。 */
export function truncateForContext(text: string, opts: TruncateOptions): TruncateResult {
  const max = opts.maxChars ?? MAX_OUTPUT_CHARS;
  if (text.length <= max) return { text, truncated: false };

  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const lines = text.split("\n").length;
  let pointer: string;
  let artifact: string | undefined;
  if (opts.save) {
    artifact = saveArtifact(opts.workdir, text);
    pointer = `…[输出过长已截断：完整 ${lines} 行 / ${text.length} 字符已存盘。若上面首尾不足以判断，用 read_file 按行精准读取 ${artifact}（offset/limit 指定行段，勿一次全读以免再次截断）]…`;
  } else {
    pointer = `…[已截断：完整 ${lines} 行 / ${text.length} 字符，${opts.hint ?? "用 offset/limit 读取指定范围"}]…`;
  }
  return { text: `${head}\n${pointer}\n${tail}`, truncated: true, artifact };
}
