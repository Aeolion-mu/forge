---
name: ascend-ascend-notes
description: 昇腾 CANN/Ascend 算子开发路线：官方 skills 生态（cannbot-skills/agent-skills）入口、AscendC 与 triton-ascend 双路线、算子语料仓地图。目标芯片是昇腾时读。
license: MIT
---

# 昇腾：路线与资源地图

昇腾是国产线里 skills 生态最成熟的（官方在维护），**优先直接用官方件**：

## 官方 skills 生态（注意协议）

- **`gitcode.com/cann/cannbot-skills`**（CANN 官方，259 个 SKILL.md，gitcode 1300+★，活跃维护）：ops 70 / model / graph / runtime / infra / tools 分域 + 官方/社区插件；Triton 专项 7 个（`triton-op-generator` 是多 Agent 编排插件）。**协议为 CANN OSL v2.0（非标）——结构与流程可借鉴，内容不可拷入 forge**。
- **`gitcode.com/Ascend/agent-skills`**（华为官方总分发仓，216 个 SKILL.md）：official/（CANNBot、MindStudio、PyTorch、vllm-ascend、verl、MindSpeed）+ community/——「总分发仓 + 领域分区」的结构范本。
- 聚合入口：`ascend-ai-coding/awesome-ascend-skills`（自动同步三源）；`Ascend/ascendc-kernelgen-data`（算子生成训练数据集）。

## 双路线选择

- **AscendC 原生路线**：CANN 的算子开发语言（tile 级编程、Que/TPipe 内存管理）。上手看 CANN 官方文档 + `cann` 组织的算子实现仓（见下）。
- **Triton 路线（生态顺）**：`Ascend/agent-skills` 的 **Triton 全流程九件套**（dev 编排/design/env/code-gen/code-review/precision-eval/perf-eval/perf-optim/doc-gen）+ GPU→NPU 迁移 3 个 skill；配套 `triton-ascend` 编程指南。
- 论文参考：AgenticCANN、AscendOptimizer（agent 驱动昇腾算子优化的学术线）。

## 算子语料仓（gitcode `cann` 组织，参考实现用）

- `ops-math`（1227★）/ `ops-transformer`（1001★）：官方算子实现库——写新算子前先查是否已有实现与调参记录。
- `catlass`（434★）：昇腾版 CUTLASS——GEMM 类优化的模板库。
- `cann-bench`：算子评测平台（基线数字的权威来源）。
- `pypto`（758★）：Python 侧算子开发工具链。

## 工作纪律

- NPU 编程模型与 GPU 差异大（AI Core/Vector/ Cube 单元分工、显存层级）——GPU 直觉只做参考，以 CANN 文档为准。
- 性能闭环走 common/perf-methodology；profiler 用 msprof（命令对照：ncu/rocprof ↔ msprof）。
