import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * 多文件记忆 —— 仿 Claude Code / 本助手的记忆架构：
 *   · MEMORY.md 是**索引**，常驻注入进 system prompt（每条只占一行）
 *   · 其余 <name>.md 是**具体记忆**，按需用 memory_read 召回
 *   · 双作用域：项目（<workdir>/.forge/memory）与全局（~/.forge/memory）
 */

export type MemoryScope = "project" | "global";

/** 文件名收口：去掉路径分隔符与点（防穿越/扩展名），保留中文与字母数字。 */
function sanitize(name: string): string {
  return (
    name
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[\/\\:*?"<>|.]+/g, "-")
      .replace(/^-+|-+$/g, "") || "memory"
  );
}

export class Memory {
  readonly projectDir: string;
  readonly globalDir: string;

  constructor(workdir: string) {
    this.projectDir = resolve(workdir, ".forge", "memory");
    this.globalDir = resolve(homedir(), ".forge", "memory");
  }

  private dir(scope: MemoryScope): string {
    return scope === "global" ? this.globalDir : this.projectDir;
  }

  private indexPath(scope: MemoryScope): string {
    return resolve(this.dir(scope), "MEMORY.md");
  }

  private readIndex(scope: MemoryScope): string {
    const p = this.indexPath(scope);
    return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
  }

  /** 注入 system prompt 的索引块（两作用域合并）；空则返回 ""。 */
  indexBlock(): string {
    const g = this.readIndex("global");
    const p = this.readIndex("project");
    if (!g && !p) return "";
    const out = ["【长期记忆索引】相关时用 memory_read <name> 召回。memory_write 仅用于会改变未来决策的持久事实（架构/命令/用户偏好/反复纠正），勿记一次性结果或对话内临时信息。"];
    if (g) out.push(`〔全局〕\n${g}`);
    if (p) out.push(`〔本项目〕\n${p}`);
    return out.join("\n\n");
  }

  /** 列出两作用域索引（供 memory_list / TUI）。 */
  list(): string {
    const g = this.readIndex("global");
    const p = this.readIndex("project");
    return [g ? `〔全局〕\n${g}` : "", p ? `〔本项目〕\n${p}` : ""].filter(Boolean).join("\n\n") || "(暂无记忆)";
  }

  /** 读具体记忆：先项目后全局。 */
  read(name: string): string {
    const file = `${sanitize(name)}.md`;
    for (const scope of ["project", "global"] as MemoryScope[]) {
      const p = resolve(this.dir(scope), file);
      if (existsSync(p)) return readFileSync(p, "utf8");
    }
    throw new Error(`未找到记忆：${name}`);
  }

  /** 写/更新一条记忆：写 <name>.md（含 frontmatter）+ 更新该作用域索引。 */
  write(opts: { name: string; scope: MemoryScope; description: string; type?: string; content: string }): string {
    const name = sanitize(opts.name);
    const dir = this.dir(opts.scope);
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${name}.md`);
    const body = [
      "---",
      `name: ${name}`,
      `description: ${opts.description}`,
      "metadata:",
      `  type: ${opts.type ?? "project"}`,
      "---",
      "",
      opts.content.trim(),
      "",
    ].join("\n");
    writeFileSync(file, body, "utf8");
    this.updateIndex(opts.scope, name, opts.description);
    return file;
  }

  private updateIndex(scope: MemoryScope, name: string, description: string): void {
    const p = this.indexPath(scope);
    const line = `- ${name} — ${description}`;
    let lines = existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()) : [];
    lines = lines.filter((l) => !l.startsWith(`- ${name} —`)); // 同名则替换
    lines.push(line);
    writeFileSync(p, `${lines.join("\n")}\n`, "utf8");
  }
}
