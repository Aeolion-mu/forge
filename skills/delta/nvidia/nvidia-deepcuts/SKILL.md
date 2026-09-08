---
name: nvidia-deepcuts
description: NVIDIA 深化路线：官方 kernel-triton-writing/GEAK 级调优资源地图、CUTLASS/PTX/SASS 三层深入、闭环优化与 SASS 签名验证。做 CUDA 深度优化或写高性能模板时读。
license: MIT
---

# NVIDIA：深化路线图

NVIDIA 生态资料最厚，问题不是找不到而是选错层。按深度分层取用：

## 资源地图（按层）

- **Triton 层**：`NVIDIA/TensorRT-LLM` 仓内嵌官方 `.claude/skills/kernel-triton-writing`（SKILL.md + 9 份 references + verify/benchmark 脚本，质量标杆级）；同仓还有 kernel-cute-writing 等 29 个 kernel skill。
- **CUDA C++ 层**：`tensormux/kernel-skills`（MIT，35 个：gemm/softmax/layernorm/reduction/warp-divergence/smem-tiling/patterns）；`KernelFlow-ops/cuda-optimized-skill`（中文双语：roofline 轴预算 → 候选分支 → 消融归因 → **SASS 签名验证**的完整闭环 + 20 余脚本）。
- **PTX 层**：`ptx-isa-markdown`（PTX ISA 的 markdown 化，可检索）；内联 asm 与微调度优化前先查。
- **SASS/微架构层**：mit-han-lab 的 KernelWiki（Blackwell 知识库）；ncu 深度分析用 `ncu-report-skill` 的报告模板。
- **体系学习**：gpu-mode 讲座（106 讲，kernel 优化最大的免费课程库）；KernelBench/Tensara 练习场。

## 方法论本地件

- 优化闭环与消融归因：用 common/perf-methodology（其闭环设计即源自 KernelFlow 同款思路）。
- SASS 签名验证：优化后 dump SASS 对比关键循环的指令序列是否真的变了（防「源码改了、二进制没变」的假优化；编译器可能把你优化掉）。

## CUDA 专属要点

- GEMM 类直接评估 CUTLASS（含EvictionPolicy/Cluster/TMA 各代特性）能不能满足，别手写超出了自己维护能力的模板怪兽。
- Hopper/Blackwell 的 warp specialization 与 TMA/cluster 是结构性收益，优先于指令级微调。
- 压测纪律见 common/bench-method（ncu 采样与计时的预热/锁频要求同）。
