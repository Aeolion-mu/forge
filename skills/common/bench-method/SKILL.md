---
name: bench-method
description: 算子基准测试的正确姿势：预热、时钟处理、统计口径（分位数而非均值）、精度校验与性能一起报。写 benchmark 或对比优化前后必读。
license: MIT
---

# 算子基准测试方法

## 时钟与预热

- CPU/GPU 都有动态频率：冷启动第一次运行必然偏慢。先跑 10-25 次 warmup 再计时。
- Triton 用官方 `triton.testing.do_bench`（默认处理了预热与时钟同步）；自写计时必须 `torch.cuda.synchronize()`（或对应后端的同步原语）后再取时间。
- 长时间压测会让芯片降频：对比实验放在相邻时间段跑，或锁定频率（能锁的话）。

## 统计口径

- 报**中位数或 P10/P90**，不报均值——一次内核调度抖动能把均值拉高一个档。
- 至少 100 次采样；报告里写明样本数与离散度。
- 吞吐类指标（tokens/s、GFLOPS、GB/s）和延迟一起报，换算关系写清楚 batch/shape。

## 对照实验纪律

- 优化前后**同一**：shape 集合、dtype、输入数据分布（随机种子固定）、编译缓存状态、机器负载。
- 多 shape 测试：至少覆盖 (小/中/大) × (方/瘦长/胖矮)，避免只对单 shape 过拟合。
- E2E 与 kernel 级分开测：fusion 的收益常在 launch 次数，单独计时 kernel 会看不到。

## 精度校验（和性能一起报，缺一不可）

- 参考实现定基准（PyTorch eager / 厂商库），`torch.testing.assert_close` 带 `rtol/atol` 显式写出来。
- 精度阈值不是拍脑袋：BF16 累加的 matmul 与 FP32 参考比，rtol 量级 1e-2 是正常的；写明你用的容差和依据。
- 全 shape 抽查 + 一个最坏 case 深查（最大 K、最丑 stride、batch=1 边界）。

## 反模式

- 只报最好的一次运行（cherry-picking）。
- 在 notebook 里测，后台还有训练进程抢 SM。
- 拿不同日期/不同机器的数字直接对比。
- 性能报了、精度没报——降精度提速是最常见的「假优化」。
