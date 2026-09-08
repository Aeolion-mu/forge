---
name: metax-maca-notes
description: 沐曦 MetaX（曦云 C280/C500，MACA 软件栈）算子开发要点：路线选择（MACA-C / torch_musa / TileLang-MACA）、官方调优指南位置与已知约束。目标芯片是沐曦时读。
license: MIT
---

# 沐曦 MetaX：MACA 栈要点

沐曦无官方 agent skills 仓；本条是路线图与资源指引（详细 API 以官方文档为准）。

## 路线选择（按任务类型）

- **Triton/TileLang 路线（首选，生态最顺）**：`tile-ai/tilelang-metax` 后端可用；沐曦官方 `TileOPs-Metax`（Gitee，MIT）是一套 spec 驱动的 TileLang 算子库工程流（14 个 skill：scaffold/implement/test/bench/align/review），做算子库开发直接按它的流程走。
- **MACA-C 原生路线**：性能天花板更高，语法细节看官方 `mxmaca-performance-tuning-guide`（Gitee，C500 架构、HW limitation checklist、编译参数共 10 章 + microbenchmark 案例）——**这是沐曦最值的一份公开调优资料**。
- **PyTorch 接入**：`torch_musa` 适配层（`torch.musa` 设备语义）；样例看官方 `maca-samples` 与 `mxmaca-courses` 教材站（maca-school.metax-tech.com）。

## 已知约束（写码前对一遍）

- 具体卡型号的 HW limitation（对齐、bank、精度支持）以 tuning-guide 的 checklist 为准——不同代际差异大，不要拿 CUDA 直觉套。
- FlagGems `_metax` 后端有沐曦目标的 Triton 算子实现可作参照（能编译的写法 = 该后端支持的特性子集）。
- 沐曦 AI Agent 算子赛事的 `op_optimization` 仓有 TileLang-MACA 的编译/测试实操指南（社区方案，思路可借鉴）。

## 工作纪律

- 环境版本对齐：MACA 版本 ↔ torch_musa 版本 ↔ 驱动版本三件套要配套，报「莫名编译错」先查这里。
- 基线与精度校验方法用 common/bench-method；性能闭环用 common/perf-methodology。
