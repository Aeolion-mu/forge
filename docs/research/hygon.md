# 海光信息（Hygon DCU / DTK）算子开发 Skills 调研报告

调研日期：2026-09-08
调研范围：GitHub / Gitee / GitCode，中英文关键词 20+ 组；重点仓库已 `git clone --depth 1` 至 /tmp/hygon-research 实测核验。
技术栈关键词：DCU（深算/Deep Computing Unit）、DTK（DCU Toolkit，源自 ROCm/HIP）、HCU（Hygon Computing Unit，新命名）、DAS（海光 AI 软件栈品牌）、hipcc/dcc、DUMMA、hipprof、hy-smi、gfx928。

---

## 一、总结论

1. **海光官方不存在任何 Claude Code / Codex 格式的算子开发 skills**。官方 GitHub 组织 HYGON-AI 共 23 个仓库，全部是推理/训练生态适配（vLLM/sglang/Megatron 等下游 fork）、cookbook 与 K8s 工具，无一处 SKILL.md；官方 Gitee 组织（gitee.com/hygon）仅 3 个 CPU 侧仓库（cloud-kernel/qemu/kata fork），与 DCU 无关。
2. **社区存在两个可用的 skills 入口**：
   - `yangzhuxinyzx/hygon-dcu-bringup`：唯一一个"Hygon 专用"skill（Codex 格式），但内容是**驱动/VBIOS/DTK 装机排障**，不是算子开发；
   - `flagos-ai/skills`（智源 BAAI 众智 FlagOS Skills）：**唯一把"算子生成/优化"做成 skill 且显式支持海光 DCU** 的仓库（`kernelgen-flagos` skill 内置 `haiguang` 设备目标），Apache-2.0、活跃维护、兼容 Claude Code/Cursor/Codex。这是当前对 forge 最有直接价值的发现。
3. 达坦科技（DatenLord）联合鹏城实验室把 AKO4X、GEAK 两个智能体算子优化框架迁移到了海光 DCU（gfx928），文章披露**已编写 DCU 专用 SKILL 文件**（HIP kernel 规范 / DUMMA Tensor Core / LDS 优化 / hipprof 分析），但这些 DCU skill **未开源**（公开仓库中无 DCU 内容）——是潜在的自建素材来源而非可下载资源。
4. ROCm/HIP 系通用 skills（AMD 官方 `amd/skills`、`ROCm/aiter` 内嵌 skill、GEAK）**可部分迁移到海光**：工具链/HIP API 层可迁移性高（DTK 同源），微架构调优层中等（同为 CDNA 系 wavefront=64，但 DUMMA≠WMMA、无 FP8 硬件支持、hipprof≠rocprof），具体见第六节评估。

---

## 二、逐仓库明细

### 2.1 Hygon 专用 skills（严格匹配：内容针对海光 + Agent skill 格式）

#### ① yangzhuxinyzx/hygon-dcu-bringup ⭐ 唯一 Hygon 专用 skill
- URL: https://github.com/yangzhuxinyzx/hygon-dcu-bringup
- 维护方：个人社区（yangzhuxinyzx，非海光官方）
- 格式：**Codex skill 格式**（根目录 `SKILL.md` + `agents/openai.yaml`（display_name / default_prompt / allow_implicit_invocation）+ `references/hygon-dcu-runbook.md`），README 给出安装路径 `~/.codex/skills/`。SKILL.md 带 YAML frontmatter（name/description），**同时兼容 Claude Code 布局**。
- 内容清单：Hygon rock/hydcu/hycu 驱动安装核查、hy-smi 可用性 vs 内核绑定、MP1/SMU/SMC 探测失败诊断、VBIOS 安全检查/备份/刷写、DTK 26.04 用户态 HIP 安装（/opt/dtk-26.04、profile 覆盖 /opt/rocm）、PCIe 拓扑与带宽诊断。含 known-good 锚点（Z100 8176/1d94:54b7、VBIOS 版本、hipconfig 6.3.26113）与 Stop Rules。
- 与算子开发的关系：**无直接关系**（运维/bring-up），但其"已知良好配置 + 禁止事项"写法是很好的 skill 范本；其中 DTK 安装/PATH/驱动章节可并入 forge 的"环境准备"skill。
- 活跃度：最后提交 2026-06-11，单次性产出（事故复盘沉淀），无 star 数据参考。
- License：**无 LICENSE 文件**（引用需注意）。
- 本地克隆核验：/tmp/hygon-research/hygon-dcu-bringup

#### ② flagos-ai/skills（众智 FlagOS Skills）⭐ 最有直接价值
- URL: https://github.com/flagos-ai/skills （GitCode 镜像：https://gitcode.com/flagos-ai/skills）
- 维护方：北京智源人工智能研究院（BAAI）众智 FlagOS 社区（非海光官方，但为多芯片中立方案）
- 格式：**Agent Skills 开放标准**（agentskills.io），兼容 **Claude Code / Cursor / Codex / Gemini CLI**；提供 npx 安装、Claude 插件（.claude-plugin/）、Cursor 插件、gemini-extension.json。
- License：Apache-2.0；活跃：最后提交 2026-07-18，FlagOS 2.0（2026 年中发布）配套 12 个 skills，覆盖 32 款芯片、497 算子。
- 海光相关内容（本地 grep 核验）：
  - `skills/kernelgen-flagos/`——**GPU kernel 算子生成与优化总入口 skill**（SKILL.md frontmatter 含 allowed-tools、argument-hint）。子文档 `kernelgen-generate-for-flaggems.md` / `kernelgen-generate.md` / `kernelgen-optimize.md` 中：目标设备映射表 "If user mentions 海光/Hygon/DCU → `haiguang`"；硬件探测脚本（rocm-smi 输出含 hygon → 判为 haiguang）；FlagGems 后端路径 `src/flag_gems/runtime/backend/_hygon/ops/`（vendor 表同时列 _ascend/_cambricon/_mthreads/_iluvatar/_metax 等）。
  - `skills/gpu-container-setup-flagos/`——references 含 Hygon DCU（HCU/BW 系列）检测（/opt/dtk-*/bin/rocm-smi、输出含 "HCU"）、镜像源（harbor.sourcefind.cn dcu registry、harbor.baai.ac.cn hygon-pytorch:2.5.1-dtk25.04）、**关键坑**：必须挂 /opt/hyhal、禁止挂宿主机 /opt/dtk-*（NCCL 符号冲突 ncclCommRegister undefined symbol）。
  - `skills/flaggems-pr-submit-flagos/` / `flaggems-pr-review-flagos/`——算子 PR 模板含 Hygon 列（天数/沐曦/华为/海光国产卡测试结果采集脚本）。
  - `skills/vllm-plugin-fl-setup-flagos/`——Hygon DCU 状态 **TBD（待补充）**，说明其 vLLM 适配 skill 尚未覆盖海光。
- 局限：算子路线以 **Triton/FlagGems** 为主，不是原生 HIP kernel 开发；海光深度仅到"设备识别 + 容器 + FlagGems 后端"层面。
- 本地克隆核验：/tmp/hygon-research/skills

#### ③ DeepLink-org/DeepEval-Skills（相关但非开发向）
- URL: https://github.com/DeepLink-org/DeepEval-Skills
- 维护方：DeepLink（人工智能软硬件验证平台）
- 格式：Agent Skills 开放标准，兼容 Claude Code/Cursor/Codex
- 内容：GEMM/Attention/FFN/LayerNorm 等**算子性能评测** skills（不同精度/批量/序列长度组合），已适配含 DCU 在内的多款芯片；配套 DeepEval-Agent 多智能体自动化评测（知乎 p/2053854729394993086）。
- 定位：算子 benchmark/评测 skill，非算子编写 skill；可作 forge"性能验证"环节参考。

### 2.2 智能体算子优化框架（已在 DCU 实测、含 skill 体系，但 DCU 部分未开源）

#### ④ TongmingLAIC/AKO4ALL + AKO4X + AKO
- URL: https://github.com/TongmingLAIC/AKO4ALL 、https://github.com/TongmingLAIC/AKO4X （项目页 tongminglaic.github.io/AKO）
- 维护方：TongmingLAIC（MLSys 2026 FlashInfer 竞赛参赛团队）；License：MIT；活跃：2026-08 仍在更新。
- 形态：AKO4ALL = **单文件即插即用 Claude Code skill**（根目录 SKILL.md + ITERATIONS.md 经验沉淀 + bench/KernelBench）；AKO4X = 多轮 campaign 级框架（spawn 隔离环境、master 归档、`templates/skills/` 可插拔 SKILL 目录：cuda/triton/tilelang/cute-dsl/cpp/profiler-ncu/sanitizer/bench）。
- DCU 关联（知乎 zhuanlan.zhihu.com/p/2059618681940923981，达坦科技×鹏城实验室×琶洲实验室，2026-07）：AKO4X 已迁移至**海光 DCU K500SM_AI (gfx928) + HIP**，Claude Code + DeepSeek V4-pro 驱动；迁移中**编写了 DCU 专用 SKILL 文件**：HIP kernel 开发规范、DUMMA Tensor Core 编程、LDS 优化策略、hipprof 性能分析。实测：RMSNorm 达 ATen 融合算子 3.4×；GEMM 约 hipBLAS 的 0.50×（32.5 TFLOPS）；uint4 向量化加载 +3×；反模式：双缓冲 LDS、TK=32、sB +1 padding。
- **公开仓库中无任何 DCU/Hygon 内容**（本地 grep 仅 1 处无关提及）——DCU skill 属未开源状态，文章本身即最佳需求定义与验收参照。
- 可迁移资产：AKO4ALL 的 skill 骨架（SKILL.md + ITERATIONS 经验传承机制 + benchmark harness）可直接被 forge 借用，把 DCU 知识灌入。

#### ⑤ AMD-AGI/GEAK（AMD 官方，ROCm 同源 → 高可迁移）
- URL: https://github.com/AMD-AGI/GEAK
- 维护方：AMD 官方（AMD-AGI 组织）；License：Apache-2.0
- 形态：自主 kernel 优化智能体（Claude Code 驱动 + 确定性 JS Workflow 编排），kernel_workflow（单算子：Director→TechLead→算法/内存/计算/host_runtime 专家）与 e2e_workflow（整模型 sglang/vLLM 吞吐），覆盖 Triton/HIP/CK/FlyDSL；`perf_knowledge/` 为 AMD 算子×后端 SOTA 知识库；MI300X 上 12 个 HIP kernel geomean 3.68×。
- DCU 关联：知乎 p/2064680746183402155 记录 **GEAK 迁移到海光 K500SM_AI (gfx928) 做 MHC（Manifold Hyper-Connection）算子优化**（同为达坦系工作）；迁移版未开源。
- 对 forge 的意义：是"把算子优化 agent 落到 HIP 系硬件"的最完整开源参照（角色分工、知识库结构、profiling 脚本），DCU 版需替换 rocprof→hipprof、gfx942/950→gfx928、WMMA→DUMMA。

#### ⑥ 达坦科技 MetaInfer（文章级线索，未见公开仓库）
- 知乎 p/2068131343263852455：让 Agent 在海光 DCU 上生成原生 C++ 大模型推理框架（端到端跑通）；SegmentFault a/1190000048168046：用 MetaInfer 测试 DeepSeek v4 Flash 编写海光 GPU 算子的能力。未见 GitHub 仓库，持续关注达坦（datenlord.github.io / 知乎"达坦科技DatenLord"）。

### 2.3 ROCm/HIP 通用 skills（可迁移到海光，需标注差异）

| 仓库 | 维护方 | 格式 | 内容 | 对海光可迁移性 |
|---|---|---|---|---|
| **amd/skills**（github.com/amd/skills） | AMD 官方 | Agent Skills 标准（SKILL.md），MIT，2026-08 活跃 | 官方 skill 目录：serving-llms-on-instinct、rocm-doctor（staging）、apu-memory-tuner、tracelens-analysis-orchestrator、magpie-kernel-evaluator、hyperloom-workload-optimizer、lemonade-router-builder、local-ai-use 等；docs/best-practices.md 含 skill 编写规范与 CUDA→HIP 移植 skill | **高**（ROCm 工具链层面直接同源；Instinct 专属调优需换 DCU 参数） |
| **ROCm/aiter** 内嵌 `.claude/skills/opus-kernel-best-practice/SKILL.md` | AMD ROCm 官方仓库 | Claude Code 项目级 skill | HIP/C++ OPUS kernel 编译期优化最佳实践（减少模板膨胀） | **高**——纯 HIP 代码规范，DCU 同样适用 |
| **GEAK**（见上） | AMD 官方 | Claude Code workflow + 知识库 | HIP/Triton/CK/FlyDSL 算子优化 | 高（架构层需 gfx928 适配） |
| huggingface/kernels 的 `rocm-kernels` CLI skill | HuggingFace | `kernel-builder skills add`（Claude/Codex/OpenCode） | HIP kernel 构建/提交 | 中 |
| datawharechina/**hello-rocm**（github.com/datawhalechina/hello-rocm） | Datawhale 社区 | Skill/Rules/Agent 导航层（中文） | HIP/ROCm 入门到进阶教程 + AI 助手导航 | 中高——中文 HIP 教学素材 |
| tazwaryayyyy/ROCmPort-AI | 个人社区 | agentic 循环脚本 | CUDA→ROCm/HIP 迁移闭环（翻译→编译→profile→修复） | 中——思路可借，DTK 下 hipify 行为需验证 |

### 2.4 海光官方素材仓库（非 skill，适合转成 skill）

#### HYGON-AI（github.com/HYGON-AI，海光信息官方 AI 组织，23 仓库，2026-09 仍高频更新）
关键仓库（经 GitHub API 核验）：
- **inference-cookbook-das**（又名 dcu-inference-cookbook）：HCU 上部署/调优/运行 AI 模型经验与最佳实践；MIT；star 42。→ **最适合转 skill 的官方素材**（部署、容器、性能调优、踩坑）。
- **train-cookbook-das**：HCU 训练/微调最佳实践；MIT。
- **TileKernels-das**：基于 DeepSeek-AI/TileKernels 的 hcu 下游算子适配与优化；MIT；本地核验：Gating/MoE Routing/量化（FP8/FP4/E5M6 + 融合 SwiGLU 量化）/Transpose/Engram/mHC 算子，运行于 **tilelang-hygon** DSL，支持 BW1000/BW1100/BW150/K100_AI（DTK）。→ **官方算子样例库**， forge 的 TileLang 路线素材。
- **tile-ai/tilelang-hygon**（github.com/tile-ai/tilelang-hygon，tile-ai 组织下与海光 DAS 合作维护）：TileLang 的 Hygon HCU 专用 fork，改造 passes/codegen/runtime 以适配 DTK 工具链；2026-09-07 仍活跃；含 das-build.sh/das-regression.sh、docker。→ **TileLang 算子开发路线的编译器底座**。
- 其余：vllm-plugin-das、sglang-das、Megatron-LM-das、verl-das、DeepEP-das、slime-das、AReal-das、LMCache-das、mooncake-das、volcano（推理/训练生态适配）、apex-das（HCU/HIP Kernel 融合优化，BSD-3）、TurboPhysAI（训练性能优化组件：算子/计算图/数据链路）、k8s-hcu-device-plugin / hcu-exporter / k8s-hcu-dra-driver / hcu-container-toolkit / hcu-dcgm（K8s 与监控）、quality-gate（PR 门禁）。
- **结论：官方组织无任何 agent/skill/LLM 字样仓库，无 SKILL.md。**

#### 官方文档站（转 skill 的第一素材源）
- **光合开发者社区**：https://developer.hpccube.com/ （DTK/DCU 官方开发者社区，SPA 站点）；文档聚合：https://cancon.hpccube.com:65024/ （含 DCU 编程实战代码、DOS 开源软件栈）。
- **DTK 文档 PDF 列表**（https://download.sourcefind.cn:65024/1/main/latest/Document ，DTK 26.04）：《HIP C++编程指南》《HIP Runtime API 开发手册》《HIP 最佳实践手册》《MIOpen 库使用手册》《OpenCL 使用手册》等 → **直接对应 forge 需要的 HIP 编程 / API / 最佳实践三件套 skill 素材**。
- 镜像仓库（SourceFind registry）：harbor.sourcefind.cn:5443/dcu/admin/base/pytorch（如 2.5.1-ubuntu22.04-dtk25.04.4-…）与 harbor.baai.ac.cn/flagrelease-public/hygon-pytorch:2.5.1-dtk25.04-driver6.3.28。

#### 社区素材（文章/样例）
- FlyAIBox/dcu-in-action（github.com/FlyAIBox/dcu-in-action）：基于海光 DCU 开发社区公开资料的实战（大模型训练/微调）。
- gitcode.com/alain999/dcu-inference-cookbook：官方 cookbook 在 GitCode 的搬运（含 wan2.1-i2v/wan2.2-t2v DCU 部署文档，hygon copyright）。
- CSDN：《海光 DCU 自定义算子完整实战》（PyTorch+HIP 融合 bias+GELU，blog.csdn.net/2403_86879992/article/details/162934908）；《DCU 上的 Matrix Core 编程 part1》（dcc/hipcc，blog.gensh.me/dcu-matrix-core-programming-part1）；《DCU 编程实战万字长文》（blog.csdn.net/zzzzzucc/article/details/140313167）；《海光 DCU 性能分析实战：hipprof 从 API、Kernel 到 PMC》；KTransformers 在 K100-AI (gfx928) 适配等 GitCode 博客。
- 运维侧：GPUStack 文档（docs.gpustack.ai Running Inference with Hygon DCUs）、HAMi（project-hami.io Hygon DCU sharing）、4paradigm/k8s-vgpu-scheduler hygon-dcu-support.md、OpenCloudOS 海光部署文档。→ 环境/容器 skill 素材。
- xueqiu.com/5304331218/406761203《从 CUDA 迁到海光 DCU，开发者究竟要改什么？》：MotionCor3 可直接编译、DeepETPicker 需重构——迁移难度分级的真实案例。

---

## 三、ROCm/HIP 系 skills 可迁移性评估（重点）

**DTK 与 ROCm 的同源关系**：DTK 6.x 基于 ROCm 派生（hipconfig --version 6.3.26113），工具链 hipcc/hipconfig/rocminfo/hipify、库 hipBLAS/MIOpen 同名同形；海光卡被 GPUStack 等直接按 "ROCm backend as AMD GPU" 检测（gpustack issue #869）。因此：

| 层次 | 可迁移性 | 说明 |
|---|---|---|
| 工具链/环境（hipcc、hipify、镜像、容器挂载） | **高** | amd/skills、flagos gpu-container-setup 的经验基本直接可用；差异点：DTK 装在 /opt/dtk-*，需 /opt/hyhal，禁止挂宿主 DTK |
| HIP Runtime API / 语言规范 | **高** | cudaMalloc↔hipMalloc 一一对应；ROCm/aiter 的 HIP C++ 最佳实践 skill 可直接用于 DCU |
| 微架构调优 | **中** | 同为 CDNA 系（gfx928 类 CDNA3）：wavefront=64、LDS 概念通用；但 **DUMMA ≠ WMMA/mma.sync**（API 形态完全不同）、**Tensor Core 仅 BF16、无硬件 FP8**（且 AMD FP8 为 FNUZ 格式，需 uint8+查表）、LDS bank 结构与容量需按 DCU 手册重算 |
| Profiling | **中** | rocprof/rocprof-compute → **hipprof/hipprof_ctrl**；NCU 经验（AKO4X profiler-ncu skill）需整体重写 |
| 生态库 | **中** | hipBLAS/MIOpen 可用；CK/aiter/Composable Kernels 在 DCU 可编译性未验证（GEAK/AKO4X 文章提到拟从 CK/rocBLAS 蒸馏，属计划项） |
| CUDA 兼容层 | **不可迁移（已验证死路）** | DCU 的 GPUfusion 兼容层对 mma.sync/WGMMA/TMA/CUTLASS Hopper 原语直接编译报错；**结论是"不能翻译、必须重写"**（AKO4X 文章实测） |

**实操建议**：forge 的海光 skill 应以「光合社区 DTK 官方 PDF（HIP 编程指南/Runtime API/最佳实践）+ HYGON-AI cookbook/TileKernels 样例 + AKO4X 文章披露的 DCU 正反经验」为知识底座，借 AKO4ALL 的 SKILL+ITERATIONS 骨架与 amd/skills 的格式规范，绕开 CUDA 兼容层路线。

---

## 四、其他国产芯片算子 skills 线索（顺带记录）

- **昇腾（最成熟，海光可对标其组织方式）**：`Ascend/agent-skills`（官方，SKILL 索引 A-G 类：AscendC/Catlass/Triton 算子开发、迁移适配、性能优化、自动化测试，`skills/<name>/SKILL.md` 格式）；`ascend-ai-coding/awesome-ascend-skills`（官方 skills 集合，兼容 Claude Code/OpenCode/Cursor/Trae/Codex）；CANNBot（16 skills + 7 阶段 agent 工作流，Claude Code 注入 Ascend C 知识）。
- **寒武纪**：未见 skill；素材是 `Cambricon/mlu-ops`（BANG C 算子开发指南 docs/BANG-C-OPS-Develop-Guide.md + 算子样例库）。
- **摩尔线程**：未见官方 skill 仓库；有 TileLang-MUSA 开源、`MooreThreads/tutorial_on_musa`、MATE 算子库；FlagGems 有 `_mthreads` 后端。
- **天数智芯/沐曦/昆仑芯/壁仞等**：仅作为 FlagGems vendor 后端（_iluvatar/_metax/_kunlunxin）出现在 FlagOS skills 中，未见独立 skill 仓库（本 repo 已另有 iluvatar.md/metax.md 调研）。
- **非芯片中文 skill 参考**：oceanbase/oceanbase-skills（Claude Code/Cursor 格式组织方式可参考）；gitcode mydb/kes-skills（金仓数据库 Claude Code skill，宣称支持海光/兆芯 CPU——仅 CPU 平台适配声明，与算子无关）。

---

## 五、对 forge 的行动建议

1. **立即可用**：引入 `flagos-ai/skills` 的 `kernelgen-flagos`（Triton/FlagGems 路线，`_hygon` 后端 + `haiguang` 设备）与 `gpu-container-setup-flagos`（DCU 容器/镜像/挂载坑），Apache-2.0 无合规障碍。
2. **自建 HIP 原生 skill**：以光合社区 DTK 26.04 三份 PDF（HIP C++编程指南/Runtime API/最佳实践）为语料，参照 `Ascend/agent-skills` 的分类组织与 `hygon-dcu-bringup` 的 known-good 写法；把 AKO4X-DCU 文章中的正反经验（wavefront=64、DUMMA、无 FP8、uint4 向量化 +3×、双缓冲/TK=32/+1 padding 反模式、GPUfusion 死路）硬编码进 skill。
3. **参考实现**：HYGON-AI/TileKernels-das + tile-ai/tilelang-hygon（TileLang DSL 路线）与 apex-das（HIP Kernel 融合）可作为 skill 内"参考算子"素材。
4. **格式双栈**：同时产出 Claude Code（SKILL.md + frontmatter）与 Codex（agents/openai.yaml）双格式，`hygon-dcu-bringup` 已验证该双格式布局可行。
5. **跟踪**：达坦科技（AKO4X/GEAK/MetaInfer 的 DCU skill 若开源会是最好素材）、flagos-ai/skills 的 vllm-plugin skill 海光 TBD 状态、HYGON-AI org（若官方跟进 skills 大概率落在此）。

---

## 六、来源清单

- https://github.com/yangzhuxinyzx/hygon-dcu-bringup （clone 核验）
- https://github.com/flagos-ai/skills （clone 核验；GitCode: https://gitcode.com/flagos-ai/skills）
- https://github.com/TongmingLAIC/AKO4ALL 、https://github.com/TongmingLAIC/AKO4X （clone 核验）
- https://github.com/AMD-AGI/GEAK （web 核验，clone 因网络失败）
- https://github.com/amd/skills （clone 核验）
- https://github.com/ROCm/aiter （.claude/skills/opus-kernel-best-practice）
- https://github.com/HYGON-AI 及 23 个子仓库（API 核验）；TileKernels-das、tilelang-hygon（clone 核验）
- https://gitee.com/hygon （3 仓库，CPU 侧）；https://gitee.com/anolis/hygon-devkit （龙蜥，CSV 安全向）
- https://gitcode.com/alain999/dcu-inference-cookbook 、https://gitcode.com/mydb/kes-skills
- https://developer.hpccube.com/ 、https://cancon.hpccube.com:65024/ 、https://download.sourcefind.cn:65024/1/main/latest/Document （DTK PDF）
- 知乎：p/2059618681940923981（AKO4X→DCU 迁移，**核心文献**）、p/2064680746183402155（GEAK→DCU MHC）、p/2068131343263852455（MetaInfer）、p/2024207186176288648（FlagOS Skills 整理）、p/2022976367738758188（FlagOS Skills 发布）、p/2053854729394993086（DeepEval-Skills）、p/2022437594412106149（FlagOS 2.0）
- SegmentFault：a/1190000048015563（AKO4X DCU）、a/1190000048168046（MetaInfer DCU 算子测试）
- https://github.com/FlyAIBox/dcu-in-action ；CSDN：2403_86879992/162934908（DCU 自定义算子实战）、zzzzzucc/140313167（DCU 编程实战）、blog.gensh.me/dcu-matrix-core-programming-part1
- GPUStack docs / HAMi / k8s-vgpu-scheduler hygon-dcu-support（运维素材）
- 跨厂商参照：https://github.com/Ascend/agent-skills 、https://github.com/ascend-ai-coding/awesome-ascend-skills 、https://github.com/Cambricon/mlu-ops 、https://github.com/MooreThreads/tutorial_on_musa 、https://github.com/DeepLink-org/DeepEval-Skills
