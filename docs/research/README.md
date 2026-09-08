# 算子开发 Skills 调研 · 总览与索引

> 2026-09-08 由 8 个并行调研 agent 产出（GitHub / GitCode / Gitee / 官方文档站，重点仓库均 clone 核验）。
> 配套机制设计见 [../skills-management-plan.md](../skills-management-plan.md)。

## 全景矩阵

| 分区 | 现成 skills | 最佳引入/转化路径 | 报告 |
|---|---|---|---|
| ascend | ✅ 官方，规模最大 | `gitcode.com/cann/cannbot-skills`（259 个 SKILL.md，CANN OSL v2.0 ⚠️）+ `gitcode.com/Ascend/agent-skills`（216 个，总分发仓） | [ascend-cann.md](ascend-cann.md) |
| triton | ✅ 丰富 | `NVIDIA/TensorRT-LLM` 内嵌 kernel-triton-writing + `Ascend/agent-skills` Triton 九件套 + `tensormux/kernel-skills` | [triton.md](triton.md) |
| nvidia | ✅ 官方+社区 | `tensormux/kernel-skills`（35 个，MIT）、`KernelFlow-ops/cuda-optimized-skill`（闭环优化）、`nvidia/skills`（官方 350 个，偏 Physical AI） | [nvidia-cuda.md](nvidia-cuda.md) |
| amd | ✅ 官方，质量极高 | `amd/skills`（官方四端兼容）+ `AMD-AGI/GEAK`（~20 个调优 skill + 586 篇 perf 知识库）+ `Arist12/AMD-Skills`（porting 8 阶段） | [amd-rocm.md](amd-rocm.md) |
| hygon | ⚠️ 仅 FlagOS 路线 | 无官方。**AMD overlay 策略**：HIP API 层直接复用 AMD skills（DTK 6.x 同源 ROCm），微架构差异（DUMMA/BF16-only）自建 | [hygon.md](hygon.md) |
| iluvatar | ⚠️ 半现成 | `flagos-ai/skills`（kernelgen 含 `_iluvatar` 规范）+ 官方 `Deep-Spark/FlyDSL`（16 个 skill + cursor rules 天数特化，蒸馏） | [iluvatar.md](iluvatar.md) |
| metax | ⚠️ 半现成 | 官方 `MetaX-MACA/TileOPs-Metax`（14 个工程流 skill，MIT）+ `mxmaca-performance-tuning-guide` 蒸馏 MACA 知识 | [metax.md](metax.md) |
| enflame | ❌ 荒漠 | 官方 `torch-gcu` manuals/（自定义算子指南 + 989 行算子支持表）蒸馏；FlagGems `_enflame/` 412 个 Triton 算子作参考 | [enflame.md](enflame.md) |
| common | — | FlagGems（200+ 算子 / 17 个 vendor 后端）、gpu-mode 106 讲、PTX ISA markdown、KernelBench、Liger-Kernel | 各报告素材节 |

## 横断结论

1. **格式已收敛**：Claude Code SKILL.md（agentskills.io 开放标准）是绝对主流；Codex 原生兼容同格式（仅安装目录与可选字段差异）。一套解析器即可覆盖，少数异类（无 frontmatter / 表格式 frontmatter）需转换层。
2. **FlagOS 是国产芯片 skills 的公共底座**：`flagos-ai/skills`（Apache-2.0）四端兼容，kernelgen-flagos 显式支持天数/沐曦/海光/燧原目标；配套 FlagGems vendor 后端（_enflame 412 / _iluvatar 53 / 共 17 家）是最大跨厂 Triton 算子语料。
3. **质量标杆**：cannbot-skills 的治理结构（evals CI 硬门禁 + references/scripts/templates 四件套）与 AMD GEAK 的知识库组织（operator×backend SOTA 注册表）值得 forge 内置 skills 效仿。
4. **协议注意**：cannbot-skills 为 CANN OSL v2.0 非标协议——借鉴结构可以，直接拷贝内容需法务审阅；MIT/Apache-2.0 仓库（amd/skills、GEAK、tensormux、TileOPs 等）可直接引入。

## 与机制设计的对接

- 内置分区即上表「分区」列，落 `skills/<partition>/`（见计划书第 4 章）。
- hygon 采用 **amd + hygon overlay** 两层结构（HIP 同源，报告已给出三层可迁移性结论）。
- 素材类仓库不作 skills 引入，作为 `skillgen`（蒸馏建 skill）的原料清单。
