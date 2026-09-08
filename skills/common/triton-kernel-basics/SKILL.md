---
name: triton-kernel-basics
description: 写/改/调 Triton kernel 的工程基线：编程模型、tiling 与 mask、num_warps/num_stages 调参、常见性能陷阱与调试方法。任何 Triton 算子工作开始前先读。
license: MIT
---

# Triton Kernel 工程基线

适用于 openai/triton 及其各芯片后端（昇腾 triton-ascend、FlagTree 多后端、TileLang-Metax、Triton-GCU 等——后端差异见各厂商 delta skill）。

## 编程模型速查

- 一个 program 处理一个 tile：`pid = tl.program_id(axis)`，用 `tl.arange(0, BLOCK)` 构造块内索引。
- 显式 tiling：把问题切成 `BLOCK_M × BLOCK_N` 级块，循环 K 维累加；`tl.load/store` 带 `mask=` 与 `other=`，边界永远显式——不写 mask 是越界和静默错误的头号来源。
- 数据布局先行：确认输入是 row-major 还是 column-major，`tl.trans` / `tl.permute` 的代价要心里有数。
- accumulator 用 `tl.dot` 的 `acc` 参数跨 K 循环携带；精度按需 `allow_tf32` / `input_precision`。

## 调参基线（按此顺序试）

1. `num_warps`：从 4/8 起步。饱和 occupancy 但寄存器不溢出（看 ptxas/spill 报告）；tile 大常要更多 warp。
2. `num_stages`：软件流水深度。访存密集型提到 3-4 常有收益；寄存器压力大时回退。
3. BLOCK 尺寸：乘出 2 的幂；`BLOCK_M*N*K` 的组合决定共享内存用量，超限直接编译失败或静默降速。
4. 向量化：保证最内维连续访问（合并访存）；`tl.multiple_of` / `tl.max_contiguous` 给编译器对齐提示。
5. bank conflict：swizzle 或换 padding；NVIDIA 上用 `ncu --metrics l1tex__data_bank_conflicts` 验证。

## 常见陷阱

- 竞争性 API：不同 Triton 版本/后端的 `tl.dot` 精度参数名不同（`allow_tf32` vs `input_precision`），写版本守卫或注释说明目标版本。
- 不要在 kernel 里做 `print` 调试的残留留在压测里（会吞掉几倍性能）。
- host 侧每次 `kernel[grid](...)` 都有 launch 开销：压测要预热 + 多次取样（见 bench-method skill）。
- 后端差异不猜：目标芯片的手册/限制写在该厂商 delta skill 里，动手前对一遍。

## 调试方法

- 先用小尺寸 + `TRITON_INTERPRET=1`（CPU 解释执行）验证正确性，再上 GPU 调性能。
- dump IR：`TRITON_KERNEL_DUMP=1`；对比 ttgir/llir/ptx 三层定位「哪一层开始变慢」。
- 精度问题二分：先关 TF32/舍入优化复测，再查 mask 边界与 accumulator dtype。

## 参考实现库（读好的 kernel 比读文档快）

- FlagGems（FlagOpen/FlagGems）：200+ 算子、17 个厂商后端目录（`_ascend/_iluvatar/_enflame/_hygon/_metax/...`）——各厂后端写法的活样本。
- Liger-Kernel：fused kernel 设计范式（RMSNorm/SwiGLU/rope 的融合思路）。
- openai/triton `python/tutorials`：官方教学路径，按 01-10 顺序过一遍。
