import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanSkillsRoot,
  splitFrontmatter,
  renderSummaryLine,
  SkillsRegistry,
  type SkillRecord,
} from "../src/kernel/skills.js";
import { validateConfigFile } from "../src/config.js";

/** rev3：全量注册 + 一行摘要 + agent 按需翻阅（skill_list/skill_read）。 */

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-skills-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function wf(rel: string, content: string): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

const skill = (name: string, desc: string, extra = "", body = "正文") =>
  `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n${body}\n`;

// ---------------------------------------------------------------------------
// 格式识别矩阵
// ---------------------------------------------------------------------------

test("标准 SKILL.md → agentskills 格式", () => {
  wf("common/triton-basics/SKILL.md", skill("triton-basics", "Triton kernel 工程基础"));
  const { records, diagnostics } = scanSkillsRoot(join(root, "common"), { source: "builtin", layer: "common", origin: "common" });
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.name, "triton-basics");
  assert.equal(r.format, "agentskills");
  assert.equal(r.layer, "common");
  assert.equal(r.origin, "common");
  assert.deepEqual(r.invocation, { model: true, user: true });
  assert.equal(diagnostics.length, 0);
});

test("agents/openai.yaml 存在 → codex 格式；allow_implicit_invocation=false → model 调用关（true 保持开）", () => {
  wf("vendors/x/k/SKILL.md", skill("k", "样本"));
  wf("vendors/x/k/agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n");
  wf("vendors/x/j/SKILL.md", skill("j", "样本二"));
  wf("vendors/x/j/agents/openai.yaml", "policy:\n  allow_implicit_invocation: true\n");
  const { records } = scanSkillsRoot(join(root, "vendors/x"), { source: "builtin", layer: "vendor", origin: "vendor:x" });
  const k = records.find((x) => x.name === "k")!;
  assert.equal(k.format, "codex");
  assert.equal(k.invocation.model, false); // 归一到 invocation.model
  assert.equal(k.invocation.user, true);
  assert.equal(k.origin, "vendor:x");
  assert.equal(records.find((x) => x.name === "j")!.invocation.model, true);
});

test("Claude 专有字段 → claude-code 格式；disable-model-invocation → model 关；user-invocable=false → user 关", () => {
  wf("global/s1/SKILL.md", skill("s1", "样本一", "disable-model-invocation: true\n"));
  wf("global/s2/SKILL.md", skill("s2", "样本二", "user-invocable: false\n"));
  const { records } = scanSkillsRoot(join(root, "global"), { source: "global", layer: "user", origin: "user" });
  const s1 = records.find((r) => r.name === "s1")!;
  assert.equal(s1.format, "claude-code");
  assert.equal(s1.invocation.model, false);
  assert.equal(s1.invocation.user, true);
  const s2 = records.find((r) => r.name === "s2")!;
  assert.equal(s2.format, "claude-code");
  assert.equal(s2.invocation.user, false);
});

test("根级 <name>.md 带 frontmatter → flatten 形态（dir 取所在目录）", () => {
  wf("userdir/quick-op.md", "---\nname: quick-op\ndescription: 快速算子骨架\n---\n\n正文");
  const { records } = scanSkillsRoot(join(root, "userdir"), { source: "global", layer: "user", origin: "user" });
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "quick-op");
  assert.equal(records[0].dir, join(root, "userdir"));
});

test("裸 .md：普通目录跳过；legacy 目录收为 codex-prompt-legacy", () => {
  wf("plain/a.md", "# 没有 frontmatter 的普通文件\n\n第一段正文。");
  const normal = scanSkillsRoot(join(root, "plain"), { source: "global", layer: "user", origin: "user" });
  assert.equal(normal.records.length, 0);

  wf("prompts/b.md", "# 旧 Codex prompt\n\n第一段：迁移说明。");
  const legacy = scanSkillsRoot(join(root, "prompts"), { source: "compat", layer: "compat", origin: "compat", legacy: true });
  assert.equal(legacy.records.length, 1);
  assert.equal(legacy.records[0].format, "codex-prompt-legacy");
  assert.equal(legacy.records[0].description.includes("迁移说明"), true);
});

test("缺 description：正文可降级提取则载入（计 no_frontmatter）；正文也无段则跳过", () => {
  wf("dir/tensormux-style/SKILL.md", "# Skill: 无 frontmatter 的 vendor 样本\n\n## Purpose\n识别数值不稳定风险并给出稳定化策略。\n\n## Use this when\n- fp16 溢出");
  wf("dir/empty-all/SKILL.md", "# 只有一个标题\n");
  wf("dir/renamed/SKILL.md", "---\nname: real-name\ndescription: 有描述\n---\n正文");
  const { records, diagnostics } = scanSkillsRoot(join(root, "dir"), { source: "builtin", layer: "vendor", origin: "vendor:x" });
  const ts = records.find((r) => r.name === "tensormux-style")!;
  assert.ok(ts, "降级识别应载入");
  assert.equal(ts.description.includes("数值不稳定"), true);
  assert.equal(records.some((r) => r.name === "empty-all"), false); // 正文无可提取段 → 跳过
  assert.ok(diagnostics.some((d) => d.code === "no_frontmatter"));
  assert.ok(diagnostics.some((d) => d.code === "invalid_metadata" && d.message.includes("正文也无可降级提取")));
});

test("name 不合规跳过；name 与目录名不一致保留但计 warning", () => {
  wf("dir/Bad_Name/SKILL.md", "---\nname: Bad_Name\ndescription: 有描述\n---\n正文");
  wf("dir/renamed/SKILL.md", "---\nname: real-name\ndescription: 有描述\n---\n正文");
  const { records, diagnostics } = scanSkillsRoot(join(root, "dir"), { source: "builtin", layer: "common", origin: "common" });
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "real-name");
  assert.ok(diagnostics.some((d) => d.code === "invalid_metadata" && d.message.includes("不一致")));
});

test("vendor 快照的 .claude/skills 下钻（TileOPs 形态）；其余点开头目录仍跳过", () => {
  wf("snap/.claude/skills/review-pr/SKILL.md", skill("review-pr", "审查 PR"));
  wf("snap/.git/hooks/SKILL.md", skill("git-hook", "不该出现"));
  wf("snap/normal-op/SKILL.md", skill("normal-op", "正常"));
  const { records } = scanSkillsRoot(join(root, "snap"), { source: "builtin", layer: "vendor", origin: "vendor:tileops" });
  assert.deepEqual(records.map((r) => r.name).sort(), ["normal-op", "review-pr"]);
});

test("点开头目录与 node_modules 跳过；嵌套目录树递归可发现 skill；根自身即单个 skill", () => {
  wf("real/ok-skill/SKILL.md", skill("ok-skill", "正常"));
  wf("real/.hidden/sneaky/SKILL.md", skill("sneaky", "隐藏"));
  wf("real/node_modules/pkg/SKILL.md", skill("pkg", "依赖"));
  wf("real/a/b/deep/SKILL.md", skill("deep", "深层嵌套"));
  const { records } = scanSkillsRoot(join(root, "real"), { source: "builtin", layer: "vendor", origin: "vendor:x" });
  assert.deepEqual(records.map((r) => r.name).sort(), ["deep", "ok-skill"]);

  wf("one/SKILL.md", skill("one", "单个"));
  const single = scanSkillsRoot(join(root, "one"), { source: "builtin", layer: "delta", origin: "delta:hygon" });
  assert.equal(single.records.length, 1);
  assert.equal(single.records[0].origin, "delta:hygon");
});

test("splitFrontmatter：无 frontmatter / 坏格式", () => {
  assert.deepEqual(splitFrontmatter("没有分隔线").frontmatter, {});
  assert.throws(() => splitFrontmatter("---\n- a\n- b\n---\n正文"), /frontmatter 应是/);
});

// ---------------------------------------------------------------------------
// 注册表：全量注册 + 分层优先级 + overrides 四态
// ---------------------------------------------------------------------------

function makeBuiltin(): string {
  const b = join(root, "builtin");
  wf("builtin/common/triton-basics/SKILL.md", skill("triton-basics", "Triton 语言与调参基础"));
  wf("builtin/vendors/amd-skills/amd-kernel-optimization/SKILL.md", skill("amd-kernel-optimization", "MI300 优化循环"));
  wf("builtin/vendors/amd-skills/rocm-porting/SKILL.md", skill("rocm-porting", "CUDA→ROCm 迁移"));
  wf("builtin/delta/hygon/amd-kernel-optimization/SKILL.md", skill("amd-kernel-optimization", "海光版优化循环（覆盖 vendor）"));
  wf("builtin/delta/hygon/dtk-vs-rocm/SKILL.md", skill("dtk-vs-rocm", "DTK 与 ROCm 差异"));
  return b;
}

function makeUserLayers(): { globalDir: string; projectDir: string } {
  const globalDir = join(root, "home/.forge/skills");
  const projectDir = join(root, "proj/.forge/skills");
  wf("home/.forge/skills/rocm-porting/SKILL.md", skill("rocm-porting", "用户全局版迁移指南"));
  wf("home/.forge/skills/my-own/SKILL.md", skill("my-own", "用户独有 skill"));
  wf("proj/.forge/skills/dtk-vs-rocm/SKILL.md", skill("dtk-vs-rocm", "项目版 DTK 差异（最具体）"));
  return { globalDir, projectDir };
}

test("全量注册：common + vendors/* + delta/* 都进注册表；delta 覆盖 vendor 同名（厂商特化胜）", () => {
  const b = makeBuiltin();
  const { globalDir, projectDir } = makeUserLayers();
  const reg = SkillsRegistry.create({ builtinRoot: b, builtin: true, ...{ globalDir, projectDir } });
  const names = reg.records.map((r) => r.name).sort();
  assert.deepEqual(names, ["amd-kernel-optimization", "dtk-vs-rocm", "my-own", "rocm-porting", "triton-basics"]);
  const ako = reg.get("amd-kernel-optimization")!;
  assert.equal(ako.layer, "delta"); // delta 在 vendor 之后叠加 → 特化版胜
  assert.equal(ako.origin, "delta:hygon");
  // 用户层覆盖内置
  assert.equal(reg.get("rocm-porting")!.source, "global");
  assert.equal(reg.get("dtk-vs-rocm")!.source, "project");
  assert.ok(reg.diagnostics.some((d) => d.code === "skill_overridden"));
});

test("overrides 四态：off 移除；user-only 模型侧关；name-only 留名", () => {
  const b = makeBuiltin();
  const { globalDir, projectDir } = makeUserLayers();
  const reg = SkillsRegistry.create({
    builtinRoot: b, builtin: true, globalDir, projectDir,
    overrides: { "triton-basics": "off", "rocm-porting": "user-only", "dtk-vs-rocm": "name-only" },
  });
  assert.equal(reg.get("triton-basics"), undefined);
  assert.equal(reg.get("rocm-porting")!.invocation.model, false);
  assert.equal(reg.get("dtk-vs-rocm")!.nameOnly, true);
  assert.ok(reg.diagnostics.some((d) => d.code === "override_off"));
});

test("builtin=false 或根缺失 → 无内置但不崩（builtin_missing 降级）", () => {
  const globalDir = join(root, "none-home/.forge/skills");
  const projectDir = join(root, "none-proj/.forge/skills");
  assert.equal(SkillsRegistry.create({ builtin: false, globalDir, projectDir }).records.length, 0);
  const missing = SkillsRegistry.create({ builtin: true, builtinRoot: join(root, "ghost"), globalDir, projectDir });
  assert.equal(missing.records.length, 0);
  assert.ok(missing.diagnostics.some((d) => d.code === "builtin_missing"));
});

// ---------------------------------------------------------------------------
// 一行摘要（system prompt 的全部 skills 足迹）
// ---------------------------------------------------------------------------

test("renderSummaryLine：总量 + 各分区分组计数；空集返回空串；确定性", () => {
  assert.equal(renderSummaryLine([]), "");
  const recs: SkillRecord[] = [
    { name: "a", description: "x", filePath: "/a", dir: "/a", source: "builtin", layer: "common", origin: "common", targets: [] } as unknown as SkillRecord,
    { name: "b", description: "x", filePath: "/b", dir: "/b", source: "builtin", layer: "common", origin: "common", targets: [] } as unknown as SkillRecord,
    { name: "c", description: "x", filePath: "/c", dir: "/c", source: "builtin", layer: "vendor", origin: "vendor:geak", targets: [] } as unknown as SkillRecord,
  ];
  const line = renderSummaryLine(recs);
  assert.match(line, /^【Skills】本机共 3 个算子开发 skills（common 2 · vendor:geak 1）/);
  assert.match(line, /skill_list\(\)/);
  assert.match(line, /skill_read\(<name>\)/);
  assert.equal(renderSummaryLine(recs), line); // 确定性
});

// ---------------------------------------------------------------------------
// P3：仓库真实 skills/ 目录全量扫描
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 仓库 skills/ 的临时拷贝（剔除 vendors 内容）：断言不受本机是否跑过 skills:fetch 影响。 */
function repoSkillsWithoutVendors(): string {
  const dest = join(root, "repo-skills");
  cpSync(join(REPO_ROOT, "skills"), dest, { recursive: true });
  rmSync(join(dest, "vendors"), { recursive: true, force: true });
  mkdirSync(join(dest, "vendors"), { recursive: true });
  return dest;
}

test("仓库 skills/ 全量注册：common 4 个（含 skill-maintenance）+ 7 家 delta（无 vendors 也能完整工作）", () => {
  const reg = SkillsRegistry.create({
    builtinRoot: repoSkillsWithoutVendors(), builtin: true,
    globalDir: join(root, "no-global"), projectDir: join(root, "no-proj"),
  });
  const count = (origin: string): number => reg.records.filter((r) => r.origin === origin).length;
  assert.equal(count("common"), 4);
  assert.ok(reg.get("skill-maintenance"), "维护指引 skill 应在 common 层");
  for (const v of ["amd", "ascend", "enflame", "hygon", "iluvatar", "metax", "nvidia"]) {
    assert.equal(count(`delta:${v}`), 1, `delta:${v} 应有 1 个记录`);
  }
  assert.match(reg.summaryLine, /本机共 \d+ 个算子开发 skills/);
  assert.match(reg.summaryLine, /common 4/);
});

test("仓库 vendors 已 fetch 时全量并入（本机实拉后自然生效，无 manifest 引导）", () => {
  // 用临时 vendor 目录模拟：skills/vendors/<n>/ 直接被扫进注册表
  const b = repoSkillsWithoutVendors();
  mkdirSync(join(b, "vendors/my-vendor/some-skill"), { recursive: true });
  writeFileSync(join(b, "vendors/my-vendor/some-skill/SKILL.md"), skill("some-skill", "vendor 快照样本"), "utf8");
  const reg = SkillsRegistry.create({ builtinRoot: b, builtin: true, globalDir: join(root, "ng"), projectDir: join(root, "np") });
  assert.equal(reg.get("some-skill")!.origin, "vendor:my-vendor");
});

test("vendor 溯源：.vendor-meta.json → 该 vendor 全体记录挂 upstream；无 meta 静默 undefined（非 vendor 层不受影响）", () => {
  wf("b/common/own/SKILL.md", skill("own", "自建样本"));
  wf("b/vendors/geak/g1/SKILL.md", skill("g1", "样本一"));
  wf("b/vendors/geak/g2/SKILL.md", skill("g2", "样本二"));
  wf("b/vendors/geak/.vendor-meta.json", JSON.stringify({
    repo: "https://github.com/AMD-AGI/GEAK", ref: "main",
    commit: "e867fa4ae4516f644221cb04dcdf24008a43cb99", license: "MIT",
  }));
  wf("b/vendors/bare/b1/SKILL.md", skill("b1", "没跑过 fetch 的 vendor"));
  wf("b/vendors/broken/.vendor-meta.json", "{不是 json");
  const reg = SkillsRegistry.create({ builtinRoot: join(root, "b"), builtin: true, globalDir: join(root, "ng"), projectDir: join(root, "np") });
  for (const n of ["g1", "g2"]) {
    assert.equal(reg.get(n)!.upstream?.repo, "https://github.com/AMD-AGI/GEAK", `${n} 应带 repo`);
    assert.equal(reg.get(n)!.upstream?.ref, "main");
    assert.equal(reg.get(n)!.upstream?.commit?.slice(0, 10), "e867fa4ae4", "commit 短 sha");
  }
  assert.equal(reg.get("own")!.upstream, undefined, "common 层无 upstream");
  assert.equal(reg.get("b1")!.upstream, undefined, "无 meta 的 vendor 静默");
});

// ---------------------------------------------------------------------------
// config 校验：skills 段（rev3）
// ---------------------------------------------------------------------------

test("validateConfigFile：skills 段合法值通过（$ 注释键放行）", () => {
  const c = validateConfigFile({
    skills: { $comment: "注释", builtin: true, dirs: ["~/extra-skills"], compat: true, overrides: { "triton-basics": "name-only" } },
  });
  assert.deepEqual(c.skills?.dirs, ["~/extra-skills"]);
  assert.deepEqual(c.skills?.overrides, { "triton-basics": "name-only" });
});

test("validateConfigFile：rev3 移除项给明确报错；未知字段/类型错误报错", () => {
  assert.throws(() => validateConfigFile({ skills: { targets: ["ascend"] } }), /skills\.targets 已移除（rev3）.*删掉这一行/);
  assert.throws(() => validateConfigFile({ skills: { indexBudgetTokens: 1500 } }), /skills\.indexBudgetTokens 已移除（rev3）.*删掉这一行/);
  assert.throws(() => validateConfigFile({ skills: { hot: true } }), /skills：未知字段 hot/);
  assert.throws(() => validateConfigFile({ skills: { builtin: "yes" } }), /skills\.builtin 应为布尔值/);
  assert.throws(() => validateConfigFile({ skills: { overrides: { x: "disable" } } }), /overrides\["x"\] 应为/);
  assert.throws(() => validateConfigFile({ skills: { dirs: [""] } }), /skills\.dirs 应为/);
});
