import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONVERGENT_SYSTEM_PROMPT,
  buildConvergentTask,
  parseVerdict,
  buildClassifierPrompt,
  parseClassification,
  buildContinueFeedback,
  buildGoalKickoff,
  ConvergeController,
  DEFAULT_CONVERGE_MAX_TURNS,
} from "../src/kernel/converge.js";

// ── parseVerdict ──────────────────────────────────────────────────────────

test("parseVerdict：YES / NO 大小写不敏感，抽出 REASON", () => {
  const y = parseVerdict("VERDICT: YES\nREASON: 三处调用都已迁移，grep 旧 API 无命中。");
  assert.equal(y.verdict, "yes");
  assert.match(y.reason, /grep 旧 API 无命中/);

  const n = parseVerdict("verdict: no\nreason: src/legacy 下仍有 2 处旧调用。");
  assert.equal(n.verdict, "no");
  assert.match(n.reason, /2 处旧调用/);
});

test("parseVerdict：解析不到明确 VERDICT → 放行判 yes（拿不准放行，用户复核）", () => {
  const a = parseVerdict("我觉得应该差不多完成了吧");
  assert.equal(a.verdict, "yes");
  assert.match(a.reason, /未给出可解析裁决|放行/);
  assert.equal(parseVerdict("").verdict, "yes");
});

test("parseVerdict：有 VERDICT 无 REASON 行 → 用末段文本兜底", () => {
  const v = parseVerdict("我核验了测试输出。\nVERDICT: NO\ntsc 报 1 处类型错误未修");
  assert.equal(v.verdict, "no");
  assert.match(v.reason, /类型错误/);
});

test("parseVerdict：多行 REASON 完整保留", () => {
  const v = parseVerdict("VERDICT: NO\nREASON: 第一点没做完。\n还差第二点。");
  assert.equal(v.verdict, "no");
  assert.match(v.reason, /第一点/);
  assert.match(v.reason, /第二点/);
});

// ── buildConvergentTask ──────────────────────────────────────────────────────

test("buildConvergentTask：含目标原文 + 文件清单 + 硬指标 + 声明降级标注", () => {
  const t = buildConvergentTask({
    goal: "把所有 foo() 调用迁移到 bar()",
    changedFiles: ["src/a.ts", "src/b.ts"],
    checks: [{ command: "npm test", exitCode: 1, output: "1 failing" }],
    agentClaim: "我已全部迁移完毕",
  });
  assert.match(t, /把所有 foo\(\) 调用迁移到 bar\(\)/); // 目标逐字
  assert.match(t, /- src\/a\.ts/);
  assert.match(t, /- src\/b\.ts/);
  assert.match(t, /exit=1/); // 硬指标退出码可见
  assert.match(t, /不得作为通过依据/); // 声明被明确降级
  assert.match(t, /我已全部迁移完毕/);
});

test("buildConvergentTask：零改动 → 提示这可能是没干活的信号", () => {
  const t = buildConvergentTask({ goal: "随便", changedFiles: [] });
  assert.match(t, /没有任何文件改动/);
  assert.match(t, /没真正干活/);
});

test("buildConvergentTask：无声明 → 兜底文案", () => {
  const t = buildConvergentTask({ goal: "g", changedFiles: ["x.ts"] });
  assert.match(t, /未提供声明/);
});

test("buildGoalKickoff：含目标 + 强制 submit_for_review + 提问豁免", () => {
  const k = buildGoalKickoff("让测试全过");
  assert.match(k, /让测试全过/);
  assert.match(k, /submit_for_review/);
  assert.match(k, /提问|澄清/);
});

// ── 分类器 ───────────────────────────────────────────────────────────────────

test("parseClassification：三类各自识别", () => {
  assert.equal(parseClassification("claims_done"), "claims_done");
  assert.equal(parseClassification("asking_user"), "asking_user");
  assert.equal(parseClassification("blocked"), "blocked");
});

test("parseClassification：宽松匹配自然语言", () => {
  assert.equal(parseClassification("It looks done to me"), "claims_done");
  assert.equal(parseClassification("It is asking the user a question"), "asking_user");
  assert.equal(parseClassification("The agent is blocked on an error"), "blocked");
});

test("parseClassification：辨认不出 → 保守 asking_user（交回用户）", () => {
  assert.equal(parseClassification("¯\\_(ツ)_/¯"), "asking_user");
  assert.equal(parseClassification(""), "asking_user");
});

test("buildClassifierPrompt：包含被分类的最后消息", () => {
  const p = buildClassifierPrompt("我已经把功能实现完了");
  assert.match(p, /我已经把功能实现完了/);
  assert.match(p, /claims_done/);
});

// ── ConvergeController ───────────────────────────────────────────────────────

test("ConvergeController：set / active / goal / clear", () => {
  const c = new ConvergeController();
  assert.equal(c.active, false);
  c.set("  让测试通过  ");
  assert.equal(c.active, true);
  assert.equal(c.goal, "让测试通过"); // trim
  c.clear();
  assert.equal(c.active, false);
  assert.equal(c.goal, "");
});

test("ConvergeController：YES → done 并清空目标", () => {
  const c = new ConvergeController();
  c.set("g");
  const d = c.decide({ verdict: "yes", reason: "全部判据有据可证" });
  assert.equal(d.action, "done");
  assert.match((d as { reason: string }).reason, /有据可证/);
  assert.equal(c.active, false); // 达成后自动清
});

test("ConvergeController：NO → continue，feedback 含目标与理由", () => {
  const c = new ConvergeController();
  c.set("迁移全部调用");
  const d = c.decide({ verdict: "no", reason: "还剩 3 处没迁" });
  assert.equal(d.action, "continue");
  const fb = (d as { feedback: string }).feedback;
  assert.match(fb, /迁移全部调用/);
  assert.match(fb, /还剩 3 处没迁/);
  assert.match(fb, /submit_for_review/);
  assert.equal(c.active, true); // 未通过，目标仍在
  assert.equal(c.lastReason, "还剩 3 处没迁");
  assert.equal(c.turns, 1);
});

test("ConvergeController：达到轮数上限 → stop 并清空", () => {
  const c = new ConvergeController();
  c.set("难搞的目标", 2);
  assert.equal(c.decide({ verdict: "no", reason: "差一点" }).action, "continue");
  const d = c.decide({ verdict: "no", reason: "还是差一点" });
  assert.equal(d.action, "stop");
  assert.match((d as { reason: string }).reason, /达到 2 轮验收上限/);
  assert.equal(c.active, false);
});

test("ConvergeController：无活动目标时 decide 抛错", () => {
  const c = new ConvergeController();
  assert.throws(() => c.decide({ verdict: "yes", reason: "x" }), /没有进行中的 converge/);
});

test("默认轮数上限是正数（护栏存在）", () => {
  assert.ok(DEFAULT_CONVERGE_MAX_TURNS > 0);
});

test("CONVERGENT_SYSTEM_PROMPT：核心原则在场（只认证据 / 拿不准放行 / 输出 VERDICT）", () => {
  assert.match(CONVERGENT_SYSTEM_PROMPT, /只认你亲自拉到 \/ 跑出来的证据/);
  assert.match(CONVERGENT_SYSTEM_PROMPT, /VERDICT: YES/);
  assert.match(CONVERGENT_SYSTEM_PROMPT, /不得作为通过依据/);
  assert.match(CONVERGENT_SYSTEM_PROMPT, /判 NO 需要明确反证/);
  assert.match(CONVERGENT_SYSTEM_PROMPT, /拿不准就放行/);
});

test("buildContinueFeedback：含目标 + 理由 + 重新提交指引", () => {
  const fb = buildContinueFeedback("目标X", "理由Y");
  assert.match(fb, /目标X/);
  assert.match(fb, /理由Y/);
  assert.match(fb, /submit_for_review/);
});
