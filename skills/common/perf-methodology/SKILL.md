---
name: perf-methodology
description: GPU/NPU 算子性能优化的通用闭环：roofline 定位 → 假设排序 → 单变量改动 → 消融归因 → 复测确认。任何「这个 kernel 慢」的任务都走这套流程。
license: MIT
---

# 算子性能优化闭环

方法论综合自 amd/GEAK 调优实践与 KernelFlow cuda-kernel-optimizer 的闭环设计（归因→候选→验证），适用于所有目标芯片。

## 第 0 步：先量化，别猜

- 拿到「慢」的第一件事：确定基线数字（latency / throughput / achieved FLOPS 与 bandwidth）。
- 算 roofline 位置：`achieved_mem_bw / peak_bw` 与 `achieved_flops / peak_flops` 哪个先顶到 1.0。
  - 带宽先顶满 → 访存密集：优化方向是合并访存、减少搬运、cache blocking、fusion。
  - 算力先顶满 → 计算密集：看指令mix、TF32/BF16/FP8 降精度、tensor core 利用率。
  - 都很低 → 有别的瓶颈：occupancy、同步、launch 开销、访存不合并、bank conflict。

## 闭环（每次只改一个变量）

1. **假设**：一句话写清「我认为瓶颈是 X，因为证据 Y（profiler 数字）」。
2. **候选**：列出 2-3 个针对性改动，按预期收益/实现成本排序。
3. **单变量改动**：一次只应用一个，其他保持不变。
4. **消融归因**：改动后必须能回答「快了/慢了多少，是哪个改动贡献的」。多改动混在一起的结果没有归因价值。
5. **复测确认**：压测方法见 bench-method skill；改善 < 噪声水平（通常 2-3%）视为无效改动，回退。

## Profiler 使用要点

- 计数器采样前先跑稳（锁频、预热）；对比时同一机器同一环境。
- 至少看三层：kernel 级（时间分布）→ 指令级（tensor core 占比、访存效率）→ 内存级（L2 命中、bank conflict）。
- 各芯片 profiler 名字不同（NVIDIA ncu / AMD rocprof / 海光 hipprof / 昇腾 msprof）：用该厂商 delta skill 里的命令对照。

## 写报告的纪律

- 每轮优化记录：基线 → 假设 → 改动（diff）→ 数字 → 归因结论。没有归因的「我改快了 20%」不可信。
- 负结果也记（哪条路试过没用），防止下个人重走。
