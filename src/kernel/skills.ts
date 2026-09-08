import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { estimateTokens } from "./compaction.js";

/**
 * Skills 管理内核（P0：IR + 扫描 + manifest 组合 + 索引渲染，纯逻辑无 agent 依赖）。
 *
 * 架构「物理三态 × 逻辑组合」（docs/skills-management-plan.md §4）：
 *   · 物理三态：common（自建通用层）/ delta/<vendor>（自建差异层）/ vendors/<name>（上游快照，lock 锁 ref）
 *   · 逻辑组合：targets/<name>.yaml manifest 声明式引用（common / delta: / vendor: / target: 四种），
 *     resolve 成芯片视图——不复制、不软链，去重发生在 filePath 物理身份层
 *   · 用户三层叠加：builtin → compat → global(~/.forge/skills) → project(<workdir>/.forge/skills)，
 *     同名后读覆盖先读（项目 > 全局 > 内置，对齐 memory「先项目后全局」）
 *
 * 为什么不用库的 loadSkills：它只保留 name/description/disable-model-invocation，丢掉完整
 * frontmatter——而格式识别（claude-code / codex）、invocation 归一、meta 透传都需要原始字段；
 * 且其 ExecutionEnv 异步抽象对我们「本地一次性扫描」是纯负担。自研同步扫描器单遍 IO、好测。
 */

export type SkillFormat = "agentskills" | "claude-code" | "codex" | "codex-prompt-legacy";
export type SkillSource = "builtin" | "global" | "project" | "compat";
/** 物理归属层：内置三态（common/delta/vendor）+ 用户层（user/compat）。 */
export type SkillLayer = "common" | "delta" | "vendor" | "user" | "compat";

/** 四态覆盖（对齐 Claude skillOverrides 语义；见计划书 §7）。 */
export type SkillOverrideState = "on" | "off" | "user-only" | "name-only";

export interface SkillRecord {
  /** 规范 name；同名冲突按 source/include 优先级整条替换。 */
  name: string;
  description: string;
  /** SKILL.md 绝对路径（skill_read 白名单锚点；也是物理去重身份）。 */
  filePath: string;
  /** skill 根目录（资源相对路径的基）。 */
  dir: string;
  source: SkillSource;
  layer: SkillLayer;
  /** 经 targets 组合反查的归属标签（物理去重后累积；user/compat 层为空）。 */
  targets: string[];
  /** 溯源标签（layer=vendor 时如 "vendor:geak:expert_skills"；delta 如 "delta:hygon"）。 */
  origin?: string;
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

/** targets/<name>.yaml 的 manifest 形态。 */
export interface TargetManifest {
  name: string;
  label?: string;
  include: string[];
}

/** manifest include 条目的四种引用。 */
export type IncludeRef =
  | { kind: "common" }
  | { kind: "delta"; vendor: string }
  | { kind: "vendor"; name: string; subpath?: string }
  | { kind: "target"; name: string };

export function parseIncludeRef(ref: string, file: string): IncludeRef {
  if (ref === "common") return { kind: "common" };
  if (ref.startsWith("delta:")) {
    const vendor = ref.slice("delta:".length).trim();
    if (!vendor || vendor.includes("/")) throw new Error(`${file}：include 条目 "${ref}" 应形如 delta:<vendor>（不含路径）`);
    return { kind: "delta", vendor };
  }
  if (ref.startsWith("vendor:")) {
    const rest = ref.slice("vendor:".length).trim();
    const slash = rest.indexOf("/");
    if (slash === 0) throw new Error(`${file}：include 条目 "${ref}" 缺少 vendor 名`);
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const subpath = slash < 0 ? undefined : rest.slice(slash + 1);
    if (!name || name.includes(":")) throw new Error(`${file}：include 条目 "${ref}" 的 vendor 名不合法`);
    return subpath ? { kind: "vendor", name, subpath } : { kind: "vendor", name };
  }
  if (ref.startsWith("target:")) {
    const name = ref.slice("target:".length).trim();
    if (!name) throw new Error(`${file}：include 条目 "${ref}" 缺少 target 名`);
    return { kind: "target", name };
  }
  throw new Error(`${file}：无法识别的 include 条目 "${ref}"（支持 common / delta:<v> / vendor:<n>[/<sub>] / target:<t>）`);
}

export function parseTargetManifest(text: string, file: string): TargetManifest {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`${file}：不是合法 YAML（${(e as Error).message}）`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error(`${file}：manifest 应是 name/label/include 的映射`);
  const o = doc as Record<string, unknown>;
  const stem = file.split("/").pop()!.replace(/\.ya?ml$/, "");
  const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : stem;
  if (!Array.isArray(o.include) || !o.include.every((x) => typeof x === "string") || !(o.include as string[]).length) {
    throw new Error(`${file}：include 应为非空字符串数组`);
  }
  const manifest: TargetManifest = { name, include: o.include as string[] };
  if (typeof o.label === "string" && o.label.trim()) manifest.label = o.label.trim();
  return manifest;
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
  /** 溯源标签（vendor/delta 引用时填）。 */
  origin?: string;
  /** legacy prompts 目录：无 frontmatter 的裸 .md 也收为 codex-prompt-legacy。 */
  legacy?: boolean;
}

export interface ScanResult {
  records: SkillRecord[];
  diagnostics: SkillsDiagnostic[];
}

const SKIP_DIRS = new Set(["node_modules"]);

/**
 * 扫描一个 skills 根目录（集合目录）。规则（计划书 §3.3/§4）：
 *  · 目录树里任意层出现 <dir>/SKILL.md 即一个 skill（支持 vendor 仓的任意嵌套），扫到即不再下钻；
 *  · 扫描根的根级 <name>.md 带 frontmatter+description → flatten 形态（dir 取所在目录）；
 *  · 裸 .md（无 frontmatter）仅 legacy 目录收为 codex-prompt-legacy，否则跳过计 warning；
 *  · 跳过点开头的条目与 node_modules（对齐库 loader 的忽略面，不含 .gitignore 处理——skills 目录是自己的地盘）。
 * 目录不存在 → 空结果（调用方决定是否计诊断，如 vendor 未 fetch）。
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
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
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
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: "缺少必填 description", path: filePath });
    return null;
  }
  if (description.length > 1024) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: `description 超 1024 字符（${description.length}）`, path: filePath });
  }
  const dirname = dir.split("/").pop()!;
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : dirname;
  if (!isValidName(name)) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: `name "${name}" 不符合 [a-z0-9-] 且 ≤64`, path: filePath });
    return null;
  }
  if (name !== dirname) {
    diagnostics.push({ type: "warning", code: "invalid_metadata", message: `name "${name}" 与目录名 "${dirname}" 不一致（规范建议一致）`, path: filePath });
  }
  return finalizeRecord({ name, description, filePath, dir, opts, fm, body: parsed.body });
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
  const dir = resolve(filePath, "..");
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
      targets: [],
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
  return finalizeRecord({ name, description, filePath, dir, opts, fm, body: parsed.body });
}

function finalizeRecord(args: {
  name: string; description: string; filePath: string; dir: string;
  opts: ScanOptions; fm: Record<string, unknown>; body: string;
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
    targets: [],
    ...(opts.origin ? { origin: opts.origin } : {}),
    format,
    invocation: {
      model: !(fm["disable-model-invocation"] === true || codexImplicit === false),
      user: !(fm["user-invocable"] === false),
    },
    meta: fm,
  };
}

// ---------------------------------------------------------------------------
// manifest 组合 resolve（纯函数，带扫描缓存）
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  builtinRoot: string;
  manifests: Map<string, TargetManifest>;
  /** 激活的 target（config.skills.targets，会话内锁定）。 */
  activated: string[];
}

export interface ResolveResult extends ScanResult {
  records: SkillRecord[];
}

/**
 * 解析激活的 targets 为 builtin 记录集（计划书 §4.3/§4.4）：
 *  · target: 传递解析、禁环（访问链检测）；
 *  · 单 target 内 include 顺序后者胜（同名整条替换）→ delta 放最后即覆盖 vendor 同名；
 *  · 跨 target 按 activated 顺序后者胜；同一物理文件（filePath 相同）只登记一条、targets 标签累积；
 *  · vendor 目录缺失 → 降级 warning（提示 skills:fetch），不崩。
 */
export function resolveTargets(opts: ResolveOptions): ResolveResult {
  const diagnostics: SkillsDiagnostic[] = [];
  const scanCache = new Map<string, ScanResult>();
  const scan = (dir: string, so: ScanOptions): ScanResult => {
    const key = `${so.layer}|${so.origin ?? ""}|${dir}`;
    const hit = scanCache.get(key);
    if (hit) return hit;
    const res = scanSkillsRoot(dir, so);
    scanCache.set(key, res);
    return res;
  };

  const resolveTarget = (name: string, chain: string[]): SkillRecord[] => {
    if (chain.includes(name)) {
      diagnostics.push({ type: "error", code: "manifest_cycle", message: `target 引用成环：${[...chain, name].join(" → ")}` });
      return [];
    }
    const manifest = opts.manifests.get(name);
    if (!manifest) {
      diagnostics.push({ type: "error", code: "unknown_target", message: `未找到 target manifest：targets/${name}.yaml` });
      return [];
    }
    const byName = new Map<string, SkillRecord>();
    for (const raw of manifest.include) {
      let ref: IncludeRef;
      try {
        ref = parseIncludeRef(raw, `targets/${name}.yaml`);
      } catch (e) {
        diagnostics.push({ type: "error", code: "bad_include", message: (e as Error).message });
        continue;
      }
      switch (ref.kind) {
        case "common": {
          const res = scan(join(opts.builtinRoot, "common"), { source: "builtin", layer: "common" });
          diagnostics.push(...res.diagnostics);
          for (const r of res.records) byName.set(r.name, r);
          break;
        }
        case "delta": {
          const res = scan(join(opts.builtinRoot, "delta", ref.vendor), { source: "builtin", layer: "delta", origin: `delta:${ref.vendor}` });
          diagnostics.push(...res.diagnostics);
          for (const r of res.records) byName.set(r.name, r);
          break;
        }
        case "vendor": {
          const dir = join(opts.builtinRoot, "vendors", ref.name, ref.subpath ?? "");
          if (!existsSync(dir)) {
            diagnostics.push({
              type: "warning", code: "vendor_missing",
              message: `vendor "${ref.name}${ref.subpath ? "/" + ref.subpath : ""}" 未 fetch（${dir} 不存在）——npm run skills:fetch`,
            });
            break;
          }
          const res = scan(dir, { source: "builtin", layer: "vendor", origin: `vendor:${ref.name}${ref.subpath ? ":" + ref.subpath : ""}` });
          diagnostics.push(...res.diagnostics);
          for (const r of res.records) byName.set(r.name, r);
          break;
        }
        case "target": {
          const nested = resolveTarget(ref.name, [...chain, name]);
          for (const r of nested) byName.set(r.name, r);
          break;
        }
      }
    }
    return [...byName.values()];
  };

  const final = new Map<string, SkillRecord>();
  for (const t of opts.activated) {
    if (!opts.manifests.has(t)) {
      diagnostics.push({ type: "error", code: "unknown_target", message: `激活的 target 不存在：${t}（skills/targets/${t}.yaml 缺失）` });
      continue;
    }
    for (const r of resolveTarget(t, [])) {
      const existing = final.get(r.name);
      if (existing) {
        if (existing.filePath === r.filePath) {
          // 物理同一文件（多 target 共用）：只登记一条，累积归属标签。
          if (!existing.targets.includes(t)) existing.targets.push(t);
        } else {
          final.set(r.name, { ...r, targets: [t] }); // 跨 target 同名：activated 顺序后者胜
        }
      } else {
        final.set(r.name, { ...r, targets: [t] });
      }
    }
  }
  return { records: [...final.values()], diagnostics };
}

/** 扫 skills/targets/*.yaml → manifest 表（含 name/label 校验）。 */
export function loadTargetManifests(targetsDir: string): { manifests: Map<string, TargetManifest>; diagnostics: SkillsDiagnostic[] } {
  const manifests = new Map<string, TargetManifest>();
  const diagnostics: SkillsDiagnostic[] = [];
  if (!existsSync(targetsDir)) return { manifests, diagnostics };
  for (const entry of readdirSync(targetsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const full = join(targetsDir, entry.name);
    try {
      const manifest = parseTargetManifest(readFileSync(full, "utf8"), full);
      manifests.set(manifest.name, manifest);
    } catch (e) {
      diagnostics.push({ type: "error", code: "bad_manifest", message: (e as Error).message, path: full });
    }
  }
  return { manifests, diagnostics };
}

// ---------------------------------------------------------------------------
// 索引渲染（纯函数、确定性输出：同输入字节相同）
// ---------------------------------------------------------------------------

const INDEX_HEADER = "【Skills 索引】任务匹配 description 时用 skill_read(<name>) 加载全文（同一 skill 本会话重复调用只返回短注记）；不确定该不该用时，宁可先 skill_read 再动手。skill 可引用其目录下 references/scripts 等资源。";

export interface RenderIndexOptions {
  /** 激活 target 的声明序（分组顺序）。 */
  activated: string[];
  /** manifest label（target 分组标题用；无则用 name）。 */
  labels?: Record<string, string>;
  /** 单行 description 截断长度（默认 160 字符）。 */
  maxDescChars?: number;
}

interface IndexedLine {
  name: string;
  desc: string;
  group: string;
  suffix: string;
}

/**
 * 渲染常驻索引块（计划书 §5）。分层裁剪直到入预算：
 *  1. 截长描述；2. 低价值分组逆序丢描述（name-only）；3. 整分组折叠为一行；4. 兜底尾注。
 * 分组序：common → activated 声明序 → 用户（全局先于项目）→ 兼容。组内 name 字母序。
 */
export function renderIndex(records: SkillRecord[], budgetTokens: number, opts: RenderIndexOptions): string {
  const visible = records.filter((r) => r.invocation.model !== false);
  if (!visible.length) return "";

  const maxDesc = opts.maxDescChars ?? 160;
  const groupOf = (r: SkillRecord): string => {
    if (r.layer === "common") return "common";
    if (r.layer === "vendor" || r.layer === "delta") {
      for (const t of opts.activated) if (r.targets.includes(t)) return t;
      return r.targets[0] ?? "common";
    }
    if (r.source === "compat") return "compat";
    return r.source === "global" ? "user-global" : "user-project";
  };
  const groupOrder = ["common", ...opts.activated, "user-global", "user-project", "compat"];
  const groupTitle = (g: string): string => {
    if (g === "common") return "〔common〕";
    if (g === "user-global") return "〔用户 · 全局〕";
    if (g === "user-project") return "〔用户 · 项目〕";
    if (g === "compat") return "〔兼容目录〕";
    return `〔target · ${g}${opts.labels?.[g] ? " ＝ " + opts.labels[g] : ""}〕`;
  };

  const lines: IndexedLine[] = visible
    .map((r) => {
      let suffix = "";
      if (r.layer === "common" && r.targets.length > 1) suffix = `（亦用于 ${r.targets.join(",")}）`;
      else if (r.layer === "vendor" || r.layer === "delta") suffix = `（${r.origin}）`;
      return { name: r.name, desc: r.nameOnly ? "" : r.description, group: groupOf(r), suffix };
    })
    .sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group) || a.name.localeCompare(b.name));

  const fits = (rendered: string): boolean => estimateTokens(rendered) <= budgetTokens;

  // 每组渲染为 { title, lines: string[] }，裁剪层按组粒度操作。
  const buildGroups = (ls: IndexedLine[], mode: "full" | "name-only" | "collapsed"): Array<{ title: string; body: string }> => {
    const byGroup = new Map<string, IndexedLine[]>();
    for (const l of ls) {
      const arr = byGroup.get(l.group) ?? [];
      arr.push(l);
      byGroup.set(l.group, arr);
    }
    const groups: Array<{ title: string; body: string }> = [];
    for (const g of groupOrder) {
      const arr = byGroup.get(g);
      if (!arr?.length) continue;
      if (mode === "collapsed") {
        groups.push({ title: groupTitle(g), body: `另有 ${arr.length} 个：${arr.map((l) => l.name).join(", ")}` });
      } else {
        groups.push({
          title: groupTitle(g),
          body: arr.map((l) => (mode === "name-only" || !l.desc ? `- ${l.name}${l.suffix}` : `- ${l.name} — ${trimDesc(l.desc, maxDesc)}${l.suffix}`)).join("\n"),
        });
      }
    }
    return groups;
  };
  const assemble = (groups: Array<{ title: string; body: string }>, tailNote: string): string => {
    const parts = [INDEX_HEADER, ...groups.map((g) => `${g.title}\n${g.body}`)];
    if (tailNote) parts.push(tailNote);
    return parts.join("\n\n");
  };

  const full = assemble(buildGroups(lines, "full"), "");
  if (fits(full)) return full;

  // 层 1 已内建（trimDesc）。层 2：按组逆序逐步把组降为 name-only（低价值组先降）。
  const dropOrder = [...groupOrder].reverse();
  for (let i = 0; i < dropOrder.length; i++) {
    const degrade = new Set(dropOrder.slice(0, i + 1));
    const ls = lines.map((l) => (degrade.has(l.group) ? { ...l, desc: "" } : l));
    const out = assemble(buildGroups(ls, "full"), `（索引超预算：${degradedNames(degrade, groupTitle)} 只列名，/skills 查看全部）`);
    if (fits(out)) return out;
  }
  // 层 3：整组折叠（同样低价值组先折叠）。
  for (let i = 0; i < dropOrder.length; i++) {
    const collapse = new Set(dropOrder.slice(0, i + 1));
    const groups: Array<{ title: string; body: string }> = [];
    const byGroup = new Map<string, IndexedLine[]>();
    for (const l of lines) {
      const arr = byGroup.get(l.group) ?? [];
      arr.push(l);
      byGroup.set(l.group, arr);
    }
    for (const g of groupOrder) {
      const arr = byGroup.get(g);
      if (!arr?.length) continue;
      if (collapse.has(g)) groups.push({ title: groupTitle(g), body: `另有 ${arr.length} 个：${arr.map((l) => l.name).join(", ")}` });
      else groups.push({ title: groupTitle(g), body: arr.map((l) => `- ${l.name}${l.suffix}`).join("\n") });
    }
    const out = assemble(groups, "（索引超预算：部分分组已折叠，/skills 查看全部）");
    if (fits(out)) return out;
  }
  // 层 4：兜底——全部折叠都超预算（预算极小）。
  return assemble([{ title: "〔skills〕", body: `共 ${visible.length} 个 skills，索引超出 ${budgetTokens} token 预算未展开——用 /skills 查看全部` }], "");
}

function trimDesc(desc: string, max: number): string {
  return desc.length > max ? `${desc.slice(0, max)}…` : desc;
}

function degradedNames(set: Set<string>, title: (g: string) => string): string {
  return [...set].map(title).join("、");
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
// 注册表：create() 一次成型（P1 起作为索引快照的唯一来源）
// ---------------------------------------------------------------------------

export interface SkillsRegistryOptions {
  /** forge 仓库 skills/ 根（内置三态 + targets）；不传或不存在 → 无内置。 */
  builtinRoot?: string;
  /** 是否加载内置（config.skills.builtin）。 */
  builtin: boolean;
  /** 激活 target（config.skills.targets）。 */
  activated: string[];
  /** 全局用户目录（~/.forge/skills）。 */
  globalDir: string;
  /** 项目用户目录（<workdir>/.forge/skills）。 */
  projectDir: string;
  /** 兼容目录（.claude/skills 与 .agents/skills，项目+全局）。 */
  compatDirs?: string[];
  /** 额外 skills 根（config.skills.dirs；按全局层优先级叠加在 builtin 之后、全局之前）。 */
  extraDirs?: string[];
  /** 四态覆盖（config.skills.overrides）。 */
  overrides?: Record<string, SkillOverrideState>;
  /** 索引 token 预算（renderIndex 用；create 时一次渲染存字段）。 */
  indexBudgetTokens?: number;
}

export class SkillsRegistry {
  readonly records: SkillRecord[];
  readonly diagnostics: SkillsDiagnostic[];
  /** 索引快照：create() 时一次渲染，字节级恒定（前缀缓存安全，D1）。 */
  readonly indexBlock: string;
  /** 本会话 skill_read 过的 skill 名（主/子 agent 共用注册表 → 并集；压缩摘要第 10 段用）。 */
  private readonly usedNames = new Set<string>();
  private readonly byName = new Map<string, SkillRecord>();

  private constructor(records: SkillRecord[], diagnostics: SkillsDiagnostic[], indexBlock: string) {
    this.records = records;
    this.diagnostics = diagnostics;
    this.indexBlock = indexBlock;
    for (const r of records) this.byName.set(r.name, r);
  }

  /** skill_read 成功加载时记一笔（幂等：Set 语义）。 */
  noteUsed(name: string): void {
    this.usedNames.add(name);
  }

  /** 已用 skill 名单（确定性序：注册表顺序）。 */
  usedList(): string[] {
    return this.records.filter((r) => this.usedNames.has(r.name)).map((r) => r.name);
  }

  static create(opts: SkillsRegistryOptions): SkillsRegistry {
    const diagnostics: SkillsDiagnostic[] = [];
    let builtin: SkillRecord[] = [];
    const labels: Record<string, string> = {};
    if (opts.builtin && opts.builtinRoot && existsSync(opts.builtinRoot)) {
      const { manifests, diagnostics: md } = loadTargetManifests(join(opts.builtinRoot, "targets"));
      diagnostics.push(...md);
      for (const m of manifests.values()) if (m.label) labels[m.name] = m.label;
      const res = resolveTargets({ builtinRoot: opts.builtinRoot, manifests, activated: opts.activated });
      builtin = res.records;
      diagnostics.push(...res.diagnostics);
    } else if (opts.builtin && opts.builtinRoot && !existsSync(opts.builtinRoot)) {
      diagnostics.push({ type: "warning", code: "builtin_missing", message: `内置 skills 目录不存在：${opts.builtinRoot}（源码树被裁剪？降级为无内置）` });
    }

    // 用户层叠加：builtin → compat → global → project（后读覆盖先读）。
    const merged = new Map<string, SkillRecord>();
    const overlay = (records: SkillRecord[], keepTargets = false): void => {
      for (const r of records) {
        const existing = merged.get(r.name);
        if (existing) {
          diagnostics.push({
            type: "warning", code: "skill_overridden",
            message: `同名覆盖：${existing.name}（${existing.source}${existing.origin ? " · " + existing.origin : ""} → ${r.source}）`,
          });
        }
        merged.set(r.name, keepTargets ? { ...r } : { ...r, targets: [] });
      }
    };
    overlay(builtin, true);
    // 叠加序（后读覆盖先读）：builtin → compat → 额外根（global 级）→ global → project。
    for (const dir of opts.compatDirs ?? []) overlay(scanSkillsRoot(dir, { source: "compat", layer: "compat" }).records);
    for (const dir of opts.extraDirs ?? []) overlay(scanSkillsRoot(dir, { source: "global", layer: "user" }).records);
    overlay(scanSkillsRoot(opts.globalDir, { source: "global", layer: "user" }).records);
    overlay(scanSkillsRoot(opts.projectDir, { source: "project", layer: "user" }).records);

    // 四态覆盖在扫描后、索引渲染前统一应用（/skills、索引、skill_read 三处一致）。
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

    const indexBlock = renderIndex(records, opts.indexBudgetTokens ?? 1500, { activated: opts.activated, labels });
    return new SkillsRegistry(records, diagnostics, indexBlock);
  }

  get(name: string): SkillRecord | undefined {
    return this.byName.get(name);
  }

  /** 前缀匹配建议（skill_read name 不存在时给模型可读错误用）。 */
  suggest(name: string): string[] {
    const lower = name.toLowerCase();
    return this.records.filter((r) => r.name.includes(lower)).map((r) => r.name).slice(0, 5);
  }
}
