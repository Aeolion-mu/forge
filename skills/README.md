# forge 内置算子 skills（物理三态 × 逻辑组合）

> 布局与机制设计见 `docs/skills-management-plan.md`（§4）；厂商调研见 `docs/research/`。

```
skills/
  common/     L0 通用层（自建）：triton 语言、优化方法论、bench 方法、kernel 工程规范
  delta/      L2 厂商差异层（自建，薄）：只存「与家族常识不同之处」
              hygon/ metax/ iluvatar/ enflame/ nvidia/ amd/ ascend/
  vendors/    上游仓库原样快照（MIT/Apache 才可 vendor）+ skills.lock.json（repo/ref/license）
  targets/    每芯片一个 yaml，纯声明组合：common / delta:<v> / vendor:<n>[/<sub>] / target:<t>
```

## 约定

- 每个 skill 一个目录，`SKILL.md` 必含 `name`（与目录名一致，[a-z0-9-]）与 `description`（首句写清「何时用」）；
  附带资源放 `references/`（参考文档）、`scripts/`（可执行）、`assets/`（模板/数据）。
- 正文 ≤500 行；超长内容拆进 references/ 按需 `skill_read`。
- 引用上游内容：优先 `vendor:`（原样快照，更新走 `npm run skills:fetch`）；确需魔改则拷进 `delta/` 并在
  正文头部标注 fork 来源与日期（fork 即脱离上游，更新不自动跟进）。
- 协议纪律：vendors/ 只收 MIT/Apache-2.0/BSD；CANN OSL 等非标协议素材必须改写进 delta、不得原样 vendor。
