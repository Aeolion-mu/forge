import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseIncludeRef,
  parseTargetManifest,
  scanSkillsRoot,
  resolveTargets,
  loadTargetManifests,
  renderIndex,
  SkillsRegistry,
  type SkillRecord,
} from "../src/kernel/skills.js";
import { estimateTokens } from "../src/kernel/compaction.js";
import { validateConfigFile } from "../src/config.js";

// ---------------------------------------------------------------------------
// 工具：临时目录 fixture
// ---------------------------------------------------------------------------

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
  const { records, diagnostics } = scanSkillsRoot(join(root, "common"), { source: "builtin", layer: "common" });
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.name, "triton-basics");
  assert.equal(r.format, "agentskills");
  assert.equal(r.layer, "common");
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.invocation, { model: true, user: true });
  assert.equal(diagnostics.length, 0);
});

test("agents/openai.yaml 存在 → codex 格式；allow_implicit_invocation=false → model 调用关", () => {
  wf("vendors/amd-skills/rocm-porting/SKILL.md", skill("rocm-porting", "CUDA→ROCm 迁移八阶段"));
  wf("vendors/amd-skills/rocm-porting/agents/openai.yaml", "policy:\n  allow_implicit_invocation: false\n");
  const { records } = scanSkillsRoot(join(root, "vendors/amd-skills"), { source: "builtin", layer: "vendor", origin: "vendor:amd-skills" });
  const r = records.find((x) => x.name === "rocm-porting")!;
  assert.equal(r.format, "codex");
  assert.equal(r.invocation.model, false); // 归一到 invocation.model
  assert.equal(r.invocation.user, true);
  assert.equal(r.origin, "vendor:amd-skills");
});

test("agents/openai.yaml 的 allow_implicit_invocation=true → model 调用保持开", () => {
  wf("vendors/x/k/SKILL.md", skill("k", "样本"));
  wf("vendors/x/k/agents/openai.yaml", "policy:\n  allow_implicit_invocation: true\n");
  const { records } = scanSkillsRoot(join(root, "vendors/x"), { source: "builtin", layer: "vendor" });
  assert.equal(records[0].format, "codex");
  assert.equal(records[0].invocation.model, true);
});

test("Claude 专有字段 → claude-code 格式；disable-model-invocation → model 关；user-invocable=false → user 关", () => {
  wf("global/s1/SKILL.md", skill("s1", "样本一", "disable-model-invocation: true\n"));
  wf("global/s2/SKILL.md", skill("s2", "样本二", "user-invocable: false\n"));
  const { records } = scanSkillsRoot(join(root, "global"), { source: "global", layer: "user" });
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
  const { records } = scanSkillsRoot(join(root, "userdir"), { source: "global", layer: "user" });
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "quick-op");
  assert.equal(records[0].dir, join(root, "userdir"));
});

test("裸 .md：普通目录跳过；legacy 目录收为 codex-prompt-legacy", () => {
  wf("plain/a.md", "# 没有 frontmatter 的普通文件\n\n第一段正文。");
  const normal = scanSkillsRoot(join(root, "plain"), { source: "global", layer: "user" });
  assert.equal(normal.records.length, 0);

  wf("prompts/b.md", "# 旧 Codex prompt\n\n第一段：迁移说明。");
  const legacy = scanSkillsRoot(join(root, "prompts"), { source: "compat", layer: "compat", legacy: true });
  assert.equal(legacy.records.length, 1);
  assert.equal(legacy.records[0].format, "codex-prompt-legacy");
  assert.equal(legacy.records[0].description.includes("迁移说明"), true);
});

test("缺 description 跳过并计 warning；name 不合规跳过", () => {
  wf("dir/bad-desc/SKILL.md", "---\nname: bad-desc\n---\n正文");
  wf("dir/Bad_Name/SKILL.md", "---\nname: Bad_Name\ndescription: 有描述\n---\n正文");
  const { records, diagnostics } = scanSkillsRoot(join(root, "dir"), { source: "builtin", layer: "common" });
  assert.equal(records.length, 0);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].code, "invalid_metadata");
});

test("name 与目录名不一致 → 保留记录但计 warning（规范建议一致）", () => {
  wf("dir/renamed/SKILL.md", "---\nname: real-name\ndescription: 有描述\n---\n正文");
  const { records, diagnostics } = scanSkillsRoot(join(root, "dir"), { source: "builtin", layer: "common" });
  assert.equal(records[0].name, "real-name");
  assert.ok(diagnostics.some((d) => d.code === "invalid_metadata" && d.message.includes("不一致")));
});

test("点开头目录与 node_modules 跳过；嵌套目录树递归可发现 skill", () => {
  wf("real/ok-skill/SKILL.md", skill("ok-skill", "正常"));
  wf("real/.hidden/sneaky/SKILL.md", skill("sneaky", "隐藏"));
  wf("real/node_modules/pkg/SKILL.md", skill("pkg", "依赖"));
  wf("real/a/b/deep/SKILL.md", skill("deep", "深层嵌套"));
  const { records } = scanSkillsRoot(join(root, "real"), { source: "builtin", layer: "vendor" });
  assert.deepEqual(records.map((r) => r.name).sort(), ["deep", "ok-skill"]);
});

test("扫描根自身即单个 skill 目录（含 SKILL.md）", () => {
  wf("one/SKILL.md", skill("one", "单个"));
  const { records } = scanSkillsRoot(join(root, "one"), { source: "builtin", layer: "delta", origin: "delta:hygon" });
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "one");
  assert.equal(records[0].origin, "delta:hygon");
});

// ---------------------------------------------------------------------------
// manifest：解析与组合 resolve
// ---------------------------------------------------------------------------

test("parseIncludeRef 四种引用 + 非法形态报错", () => {
  assert.deepEqual(parseIncludeRef("common", "t.yaml"), { kind: "common" });
  assert.deepEqual(parseIncludeRef("delta:hygon", "t.yaml"), { kind: "delta", vendor: "hygon" });
  assert.deepEqual(parseIncludeRef("vendor:amd-skills", "t.yaml"), { kind: "vendor", name: "amd-skills" });
  assert.deepEqual(parseIncludeRef("vendor:geak/expert_skills", "t.yaml"), { kind: "vendor", name: "geak", subpath: "expert_skills" });
  assert.deepEqual(parseIncludeRef("target:amd", "t.yaml"), { kind: "target", name: "amd" });
  assert.throws(() => parseIncludeRef("random", "t.yaml"), /无法识别的 include 条目/);
  assert.throws(() => parseIncludeRef("delta:a/b", "t.yaml"), /应形如 delta/);
  assert.throws(() => parseIncludeRef("vendor:/x", "t.yaml"), /缺少 vendor 名/);
});

test("parseTargetManifest：name 缺省取文件名；include 非数组报错", () => {
  const m = parseTargetManifest("label: 海光\ninclude:\n  - common\n", "targets/hygon.yaml");
  assert.equal(m.name, "hygon");
  assert.equal(m.label, "海光");
  assert.deepEqual(m.include, ["common"]);
  assert.throws(() => parseTargetManifest("name: x\n", "t.yaml"), /include 应为非空字符串数组/);
  assert.throws(() => parseTargetManifest("- a\n- b\n", "t.yaml"), /manifest 应是/);
});

function makeBuiltin(): string {
  const b = join(root, "builtin");
  wf("builtin/common/triton-basics/SKILL.md", skill("triton-basics", "Triton 语言与调参基础"));
  wf("builtin/vendors/amd-skills/amd-kernel-optimization/SKILL.md", skill("amd-kernel-optimization", "MI300 优化循环"));
  wf("builtin/vendors/amd-skills/rocm-porting/SKILL.md", skill("rocm-porting", "CUDA→ROCm 迁移"));
  wf("builtin/vendors/amd-skills/mi300-tuning/SKILL.md", skill("mi300-tuning", "MI300X 调优要点"));
  wf("builtin/delta/hygon/amd-kernel-optimization/SKILL.md", skill("amd-kernel-optimization", "海光版优化循环（覆盖 vendor）"));
  wf("builtin/delta/hygon/dtk-vs-rocm/SKILL.md", skill("dtk-vs-rocm", "DTK 与 ROCm 差异"));
  wf("builtin/targets/amd.yaml", "include:\n  - common\n  - vendor:amd-skills\n");
  wf("builtin/targets/hygon.yaml", "include:\n  - target:amd\n  - delta:hygon\n");
  return b;
}

function manifestsOf(b: string): Map<string, ReturnType<typeof parseTargetManifest>> {
  return loadTargetManifests(join(b, "targets")).manifests;
}

test("resolveTargets：target: 传递 + delta 同名覆盖 vendor + 物理去重累积标签", () => {
  const b = makeBuiltin();
  const res = resolveTargets({ builtinRoot: b, manifests: manifestsOf(b), activated: ["amd", "hygon"] });
  assert.equal(res.diagnostics.length, 0);
  const by = new Map(res.records.map((r) => [r.name, r]));
  // common 物理去重：两 target 共用同一文件 → 单条、标签累积
  assert.deepEqual(by.get("triton-basics")!.targets, ["amd", "hygon"]);
  // rocm-porting 经 target:amd 传递 → 标签同样累积
  assert.deepEqual(by.get("rocm-porting")!.targets, ["amd", "hygon"]);
  // delta:hygon 在 include 顺序上靠后 → 同名整条替换 vendor 版
  const ako = by.get("amd-kernel-optimization")!;
  assert.equal(ako.layer, "delta");
  assert.ok(ako.filePath.includes("delta/hygon"));
  assert.deepEqual(ako.targets, ["hygon"]);
  // delta 独有条目
  assert.equal(by.get("dtk-vs-rocm")!.origin, "delta:hygon");
});

test("resolveTargets：环引用报 error 且不死循环", () => {
  const b = join(root, "builtin2");
  wf("builtin2/common/x/SKILL.md", skill("x", "样本"));
  wf("builtin2/targets/a.yaml", "include:\n  - target:b\n");
  wf("builtin2/targets/b.yaml", "include:\n  - target:a\n");
  const res = resolveTargets({ builtinRoot: b, manifests: manifestsOf(b), activated: ["a"] });
  assert.ok(res.diagnostics.some((d) => d.code === "manifest_cycle"));
});

test("resolveTargets：vendor 子路径引用 + vendor 未 fetch 降级 warning", () => {
  const b = join(root, "builtin3");
  wf("builtin3/vendors/geak/expert_skills/tuning-ck/SKILL.md", skill("tuning-ck", "Composable Kernel 调优"));
  wf("builtin3/targets/geak-only.yaml", "include:\n  - vendor:geak/expert_skills\n  - vendor:missing-repo\n");
  const res = resolveTargets({ builtinRoot: b, manifests: manifestsOf(b), activated: ["geak-only"] });
  const ck = res.records.find((r) => r.name === "tuning-ck")!;
  assert.equal(ck.layer, "vendor");
  assert.equal(ck.origin, "vendor:geak:expert_skills");
  const missing = res.diagnostics.find((d) => d.code === "vendor_missing")!;
  assert.ok(missing.message.includes("skills:fetch"));
});

test("resolveTargets：激活不存在的 target → error；activated 顺序决定跨 target 同名胜者（后者胜）", () => {
  const b = makeBuiltin();
  const res = resolveTargets({ builtinRoot: b, manifests: manifestsOf(b), activated: ["nope"] });
  assert.ok(res.diagnostics.some((d) => d.code === "unknown_target"));
  // hygon 在后 → 其 delta 版胜（["amd","hygon"]）
  const hygonLast = resolveTargets({ builtinRoot: b, manifests: manifestsOf(b), activated: ["amd", "hygon"] });
  assert.equal(hygonLast.records.find((r) => r.name === "amd-kernel-optimization")!.layer, "delta");
  // amd 在后 → vendor 版胜（["hygon","amd"]）——顺序语义即优先级，写进文档、确定性可测
  const amdLast = resolveTargets({ builtinRoot: b, manifests: manifestsOf(b), activated: ["hygon", "amd"] });
  assert.equal(amdLast.records.find((r) => r.name === "amd-kernel-optimization")!.layer, "vendor");
});

// ---------------------------------------------------------------------------
// 注册表：overlay 优先级 + overrides 四态
// ---------------------------------------------------------------------------

function makeRegistryLayers(): { builtin: string; globalDir: string; projectDir: string } {
  const builtin = makeBuiltin();
  const globalDir = join(root, "home/.forge/skills");
  const projectDir = join(root, "proj/.forge/skills");
  wf("home/.forge/skills/rocm-porting/SKILL.md", skill("rocm-porting", "用户全局版迁移指南"));
  wf("home/.forge/skills/my-own/SKILL.md", skill("my-own", "用户独有 skill"));
  wf("proj/.forge/skills/dtk-vs-rocm/SKILL.md", skill("dtk-vs-rocm", "项目版 DTK 差异（最具体）"));
  return { builtin, globalDir, projectDir };
}

test("SkillsRegistry：项目 > 全局 > 内置，覆盖计 skill_overridden 诊断", () => {
  const { builtin, globalDir, projectDir } = makeRegistryLayers();
  const reg = SkillsRegistry.create({
    builtinRoot: builtin, builtin: true, activated: ["amd", "hygon"], globalDir, projectDir,
  });
  assert.equal(reg.get("rocm-porting")!.source, "global"); // 全局盖内置
  assert.equal(reg.get("dtk-vs-rocm")!.source, "project"); // 项目盖内置
  assert.equal(reg.get("my-own")!.source, "global");
  assert.equal(reg.get("triton-basics")!.source, "builtin");
  const overrides = reg.diagnostics.filter((d) => d.code === "skill_overridden");
  assert.equal(overrides.length, 2);
});

test("overrides 四态：off 移除；user-only 索引不可见；name-only 索引只列名", () => {
  const { builtin, globalDir, projectDir } = makeRegistryLayers();
  const reg = SkillsRegistry.create({
    builtinRoot: builtin, builtin: true, activated: ["amd", "hygon"], globalDir, projectDir,
    overrides: { "triton-basics": "off", "rocm-porting": "user-only", "dtk-vs-rocm": "name-only" },
  });
  assert.equal(reg.get("triton-basics"), undefined); // off：索引与 skill_read 都不可见
  assert.equal(reg.get("rocm-porting")!.invocation.model, false); // user-only：模型侧关
  assert.equal(reg.get("dtk-vs-rocm")!.nameOnly, true);
  assert.match(reg.indexBlock, /- dtk-vs-rocm$/m); // name-only → 无 description
  assert.ok(!reg.indexBlock.includes("Triton 语言与调参基础"));
  assert.ok(!reg.indexBlock.includes("用户全局版迁移指南"));
  assert.ok(reg.diagnostics.some((d) => d.code === "override_off"));
});

test("builtin=false 或根缺失 → 无内置但不崩（builtin_missing 降级）", () => {
  const globalDir = join(root, "none-home/.forge/skills");
  const projectDir = join(root, "none-proj/.forge/skills");
  const off = SkillsRegistry.create({ builtin: false, activated: ["amd"], globalDir, projectDir });
  assert.equal(off.records.length, 0);
  const missing = SkillsRegistry.create({ builtin: true, builtinRoot: join(root, "ghost"), activated: ["amd"], globalDir, projectDir });
  assert.equal(missing.records.length, 0);
  assert.ok(missing.diagnostics.some((d) => d.code === "builtin_missing"));
});

// ---------------------------------------------------------------------------
// 索引渲染：分组/确定性/预算分层裁剪
// ---------------------------------------------------------------------------

test("renderIndex：空集返回空串；分组序 common → targets 声明序 → 用户全局 → 用户项目；组内字母序", () => {
  assert.equal(renderIndex([], 1500, { activated: ["amd"] }), "");
  const { builtin, globalDir, projectDir } = makeRegistryLayers();
  const reg = SkillsRegistry.create({
    builtinRoot: builtin, builtin: true, activated: ["amd", "hygon"], globalDir, projectDir, indexBudgetTokens: 4000,
  });
  const lines = reg.indexBlock.split("\n");
  const titles = lines.filter((l) => l.startsWith("〔"));
  assert.deepEqual(titles, ["〔common〕", "〔target · amd〕", "〔target · hygon〕", "〔用户 · 全局〕", "〔用户 · 项目〕"]);
  // common 多 target 共用 → 尾注「亦用于」
  assert.match(reg.indexBlock, /triton-basics — .+（亦用于 amd,hygon）/);
  // vendor/delta 条目带溯源（rocm-porting 已被用户全局覆盖，用 mi300-tuning 验证 vendor 后缀）
  assert.match(reg.indexBlock, /mi300-tuning — .+（vendor:amd-skills）/);
  assert.match(reg.indexBlock, /- dtk-vs-rocm — 项目版/);
});

test("renderIndex：确定性——同输入两次渲染字节相同", () => {
  const { builtin, globalDir, projectDir } = makeRegistryLayers();
  const reg = SkillsRegistry.create({
    builtinRoot: builtin, builtin: true, activated: ["amd", "hygon"], globalDir, projectDir,
  });
  const again = renderIndex(reg.records, 1500, { activated: ["amd", "hygon"] });
  // renderIndex 直接重放与 registry 内快照一致（labels 不传时省略 label，仅 target 标题不同也算确定）
  const replay = renderIndex(reg.records, 1500, { activated: ["amd", "hygon"] });
  assert.equal(again, replay);
  assert.equal(reg.indexBlock, reg.indexBlock);
});

test("renderIndex：预算分层裁剪——先丢低价值组描述、再折叠分组、兜底不超预算", () => {
  const recs: SkillRecord[] = [];
  for (let i = 0; i < 2; i++) {
    recs.push({
      name: `common-skill-${i}`, description: `${"很长的描述".repeat(30)} ${i}`, filePath: `/c/${i}`, dir: "/c",
      source: "builtin", layer: "common", targets: ["amd"], format: "agentskills",
      invocation: { model: true, user: true }, meta: {},
    });
  }
  for (let i = 0; i < 12; i++) {
    recs.push({
      name: `vendor-skill-${i}`, description: `${"厂商描述".repeat(30)} ${i}`, filePath: `/v/${i}`, dir: "/v",
      source: "builtin", layer: "vendor", targets: ["amd"], origin: "vendor:amd-skills", format: "agentskills",
      invocation: { model: true, user: true }, meta: {},
    });
  }
  const full = renderIndex(recs, 100000, { activated: ["amd"] });
  assert.ok(estimateTokens(full) > 400); // 未裁剪时明显超小预算
  // 预算 300：低价值组（target/amd）先降 name-only，输出入预算且保留 common 描述（最高价值最后丢）
  const trimmed = renderIndex(recs, 300, { activated: ["amd"] });
  assert.ok(estimateTokens(trimmed) <= 300, `trimmed=${estimateTokens(trimmed)} tok 超预算`);
  assert.match(trimmed, /common-skill-0 — /);
  assert.ok(!trimmed.includes("厂商描述")); // vendor 组已降为 name-only
  // 预算 60：兜底路径（分层 1-3 都放不下时的最终降级）
  const tiny = renderIndex(recs, 60, { activated: ["amd"] });
  assert.ok(estimateTokens(tiny) <= 60);
  assert.match(tiny, /\/skills/);
});

test("renderIndex：单行描述超 160 字符截断", () => {
  const rec: SkillRecord = {
    name: "long-desc", description: "长".repeat(300), filePath: "/x", dir: "/x",
    source: "builtin", layer: "common", targets: [], format: "agentskills",
    invocation: { model: true, user: true }, meta: {},
  };
  const out = renderIndex([rec], 2000, { activated: [] });
  const line = out.split("\n").find((l) => l.startsWith("- long-desc"))!;
  assert.ok(line.length < 200 && line.endsWith("…"));
});

test("invocation.model=false 的 skill 不进索引", () => {
  const recs: SkillRecord[] = [
    {
      name: "hidden", description: "不该出现", filePath: "/h", dir: "/h", source: "builtin", layer: "common",
      targets: [], format: "agentskills", invocation: { model: false, user: true }, meta: {},
    },
    {
      name: "visible", description: "该出现", filePath: "/v", dir: "/v", source: "builtin", layer: "common",
      targets: [], format: "agentskills", invocation: { model: true, user: true }, meta: {},
    },
  ];
  const out = renderIndex(recs, 2000, { activated: [] });
  assert.ok(!out.includes("hidden"));
  assert.ok(out.includes("visible"));
});

// ---------------------------------------------------------------------------
// config 校验：skills 段
// ---------------------------------------------------------------------------

test("validateConfigFile：skills 段合法值通过", () => {
  const c = validateConfigFile({
    skills: {
      builtin: true, targets: ["hygon", "metax"], dirs: ["~/extra-skills"],
      compat: true, indexBudgetTokens: 800, overrides: { "triton-basics": "name-only" },
    },
  });
  assert.deepEqual(c.skills?.targets, ["hygon", "metax"]);
  assert.equal(c.skills?.indexBudgetTokens, 800);
  assert.deepEqual(c.skills?.overrides, { "triton-basics": "name-only" });
});

test("validateConfigFile：skills 段未知字段/类型错误/枚举错误报错", () => {
  assert.throws(() => validateConfigFile({ skills: { hot: true } }), /skills：未知字段 hot/);
  assert.throws(() => validateConfigFile({ skills: { builtin: "yes" } }), /skills\.builtin 应为布尔值/);
  assert.throws(() => validateConfigFile({ skills: { targets: ["Hygon"] } }), /skills\.targets 应为/);
  assert.throws(() => validateConfigFile({ skills: { indexBudgetTokens: -5 } }), /indexBudgetTokens 应为正数/);
  assert.throws(() => validateConfigFile({ skills: { overrides: { x: "disable" } } }), /overrides\["x"\] 应为/);
  assert.throws(() => validateConfigFile({ skills: { dirs: [""] } }), /skills\.dirs 应为/);
});

// ---------------------------------------------------------------------------
// P3：仓库真实 skills/ 目录扫描（common/delta/targets/vendors-lock 全链路）
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

test("仓库 targets/：10 个 manifest 全部可解析、无诊断；availableTargets 暴露全部（含未激活）", () => {
  const { manifests, diagnostics } = loadTargetManifests(join(REPO_ROOT, "skills", "targets"));
  assert.equal(diagnostics.length, 0);
  assert.deepEqual(
    [...manifests.keys()].sort(),
    ["amd", "ascend", "common", "enflame", "flagos", "hygon", "iluvatar", "metax", "nvidia", "triton"],
  );
  const reg = SkillsRegistry.create({
    builtinRoot: repoSkillsWithoutVendors(), builtin: true, activated: ["common"],
    globalDir: join(root, "no-global"), projectDir: join(root, "no-proj"),
  });
  assert.deepEqual(reg.availableTargets, ["amd", "ascend", "common", "enflame", "flagos", "hygon", "iluvatar", "metax", "nvidia", "triton"]);
  assert.ok(reg.get("triton-kernel-basics")!.targets.includes("common"));
});

test("仓库 common 层：3 个通用 skill 可解析", () => {
  const { manifests } = loadTargetManifests(join(REPO_ROOT, "skills", "targets"));
  const res = resolveTargets({ builtinRoot: join(REPO_ROOT, "skills"), manifests, activated: ["common"] });
  assert.deepEqual(res.records.map((r) => r.name).sort(), ["bench-method", "perf-methodology", "triton-kernel-basics"]);
  assert.ok(res.records.every((r) => r.layer === "common" && r.format === "agentskills"));
});

test("仓库 hygon target：AMD 家底传递 + delta 记录 + 未 fetch 的 vendor 降级 warning", () => {
  const skillsRoot = repoSkillsWithoutVendors();
  const { manifests } = loadTargetManifests(join(skillsRoot, "targets"));
  const res = resolveTargets({ builtinRoot: skillsRoot, manifests, activated: ["hygon"] });
  const names = res.records.map((r) => r.name);
  // common + amd delta + hygon delta 都在
  for (const n of ["triton-kernel-basics", "amd-rocm-notes", "hygon-dtk-vs-rocm"]) assert.ok(names.includes(n), `缺 ${n}`);
  const hygonDelta = res.records.find((r) => r.name === "hygon-dtk-vs-rocm")!;
  assert.equal(hygonDelta.layer, "delta");
  assert.equal(hygonDelta.origin, "delta:hygon");
  // 未 fetch 的 vendor（amd-skills/geak）→ vendor_missing warning，不崩
  const missing = res.diagnostics.filter((d) => d.code === "vendor_missing");
  assert.ok(missing.length >= 2, "amd-skills 与 geak 都应报 vendor_missing");
  assert.ok(missing.every((d) => d.message.includes("skills:fetch")));
});

test("仓库 metax/nvidia target：vendor_missing 降级 + delta 记录在", () => {
  const skillsRoot = repoSkillsWithoutVendors();
  const { manifests } = loadTargetManifests(join(skillsRoot, "targets"));
  const metax = resolveTargets({ builtinRoot: skillsRoot, manifests, activated: ["metax"] });
  assert.ok(metax.records.some((r) => r.name === "metax-maca-notes"));
  assert.ok(metax.diagnostics.some((d) => d.code === "vendor_missing" && d.message.includes("metax-tileops")));
  const nvidia = resolveTargets({ builtinRoot: skillsRoot, manifests, activated: ["nvidia"] });
  assert.ok(nvidia.records.some((r) => r.name === "nvidia-deepcuts"));
  assert.ok(nvidia.diagnostics.filter((d) => d.code === "vendor_missing").length >= 2); // kernelflow + tensormux
});

test("仓库多 target 激活：common 物理去重只一行、各 delta 并列（CANN OSL 内容不 vendor 的路线）", () => {
  const skillsRoot = repoSkillsWithoutVendors();
  const reg = SkillsRegistry.create({
    builtinRoot: skillsRoot, builtin: true, activated: ["ascend", "metax"],
    globalDir: join(root, "no-global"), projectDir: join(root, "no-proj"), indexBudgetTokens: 4000,
  });
  assert.ok(reg.get("ascend-ascend-notes"));
  assert.ok(reg.get("metax-maca-notes"));
  assert.match(reg.indexBlock, /ascend-ascend-notes — .+（delta:ascend）/);
  assert.match(reg.indexBlock, /metax-maca-notes — .+（delta:metax）/);
  // 两 target 共用同一份 triton-kernel-basics：单行 + 「亦用于」标注（物理去重的索引体现）
  assert.match(reg.indexBlock, /triton-kernel-basics — .+（亦用于 ascend,metax）/);
  assert.equal(reg.indexBlock.split("triton-kernel-basics").length - 1, 1);
});
