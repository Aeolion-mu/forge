# Triton 算子开发 Skills 调研报告

> 调研日期：2026-09-08
> 范围：Triton（openai/triton 生态，含国产芯片 Triton 后端）相关的 Claude Code SKILL.md 格式技能包、Codex 格式 prompt/技能包，以及可转化为 skill 的高质量素材仓库。
> 渠道：github.com / gitcode.com / gitee.com，中英文关键词共 20+ 组。
> 方法：重点仓库已 `git clone --depth 1` 到 /tmp/triton-research/ 实际核验内容与格式。

---

## 一、总体结论

1. **现成 Triton skills 生态已经相当成熟**，且国内外大厂均已入场：NVIDIA（TensorRT-LLM 内置 skill）、华为昇腾（Ascend/agent-skills + CANNBot skills，共 16+ 个 Triton 专项 skill）、智源 FlagOS（kernelgen）、HuggingFace（triton-kernels）均有官方出品。
2. **格式高度收敛于 Agent Skills 开放标准**（agentskills.io，即 Claude Code 的 SKILL.md + YAML frontmatter），绝大多数仓库同时声明兼容 Claude Code / Codex / Cursor / OpenCode / TRAE，并推荐用 `npx skills add`（vercel-labs/skills）统一安装。
3. **国产芯片（昇腾）方向的 Triton skills 是全场最丰富的一支**：Ascend 官方 + CANNBot + 社区 dev-kit + awesome-ascend-skills 聚合，覆盖 Triton 算子「设计→编码→检视→精度→性能→优化→迁移」全流程。
4. 少数仓库格式不标准（tensormux 无 frontmatter、HF 用表格式 frontmatter），接入前需做少量转换。

---

## 二、现成 skills 仓库（已 clone 核验）

### 2.1 NVIDIA/TensorRT-LLM `.claude/skills/kernel-triton-writing` ★ 重点推荐

- **URL**: https://github.com/NVIDIA/TensorRT-LLM/tree/main/.claude/skills/kernel-triton-writing
- **维护方**: NVIDIA 官方（随 TensorRT-LLM 主线维护）
- **内容清单**（已 clone 核验）:
  - `SKILL.md`（正确性优先原则、FP16/BF16 精度规则、CPU-GPU 同步规避、C 整数除法语义等）
  - `references/`：api-core.md、api-language.md、concepts-semantics.md、operator-routing.md、patterns-basic.md、patterns-fusion.md、patterns-gemm.md、patterns-advanced.md、troubleshooting.md（共 9 份参考）
  - `scripts/verify_kernel.py`、`benchmark_kernel.py`（配套验证/压测脚本，skill 要求强制跑 verify）
- **格式**: 标准 Claude Code SKILL.md（YAML frontmatter: name / tags / description / license / metadata），安装：`npx skills add https://github.com/nvidia/tensorrt-llm --skill kernel-triton-writing`
- **同仓库兄弟 skill**: kernel-cute-writing（CUTLASS CuTe）、kernel-tileir-optimization、perf-optimization、perf-nsight-* 等 29 个 `.claude/skills/`
- **活跃度/license**: TRT-LLM 主线高频更新 / skill 声明 Apache-2.0

### 2.2 Ascend/agent-skills（华为昇腾官方）★ 国产芯片首选

- **URL**: https://github.com/Ascend/agent-skills
- **维护方**: 华为昇腾官方
- **内容清单**（已 clone 核验，共 61 个 skill、8 大类）:
  - **Triton 算子开发类（9 个，全流程）**：`triton-operator-dev`（总编排：环境配置→需求设计→代码生成→静态检视→精度验证→性能评估→性能优化 7 阶段，含 TaskCreate 跟踪与场景路由表）、`triton-operator-design`、`triton-operator-env-config`、`triton-operator-code-gen`、`triton-operator-code-review`、`triton-operator-precision-eval`、`triton-operator-performance-eval`、`triton-operator-performance-optim`、`triton-operator-doc-gen`，另有 `triton-operator-shared/`（共享 references）
  - **迁移优化类**：`simple-vector-triton-gpu-to-npu`（GPU Triton→NPU）、`vector-triton-ascend-ops-optimizer`、`tilelang-vector-ascend-ops-migration`
  - **AscendC 算子开发类 9 个** + **Catlass 算子开发类 5 个**（对比参考价值高）
- **格式**: 标准 SKILL.md（中文，frontmatter name/description 含触发关键词），`npx skills add ascend/agent-skills --skill triton-operator-dev`，支持安装到 trae/opencode 等
- **活跃度/license**: 最后提交 2026-05-07 / MulanPSL-2.0
- **相关报道**: 知乎《FlagOS/Ascend skills 整理》、CSDN《1 小时完成 Triton Vector 算子开发》（昇腾 8 模块 Triton Skills 体系）

### 2.3 CANNBot skills（华为 CANN 官方，GitCode）

- **URL**: https://gitcode.com/cann/cannbot-skills （克隆时用了镜像 gitcode.com/xiaodong666/cannbot-skills）
- **维护方**: 华为 CANN 官方（GitCode 平台）
- **内容清单**（已 clone 核验）:
  - `ops/` 共 **69 个 skill**，其中 **Triton 专项 7 个**：`triton-task-extractor`（算子提取）、`triton-op-designer`（算法草图）、`triton-op-coding`（代码生成，backend=ascend/framework=torch/dsl=triton_ascend 固定参数）、`triton-op-verifier`、`triton-latency-optimizer`、`triton-precision-debug`、`triton-simulator-optimizer`，共享 `npu-arch`；每个 skill 带 SKILL.md + evals/evals.json + references/ + scripts/
  - 另有 AscendC 24 个、PyPTO 16 个、TileLang 8 个、Catlass 3 个
  - `plugins-official/triton-op-generator/`：**多 Agent 编排插件**——AGENTS.md（frontmatter 含 `mode: primary`、`temperature: 0.1`、`skills:` 子技能列表、permission）+ 6 阶段工作流 + 8 类算子模板（index-computation / math-compute / normalization / object-detection / quantization / tensor-transform / transformer-inference）+ init.sh 安装器
  - `graph/`（torch-npugraph 图模式 7 个）、`runtime/`、`model/`、`plugins-community/`
- **格式**: agentskills.io 标准 SKILL.md（YAML frontmatter 含 argument-hint）+ Codex 风格 AGENTS.md；init.sh 支持 OpenCode（推荐）、Claude Code、TRAE、Cursor、Copilot、CodeArts
- **活跃度/license**: 最后提交 2026-08-04（活跃）/ CANN Open Software License v2.0；npm 安装器 `@cannbot-ai/install-helper`

### 2.4 Krusty84/triton-ascend-agent-dev-kit（社区，双格式）

- **URL**: https://github.com/Krusty84/triton-ascend-agent-dev-kit （约 106 stars）
- **维护方**: 社区个人（LeChat），质量很高
- **内容清单**（已 clone 核验）:
  - `AGENTS.md`：Codex 格式项目指令，核心原则「**抛弃 GPU/CUDA 心智模型**」——禁止机械移植 GPU Triton 代码、禁止引入 CUDA 假设
  - `triton-ascend-dev-doc.md`（加载规则索引）+ `triton-ascend-dev-doc/` **12 章文档**：01-quick-start、02-execution-model-and-architecture、03-common-kernel-development、04-vector-kernels、05-cube-kernels、06-cube-vector-fusion、07-memory-tiling-and-performance、08-autotuning、09-gpu-to-ascend-npu-migration、10-language-and-compiler-reference、11-validation-and-troubleshooting、12-operator-support-matrix-and-constraints
  - `skills/` **24 个 SKILL.md**：build-triton-ascend-{vector-add,fused-softmax,layer-norm,small-matmul,fused-attention,moe-gather-scatter,padded/binned-moe-routing}、optimize-triton-ascend-{discrete-loads,grouped-attention-access,int-vectors}、prevent-triton-ascend-ub-overflow、tile-triton-ascend-gather、tune/validate/max-autotune-triton-ascend 等
- **格式**: 同时提供 Codex AGENTS.md + Claude 风格 skills/，发布打包为 Releases 压缩包
- **活跃度**: 最后提交 2026-08-15（活跃）

### 2.5 flagos-ai/skills（智源 FlagOS 官方）

- **URL**: https://github.com/flagos-ai/skills
- **维护方**: 智源研究院 FlagOS 团队（官方）
- **内容清单**（已 clone 核验，12 个 skill）:
  - **`kernelgen-flagos`**（核心）：统一 GPU 算子生成/优化 skill，自动检测目标仓库类型（FlagGems / vLLM / 通用 Python/Triton）分派子技能；含 kernelgen-generate.md、kernelgen-optimize.md、kernelgen-generate-for-flaggems.md、kernelgen-generate-for-vllm.md，支持 MCP 迭代优化
  - `flaggems-pr-review-flagos`、`flaggems-pr-submit-flagos`（FlagGems PR 流程）、`perf-test-flagos`、`tle-developer-flagos`（TileLang）、`model-migrate-flagos`、`install-stack-flagos`、`gpu-container-setup-flagos` 等
  - `spec/agent-skills-spec.md`：自带 Agent Skills 规范说明
- **格式**: agentskills.io 开放标准，frontmatter 扩展了 argument-hint / user-invokable / compatibility / allowed-tools / metadata；README 明确兼容 **Claude Code、Cursor、Codex**；`npx skills add flagos-ai/skills --skill kernelgen-flagos`
- **活跃度/license**: 最后提交 2026-07-18 / Apache-2.0
- **报道**: 知乎《FlagOS Skills 详细整理：部署与发布，基准测试，内核算子开发》 https://zhuanlan.zhihu.com/p/2024207186176288648 ；ModelScope 课程 https://modelscope.cn/learn/6564

### 2.6 tensormux/kernel-skills

- **URL**: https://github.com/tensormux/kernel-skills
- **维护方**: TensorMux 公司（社区/商业混合，开源 skill 库）
- **内容清单**（已 clone 核验）:
  - `skills/triton/`：write-triton-{gemm,softmax,layernorm,attention}-kernel、optimize-triton-block-parameters
  - `skills/inference/`：write-triton-{silu-mul,rmsnorm,kv-cache-append,sampling}-kernel
  - `skills/cuda/` 9 个、`skills/patterns/` 5 个（数值稳定、边界条件、tile 选择、算子融合、测试计划）、`skills/portability/`、`skills/quantization/`
  - `proof/`：验证过的 kernel 实例（triton/attention、triton/softmax 等）
  - npm 包 `@krxgu/kernel-skills`（带 CLI 与 TypeScript API）、schema/、examples/
- **格式**: ⚠️ SKILL.md **无 YAML frontmatter**（纯 Markdown 章节式：Purpose / Use this when / Do not use this when / Required reasoning process…）。内容质量高但接入 Claude Code 需补 frontmatter
- **活跃度/license**: 最后提交 2026-06-22 / MIT

### 2.7 slowlyC/agent-gpu-skills

- **URL**: https://github.com/slowlyC/agent-gpu-skills
- **维护方**: 社区（知乎作者 slowlyC）
- **内容清单**（已 clone 核验）: 4 个 skill——`triton-skill`（Triton + Gluon）、`cuda-skill`（CUDA/PTX）、`cutlass-skill`（CUTLASS/CuTe/CuTeDSL）、`tilelang-skill`，每个含 SKILL.md + quick-reference.md
- **思路特色**: `update-repos.sh` 对上游仓库做 shallow sparse checkout 到 `third_party/`，skill 指导 agent **检索本地 triton 源码/教程/生产 kernel**（解决模型记忆过时问题）；`install.sh --agent codex|claude|...` 多端安装
- **格式**: 标准 SKILL.md frontmatter（name/description 含大量触发词）
- **活跃度/license**: 最后提交 2026-08-08（很新）/ MIT
- **介绍文章**: 知乎《Agent GPU Skills 介绍》 https://zhuanlan.zhihu.com/p/2011569660810785777

### 2.8 huggingface/kernels（kernel-builder 内置 skills）

- **URL**: https://github.com/huggingface/kernels/tree/main/kernel-builder/skills
- **维护方**: HuggingFace 官方
- **内容清单**（已 clone 核验）: `triton-kernels/`——SKILL.md + references/{kernel-patterns.md, autotune-guide.md, benchmarking-guide.md}；同仓还有 cuda-kernels（含 A100/H100/T4 优化指南、kernel-templates）、rocm-kernels（mi355x/r9700 指南）、xpu-kernels（Intel）、cpu-kernels
- **格式**: ⚠️ frontmatter 用 **Markdown 表格**（`| name | triton-kernels |`）而非 YAML，由 `kernel-builder skills add` 安装到 Claude/Codex/OpenCode 时转换；文档 https://huggingface.co/docs/kernels/cli-skills
- **配套博客**: 《Custom Kernels for All from Codex and Claude》 https://huggingface.co/blog/custom-cuda-kernels-agent-skills ；Intel XPU 版 https://huggingface.co/blog/danf/intel-xpu-kernels-skill
- **活跃度/license**: HF 主线活跃 / Apache-2.0（kernels 仓库）

### 2.9 ascend-ai-coding/awesome-ascend-skills（华为系聚合库）

- **URL**: https://github.com/ascend-ai-coding/awesome-ascend-skills
- **维护方**: 华为系（ascend-ai-coding org）
- **内容清单**（已 clone 核验）:
  - `skills/ops/triton-ascend-migration`：GPU/CUDA Triton → Triton-Ascend 迁移 skill，覆盖 coreDim、UB overflow、1D grid、物理核绑定、block_ptr、stride、访存对齐、mask 性能、dtype 退化等昇腾特有约束（含 references/）
  - `skills/ops/` 另有 ascend-opplugin、ascendc、npu-op-benchmark；`skills/{base,training,inference,profiling,agent-tools,ai-for-science}`
  - `external/`：自动同步 gitcode-ascend 与 cannbot 的外部 skills（含 triton-operator-design 等）
- **格式**: 标准 SKILL.md；README 声明兼容 Claude Code、OpenCode、Cursor、Trae、Codex；已注册 skills.sh（https://skills.sh/ascend-ai-coding/awesome-ascend-skills ）；带 .claude-plugin 与 web 导航站
- **活跃度**: 最后提交 2026-06-30

### 2.10 ZJLi2013/awesome-kernel-skills

- **URL**: https://github.com/ZJLi2013/awesome-kernel-skills
- **维护方**: 社区（蒸馏自 RightNow-AI/autokernel 的 program.md）
- **内容清单**（已 clone 核验）: **18 个 SKILL.md**——7 个 kernel skill（gemm、softmax、rmsnorm、flash-attention、cross-entropy、fused-moe、rotary-embedding，**每个配 triton_template.py 双平台模板 + test_*.py**）、6 个 optimization tier skill（memory-access→advanced-scheduling→arch-nvidia/amd）、5 个 system skill（benchmark/verification/profiling/bottleneck-diagnosis/optimize-loop）+ LEARNING_PATH.md 两周学习路径
- **验证平台**: NVIDIA RTX 4090 + AMD MI300X，7/7 算子双平台通过
- **格式**: 标准 SKILL.md frontmatter（name/description），设计为挂载到 Cursor/Claude Code/Codex
- **活跃度**: 最后提交 2026-03-31 / license 未标注文件（README 无明确 license）

### 2.11 nvidia/skills（NVIDIA 官方 skill 目录）

- **URL**: https://github.com/nvidia/skills
- **维护方**: NVIDIA 官方
- **内容清单**（已 clone 核验）: 300+ skill，Triton 相关为 **tilegym 系列**：`tilegym-converting-cutile-to-triton`（cuTile→Triton 转换，带 evals/references/translations/skill-card.md/OAT 签名）、tilegym-improve-cutile-kernel-perf、tilegym-adding-cutile-kernel、tilegym-cutile-autotuning 等；另有 warp-*（Warp Python GPU 语言）系列
- **格式**: 标准 frontmatter（name/version/description/license/tools/metadata），带 skill.oms.sig 数字签名与 benchmarks.json——工程化程度最高的 skill 仓库
- **活跃度/license**: 最后提交 2026-09-04（非常活跃）/ CC-BY-4.0 AND Apache-2.0

### 2.12 其他单项技能 / 框架内置 skills

| 位置 | 说明 |
|---|---|
| `sgl-project/sglang` `.claude/skills/add-jit-kernel` | SGLang 仓库内置 Claude skill（CUDA JIT kernel 添加教程，格式范本）；同目录还有 debug-cuda-crash 等（已 fetch 核验） |
| `Ascend/sgl-sglang` `.claude/skills/` | SGLang 昇腾版的内置 skills |
| `vllm-project/vllm-skills` | vLLM 官方 skills 仓库（本次 clone 失败，未核验 Triton 专项；由知乎整理文确认存在）https://github.com/vllm-project/vllm-skills |
| `vllm-project/vllm-ascend/.agents`、`vllm-project/vllm-omni/.claude/skills` | vLLM 昇腾/多芯片版内置 skills |
| `pytorch/pytorch` `.claude/skills/` | PyTorch 官方仓库内置 skills（上玉米！含 kernel 相关，非 Triton 专项） |
| `amd/skills` | AMD 官方 skills（GPU kernel 评测、兼容 Codex/Gemini CLI）https://github.com/amd/skills |
| `BBuf/SGLang-Auto-Driven-SKILLS` | SGLang 社区（BBuf）自动驾驶开发 skills https://github.com/BBuf/SGLang-Auto-Driven-SKILLS |
| LobeHub 镜像 | `lobehub.com/zh/skills/nvidia-skills-kernel-triton-writing`、`a5c-ai-babysitter-cutlass-triton`、`dongg622-china-ai-chip-skill-triton-ascend-migration`（原仓库已 404） |
| skills 市场 | skills.sh、awesomeskill.ai（/tag/cuda）、mcpservers.org、skillsllm.com、awamer.ai、skillselion.com 均收录上述 skills 的镜像页 |
| VoltAgent/awesome-agent-skills | 收录 nvidia kernel-triton-writing 等条目的 awesome 列表（兼容 Claude Code/Codex/Cursor）https://github.com/VoltAgent/awesome-agent-skills |

---

## 三、素材类仓库（非现成 skill，适合转成 skill）

| 仓库 | URL | 价值 |
|---|---|---|
| **openai/triton（triton-lang/triton）** | https://github.com/triton-lang/triton （gitee 镜像: https://gitee.com/mirrors/openai-triton 、/mirrors/triton ） | `python/tutorials/` 30+ 官方教程（01-vector-add、02-fused-softmax、03-matrix-multiplication、layer-norm、grouped-gemm…），是最权威的 Triton 素材；slowlyC/agent-gpu-skills 就是把它打包成本地检索 |
| **flagos-ai/FlagGems**（原 FlagOpen） | https://github.com/flagos-ai/FlagGems （gitee: https://gitee.com/magicor/FlagGems ） | 200+ 后端中立 Triton 算子库，已加入 PyTorch 生态；其算子实现模式 + benchmark 体系是「算子实现 skill」的最佳语料；FlagOS 2.0 宣称 497 算子、KernelGen 在 5 种国产芯片上正确率 >95% |
| **linkedin/Liger-Kernel** | https://github.com/linkedin/Liger-Kernel | LLM 训练 Triton kernel 合集（RMSNorm/RoPE/SwiiGLU/Fused CE/FLCE…），训练吞吐 +20%、显存 -60%；论文 arXiv:2410.10989；适合做「融合算子模式」skill 素材 |
| **gpu-mode/lectures（GPU MODE / 原 CUDA MODE）** | https://github.com/gpu-mode/lectures | 106 讲社区讲座材料；Lecture 14《A Practitioner's Guide to Triton》、Lecture 78《Iris: Multi-GPU Programming in Triton》等大量 Triton notebook，适合做教程型 skill 素材 |
| **triton-lang/triton-ascend**（原 Ascend/triton-ascend） | https://github.com/triton-lang/triton-ascend （gitee: https://gitee.com/ascend/triton-ascend ；docs: https://triton-ascend.readthedocs.io ） | 昇腾官方 Triton 后端；`docs/en/programming_guide/` 算子开发指南（NPU 上写 Triton 的注意事项），是国产芯片 skill 的一手素材 |
| **ciggaco/triton-ascend-kernels** | https://gitcode.com/ciggaco/triton-ascend-kernels | 昇腾亲和高性能 Triton 算子库，含性能/功能测试与文档（Krusty84 dev-kit 引用） |
| **Zhao-jiacheng/triton-ascend**（GitCode 镜像） | https://gitcode.com/Zhao-jiacheng/triton-ascend | `docs/HighPerformanceGuide.md` 高性能 Triton 算子编程开发指南（并发任务数、Tile/Block 切块、数据读写方式等昇腾调优要点） |
| **AMD-AGI/GEAK** | https://github.com/AMD-AGI/GEAK | AMD 的 Triton kernel 优化 agent（多智能体 + 进化搜索），附 **ROCm Triton Benchmark**（30 个真实生产 kernel）；论文 arXiv:2507.23194；博客 https://rocm.blogs.amd.com/software-tools-optimization/triton-kernel-ai/ ；同 org 还有 AMD-AGI/Apex（RL 训练环境） |
| **RightNow-AI/autokernel** | https://github.com/RightNow-AI/autokernel | 自主 GPU 算子优化 agent，900 行 program.md 调优手册（6 层 tier）——awesome-kernel-skills 即由它拆解而来 |
| **TongmingLAIC/AKO4ALL** | https://github.com/TongmingLAIC/AKO4ALL | AKO（Agentic Kernel Optimization），SOL-ExecBench 13 kernel 中 10 个超过 NVIDIA 多智能体基线 |
| **meta-pytorch/KernelAgent** | https://github.com/meta-pytorch/KernelAgent | Meta 的 PyTorch→验证 Triton kernel 多智能体合成（KernelBench 向） |
| **IntelLabs/Triton8 / Xe-Forge** | https://github.com/IntelLabs/Triton8 、https://github.com/IntelLabs/Xe-Forge | Intel 的 Triton kernel 生成/优化 agent，Triton8 自带精选知识库（curated knowledge base）——其知识组织方式值得 skill 化参考 |
| **昇腾社区 Triton 学习路径** | https://www.hiascend.com/edu/growth/details/40da2182f5c94d4c9ddb2b582161e0f5 | 官方系列教程（架构原理 + 算子实战） |
| **知乎 AI infra skills 整理（小力龙虾）** | https://zhuanlan.zhihu.com/p/2023063871259177169 | 上述生态的中文导航总表（vllm/sglang/torch/国产芯片 skills 全景） |

---

## 四、国产芯片 Triton 后端（仅记 URL，不深挖）

| 厂商 | 仓库/入口 |
|---|---|
| 昇腾 Ascend（华为） | https://github.com/triton-lang/triton-ascend （gitee: https://gitee.com/ascend/triton-ascend ） |
| 摩尔线程 Moore Threads | Torch-MUSA 的 Triton-MUSA 后端（Torch-MUSA v2.0.0+）；https://github.com/MooreThreads/tutorial_on_musa 、https://github.com/MooreThreads/vllm-musa 、https://github.com/MooreThreads/tilelang_musa |
| 沐曦 MetaX | mcTriton（MXMACA 后端，基于 Triton 2.1.0）: https://developer.metax-tech.com/api/client/document/preview/551/C500_mcTritonUserGuide_CN.html ；https://github.com/MetaX-MACA/vLLM-metax |
| 天数智芯 Iluvatar | 经 FlagTree 的 iluvatar 后端（已升级 Triton 3.6） |
| 统一多后端 | **flagos-ai/flagtree**: https://github.com/flagos-ai/flagtree —— fork 自 triton-lang/triton，一个仓库接入 18 个 AI 芯片后端（摩尔线程/沐曦/天数/平头哥/辉羲/达摩院等）；知乎解读 https://zhuanlan.zhihu.com/p/2071199903762610097 |
| 昆仑芯/燧原/壁仞/寒武纪（vLLM 插件线） | baidu/vLLM-Kunlun 、EnflameTechnology/vllm-gcu 、enginex-biren-vllm/vllm_br 、Cambricon/vllm-mlu |

---

## 五、格式兼容性结论

1. **主流格式 = Claude Code SKILL.md（YAML frontmatter：name + description，正文 Markdown）**，即 agentskills.io 开放标准。下列仓库**原生兼容、零转换可用**：NVIDIA/TensorRT-LLM、Ascend/agent-skills、CANNBot、flagos-ai/skills、Krusty84 dev-kit、slowlyC/agent-gpu-skills、ZJLi2013、nvidia/skills、ascend-ai-coding/awesome-ascend-skills、sglang。
2. **Codex 格式（AGENTS.md）与 SKILL.md 并存**是国产仓库的普遍做法：CANNBot 的 triton-op-generator 用 AGENTS.md 做多 agent 编排（frontmatter 含 mode/temperature/skills/permission）；Krusty84 用 AGENTS.md 做项目级指令 + skills/ 做任务技能。两者可同时安装互不冲突。
3. **需要少量转换**的仓库：
   - tensormux/kernel-skills：SKILL.md 无 frontmatter（纯章节式），接入 Claude Code 前需补 name/description；
   - huggingface/kernels：frontmatter 是 Markdown 表格，仅能经 `kernel-builder skills add` 安装，直接复制需改为 YAML。
4. **通用安装器事实标准**：`npx skills add <owner>/<repo> --skill <name>`（vercel-labs/skills），Ascend、FlagOS、awesome-ascend-skills、TensorRT-LLM 均给出该命令；HF 用自家 `kernel-builder skills add`；CANNBot 用 `init.sh`/npm `@cannbot-ai/install-helper`。
5. **中文化程度**：昇腾系（Ascend/CANNBot/awesome-ascend）与 FlagOS 的 skill 描述与正文为中文；NVIDIA/HF/tensormux 为英文。forge 若做中英混合算子 skill，两边的触发词写法（frontmatter description 里堆关键词）都值得借鉴。

---

## 六、对 forge 的落地建议（供主 agent 参考）

1. **直接可用性最高的组合**：NVIDIA kernel-triton-writing（英文、通用 Triton、带 verify 脚本）+ Ascend triton-operator-* 9 件套（中文、昇腾全流程）+ HF triton-kernels（跨 NVIDIA/AMD + Hub 发布流程）。
2. **昇腾/国产芯片方向**已有官方全家桶（Ascend/agent-skills + CANNBot + awesome-ascend-skills 聚合 + Krusty84 dev-kit），forge 不必自研，可做「调度/翻译层」。
3. **自建 skill 的最佳语料**：openai/triton tutorials + FlagGems 算子模式 + Liger-Kernel 融合模式 + gpu-mode lectures + triton-ascend programming guide。
4. **工程化亮点可抄**：nvidia/skills 的 skill 数字签名（skill.oms.sig）与 benchmarks.json；CANNBot 的 evals/evals.json 每 skill 自带评测；TensorRT-LLM 的强制 verify_kernel.py 流程。

---

## 七、搜索过但确认不存在 / 无法核实的路径

| 检索路径 | 结果 |
|---|---|
| anthropics/skills 官方仓库中的 Triton/GPU kernel 专项 skill | **不存在**——官方仓库为通用技能（文档处理、artifacts 等），无 GPU/Triton 条目（Triton skill 集中在 NVIDIA/Ascend/HF 等厂商仓库） |
| GitHub 用户 m0at 的 triton-skill 仓库（skills.rest 收录） | **未找到**——skills.rest 页面存在（skills.rest/skill/triton-skill），但 GitHub 上检索不到 m0at 的对应仓库，无法核验源 |
| dongg622/china-ai-chip-skill | **已失效**——GitHub API 返回 404（删除或改名）；LobeHub 仍有其 triton-ascend-migration 等镜像条目 |
| gitee.com 上的 Triton skill 仓库 | **不存在独立仓库**——gitee 只有 mirrors/openai-triton、mirrors/triton、ascend/triton-ascend、magicor/FlagGems 等镜像/后端仓库，无 SKILL.md 技能包 |
| gitcode.com 上 Ascend/agent-skills 的社区分支 | 存在（weixin_45649869/agent-skills add_opplugin 分支、qiuqianjin233/agent-skills triton_opt_0410 分支），已由 awesome-ascend-skills 的 external/ 同步机制收录 |
| GitHub code search API（kernel-triton-writing in:path） | 需认证无法直接用；已改用 TensorRT-LLM 仓库 `git ls-tree` 实际验证存在 |
| VoltAgent/awesome-agent-skills 原创 Triton skill | 无原创——仅收录 nvidia kernel-triton-writing 等第三方条目 |
| openai/triton 官方仓库自带 agent skills | **不存在**——只有 tutorials/，无 .claude/skills 或 SKILL.md |

---

## 附：本次 clone 核验清单（/tmp/triton-research/）

kernel-skills（tensormux）、flagos-skills、ascend-agent-skills、cannbot-skills、agent-gpu-skills、awesome-kernel-skills、nvidia-skills、triton-ascend-dev-kit、awesome-ascend-skills、trtllm（sparse: .claude）、hf-kernels（sparse: kernel-builder/skills）
