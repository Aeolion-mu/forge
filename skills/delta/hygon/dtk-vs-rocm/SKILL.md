---
name: hygon-dtk-vs-rocm
description: 海光 DCU（DTK）与 AMD ROCm 的差异清单：哪些 AMD 经验直接可用、哪些必须改（DUMMA/BF16-only/hipprof/容器坑）。在海光上调 HIP kernel 或从 ROCm 迁移时读。
license: MIT
---

# 海光 DCU：DTK 与 ROCm 差异

海光 DCU（深算系列）技术栈 DTK 6.x 源自 ROCm/HIP 系。**AMD 的工具链与 API 知识大部分直接可用，微架构层差异必须逐条对**。

## 可直接复用（高迁移性）

- 工具链同名同形：`hipcc`、`hipify`、`hipBLAS`/`hipSPARSE` 等——AMD 的构建脚本和迁移流程基本照搬。
- wavefront=64（CDNA 同源）：wave 级优化（lane 分配、crosslane 指令）的经验成立。
- AMD 官方 skills（amd/skills、GEAK 的 tuning-hipblaslt/tuning-ck）中的 API 层与调优思路可直接参考。
- TileLang 路线：`tilelang-hygon` 后端 + `TileKernels-das`（海光官方 MIT 算子样例）可用。

## 必须改的差异（中迁移性，逐条核对）

| 项 | ROCm 惯例 | 海光 DCU 实况 |
|---|---|---|
| Tensor Core 编程 | WMMA/mfma（含 FP8 on MI300+） | **DUMMA**（非 WMMA，API 形态不同）；**Tensor Core 仅 BF16，无 FP8** |
| Profiler | rocprof | **hipprof** |
| 典型型号 | MI300X（CDNA3，gfx942） | K500SM（**gfx928**） |
| 精度路线 | FP8 可用 | FP8 禁用——精度优化止步 BF16 |

## CUDA 迁移：别走 GPUfusion 兼容层

GPUfusion（CUDA 兼容层）对重 PTX 代码是**已验证的死路**——直接重写为 HIP。流程用 AMD 的 `hipify` 语义：先 hipify-perl 全量转换，再手修 compute-sanitizer 报出的问题。

## 容器/环境坑（FlagOS gpu-container-setup 实测）

- 用 DCU 官方容器镜像，**不要把宿主机的 DTK 挂进容器**（版本/驱动错配的典型来源）。
- 容器内 HAL 层在 `/opt/hyhal/`——排查「设备不可见」先查这里与挂载。
- 镜像/文档源：光合社区（sourcefind）有 DTK 三件套 PDF（HIP C++ 编程指南 / Runtime API / 最佳实践）。

## 迁移 checklist

1. 确认 DTK 版本（`hipcc --version`）与目标卡型号（gfx928 → CDNA2 类优化边界）。
2. hipify 转换 → 编译过 → compute-sanitizer 清干净。
3. WMMA 代码路径重写为 DUMMA；FP8 路径降 BF16。
4. rocprof 命令换成 hipprof；对照 perf-methodology 闭环跑基线。
5. Triton 路线备选：FlagGems `_hygon` 后端有该卡的真实算子写法可对照。
