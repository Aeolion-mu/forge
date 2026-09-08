---
name: amd-rocm-notes
description: AMD ROCm/HIP 深化路线：GEAK 专家调优体系（hipBLASLt/CK/aiter/vLLM）、MI300 系要点、rocprof v3 与官方资源地图。目标芯片是 AMD 或海光（HIP 同源）时读。
license: MIT
---

# AMD ROCm：深化路线图

## 官方资源地图（质量最高的一套，优先用）

- **`amd/skills`**（官方，MIT，四端兼容）：`magpie-kernel-evaluator`（基准→剖析→优化闭环）、`tracelens-analysis-orchestrator`（性能分析编排）。
- **`AMD-AGI/GEAK`**（官方，MIT）：`expert_skills/` 约 20 个专家调优 skill（tuning-hipblaslt / tuning-ck / tuning-aiter / tuning-triton / tuning-in-vllm）+ `perf_knowledge/` 586 篇知识库 + **operator×backend SOTA 注册表**（每个算子在各后端的最优实现与调参记录）——先查注册表再自己调。
- **`AMDResearch/intellikit`**：5 个 profiler skill（metrix/linex/nexus/kerncap/accordo）。
- **`jhinpan/ROCmKernelWiki`**：MI300/MI355 可检索知识库（**每条结论带 merged-PR 证据链**——可信度工程的范本）。
- HF kernels `rocm-kernels`：MI355X/R9700 的 Triton kernel + 禁忌清单。
- 中文入门：`datawhalechina/hello-rocm`（162★，教程内置中文 Skill）。

## MI300 系要点（CDNA3）

- wavefront=64（与 GCN/RDNA 的 32 不同——occupancy 计算和 wave 分配全按 64 来）。
- Infinity Fabric 带宽是 NUMA 效应来源：多 die（XCD）卡上的跨 die 访问要显式避开（数据布局按 die 亲和）。
- rocprof **v3** 命令体系与旧版差异大——用 `Arist12/AMD-Skills` 的 `rocprofv3-profiler` skill 对照写命令。

## CUDA→ROCm 迁移（Arist12 社区八阶段法）

1. hipify 全量转换 → 2. 编译清错 → 3. compute-sanitizer 清内存问题 → 4. 单元测试对齐精度 → 5. 性能基线 → 6. 逐 kernel 对照调优 → 7. wave64/矩阵核重写（WMMA 替换）→ 8. rocprof 归档复测。
铁律：先正确后快；每阶段有退出标准；不跳阶段。

## 给海光用

DTK 与 ROCm 同源：本条 + `hygon-dtk-vs-rocm`（差异表）合起来是海光的完整视图——API 层照本条，微架构层照差异表。
