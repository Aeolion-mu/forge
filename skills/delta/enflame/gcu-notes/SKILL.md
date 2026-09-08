---
name: enflame-gcu-notes
description: 燧原 GCU（云燧 DTU）算子开发要点：官方文档全在 torch-gcu 仓内、自定义算子的 topscc+PrivateUse1 注册流程、分代差异与已知禁用项。目标芯片是燧原时读。
license: MIT
---

# 燧原 GCU：要点与路线

燧原官方无任何 agent skills；TopsRider 手册/topscc 编程指南**不公开**（随 installer 分发），developer.enflame.com 不可达——公开面最薄的厂商，先认清可用面：

## 官方资料主入口：`EnflameTechnology/torch-gcu` 的 manuals/（RST）

- **自定义算子指南**：topscc 编译 + PyTorch `PrivateUse1` 后端注册的全流程——燧原自定义算子的权威路径。
- **989 行算子支持列表**：哪些算子官方已实现/支持到什么程度，动手前先查这张表（避免重造已有算子）。
- **`transfer_to_gcu` CUDA 迁移对照**：CUDA 调用到 GCU 的映射表——从 CUDA 侧迁入的起点。
- 算子调试与 profiler 指南同在 manuals/ 下。

## Triton 路线（生态最厚）

- FlagGems `runtime/backend/_enflame/`：**412 个 GCU Triton 算子文件**（gcu300/gcu400 分代 + fused）——公开面最大的燧原算子语料。`VendorDescriptor` 里带各代限制（**fp64/int64 禁用**、`tle_enabled` 标记）。
- `flagos-ai/FlagTree` 的 `third_party/enflame`：Triton-GCU 编译后端（S60 环境 Docker）。

## C++ 底层路线

- `EnflameTechnology/hlir_builder_sample`：43 个 C++ TopsGraph 算子示例 + TopsGraph API HTML 手册。
- `findtops`：CMake 里把 TOPS 当一等语言用的工程化路径。

## 已知约束

- **FP8 禁用**（精度路线止步 BF16）；fp64/int64 在 FlagGems descriptor 标禁。
- **分代差异大**：gcu300 与 gcu400 的算子实现是分开的目录——写通用算子要两代都测。
- 版本纪律：torch-gcu 的 `+gcu` 本地版本号要与运行环境严格配套（efsmi 查卡、版本对不上是排障第一站）。
