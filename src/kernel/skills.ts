import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Skills 管理内核（rev3：全量注册 + agent 按需翻阅）。
 *
 * 演进：rev2 是「targets 白名单预选 + 常驻索引块」（物理三态 × manifest 组合）；
 * 实测发现白名单把发现性卡死在配置侧，遂按用户决策拆掉开关——
 *   · create() 时**全量注册**：common → vendors/* → delta/* → compat → global → project
 *     （后读覆盖先读；delta 在 vendor 之后 = 厂商特化覆盖家底同名；用户层永远最高）；
 *   · system prompt 只留**一行摘要**（skill_list 查清单、skill_read 读全文）；
 *   · 发现性交给 agent：skill_list(partition/filter) 是工具调用，结果 append-only 合规。
 *
 * 物理布局（不变）：
 *   skills/common/（自建通用层）· skills/delta/<vendor>/（自建差异层）
 *   skills/vendors/<name>/（上游快照 + skills.lock.json，npm run skills:fetch 更新）
 *   用户层：~/.forge/skills（全局）· <workdir>/.forge/skills（项目）· 兼容目录（.claude/.agents）
 *
 * 为什么不用库的 loadSkills：它只保留 name/description/disable-model-invocation，丢掉完整
 * frontmatter——而格式识别（claude-code / codex）、invocation 归一、meta 透传都需要原始字段。
 */

export type SkillFormat = "agentskills" | "claude-code" | "codex" | "codex-prompt-legacy";
export type SkillSource = "builtin" | "global" | "project" | "compat";
/** 物理归属层：内置三态（common/delta/vendor）+ 用户层（user/compat）。 */
export type SkillLayer = "common" | "delta" | "vendor" | "user" | "compat";

/** 四态覆盖（对齐 Claude skillOverrides 语义）。 */
export type SkillOverrideState = "on" | "off" | "user-only" | "name-only";

export interface SkillRecord {
  /** 规范 name；同名冲突按层优先级整条替换。 */
  name: string;
  description: string;
  /** SKILL.md 绝对路径（skill_read 白名单锚点；也是物理去重身份）。 */
  filePath: string;
  /** skill 根目录（资源相对路径的基）。 */
  dir: string;
  source: SkillSource;
  layer: SkillLayer;
  /** 溯源标签（vendor:geak / delta:hygon / common / user）。 */
  origin: string;
  format: SkillFormat;
  invocation: { model: boolean; user: boolean };
  /** 索引渲染降级为「只列名」（overrides 四态之 name-only）。 */
  nameOnly?: boolean;
  /** 标准可选字段 + 两家扩展字段原样保留（license/compatibility/metadata/allowed-tools/...）。 */
  meta: Record<string, unknown>;
}

export interface SkillsDiagnostic {
  type: "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// frontmatter 解析与格式识别
// ---------------------------------------------------------------------------

/** Claude Code 专有 frontmatter 字段（开放标准之外）——出现即判 claude-code 格式。 */
const CLAUDE_ONLY_FIELDS = new Set([
  "disable-model-invocation", "user-invocable", "when-to-use", "when_to_use",
  "disallowed-tools", "context", "agent", "background", "argument-hint", "shell",
]);

export interface ParsedSkillFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** 剥离 `---` frontmatter（无则 frontmatter 为空对象）；格式坏时抛错由调用方计诊断。 */
export function splitFrontmatter(text: string): ParsedSkillFile {
  if (!text.startsWith("---")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 3);
  const endIdx = end < 0 ? -1 : end;
  if (endIdx < 0) return { frontmatter: {}, body: text };
  const fmText = text.slice(3, endIdx).trim();
  const body = text.slice(text.indexOf("\n", endIdx + 1) + 1);
  const frontmatter = (parseYaml(fmText) ?? {}) as Record<string, unknown>;
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new Error("frontmatter 应是 name/description 等键值映射");
  }
  return { frontmatter, body };
}

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 64;
}

/** 读 agents/openai.yaml 的 policy.allow_implicit_invocation（Codex 侧的模型调用开关）。 */
function codexImplicitInvocation(skillDir: string): boolean | undefined {
  const p = join(skillDir, "agents", "openai.yaml");
  if (!existsSync(p)) return undefined;
  try {
    const doc = parseYaml(readFileSync(p, "utf8")) as Record<string, unknown> | null;
    const policy = doc && typeof doc === "object" ? (doc.policy as Record<string, unknown> | undefined) : undefined;
    if (policy && typeof policy.allow_implicit_invocation === "boolean") return policy.allow_implicit_invocation;
    return undefined;
  } catch {
    return undefined;
  }
}

function detectFormat(frontmatter: Record<string, unknown>, hasOpenaiYaml: boolean): SkillFormat {
  if (hasOpenaiYaml) return "codex";
  for (const k of Object.keys(frontmatter)) if (CLAUDE_ONLY_FIELDS.has(k)) return "claude-code";
  return "agentskills";
}

// ---------------------------------------------------------------------------
// 目录扫描
// ---------------------------------------------------------------------------

export interface ScanOptions {
  source: SkillSource;
  layer: SkillLayer;
  /** 溯源标签（vendor/delta 目录扫描时填）。 */
  origin: string;
  /** legacy prompts 目录：无 frontmatter 的裸 .md 也收为 codex-prompt-legacy。 */
  legacy?: boolean;
}

export interface ScanResult {
  records: SkillRecord[];
  diagnostics: SkillsDiagnostic[];
}

const SKIP_DIRS = new Set(["node_modules"]);
/** vendor 快照里的标准 agent 目录（`.claude/skills`、`.agents/skills`）——点开头但必须下钻。 */
const ALLOWED_HIDDEN_DIRS = new Set([".claude", ".agents"]);

/**
 * 扫描一个 skills 根目录（集合目录）。规则：
 *  · 目录树里任意层出现 <dir>/SKILL.md 即一个 skill（支持 vendor 仓的任意嵌套），扫到即不再下钻；
 *  · 各目录的根级 <name>.md 带 frontmatter+description → flatten 形态（dir 取所在目录）；
 *  · 裸 .md（无 frontmatter）仅 legacy 目录收为 codex-prompt-legacy，否则跳过；
 *  · 跳过点开头的条目与 node_modules。
 * 目录不存在 → 空结果。
 */
export function scanSkillsRoot(root: string, opts: ScanOptions): ScanResult {
  const diagnostics: SkillsDiagnostic[] = [];
  if (!existsSync(root)) return { records: [], diagnostics };
  const stat = statSync(root);
  if (!stat.isDirectory()) {
    diagnostics.push({ type: "warning", code: "not_a_directory", message: `skills 根不是目录：${root}`, path: root });
    return { records: [], diagnostics };
  }
  const records: SkillRecord[] = [];
  // 根自身即单个 skill（直接含 SKILL.md）——扫描根指到具体 skill 目录时也成立。
  if (existsSync(join(root, "SKILL.md"))) {
    const rec = loadSkillDir(root, opts, diagnostics);
    if (rec) records.push(rec);
    return { records, diagnostics };
  }
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if ((entry.name.startsWith(".") && !ALLOWED_HIDDEN_DIRS.has(entry.name)) || SKIP_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(join(full, "SKILL.md"))) {
        const rec = loadSkillDir(full, opts, diagnostics);
        if (rec) records.push(rec);
      } else {
        const nested = scanSkillsRoot(full, opts);
        records.push(...nested.records);
        diagnostics.push(...nested.diagnostics);
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const rec = loadFlatMarkdown(full, opts, diagnostics);
      if (rec) records.push(rec);
    }
  }
  return { records, diagnostics };
}

/** <dir>/SKILL.md → SkillRecord（格式识别 + invocation 归一）。 */
function loadSkillDir(dir: string, opts: ScanOptions, diagnostics: SkillsDiagnostic[]): SkillRecord | null {
  const filePath = join(dir, "SKILL.md");
  let parsed: ParsedSkillFile;
  try {
    parsed = splitFrontmatter(readFileSync(filePath, "utf8"));
  } catch (e) {
    diagnostics.push({ type: "warning", code: "parse_failed", message: (e as Error).message, path: filePath });
    return null;
  }
  const fm = parsed.frontmatter;
  let description = typeof fm.description === "string" ? fm.description.trim() : "";
  const dirname = dir.split("/").pop()!;
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : dirname;
  if (!description) {
    // vendor 快照兼容（如 tensormux 完全没有 frontmatter）：SKILL.md 是**声明式** skill 文件，
    // 不像裸 .md 直接跳过——从正文降级提取 description（## Purpose / ## Use this when / 首段），
    // 计 warning 让不规范可见，但不丢内容（「vendor 原样快照不改一行」原则：适配发生在 loader）。
    const fallback = fallbackDescription(parsed.body);
    if (!fallback) {
      diagnostics.push({ type: "warning", code: "invalid_metadata", message: "缺少必填 description（正文也无可降级提取的首段）", path: filePath });
      return null;
    }
    description = fallback;
    diagnostics.push({ type: "warning", code: "no_frontmatter", message: "SKILL.md 无 frontmatter/description，按目录名 + 正文首段降级识别（vendor 快照兼容）", path: filePath });
  }
  if (description.length > 1024) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: `description 超 1024 字符（${description.length}）`, path: filePath });
  }
  if (!isValidName(name)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: `name "${name}" 不符合 [a-z0-9-] 且 ≤64`, path: filePath });
    return null;
  }
  if (name !== dirname) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: `name "${name}" 与目录名 "${dirname}" 不一致（规范建议一致）`, path: filePath });
  }
  return finalizeRecord({ name, description, filePath, dir, opts, fm });
}

/** 无 frontmatter 的 SKILL.md 降级提取 description：## Purpose / ## Use this when 段，否则首个非标题段落。 */
function fallbackDescription(body: string): string | null {
  const pick = (heading: string): string | null => {
    const m = body.split(/(?=^## )/m).find((c) => c.startsWith(`## ${heading}`));
    if (!m) return null;
    const para = m.split("\n").slice(1).join("\n").split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
    return para ? para.replace(/\s+/g, " ").slice(0, 200) : null;
  };
  const firstPara = (): string | null => {
    const para = body.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
    return para ? para.replace(/\s+/g, " ").slice(0, 200) : null;
  };
  return pick("Purpose") ?? pick("Use this when") ?? firstPara();
}

/** 根级 <name>.md 带 frontmatter → flatten 形态；裸 .md 在 legacy 目录收为 codex-prompt-legacy。 */
function loadFlatMarkdown(filePath: string, opts: ScanOptions, diagnostics: SkillsDiagnostic[]): SkillRecord | null {
  const raw = readFileSync(filePath, "utf8");
  let parsed: ParsedSkillFile;
  try {
    parsed = splitFrontmatter(raw);
  } catch (e) {
    diagnostics.push({ type: "warning", code: "parse_failed", message: (e as Error).message, path: filePath });
    return null;
  }
  const stem = filePath.split("/").pop()!.replace(/\.md$/, "");
  const dir = join(filePath, "..");
  const fm = parsed.frontmatter;
  if (!Object.keys(fm).length) {
    if (!opts.legacy) return null; // 普通 skills 目录：裸 .md 静默跳过（非声明式 skill 文件）
    const firstPara = parsed.body.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith("#"));
    const description = (firstPara ?? stem).slice(0, 200);
    return {
      name: stem,
      description,
      filePath,
      dir,
      source: opts.source,
      layer: opts.layer,
      origin: opts.origin,
      format: "codex-prompt-legacy",
      invocation: { model: true, user: true },
      meta: {},
    };
  }
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) return null; // 带 frontmatter 但无 description：不是 skill，跳过
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : stem;
  if (!isValidName(name)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: `name "${name}" 不符合 [a-z0-9-] 且 ≤64`, path: filePath });
    return null;
  }
  return finalizeRecord({ name, description, filePath, dir, opts, fm });
}

function finalizeRecord(args: {
  name: string; description: string; filePath: string; dir: string;
  opts: ScanOptions; fm: Record<string, unknown>;
}): SkillRecord {
  const { name, description, filePath, dir, opts, fm } = args;
  const hasOpenaiYaml = existsSync(join(dir, "agents", "openai.yaml"));
  const format = detectFormat(fm, hasOpenaiYaml);
  const codexImplicit = hasOpenaiYaml ? codexImplicitInvocation(dir) : undefined;
  return {
    name,
    description,
    filePath,
    dir,
    source: opts.source,
    layer: opts.layer,
    origin: opts.origin,
    format,
    invocation: {
      model: !(fm["disable-model-invocation"] === true || codexImplicit === false),
      user: !(fm["user-invocable"] === false),
    },
    meta: fm,
  };
}

// ---------------------------------------------------------------------------
// 一行摘要（system prompt 的全部 skills 足迹，rev3）
// ---------------------------------------------------------------------------

/**
 * 注入 system prompt 的**唯一** skills 内容：一行摘要。
 * 指向 skill_list（翻清单）与 skill_read（读全文），把选择权完全交给模型。
 * 确定性：同注册表必产同字符串（D1 快照纪律照旧——虽然现在恒为 create() 时一算）。
 */
export function renderSummaryLine(records: SkillRecord[]): string {
  if (!records.length) return "";
  const byOrigin = new Map<string, number>();
  for (const r of records) byOrigin.set(r.origin, (byOrigin.get(r.origin) ?? 0) + 1);
  const parts = [...byOrigin.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([o, n]) => `${o} ${n}`);
  return `【Skills】本机共 ${records.length} 个算子开发 skills（${parts.join(" · ")}）。skill_list() 按分区/关键词翻清单，skill_read(<name>) 读全文——接到某芯片/某类任务时先翻对应分区再动手。`;
}

// ---------------------------------------------------------------------------
// 正文读取（skill_read 工具与 /skills <name> 共用）
// ---------------------------------------------------------------------------

/** 读取 skill 正文（frontmatter 剥离）+ 资源清单（references/scripts/assets/agents 下的文件名）。 */
export function readSkillContent(record: SkillRecord): { body: string; resources: string[] } {
  const raw = readFileSync(record.filePath, "utf8");
  const { body } = splitFrontmatter(raw);
  const resources: string[] = [];
  for (const sub of ["references", "scripts", "assets", "agents"]) {
    const d = join(record.dir, sub);
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.name.startsWith(".")) resources.push(`${sub}/${e.name}${e.isDirectory() ? "/" : ""}`);
    }
  }
  return { body, resources };
}

/** section 参数：按 `## ` 标题切段（子串匹配、不区分大小写）；未命中返回 null。 */
export function extractSection(body: string, section: string): string | null {
  const chunks = body.split(/(?=^## )/m);
  const hit = chunks.find((c) => {
    if (!c.startsWith("## ")) return false;
    const title = c.slice(3).split("\n")[0]!.toLowerCase();
    return title.includes(section.toLowerCase());
  });
  return hit ?? null;
}

// ---------------------------------------------------------------------------
// 注册表：create() 一次成型、全量注册
// ---------------------------------------------------------------------------

export interface SkillsRegistryOptions {
  /** forge 仓库 skills/ 根（common + delta/* + vendors/*）；不传或不存在 → 无内置。 */
  builtinRoot?: string;
  /** 是否加载内置（config.skills.builtin）。 */
  builtin: boolean;
  /** 全局用户目录（~/.forge/skills）。 */
  globalDir: string;
  /** 项目用户目录（<workdir>/.forge/skills）。 */
  projectDir: string;
  /** 兼容目录（.claude/skills 与 .agents/skills，项目+全局）。 */
  compatDirs?: string[];
  /** 额外 skills 根（config.skills.dirs；按全局层优先级叠加）。 */
  extraDirs?: string[];
  /** 四态覆盖（config.skills.overrides）。 */
  overrides?: Record<string, SkillOverrideState>;
}

export class SkillsRegistry {
  readonly records: SkillRecord[];
  readonly diagnostics: SkillsDiagnostic[];
  /** system prompt 里那**一行**摘要（create() 定格；rev3 起索引块退位给它）。 */
  readonly summaryLine: string;
  /** 本会话 skill_read 过的 skill 名（主/子 agent 共用注册表 → 并集；压缩摘要第 10 段用）。 */
  private readonly usedNames = new Set<string>();
  private readonly byName = new Map<string, SkillRecord>();

  private constructor(records: SkillRecord[], diagnostics: SkillsDiagnostic[], summaryLine: string) {
    this.records = records;
    this.diagnostics = diagnostics;
    this.summaryLine = summaryLine;
    for (const r of records) this.byName.set(r.name, r);
  }

  static create(opts: SkillsRegistryOptions): SkillsRegistry {
    const diagnostics: SkillsDiagnostic[] = [];

    // 内置三态全量扫描。叠加序（后读覆盖先读）：common → vendors（字母序）→ delta（字母序）
    // ——delta 在 vendor 之后即「厂商特化覆盖家底同名」；用户层最后压上。
    const builtinLayers: Array<{ dir: string; so: ScanOptions }> = [];
    if (opts.builtin && opts.builtinRoot && existsSync(opts.builtinRoot)) {
      builtinLayers.push({ dir: join(opts.builtinRoot, "common"), so: { source: "builtin", layer: "common", origin: "common" } });
      const vendorsRoot = join(opts.builtinRoot, "vendors");
      if (existsSync(vendorsRoot)) {
        for (const e of readdirSync(vendorsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          if (e.name.endsWith(".json")) continue; // skills.lock.json
          builtinLayers.push({ dir: join(vendorsRoot, e.name), so: { source: "builtin", layer: "vendor", origin: `vendor:${e.name}` } });
        }
      }
      const deltaRoot = join(opts.builtinRoot, "delta");
      if (existsSync(deltaRoot)) {
        for (const e of readdirSync(deltaRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          builtinLayers.push({ dir: join(deltaRoot, e.name), so: { source: "builtin", layer: "delta", origin: `delta:${e.name}` } });
        }
      }
    } else if (opts.builtin && opts.builtinRoot && !existsSync(opts.builtinRoot)) {
      diagnostics.push({ type: "warning", code: "builtin_missing", message: `内置 skills 目录不存在：${opts.builtinRoot}（源码树被裁剪？降级为无内置）` });
    }

    const merged = new Map<string, SkillRecord>();
    const overlay = (res: ScanResult): void => {
      for (const r of res.records) {
        if (merged.has(r.name)) {
          diagnostics.push({
            type: "warning", code: "skill_overridden",
            message: `同名覆盖：${r.name}（${merged.get(r.name)!.origin} → ${r.origin}）`,
          });
        }
        merged.set(r.name, r);
      }
      diagnostics.push(...res.diagnostics);
    };
    for (const l of builtinLayers) overlay(scanSkillsRoot(l.dir, l.so));
    // 用户层叠加：compat → 额外根（global 级）→ global → project（后读覆盖先读）。
    for (const dir of opts.compatDirs ?? []) overlay(scanSkillsRoot(dir, { source: "compat", layer: "compat", origin: "compat" }));
    for (const dir of opts.extraDirs ?? []) overlay(scanSkillsRoot(dir, { source: "global", layer: "user", origin: "user" }));
    overlay(scanSkillsRoot(opts.globalDir, { source: "global", layer: "user", origin: "user" }));
    overlay(scanSkillsRoot(opts.projectDir, { source: "project", layer: "user", origin: "user" }));

    // 四态覆盖在扫描后统一应用（/skills、skill_read 一致）。
    const overrides = opts.overrides ?? {};
    const records: SkillRecord[] = [];
    for (const r of merged.values()) {
      const state = overrides[r.name];
      if (state === "off") {
        diagnostics.push({ type: "warning", code: "override_off", message: `skills.overrides 已禁用：${r.name}` });
        continue;
      }
      if (state === "user-only") records.push({ ...r, invocation: { ...r.invocation, model: false } });
      else if (state === "name-only") records.push({ ...r, nameOnly: true });
      else records.push(r);
    }

    return new SkillsRegistry(records, diagnostics, renderSummaryLine(records));
  }

  get(name: string): SkillRecord | undefined {
    return this.byName.get(name);
  }

  /** 前缀匹配建议（skill_read name 不存在时给模型可读错误用）。 */
  suggest(name: string): string[] {
    const lower = name.toLowerCase();
    return this.records.filter((r) => r.name.includes(lower)).map((r) => r.name).slice(0, 5);
  }

  /** skill_read 成功加载时记一笔（幂等：Set 语义）。 */
  noteUsed(name: string): void {
    this.usedNames.add(name);
  }

  /** 已用 skill 名单（确定性序：注册表顺序）。 */
  usedList(): string[] {
    return this.records.filter((r) => this.usedNames.has(r.name)).map((r) => r.name);
  }
}
