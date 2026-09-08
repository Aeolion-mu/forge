# AMD（ROCm/HIP 生态）算子开发 Skills 调研报告

> 调研日期：2026-09-08
> 调研目标：收集 AMD ROCm/HIP 生态（HIP kernel、rocBLAS/composable kernel、hipify 迁移、ROCm Profiler）的算子开发 AI 技能包 —— Claude Code SKILL.md 格式或 OpenAI Codex 格式；同时盘点可转化为 skill 的高质量素材。
> 调研渠道：github.com（搜索 API + `git clone --depth 1` 实测 15+ 仓库）、gitcode.com（API 搜索）、gitee.com（API 搜索）、AMD 官方博客/文档站（rocm.blogs.amd.com、rocm.docs.amd.com）、知乎、dev.to、聚合市场（mcpmarket / mcpservers.org / LobeHub / claude.com 插件市场）、中英文关键词 20+ 组。

---

## 一、总结论

1. **AMD 官方已下场，且是本次四家厂商调研中「官方投入最大」的一家**：ROCm 10.0（2026.8）发布 ROCm.AI 开发者体验 = **AMD Skills + ROCm CLI + Hyperloom** 三件套，官方 skills 目录 `amd/skills` 遵循 Anthropic Agent Skills 标准（SKILL.md + YAML frontmatter），明确声明兼容 Claude Code / Cursor / OpenAI Codex / Gemini CLI，并以官方 Claude 插件（claude.com/plugins/amd-skills）形式分发。
2. **现成可用的 skills 仓库约 10+ 个**，其中算子开发直接相关度最高的三个：
   - `AMD-AGI/GEAK` 的 `perf_knowledge/expert_skills/`（约 20 个 SKILL.md 专家调优技能 + 586 篇知识库）；
   - `Arist12/AMD-Skills`（13 个社区 SKILL.md，覆盖 CUDA→ROCm 移植、kernel 优化循环、rocprofv3 剖析）；
   - `AMDResearch/intellikit`（官方 5 个 SKILL.md，全部面向 ROCm kernel 剖析/验证工具链）。
3. **格式结论**：Claude Code 的 Agent Skills 开放标准（SKILL.md，agentskills.io）是绝对主流，AMD 官方仓库、HF、社区全部采用；Codex 已原生兼容同一格式（差异仅是安装目录 `.codex/skills/` 与可选扩展 frontmatter 字段 `disable-model-invocation` / `allowed-tools` / `argument-hint`）。另有大量 **AGENTS.md/CLAUDE.md 仓库级指南**散布在 ROCm 官方库内部（hipBLASLt、TensileLite、rocRoller、MIOpen、hipDNN 等），是 Codex/Claude 双格式的「内嵌素材」。
4. **素材质量总评：极高**。AMD 通过 AgentKernelArena 基准（214 个 kernel 任务 + 1617 行架构/HIP/Triton cheatsheets）和 GEAK 知识库（operator × backend SOTA 注册表）公开了大量可直接转化为 skill 的 prompt 素材；中文侧有 Datawhale `hello-rocm` 教程仓库（含内置中文 Skill）。

---

## 二、现成 Skills 资产总表

| # | 仓库 | 维护方 | 格式 | stars | 最近更新 | License |
|---|---|---|---|---|---|---|
| 1 | [amd/skills](https://github.com/amd/skills) | **AMD 官方** | SKILL.md（Agent Skills 标准） | 336 | 2026-09-08（当天仍在推送） | MIT |
| 2 | [ROCm/TheRock](https://github.com/ROCm/TheRock)（skills/ 目录） | **ROCm 官方** | SKILL.md + CLAUDE.md | 1286 | 2026-09-08 | MIT |
| 3 | [AMDResearch/intellikit](https://github.com/AMDResearch/intellikit) | **AMD 研究院官方** | SKILL.md ×5 | 32 | 2026-09（活跃） | MIT |
| 4 | [ROCm/rocprofiler-systems-skills](https://github.com/ROCm/rocprofiler-systems-skills) | **ROCm 官方**（rocprof-sys 团队） | SKILL.md ×50+（"Radisha"体系） | 4 | 2026-07-31 | 未标注 |
| 5 | [AMD-AGI/GEAK](https://github.com/AMD-AGI/GEAK) | **AMD 官方**（AGI 团队） | SKILL.md（expert_skills）+ 自有 agent | 171 | 活跃 | MIT |
| 6 | [AMD-AGI/AgentKernelArena](https://github.com/AMD-AGI/AgentKernelArena) | **AMD 官方** | prompt cheatsheets + agent 适配器 | 112 | 活跃 | Apache-2.0 |
| 7 | [ROCm/rocm-libraries](https://github.com/ROCm/rocm-libraries)（内嵌） | **ROCm 官方** | AGENTS.md/CLAUDE.md ×13 + skills/ | 419 | 2026-09-08 | 各组件自带 |
| 8 | [Arist12/AMD-Skills](https://github.com/Arist12/AMD-Skills) | 社区 | SKILL.md ×13 | 2 | 2026 年中 | 未标注 |
| 9 | [jhinpan/ROCmKernelWiki](https://github.com/jhinpan/ROCmKernelWiki) | 社区（个人） | 根目录 SKILL.md（Codex CLI skill，兼容 Claude） | 9 | 2026-07-27 | Apache-2.0 |
| 10 | [huggingface/kernels](https://github.com/huggingface/kernels)（kernel-builder/skills/rocm-kernels） | **HuggingFace 官方** | SKILL.md（Codex 扩展 frontmatter） | 740 | 活跃 | Apache-2.0 |
| 11 | [datawhalechina/hello-rocm](https://github.com/datawhalechina/hello-rocm) | Datawhale（中文社区） | SKILL.md（中文） | 162 | 2026-09-07 | MIT |
| 12 | [ianbarber/strix-halo-skills](https://github.com/ianbarber/strix-halo-skills) | 社区 | SKILL.md | 7 | 2026-08-11 | MIT |
| 13 | [yechua-silva/amd-rocm-skills](https://github.com/yechua-silva/amd-rocm-skills) | 社区（AMD 黑客松作品） | SKILL.md ×10（agentskills.io 规范） | 1 | 2026-07-10 | Apache-2.0 |
| 14 | [tensormux/kernel-skills](https://github.com/tensormux/kernel-skills) | 社区 | SKILL.md（CUDA/Triton 通用） | 74 | 2026-06-21 | MIT |
| 15 | [cycheng/rocmlib-skills](https://github.com/cycheng/rocmlib-skills) | 社区 | SKILL.md ×5 | 0 | 2026-08-19 | 未标注 |
| 16 | [kensclin/rocm-skills](https://github.com/kensclin/rocm-skills) | 社区 | SKILL.md ×2 | 0 | 2026-07-16 | 未标注 |
| 17 | [jhinpan/rocm-report-skill](https://github.com/jhinpan/rocm-report-skill) | 社区（同 ROCmKernelWiki 作者） | SKILL.md | 0 | 2026-06/07 | 未标注 |
| 18 | [M4jupitercannon/amd-gpu-gap-finder](https://github.com/M4jupitercannon/amd-gpu-gap-finder) | 社区 | SKILL.md | 0 | 2026-04 | 未标注 |

---

## 三、官方 Skills 详解

### 3.1 amd/skills —— AMD 官方技能总目录 ★核心

- URL：https://github.com/amd/skills ；官方文档：https://rocm.docs.amd.com/projects/amd-skills/en/latest/
- 安装：`npx skills add amd/skills`（vercel-labs/skills CLI），或 Claude 插件市场搜 `amd-skills`（https://claude.com/plugins/amd-skills）
- 336 stars、MIT、2026-09-08 当天仍有推送；README 声明兼容 Cursor / Claude Code / OpenAI Codex / Gemini CLI
- 实测目录结构（clone 验证）：

```
amd/skills/
├── skills/                  # 正式目录（8 个）
│   ├── magpie-kernel-evaluator/       # ★ benchmark→profile→分析→优化循环：vLLM/SGLang 基准、
│   │                                  #   torch trace 捕获、TraceLens prefill/decode/roofline 报告、
│   │                                  #   HIP/CUDA/PyTorch/Triton kernel 分析对比与变体排名
│   ├── tracelens-analysis-orchestrator/ # ★ PyTorch profiler trace 编排分析（GEMM/SDPA/elementwise
│   │                                  #   子代理并行 + 汇总报告）
│   ├── serving-llms-on-instinct/      # Instinct GPU 上 vLLM 部署
│   ├── serving-llms-on-epyc/          # EPYC CPU 上部署
│   ├── hyperloom-workload-optimizer/  # Hyperloom 负载优化（ROCm.AI 组件）
│   ├── lemonade-router-builder/       # Lemonade 本地模型路由
│   ├── local-ai-use/ + local-ai-app-integration/   # Ryzen AI 本地推理
├── staging/                 # 预发布（2 个）
│   ├── rocm-doctor/         # ★ ROCm/HIP/PyTorch/llama.cpp 故障诊断（hipErrorNoBinaryForGpu、
│   │                        #   /dev/kfd 权限、HSA_OVERRIDE_GFX_VERSION 等 20+ 已知错误模式）
│   └── apu-memory-tuner/
├── docs/best-practices.md   # skill 编写规范（含 hipify/CUDA→HIP 移植 skill 的正面示例）
├── eval/                    # skill 路由评测框架（negatives.json、routing.py、compare_skill.py）
└── walkthroughs/            # 每 skill 的实操指南
```

- 评价：目录仍在快速扩张（README 自述"built in the open and will evolve frequently"）；算子开发直接相关的是 `magpie-kernel-evaluator` 与 `tracelens-analysis-orchestrator`（性能剖析→瓶颈 kernel→源码映射→优化验证闭环），`rocm-doctor`（环境/编译目标诊断）是重要配套。

### 3.2 AMDResearch/intellikit —— 官方 ROCm 剖析工具 skills ★Profiler 方向首选

- URL：https://github.com/AMDResearch/intellikit ；文档：https://rocm.docs.amd.com/projects/intellikit/en/latest/how-to/skills-setup.html
- 32 stars、MIT；install.sh 一键安装到 `.claude/skills/`、`.cursor/skills/`、`.codex/`、`.github/agents/skills/`（Codex 与 Claude 双支持）
- 5 个 SKILL.md（实测克隆验证）：

| Skill | 用途 |
|---|---|
| `metrix-profiling` | rocprof 系 GPU 指标剖析：带宽、cache 命中率、coalescing、kernel 计时 |
| `linex-profiling` | 源码行级剖析：cycle 级计时 + stall 分析，指标映射到源码行 |
| `nexus-trace` | 从 HSA packet trace 提取 kernel 汇编与 HIP 源码（分析实际跑了什么代码） |
| `kerncap` | kernel 提取与最小复现体生成（调试/回归） |
| `accordo-validation` | kernel 正确性验证（参考实现 vs 优化实现输出比对） |

- 评价：这是「ROCm Profiler」任务域最完整的官方技能包，五件套覆盖剖析(2)+追踪(1)+提取(1)+验证(1)。

### 3.3 ROCm/TheRock —— 官方构建仓库内嵌 skills

- URL：https://github.com/ROCm/TheRock（1286 stars、MIT、极活跃）
- `skills/` 目录：`rocm-pr-quality`（ROCm 库 PR 质量基线 skill，附 reference.md 评分细则）、`therock-pr-quality`（TheRock 构建仓库 overlay）；`therock_pr_bot/` 为对应的自动执行策略检查
- 根 `CLAUDE.md`：TheRock superbuild 的构建目录布局、组件 target 约定（`ninja component+build` 等）
- 评价：偏「ROCm 库工程化/PR 流程」，是 AMD 官方在真实工程仓库中落地 agent skill 的范例；`rocm-libraries` 内的 `hipblaslt-pr-quality` 即其薄 overlay。

### 3.4 ROCm/rocprofiler-systems-skills —— rocprof-sys 团队的 "Radisha" 体系

- URL：https://github.com/ROCm/rocprofiler-systems-skills（4 stars，2026-07-31 更新）
- 50+ 个 SKILL.md（实测克隆验证），分八类：
  - **profiler 相关**：`rocprofsys`、`rocprofsys-build`、`rocprofsys-configure`、`debugging-rocprof-sys`、`verify-pmc-metrics`（PMC 硬件计数器核对）、`library-amd-smi`
  - **C++ 工程**：`programming-cpp`（constexpr / design-patterns / naming-rules / policy-based-di / stl-algorithms）、`programming-cmake-best-practices`
  - **流程**：planning-feature/bugfix/refactor/docs、pr-review、`therock-build-to-commit` 等
  - **元技能**：`radisha-create-skill` / `radisha-improve-skill`（教 agent 自己写 skill）
- 评价：单仓库 skill 数量最多的官方 ROCm 仓库，但服务于 rocprofiler-systems 自身开发；`verify-pmc-metrics` 与 `debugging-rocprof-sys` 对剖析工作有参考价值。

### 3.5 AMD-AGI/GEAK —— 官方 kernel 优化 agent + 知识库 ★素材含金量最高

- URL：https://github.com/AMD-AGI/GEAK（171 stars，MIT）；博客：[GEAK V3: Agent-Driven, Repository-Level GPU Kernel Optimization](https://rocm.blogs.amd.com/artificial-intelligence/kernel-optimization-agent/README.html)
- 定位："Generating Efficient AI-Centric Kernels"——多 agent 系统（并行子代理探索 + patch 选择），支持 HIP / Triton / FlyDSL 三种 kernel 语言与 CDNA+RDNA。姊妹仓库 `AMD-AGI/GEAK-agent`（v4 转向端到端 GPU 性能优化系统）与 `AMD-AGI/Apex`（RL 环境内核优化）。
- **`perf_knowledge/` 知识库**（实测克隆验证，README 自述：~586 篇文档 / ~43,900 行）：
  - 覆盖 CDNA1(MI100)→CDNA4(MI350X/355X) 全代际；
  - 目录：`hardware/` `languages/` `backends/` `operators/`（每算子 overview/tuning/numerics/fusion）`optimization/` `quantization/` `profiling/` `case_studies/` `workflows/` `landscape/`；
  - `index/sota_matrix.md` + `sota_registry.yaml`：**operator × backend 的 SOTA 注册表**（机器可读，指向最优已知实现+实测性能+knobs+pitfalls）；
  - **`expert_skills/skills/`：10 个 SKILL.md 格式专家技能**（`flydsl_fp8_blockscale_gemm`、`flydsl_fused_attention_backward`、`apply_flydsl_moe_to_vllm`、`mla_tilelang_to_triton`、`gluon_authoring` 等，frontmatter 含 operator/arch 匹配字段）；
  - **`expert_skills/tuning/`：10 个调优 SKILL.md**：`tuning-hipblaslt`（hipblaslt-bench 全解竞速+按 solution index 回放）、`tuning-ck`（Composable Kernel）、`tuning-aiter`、`tuning-triton`、`tuning-hip`、`tuning-flydsl`、`tuning-in-vllm`、`tuning-in-sglang`、`tuning-core`、`tuning-kb`，另有 env-setup/docs/tools/validate 配套。
- 评价：**对 forge 最有复用价值的单一仓库**——rocBLAS/hipBLASLt/CK/AITER 调优与算子级 SOTA 知识在这里最密集，且 expert_skills 已是标准 SKILL.md。

### 3.6 AMD-AGI/AgentKernelArena（AKA）—— 官方基准 + prompt cheatsheets ★素材

- URL：https://github.com/AMD-AGI/AgentKernelArena（112 stars，Apache-2.0）；博客：[AgentKernelArena](https://rocm.blogs.amd.com/software-tools-optimization/agent-kernel-arena/README.html)；论文 arXiv:2605.16819
- 214 个任务：`triton2triton`（148，vLLM/ROCmBench/TritonBench）、`hip2hip`（36，GPU MODE 风格算子）、`torch2hip`（26，PyTorch 算子→HIP kernel）、`repository`（4，rocPRIM 仓库级）
- **`src/prompts/cheatsheet/`（实测克隆验证，共 1617 行）**：
  - `MI300X_architecture.md`（51 行，CDNA3 拓扑/内存层级/MFMA）
  - `MI355X_architecture.md`（57 行，CDNA4）、`RDNA4_architecture.md`（86 行）
  - `hip_cheatsheet.md`（256 行：coalescing 64B cache line、occupancy/wavefront、向量加载…）
  - `hip_rdna_cheatsheet.md`（247 行）、`triton_cheatsheet.md`（279 行）、`triton_rdna_cheatsheet.md`（246 行）、`flydsl_cheatsheet.md`（169 行）、`tilelang_cheatsheet.md`（226 行）
- `agents/` 内置 claude_code / codex / cursor / geak_v3 / geak_v4 / quality_loop / task_validator / **forge（对接 AMD 内部 "KernelForge" 的 kernel-agents forge-loop，含 triton-fellow / hip-fellow / flydsl-fellow 后端专家）** 的启动器
- 基准结论（MI300X 44 任务子集）：GEAKv3(Opus 4.6) HIP2HIP 9.04×；Claude Code(Opus 4.6) 6.08×、Sonnet 4.6 5.27×；Cursor(Opus) 5.03× —— 证明 cheatsheet 注入对通用 agent 的 HIP kernel 优化收益巨大。
- 评价：cheatsheets 是**现成的 skill 素材**（按 GPU 架构×语言组织的最佳实践，AMD 官方验证），任务集可用于评测 forge 的算子能力。

### 3.7 ROCm/rocm-libraries —— 官方库内嵌 AGENTS.md / skills

- URL：https://github.com/ROCm/rocm-libraries（419 stars；composable_kernel、hipblaslt、hipdnn、miopen、rocblas 等已并入此 superbuild）
- 实测 `git ls-tree` 验证，仓库内 **13 个 AGENTS.md / CLAUDE.md**：
  - `projects/hipblaslt/AGENTS.md + CLAUDE.md`：hipBLASLt GEMM 栈架构（hipblasLtMatmul→rocblaslt→TensileLite kernel 生成→heuristic 选择→device library 懒加载）、目录导览、`invoke build` 开发环
  - `projects/hipblaslt/tensilelite/AGENTS.md + CLAUDE.md`：Tensile kernel 生成器
  - `shared/rocroller/AGENTS.md + CLAUDE.md`：rocRoller
  - `projects/hipdnn/CLAUDE.md`、`dnn-providers/miopen-provider/CLAUDE.md`、`dnn-providers/hip-kernel-provider/rocke/AGENTS.md`（含 library/dispatch、platform 子目录）
  - `projects/hipblaslt/skills/`：`hipblaslt-pr-quality`（TheRock 基线 overlay）+ `tensilelite-mutation-rerun`（变异测试，含 `agents/openai.yaml` Codex 配置）
  - `skills/worktree-venv`：worktree 虚拟环境 skill
- 评价：AMD 官方把「算子库架构知识 + AGENTS.md」直接维护在源码里，是 rocBLAS/hipBLASLt/CK 方向最权威的一手素材。

---

## 四、社区 Skills 详解

### 4.1 Arist12/AMD-Skills —— 算子开发相关度最高的社区仓库 ★

- URL：https://github.com/Arist12/AMD-Skills（2 stars；LobeHub 有 [amd-rocm-porting](https://lobehub.com/skills/arist12-amd-skills-amd-rocm-porting)、[amd-kernel-optimization](https://lobehub.com/skills/arist12-amd-skills-amd-kernel-optimization) 条目）
- 13 个 SKILL.md（实测克隆验证），推荐 git submodule 到 `.claude/skills/`：

| Skill | 用途（实测摘要） |
|---|---|
| `amd-rocm-porting` | CUDA→ROCm 8 阶段移植法：`is_rocm` 门控、wave64 vs warp32、reduce-overhead 禁用、inductor/cudagraph 陷阱、flash-attn→aiter、CUTLASS→CK 手工改写、三级 fallback |
| `amd-kernel-optimization` | MI250/MI300/MI350 推理优化循环：torch.compile 优先、GPU Event 计时规范、warmup/std 纪律、首编译 2-15 分钟须知 |
| `rocprofv3-profiler` | rocprofv3 包装脚本（counters/trace/full 模式）+ 输出解析为 agent 友好 JSON + 瓶颈分类 |
| `rocm-profiler-analysis` | SGLang/vLLM profiling → ROCm 感知triage 产物（kernel/overlap/fuse） |
| `rocm-crash-debug` | ROCm 崩溃调试 |
| `flydsl-kernel-authoring` | FlyDSL kernel 编写 |
| `auto-benchmark` / `amd-ci-test-bisect` / `env-probe` / `run-value-summary` | 基准、CI 二分、环境探测 |
| `skill-creator` / `git-commits` / `clean-code-style` | 元技能（skill-creator 转载自 anthropics/skills） |

- 评价：虽然 stars 极少，但 `amd-rocm-porting` 的「5 条铁律」与决策树、`amd-kernel-optimization` 的基准纪律，都是可直接吸收进 forge skill 的工程经验。

### 4.2 jhinpan/ROCmKernelWiki —— agent 可查询的 CDNA 知识库 ★

- URL：https://github.com/jhinpan/ROCmKernelWiki（9 stars，Apache-2.0）
- 自述："打包为 **Codex CLI skill**，兼容 Claude Code，仓库根即 skill 目录，一次 `git pull` 同时更新工具与语料"
- 根 `SKILL.md`（实测）：覆盖 MI300/gfx942 与 MI350-MI355X/gfx950；MFMA、LDS、direct-to-LDS、s_waitcnt、FP8(FNUZ vs OCP)/FP6/FP4/MXFP、wave 归约、GEMM/attention/MoE、CUDA→HIP 迁移、CK/CK-Tile/AITER/ATOM/hipBLASLt/FlyDSL/Triton 实现；语料含 ROCm/rocm-libraries、AITER、flash-attention、vLLM、SGLang 的 **merged-PR 证据链**；`scripts/query.py` 提供 IDF 加权检索（--repo/--architecture/--symptom/--tag 过滤）
- 姊妹仓库 `jhinpan/rocm-report-skill`：rocprofv3 + Advanced Thread Trace + ROCprof Compute Viewer 的剖析报告 skill（FlyDSL kernel 向），强调「profile→诊断→单一代码假设→再测」金律
- 评价：知识组织方式（skill + 检索工具 + PR 证据 + 真机验证 VERIFICATION.md）是 forge 自建知识型 skill 的最佳模板；原型为 MIT Han Lab 的 KernelWiki（NVIDIA 向）。

### 4.3 huggingface/kernels · rocm-kernels —— HF 官方 Triton-on-ROCm skill ★

- 位置：https://github.com/huggingface/kernels → `kernel-builder/skills/rocm-kernels/`（740 stars，Apache-2.0）；市场条目：[mcpservers.org/agent-skills/huggingface/rocm-kernels](https://mcpservers.org/agent-skills/huggingface/rocm-kernels)
- SKILL.md 508 行（实测克隆验证），frontmatter 为 **Codex 扩展格式**（`disable-model-invocation` / `user-invocable` / `allowed-tools: "Read, Grep, Glob, Bash"` / `argument-hint`）
- 内容：MI355X(gfx950, 160KB LDS, wave64) 与 R9700(RDNA4, wave32) 的 Triton kernel 开发——RMSNorm / RoPE 3D / GEGLU / AdaLN 完整实现、XCD swizzle GEMM 模板、diffusers/transformers 注入模式、benchmark 脚本；**ROCm Triton 禁忌清单**（`tl.libdevice.tanh`/`tl.math.tanh` 不可用须手写、禁 autotune BLOCK_D、RoPE 批量 OOB、LDS 溢出降 num_stages）；附 MI355X/R9700 深度优化指南、KernelBench 算子分类、skill 评测方法论
- 实测性能数据齐全（如 RMSNorm MI355X 1.71×、R9700 2.90×，带宽利用率 44%/79%）
- 同仓库姊妹 skills：`cuda-kernels` / `xpu-kernels` / `cpu-kernels` / `triton-kernels`
- 相关博客：[Custom Kernels for All from Codex and Claude](https://huggingface.co/blog/custom-cuda-kernels-agent-skills)、[Build ROCm kernels](https://huggingface.co/blog/build-rocm-kernels)

### 4.4 datawhalechina/hello-rocm —— 中文教程仓库 + 内置中文 Skill

- URL：https://github.com/datawhalechina/hello-rocm（162 stars，MIT，2026-09-07 更新）
- `src/hello-rocm-skill/SKILL.md`（实测，中文 frontmatter）：仓库定位/目录结构/学习路径导航；引用 ROCm 10.0 基线（pip 索引 `stable.repo.amd.com/rocm/whl-next/` + PyTorch 2.13）；明确「平台官方 Skill 目录是 amd/skills，与本仓库 Skill 可并存」；子 skill：`references/quick-deploy/SKILL.md`（5 步闪电部署）、`references/troubleshooting/SKILL.md`
- `src/infra/`：**算子向素材**——`handwrite-rocm-operator/`（sgemm_test.cpp、vector_add.cpp 手写 HIP 算子示例）、`custom-pytorch-operator/`、`embrace-amd-ai/`、`decode-ai-accelerator/`；文档目录覆盖 HIPify、BLAS/DNN、NCCL→RCCL、Nsight→Rocprof 迁移
- 评价：中文世界最系统的 ROCm 教程库，适合作为中文 skill 的语料源与交叉验证。

### 4.5 其他社区仓库（简评）

| 仓库 | 实测内容 | 相关度 |
|---|---|---|
| [ianbarber/strix-halo-skills](https://github.com/ianbarber/strix-halo-skills) | `strix-halo-setup`：gfx1151 PyTorch ROCm 环境搭建/诊断（verify_system.sh、AMD 支持轨 vs TheRock nightly 轨），附 INSTALLATION/TROUBLESHOOTING/GTT_MEMORY_FIX 文档 | 消费卡/iGPU 环境向 |
| [yechua-silva/amd-rocm-skills](https://github.com/yechua-silva/amd-rocm-skills) | 10 skills（rocm-setup/rocm-docker/vllm-rocm-deploy/yolo-rocm-deploy/video-pipeline-rocm/vlm-rocm-inference/rocm-benchmark/ppe-detection-pipeline/ds132-compliance/rocm-troubleshoot）；agentskills.io 规范、9+ agent 兼容、ROCm+CUDA+CPU 三后端自动探测；作者自述 AMD 黑客松作品（[dev.to](https://dev.to/yechuasilva/amd-had-zero-agent-skills-i-built-the-first-10-4mi5)） | 部署/应用向，非算子 |
| [tensormux/kernel-skills](https://github.com/tensormux/kernel-skills) | CUDA/Triton/patterns/quantization 四类 SKILL.md 剧本（reduction/layernorm/softmax/gemm/attention、tile size 选择、数值稳定、边界处理） | 通用 GPU kernel 模式，Triton 部分适用 ROCm |
| [cycheng/rocmlib-skills](https://github.com/cycheng/rocmlib-skills) | `tensile-kernel-name-to-yaml`（从 hipBLASLt kernel 名反推 TensileLite YAML 以单独复现调试）等 5 skills | rocBLAS/Tensile 调试向，小而精 |
| [kensclin/rocm-skills](https://github.com/kensclin/rocm-skills) | `rocm-info`（只读环境体检）、`rocm-repo` | 环境向 |
| [M4jupitercannon/amd-gpu-gap-finder](https://github.com/M4jupitercannon/amd-gpu-gap-finder) | 调研 vLLM/SGLang 中 AMD/ROCm 相对 NVIDIA 的功能/性能差距并产出工程建议 | 生态调研向 |
| [AmosLewis/rocm-devops-skills](https://github.com/AmosLewis/rocm-devops-skills) | ROCm DevOps 工作流 skills（Cursor/Claude CLI） | DevOps 向（未深测） |
| [ROCm/gpu-agent](https://github.com/ROCm/gpu-agent) | Instinct GPU 可编程配置/监控 API（非 skill） | 配套工具 |

### 4.6 聚合市场条目（非仓库）

- [mcpmarket.com: amd-rocm-hip-development](https://mcpmarket.com/tools/skills/amd-rocm-hip-development) 与 [amd-hip-rocm-gpu-development](https://mcpmarket.com/tools/skills/amd-hip-rocm-gpu-development)：第三方上架的「写 HIP kernel / hipify 移植 / rocBLAS·rocFFT·rocSOLVER 集成」Claude skill 条目（源仓库未定位到 GitHub 公开地址，疑为市场自建）
- [claude.com/plugins/amd-skills](https://claude.com/plugins/amd-skills)：AMD 官方插件（amd/skills 打包）
- [LobeHub Skills](https://lobehub.com/skills/arist12-amd-skills-amd-rocm-porting)：Arist12 条目镜像
- [skills.sh](https://skills.sh) registry：`npx skills add` 可发现的注册表（NVIDIA 428+ vs AMD 起步≈10，见 dev.to 文章）

---

## 五、素材类资源（适合转成 skill）

| 素材 | 位置 | 用途 |
|---|---|---|
| **AKA prompt cheatsheets**（1617 行） | [AMD-AGI/AgentKernelArena](https://github.com/AMD-AGI/AgentKernelArena) `src/prompts/cheatsheet/`：MI300X/MI355X/RDNA4 架构 + HIP/Triton(CDNA/RDNA)/FlyDSL/TileLang 最佳实践 | 按架构×语言拆成 forge 的参考文档最直接 |
| **GEAK perf_knowledge**（~586 篇 / 43.9k 行） | [AMD-AGI/GEAK](https://github.com/AMD-AGI/GEAK) `perf_knowledge/`：hardware/languages/backends/operators/optimization/quantization/profiling/case_studies + `index/sota_registry.yaml`（operator×backend SOTA） | 算子选型与调优知识底座 |
| **rocm-libraries AGENTS.md**（13 个） | [ROCm/rocm-libraries](https://github.com/ROCm/rocm-libraries)：hipBLASLt/TensileLite/rocRoller/hipDNN/MIOpen/rocke | rocBLAS 系库架构一手知识 |
| **TheRock CLAUDE.md** | [ROCm/TheRock](https://github.com/ROCm/TheRock) | ROCm 源码构建工作流 |
| **HIP Programming Guide** | https://rocm.docs.amd.com/projects/HIP/en/latest/ | HIP kernel 语义权威 |
| **HIPIFY** | [ROCm/hipify](https://github.com/ROCm/hipify)（725 stars）：CUDA→可移植 C++（HIP）转换工具链（hipify-perl/hipify-clang） | hipify 迁移 skill 的工具基础 |
| **Composable Kernel 文档** | 已并入 rocm-libraries（原 [ROCm/composable_kernel](https://github.com/ROCm/composable_kernel) 547 stars，DEPRECATED 转只读） | CK/CK-Tile 算子组装知识 |
| **ROCm Profiler 文档** | rocprofiler-systems / rocprof-compute（ROCm/rocm-systems） | 剖析 skill 依据 |
| **rocm-handbook** | https://rocm-handbook.amd.com/ （ROCm 编程核心概念/API/最佳实践） | 通用底座 |
| **AMD 官方博客** | [AgentKernelArena](https://rocm.blogs.amd.com/software-tools-optimization/agent-kernel-arena/README.html)、[GEAK V3](https://rocm.blogs.amd.com/artificial-intelligence/kernel-optimization-agent/README.html)、[ROCm 10.0 / ROCm.AI](https://rocm.blogs.amd.com/ecosystems-and-partners/rocm-x-blog/README.html)、[HIP→FlyDSL 移植](https://rocm.blogs.amd.com/software-tools-optimization/porting-hip-flydsl/README.html) | 方法论与评测数据 |
| **nod-ai AMDGPU kernel 优化指南** | 被 ROCmKernelWiki 收录（`sources/blogs/blog-amdgpu-kernel-opt-guide.md`） | 社区高质量优化指南 |
| **中文**：知乎专栏 | [ROCm.AI 正式发布](https://zhuanlan.zhihu.com/p/2065894557020168662)、[为 AMD 平台带来 AI 原生开发体验](https://zhuanlan.zhihu.com/p/2077751930282046169)、[ROCm 10.0 十年开源计算](https://zhuanlan.zhihu.com/p/2078919814081426114) | 中文语境理解 ROCm.AI |
| **FlyDSL** | [ROCm/FlyDSL](https://github.com/ROCm/FlyDSL)（275 stars）+ `docs/kernel_authoring_guide.md` | 新一代 Python DSL/MLIR kernel 栈 |

---

## 六、格式结论

1. **Claude Code SKILL.md（Agent Skills 开放标准）是事实标准**：YAML frontmatter（`name` + `description`，部分加 `license`/`metadata`/`version`）+ Markdown 正文，目录式（skill 名/SKILL.md + 可选 scripts/ references/ agents/）。AMD 官方（amd/skills、IntelliKit、TheRock、rocprofiler-systems-skills）、HF、全部社区仓库均采用。
2. **Codex 兼容性**：OpenAI Codex 已原生支持同一 Agent Skills 格式（安装到 `.codex/skills/`）；差异仅在可选扩展字段——HF rocm-kernels 使用了 `disable-model-invocation` / `user-invocable` / `allowed-tools` / `argument-hint`；hipblaslt 的 tensilelite-mutation-rerun 带 `agents/openai.yaml`。ROCmKernelWiki 自述"打包为 Codex CLI skill，兼容 Claude Code"。
3. **AGENTS.md / CLAUDE.md 仓库级指南**在 AMD 官方库（rocm-libraries 13 个、TheRock）大量存在——它们不是按需加载的 skill，而是常驻上下文的仓库说明书，两者互补。
4. **安装形态**：`npx skills add <owner>/<repo>`（vercel-labs/skills CLI，skills.sh 注册表）是主流分发方式；IntelliKit 用 curl|bash install.sh；amd/skills 另有官方 Claude 插件。

## 七、对 forge 的建议（供参考）

1. 优先吸收三处：**GEAK expert_skills/tuning**（hipBLASLt/CK/AITER 调优流程）、**AKA cheatsheets**（架构×语言最佳实践）、**Arist12 amd-rocm-porting**（CUDA→ROCm 移植铁律）——三者互补且都是 SKILL.md/可转 SKILL.md。
2. Profiler 方向直接对标 IntelliKit 五件套 + `rocprofv3-profiler`（Arist12）+ `rocm-report-skill`（jhinpan）。
3. 用 AgentKernelArena 的 214 任务作为 forge 算子能力的评测集（hip2hip/torch2hip 最贴近算子开发）。
4. 中文输出可参考 hello-rocm 的术语与结构。

## 八、搜索过但确认不存在的路径

| 路径 | 结果 |
|---|---|
| anthropics/skills 官方仓库（19 个 skills 全列表 grep） | **无任何 AMD/ROCm/HIP/GPU kernel 条目**（仅 docx/pptx 等办公技能） |
| VoltAgent/awesome-agent-skills（1000+ skills）README | `rocm`/`amd` 0 次匹配 |
| ComposioHQ/awesome-claude-skills、travisvn/awesome-claude-skills | 搜索确认无 ROCm/HIP 专属条目 |
| gitcode.com API（关键词：rocm skill / hip skill / amd claude / rocm agent） | 全部为空 |
| gitee.com API（关键词：ROCm / claude skill） | 无算子 skill 结果（仅通用 Claude skills 镜像如 910024445/skills） |
| github.com/ROCm 组织 | 无独立"skills 总目录"仓库；skills 分散在 TheRock / rocprofiler-systems-skills / IntelliKit(ROCm/IntelliKit 为文档镜像，实库在 AMDResearch) / rocm-libraries |
| mcpmarket 的 amd-rocm-hip-development 条目 | 找不到对应 GitHub 公开源仓库（疑市场自建） |
| "AMD 版 CUTLASS agent skill"（CUTLASS→CK 专用 skill） | 不存在；CK 知识只在 GEAK perf_knowledge 与 rocm-libraries AGENTS.md 中 |
| hipify 专用独立 skill 仓库 | 不存在；hipify 知识内嵌于 Arist12/amd-rocm-porting 与 amd/skills docs/best-practices 示例 |

## 附录：已执行搜索关键词（20 组）

rocm claude skill SKILL.md github / "claude skills" ROCm HIP AMD GPU / github.com/ROCm agent skills repository / hipify composable kernel rocblas claude code skill agent / awesome claude skills GPU ROCm HIP AMD kernel / yechuasilva AMD agent skills / gitee ROCm 算子开发 skill / huggingface skills rocm-kernels triton MI355X / github "rocm-kernels" skill Triton R9700 / gitcode ROCm skill 算子 kernel HIP claude / GEAK V3 agent-driven GPU kernel optimization / AMD-AGI GEAK github / 知乎 AMD Skills ROCm Claude Cursor Codex / amd skills rocm.docs.amd.com / awesome-claude-skills awesome-agent-skills rocm entry / "skills.sh" AMD ROCm registry / GitHub API: rocm skill in:name,description / GitHub API: org:ROCm agent OR skill OR CLAUDE / mcpservers.org + mcpmarket 条目 / rocm-report-skill、rocmlib-skills 等 GitHub 搜索翻页
