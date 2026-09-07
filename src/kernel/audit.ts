import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 审计日志 —— 把每一次「权限决策 / 工具调用 / 结果」落成结构化 JSONL。
 * 既是合规留痕，也是事后复盘 agent 行为的 trace。
 */

export type AuditKind = "permission" | "tool_start" | "tool_end" | "prompt";

export interface AuditRecord {
  ts: string;
  kind: AuditKind;
  tool?: string;
  args?: unknown;
  verdict?: string;
  reason?: string;
  durationMs?: number;
  isError?: boolean;
  preview?: string;
}

function clip(s: string, n = 300): string {
  return s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s;
}

/** 内存里保留的最近记录条数（环形缓冲）。完整历史在磁盘 JSONL，内存只供 all() 速查近况。 */
const MAX_RECORDS = 1000;

export class AuditLog {
  private readonly records: AuditRecord[] = [];

  constructor(private readonly path: string) {
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      /* 目录已存在即可 */
    }
  }

  write(rec: Omit<AuditRecord, "ts">): void {
    const full: AuditRecord = { ts: new Date().toISOString(), ...rec };
    // 截断仅用于控制日志体积：存「截断后的 JSON 字符串」，绝不能再 JSON.parse 它
    // —— 砍断的串会抛 "Unterminated string in JSON"，写大文件时正中此坑。
    if (full.args !== undefined) full.args = clip(JSON.stringify(full.args));
    if (full.preview) full.preview = clip(full.preview);
    this.records.push(full);
    if (this.records.length > MAX_RECORDS) this.records.shift(); // 环形缓冲：内存不随会话无界增长
    try {
      appendFileSync(this.path, `${JSON.stringify(full)}\n`);
    } catch {
      /* 审计写盘失败不应中断 agent */
    }
  }

  all(): readonly AuditRecord[] {
    return this.records;
  }
}
