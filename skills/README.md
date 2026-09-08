# forge 内置算子 skills（全量注册，rev3）

> 机制设计见 `docs/skills-management-plan.md`；厂商调研见 `docs/research/`。
> rev3：无开关——启动时**全量注册**（common → vendors/* → delta/* → 用户层），system prompt 只留
> 一行总量摘要，模型用 `skill_list`（翻清单）/ `skill_read`（读全文）按需翻阅。

```
skills/
  common/     L0 通用层（自建）：triton 语言、优化方法论、bench 方法、kernel 工程规范
  delta/      L2 厂商差异层（自建，薄）：只存「与家族常识不同之处」
              hygon/ metax/ iluvatar/ enflame/ nvidia/ amd/ ascend/
  vendors/    上游仓库原样快照（MIT/Apache 才可 vendor）+ skills.lock.json（repo/ref/license）
```

## 同名优先级（后读覆盖先读）

`common → vendors（字母序）→ delta（字母序）→ compat → 额外根 → ~/.forge/skills → <workdir>/.forge/skills`

delta 在 vendor 之后 = 厂商特化覆盖家底同名（如 hygon 版优化指南压过 amd vendor 版）；用户层永远最高。

## 约定

- 每个 skill 一个目录，`SKILL.md` 必含 `name`（与目录名一致，[a-z0-9-]）与 `description`（首句写清「何时用」）；
  附带资源放 `references/`（参考文档）、`scripts/`（可执行）、`assets/`（模板/数据）。
- 正文 ≤500 行；超长内容拆进 references/ 按需 `skill_read` 的 section 参数分段读。
- 引用上游内容：`npm run skills:fetch` 拉 vendor 快照（lock 锁 ref）；确需魔改则拷进 `delta/` 并在
  正文头部标注 fork 来源与日期（fork 即脱离上游，更新不自动跟进）。
- 协议纪律：vendors/ 只收 MIT/Apache-2.0/BSD；CANN OSL 等非标协议素材必须改写进 delta、不得原样 vendor。
