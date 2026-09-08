import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SkillsRegistry } from "../src/kernel/skills.js";
import { makeSkillTools } from "../src/tools/skill-tool.js";

/** P2：skill_read 工具——白名单、幂等（D7）、分段读、资源清单、截断。 */

let root = "";
let registry: SkillsRegistry;
let tool: ReturnType<typeof makeSkillTools>[number];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forge-skilltool-"));
  const wf = (rel: string, content: string): void => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf8");
  };
  wf("proj/.forge/skills/long-doc/SKILL.md",
    "---\nname: long-doc\ndescription: 长文档样本\n---\n\n开头。\n\n## 调参\n\nnum_warps 建议 4/8。\n\n## 迁移\n\n见 references。\n");
  wf("proj/.forge/skills/long-doc/references/isa.md", "ISA 备忘");
  wf("proj/.forge/skills/long-doc/scripts/bench.sh", "#!/bin/sh\n");
  wf("proj/.forge/skills/huge/SKILL.md", `---\nname: huge\ndescription: 巨大正文\n---\n\n${"行。".repeat(6000)}`);
  wf("proj/.forge/skills/locked/SKILL.md", "---\nname: locked\ndescription: user-only 样本\ndisable-model-invocation: true\n---\n正文");
  registry = SkillsRegistry.create({
    builtin: false, activated: ["common"],
    globalDir: join(root, "none-global"), projectDir: join(root, "proj/.forge/skills"),
  });
  tool = makeSkillTools(registry, join(root, "proj"))[0]!;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function read(params: { name: string; section?: string }): Promise<{ text: string; details: Record<string, unknown> }> {
  const r = await tool.execute("id", params as never);
  return { text: (r.content[0] as { text: string }).text, details: (r.details ?? {}) as Record<string, unknown> };
}

test("正常读取：frontmatter 剥离、正文完整、资源清单列出", async () => {
  const { text, details } = await read({ name: "long-doc" });
  assert.match(text, /\[skill: long-doc\]/);
  assert.match(text, /## 调参/);
  assert.ok(!text.includes("description: 长文档样本"), "frontmatter 不应出现在正文里");
  assert.match(text, /references\/isa\.md/);
  assert.match(text, /scripts\/bench\.sh/);
  assert.equal(details.ok, true);
  assert.equal(details.name, "long-doc");
});

test("D7 会话内幂等：同 name 二次调用只返回短注记，不重复注入", async () => {
  const first = await read({ name: "long-doc" });
  assert.ok(!first.details.deduped);
  const second = await read({ name: "long-doc" });
  assert.equal(second.details.deduped, true);
  assert.match(second.text, /已加载过/);
  assert.ok(!second.text.includes("## 调参"), "正文不应重复注入");
  // section 参数不受幂等拦截（分段读是正常需求）
  const section = await read({ name: "long-doc", section: "调参" });
  assert.match(section.text, /num_warps/);
  assert.ok(!section.text.includes("## 迁移"), "只取命中段");
});

test("section 未命中 → 可读错误", async () => {
  const { text, details } = await read({ name: "long-doc", section: "不存在的段" });
  assert.equal(details.ok, false);
  assert.match(text, /没有匹配/);
});

test("注册表外 name → 可读错误 + 前缀建议", async () => {
  const { text, details } = await read({ name: "long" });
  assert.equal(details.ok, false);
  assert.match(text, /未找到 skill「long」/);
  assert.match(text, /long-doc/); // 建议列表
});

test("user-only（disable-model-invocation）→ 拒绝模型侧调用", async () => {
  const { text, details } = await read({ name: "locked" });
  assert.equal(details.ok, false);
  assert.match(text, /user-only/);
  assert.match(text, /\/skills locked/);
});

test("超长正文走 artifacts 截断（首尾 + section 提示）", async () => {
  const { text, details } = await read({ name: "huge" });
  assert.equal(details.truncated, true);
  assert.match(text, /已截断/);
  assert.match(text, /section 参数/);
});

test("P4：成功加载记入 registry.usedList（幂等去重；失败不记）", async () => {
  assert.deepEqual(registry.usedList(), []);
  await read({ name: "long-doc" });
  await read({ name: "long-doc" }); // 幂等的重复调用不重复记
  await read({ name: "locked" }); // user-only 拒绝 → 不记
  await read({ name: "nope" }); // 未找到 → 不记
  assert.deepEqual(registry.usedList(), ["long-doc"]);
});
