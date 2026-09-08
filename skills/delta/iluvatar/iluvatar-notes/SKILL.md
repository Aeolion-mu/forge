---
name: iluvatar-iluvatar-notes
description: 天数智芯 Iluvatar Corex（IX 系列 GPU）算子开发要点：TLE/FlyDSL/FlagGems 三条现成路线与已知硬约束（SME G2S 32B 对齐等）。目标芯片是天数时读。
license: MIT
---

# 天数智芯：现成路线与硬约束

天数官方无独立 skills 仓，但三条半现成路线都验证过存在：

## 路线

- **FlagOS 线（最快上手）**：`flagos-ai/skills`（Apache-2.0）的 `kernelgen-flagos`（算子生成总控，references 内含 `_iluvatar` 后端规范）与 `tle-developer-flagos`（**TLE** kernel 开发，TLE 支持天数）；`install-stack-flagos` 走 `USE_ILUVATAR_COREX=1`。
- **FlyDSL 线（官方，深度定制）**：`Deep-Spark/FlyDSL`（天数官方，fork 自 AMD FlyDSL，`iluvatar` 分支）。`.claude/skills/` 下 16 个 kernel skill 继承 AMD 上游；**天数特化知识在 `.cursor/rules/`（3 条硬约束）与 `README_Iluvatar.md`（FlyIXDL 后端 MR/CQ 完整文档）**，另有 63 个 iluvatar kernel 源文件可作参考实现。
- **Triton 线**：FlagGems `_iluvatar/` 53 个天数 Triton 算子（KernelGen 生成）——支持特性的活样本。

## 已知硬约束（来自 FlyDSL 天数新增规则）

- **SME G2S 32B 对齐**：shared memory ↔ register 搬运的 32 字节对齐是硬约束，违反直接性能崩或错误。
- FlyIXDL 后端的 MR（memory request）/CQ（command queue）语义与 AMD 上游不同——读 `README_Iluvatar.md` 再动手。

## 资源与缺口

- 官方知识库：ixkb.iluvatar.com.cn（SDK 安装手册免登录；进阶文档在 support.iluvatar.com，需申请）。
- **缺口**：IXUCA C++ 层 API 差异文档不公开（需向官方申请）——涉及 IXUCA 原生开发时提前留出申请时间，或改走 TLE/Triton 线。
- 参考卡型：BI-V150（FlagOS vllm-plugin 的 references/iluvatar_gpu.md 有整篇环境说明）。
