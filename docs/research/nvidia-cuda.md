# NVIDIA(CUDA 生态)算子开发 Skills 调研报告

> 调研日期:2026-09-08
> 调研范围:github.com / gitcode.com / gitee.com / 知乎 / CSDN / build.nvidia.com / developer.nvidia.com,中英文关键词 20+ 组
> 调研对象:Claude Code SKILL.md 格式技能包、OpenAI Codex 格式技能/prompt 包、以及可转化为 skill 的高质量素材
> 方法:重点仓库 `git clone --depth 1` 到 /tmp 实际验证内容,辅以 GitHub API、Web 搜索、网页抓取交叉确认

---

## 一、总体结论

1. **NVIDIA 生态是所有芯片厂商中"现成算子开发 skills"最丰富、质量最高的生态**,没有之一。官方(nvidia/skills)、半官方(HuggingFace kernels、FlashInfer)、社区(tensormux、KernelFlow、mit-han-lab)三层都有高质量产出。
2. **格式上 Claude Code SKILL.md 是绝对主流**。Codex 生态没有独立的"技能包"格式,实践做法是把同一份 SKILL.md 放进 `~/.codex/skills/` 或通过 `AGENTS.md` 引用;NVIDIA 内部(Dynamo、Model Optimizer)已把 `.agents/skills/` 作为规范位置、`.claude/skills/` 作为兼容符号链接,即"一份 SKILL.md、多工具消费"。
3. 官方 nvidia/skills 仓库虽大(350 个公开 skill),但**重心在 Physical AI / 机器人 / DOCA / NeMo**,CUDA kernel 开发相关只占一小部分(tilegym-*、kernel-triton-writing、perf-nsight-compute-analysis、compileiq-* 等);**真正面向"写 CUDA 算子"的深度技能在社区仓库里**(tensormux/kernel-skills、KernelFlow-ops/cuda-optimized-skill、ForceInjection/cuda-code-skill、mit-han-lab/ncu-report-skill)。
4. gitee.com / gitcode.com 上**没有发现 CUDA 算子专用 skill 仓库**(只有通用 agent-skills 合集);中文产出集中在 GitHub(ForceInjection、slowlyC、KernelFlow、maxiaosong1124)和知乎/CSDN 的讨论与介绍文章。

---

## 二、重点现成 skills 仓库(实测 clone 验证)

### 2.1 nvidia/skills —— NVIDIA 官方 Agent Skills 库 ⭐ 最重要的官方来源

- **URL**:https://github.com/nvidia/skills
- **维护方**:NVIDIA 官方(标注 "install into Claude Code, Codex, and other coding agents")
- **活跃度**:3236 stars;最后提交 2026-09-04(本周仍在更新);双许可 Apache-2.0 + CC-BY-4.0
- **格式**:标准 Claude Code SKILL.md(仓库自带 `skills.sh` CLI 安装器,并进入 Cursor 的 NVIDIA 插件目录)
- **规模**:公开镜像 350 个 skill(已实测 clone 计数)
- **内容清单(与 CUDA 算子开发相关的部分)**:
  - `tilegym-*`(7 个):`tilegym-cutile-python`(cuTile 专家编程)、`tilegym-adding-cutile-kernel`、`tilegym-improve-cutile-kernel-perf`(迭代调优)、`tilegym-cutile-autotuning`、`tilegym-converting-cutile-to-triton`、`tilegym-converting-cutile-to-julia`、`tilegym-monkey-patch-kernels-to-transformers`——对应 NVIDIA/TileGym 与 nvidia/cutile-python 仓库
  - `cudaq-guide`(CUDA-Q 量子)、`accelerated-computing-cudf`(cuDF)、`nemo-mbridge-perf-cuda-graphs`、`deepstream-profile-pipeline`(Nsight Systems 分析 pipeline)
  - **注意**:公开 repo 是内部技能目录的部分镜像。第三方索引(mcpservers.org、skills.sh、explainx.ai)与 GitHub issue #87("Skills dropped from sync — missing required artifacts (52)",https://github.com/NVIDIA/skills/issues/87)证实完整目录还包含但当前公开仓库**缺失**:`kernel-triton-writing`(TensorRT-LLM 类别,"ONLY for OpenAI Triton (@triton.jit) kernel development",带 verify_kernel.py)、`perf-nsight-compute-analysis`(ncu 输出分析:SOL% 瓶颈分类、roofline、occupancy)、`perf-torch-cuda-graphs`、`perf-torch-sync-free`、`perf-workload-profiling`、`compileiq-*`(6 个,CUDA 编译 flag 自动调优,ptxas 搜索空间)、`cutedsl-kernel-integration`(CuTeDSL kernel 接入 cuDNN Frontend)、`tripy-*`(nvtripy/TensorRT Python 前端)。镜像索引见 https://mcpservers.org/agent-skills/author/nvidia
- **评价**:官方背书、量大,但 CUDA kernel 专精技能占比低;`tilegym-*` 与 `kernel-triton-writing` 值得直接取用/参考。

### 2.2 KernelFlow-ops/cuda-optimized-skill —— 社区最高质量的"优化循环"skill ⭐ 强烈推荐

- **URL**:https://github.com/KernelFlow-ops/cuda-optimized-skill
- **维护方**:社区(KernelFlow-ops,中文团队,双语 README)
- **活跃度**:203 stars;最后提交 2026-09-05;MIT
- **格式**:Claude Code SKILL.md(391 行)+ 20+ 配套 Python 脚本 + references + templates
- **内容清单**:单一技能 `cuda-kernel-optimizer`——围绕 Python reference 对 CUDA/CUTLASS/Triton kernel 做**证据驱动的迭代优化循环**:
  - roofline 驱动的轴预算分配(compute/memory/latency 三间隙 Δc/Δm/Δl 按比例分配方法名额,三 Δ 全 < 0.15 时输出 `near_peak` 提前终止)
  - Branch-and-Select 分支探索(每轮 K=4 候选,选 champion)
  - Leave-one-out 消融归因(单方法因果贡献)
  - **SASS 指令级验证**(`cuobjdump --dump-sass` + `sass_signatures.json` 签名表,确认优化真的出现在机器码里)
  - references/:`optimization_catalog.md`、`ncu_metrics_guide.md`、`metric_registry.json`、`method_registry.json`、`sass_signatures.json`
  - scripts/:profile_ncu / benchmark / roofline / ablate / branch_explore / orchestrate / hardware_gate / strict_validation 等
- **评价**:把"agent 优化算子"工程化为可验证闭环,方法论最完整,可直接作为 forge 的 NVIDIA 优化 skill 的蓝本。

### 2.3 tensormux/kernel-skills —— 社区最大的结构化 kernel-writing SKILL.md 集合 ⭐ 强烈推荐

- **URL**:https://github.com/tensormux/kernel-skills
- **维护方**:tensormux(社区;曾在 r/CUDA 发起讨论 https://www.reddit.com/r/CUDA/comments/1sin13l/)
- **活跃度**:74 stars;最后提交 2026-06-22;MIT
- **格式**:35 个 SKILL.md,按域分组;支持 Claude Code、Codex(ChatGPT 用法文档)、Gemini CLI、Cursor(examples/ 下每个工具都有用法文档)
- **内容清单**:
  - `skills/cuda/`(9):write-cuda-gemm-kernel、write-cuda-softmax-kernel、write-cuda-layernorm-kernel、write-cuda-reduction-kernel、optimize-shared-memory-tiling、optimize-global-memory-access、avoid-warp-divergence、choose-launch-configuration、debug-cuda-kernel-correctness
  - `skills/triton/`(5):gemm/softmax/layernorm/attention + optimize-triton-block-parameters
  - `skills/patterns/`(5):choose-tile-size-and-work-partitioning、fuse-elementwise-ops、handle-boundary-conditions、write-kernel-test-plan、write-numerically-stable-kernel
  - `skills/inference/`(10):triton rope/rmsnorm/silu-mul/kv-cache-append/sampling/dequant、prefill-vs-decode、TensorRT 插件集成计划、vLLM custom op 集成计划
  - `skills/portability/`(3):port-cuda-kernel-to-hip、port-cuda-kernel-to-triton、write-backend-agnostic-kernel-plan
  - `skills/quantization/`(3):fp8、int8、debug-quantized-kernel-accuracy
  - `proof/`:GEMM/softmax/layernorm/reduction 的实测证明与 code-diff(对 A100/H100 类硬件)
- **质量样例**:`write-cuda-gemm-kernel` 的 SKILL.md 包含"何时不要写自定义 kernel(直接用 cuBLAS/CUTLASS)"、tensor core 资格判定、三级 tiling 设计、cp.async 双缓冲、边界处理、寄存器压力估算等完整推理流程——是"算子开发方法论"最系统的开源文本。
- **评价**:对 forge 最直接可用的一套;CUDA 9 个 + patterns 5 个可直接引入或改编。

### 2.4 ForceInjection/cuda-code-skill —— 中文的 RAG 知识库 + 多技能 monorepo

- **URL**:https://github.com/ForceInjection/cuda-code-skill
- **维护方**:社区(中文项目,面向 Claude Code / Trae / Qoder)
- **活跃度**:25 stars;最后提交 2026-07-24;**无 LICENSE 文件**(引用需注意)
- **格式**:Claude Code SKILL.md × 7,monorepo,技能间互相调度
- **内容清单**:
  - `cuda-knowledge`:离线可搜索文档库(抓取自 NVIDIA 官方:PTX ISA、cuBLAS、Runtime/Driver API、Math API、NCCL 等,转成 Markdown)
  - `cuda-samples`:精选 50+ NVIDIA 官方 CUDA Samples,按模式(规约/扫描/GEMM/CUDA Graph)编排,含 GitHub 永久链接与关键代码片段
  - `cuda-optimizer`:任务编排,主导性能分析-优化循环
  - `cuda-code-generator`:生成/修改 .cu,强制先查 knowledge/samples 防幻觉;支持 `-DKERNEL_PROFILE` 条件编译 + `clock64` PTX 指令做 kernel 内 load/compute/store 分段计时
  - `ncu-rep-analyzer`:解析 Nsight Compute 报告 + performance-traps.md
  - `kernel-benchmarker`:编译/正确性/基准测试,PTX 缓存、ncu 自包含可执行、nsys 快速分析
  - `cuda-debugger`
  - `nvidia_doc_sync/scrape_cuda_docs.py`:官方文档抓取流水线(uv 单文件,可随时同步新文档)
- **评价**:思路最适合 forge 借鉴——"离线官方文档库 + 范例索引 + 编排技能"三件套,直接解决 CUDA API 幻觉问题。

### 2.5 huggingface/kernels(kernel-builder skills)—— 半官方,工程质量标杆

- **URL**:https://github.com/huggingface/kernels(`kernel-builder/skills/`)
- **维护方**:Hugging Face 官方
- **活跃度**:740 stars;最后提交 2026-09-08;Apache-2.0
- **格式**:SKILL.md + references + scripts,通过 `kernels skills add cuda-kernels --claude|--codex|--opencode` CLI 安装(文档:https://huggingface.co/docs/kernels/en/cli-skills)
- **内容清单**:5 个技能:`cuda-kernels`(默认)、`triton-kernels`、`rocm-kernels`、`cpu-kernels`、`xpu-kernels`
  - `cuda-kernels`:663 行 SKILL.md + 9 个 references 共 4459 行——H100/A100/T4 三份 per-GPU 优化指南、kernel-templates(695 行)、diffusers/transformers 集成、Kernels Hub 集成、troubleshooting;含"禁止生成模式"表格(pybind11/setup.py/TORCH_LIBRARY 硬命名等 ABI3 硬约束)
- **配套方法论**(官方博客):
  - https://huggingface.co/blog/custom-cuda-kernels-agent-skills("Custom Kernels for All from Codex and Claude"——用 Claude/Codex 在 diffusers 真实目标上验证)
  - https://huggingface.co/blog/upskill("We Got Claude to Build CUDA Kernels"——skill 从 trace 蒸馏并迁移给开源小模型)
- **评价**:单技能信息密度最高的 CUDA skill;其"Hard Constraints / Never-generate 表格 / pre-flight checklist"写法值得 forge 效仿。

### 2.6 mit-han-lab/ncu-report-skill —— Nsight Compute 性能分析 skill(学术出品)

- **URL**:https://github.com/mit-han-lab/ncu-report-skill
- **维护方**:MIT Han Lab(官方学术)
- **活跃度**:223 stars;最后提交 2026-08-26;MIT
- **格式**:根目录 SKILL.md + reference/(10 份)+ helpers/(ncu_report 解析、harness 模板、stall 热点提取、timeline 绘图)
- **内容**:面向 B200/sm_100 的 CUDA kernel profile 全流程:build standalone harness → `--set full` + `--set source` 两次采集 → `ncu_report` Python API 解析(不肉眼看 CLI)→ 六维分析 → 诊断 playbook(信号→病因→修法)→ 证据排序的报告;**中文触发词原生支持**("为什么这个 kernel 慢"、"ncu 报告说…")
- **变体**:yiweny/ncu-report-skill-gb300(GB300/B300 Blackwell Ultra 版)
- **评价**:ncu 分析类写得最好的 skill,和 2.2 的优化循环互补(分析→优化)。

### 2.7 mit-han-lab/KernelWiki —— Blackwell/Hopper 算子优化知识库 skill

- **URL**:https://github.com/mit-han-lab/KernelWiki
- **维护方**:MIT Han Lab
- **格式**:根目录 SKILL.md(自动注册)+ 可查询的条目化知识库(index.md / queries / references / artifacts)
- **内容**:SM100/SM90 kernel 优化结构化知识:tcgen05/TMEM/CLC/NVFP4/2-SM 协作、warp specialization、FlashAttention-4、DeepGEMM、FlashMLA、MoE/grouped GEMM、CuTe-DSL/PTX/Triton on Blackwell、Hopper→Blackwell 迁移(wgmma→tcgen05)、以及 CUTLASS/SGLang/vLLM/FlashInfer/PyTorch 的具体 PR 引用;附带 GPU MODE NVFP4 hackathon 与 FlashInfer MLSys 2026 竞赛数据
- **评价**:最前沿架构(Blackwell)算子知识的唯一成体系 skill 化知识库,素材价值极高。

### 2.8 flashinfer-ai/flashinfer(内嵌 .claude/skills)—— 生产级仓库自带 skills 的范例

- **URL**:https://github.com/flashinfer-ai/flashinfer(`.claude/skills/`)
- **活跃度**:6350 stars;持续更新;Apache-2.0
- **内容清单**(3 个,实测拉取):
  - `add-cuda-kernel`:向 FlashInfer 添加新 CUDA kernel 的端到端教程(以 elementwise scale 为例:头文件 kernel 定义 → launcher → pybind → 测试)
  - `benchmark-kernel`:CUPTI 硬件级计时 + CUDA Events 回退,多后端(FA2/3、cuDNN、CUTLASS、TensorRT-LLM)对比,CSV 输出;含 AutoTuner 计时选择器(globaltimer vs cuda_event,机密计算场景)
  - `debug-cuda-crash`:`@flashinfer_api` 日志装饰器定位 illegal memory access/NaN(崩溃前捕获输入张量)
- **评价**:证明"上游仓库自带 skills 指导贡献者写算子"已是主流工程实践;三个 skill 均短小精悍、可直接参考结构。

### 2.9 slowlyC/agent-gpu-skills —— 中文,GPU 技能集 + 本地源码检索

- **URL**:https://github.com/slowlyC/agent-gpu-skills(知乎介绍文:https://zhuanlan.zhihu.com/p/2011569660810785777)
- **活跃度**:165 stars;最后提交 2026-08-08;MIT
- **格式**:4 个 SKILL.md(cuda/cutlass/tilelang/triton),安装器支持 Cursor、Claude Code(`--agent claude`)、**Codex(`--agent codex`,装到 `~/.codex/skills/`,config.toml 配置)**、Gemini CLI、Qoder
- **内容**:`cuda-skill`(CUDA/PTX/NVIDIA 工具,查 ISA、API、Nsight、Compute Sanitizer)、`cutlass-skill`(CUTLASS/CuTe/CuTeDSL,基于本地 upstream checkout 检索源码与示例)、`tilelang-skill`、`triton-skill`(含 Gluon);CUDA/PTX 官方文档快照 + Triton/CUTLASS/TileLang 源码软链接
- **评价:跨工具安装(尤其 Codex 路径)的最佳参考实现**。

### 2.10 mohitmishra786/low-level-dev-skills(GPU 类)

- **URL**:https://github.com/mohitmishra786/low-level-dev-skills
- **内容**:GPU 类 6 个 skill:`cuda`、`cuda-profiling`、`cuda-debugging`、`triton-lang`、`hip-rocm`、`gpu-memory-model`;`npx skills add` 安装(skills.sh 生态)
- **评价**:偏入门/通用,可与 tensormux 互补。

### 2.11 其他值得记录的仓库(简表)

| 仓库 | stars | 内容 | 备注 |
|---|---|---|---|
| technillogue/ptx-isa-markdown | 228 | PTX ISA 9.1 官方文档转可搜索 Markdown,自带 Claude Code skill | PTX 素材+skill 二合一 |
| maxiaosong1124/ncu-cuda-profiling-skill | — | 中文 NCU 自动化采集 skill(`--set full` 持久化),AGENTS_COMPATIBILITY.md 声明支持 Kimi Code CLI/Claude 等 | 中文,安装脚本完善 |
| anthony-maio/triton-skills | 16 | Claude Code skills for 优化 Triton kernels | Triton 侧 |
| LuckyLittleMonster/cc-skills | 9 | slurm/HPC/PyTorch DDP/**NCCL/CUDA** skills | HPC 场景 |
| janeyx99/abi-stable-skills | 3 | PyTorch C++/CUDA 扩展迁移 stable ABI 的 skills(作者为 PyTorch core dev) | 官方维护者出品 |
| FrostyLeaves/nsight-graphics-analyzer | 14 | Nsight Graphics 2026.1+ 的 CLI 封装 Claude/Codex skill | 图形侧 |
| Ma1oneZhang/nsys-parquet-perfetto-skill | 11 | **Codex skill** + Rust DataFusion:Nsight Systems 报告转 Perfetto JSON | 少见的 Codex 原生格式 |
| ZJtoast/kernel-profiler-skill | 1 | CUDA/Triton kernel 的 NCU 纯 kernel 级 profiling 流程与标准化报告 | |
| Dominic789654/auto-kernel-research | 1 | Profile-driven 自主 kernel 优化循环(可移植 skill 文件,CUDA/Triton) | |
| ultimatile/cuda-x-skills | 2 | 检索 CUDA-X 库文档的自定义 skills | MIT |
| sfsf100/AI_Agent-Build-CUDA-CV | 0 | 中文:Skill.md 格式提示词让 Claude 生成 CUDA 代码(计算机视觉算子) | |
| leap21ai/djx-spark-skill | 2 | DGX Spark(GB10)skill:CUDA 13 兼容、统一内存 | |
| dgrauet/claude-skill-mlx-porting | 3 | PyTorch/CUDA 模型移植 Apple MLX 的 skill | 反向迁移 |
| CCALITA/cutlass-writer、wyn-1121/skill1 | 0 | cutlass 代码编写 / cutlass 与 AscendC 接口差异对比(中文) | 后者对国产化迁移有参考价值 |

---

## 三、官方与半官方渠道(build.nvidia.com / developer.nvidia.com / NVIDIA 组织)

1. **DGX Station AI Skills 与 dgx-assist**:https://build.nvidia.com/station/ai-skills —— 官方"教 AI 编码 agent 正确操作 DGX Station"的 4 个原生 Agent Skills + CLI;安装指南 https://build.nvidia.com/station/ai-skills/instructions。
2. **nvidia/dgx-spark-playbooks**:https://github.com/nvidia/dgx-spark-playbooks —— DGX Spark(Blackwell)AI/ML 负载搭建 playbook。
3. **Nsight AI(AI-powered Accelerated Computing Assistant)**:https://developer.nvidia.com/nsight-ai —— 官方把"当前 CUDA 知识"接入 AI 编码 agent(可自托管),把 AI 引导的性能分析带进 Nsight 工作流。**这是 NVIDIA 官方对"agent 写 CUDA"的产品化回应**,与 skills 路线并行。
4. **NVIDIA 开发者博客:Automating GPU Kernel Translation with AI Agents: cuTile Python to cuTile.jl**:https://developer.nvidia.com/blog/automating-gpu-kernel-translation-with-ai-agents-cutile-python-to-cutile-jl/ —— 官方示范"把 agent 指向 `.claude/skills/converting-cutile-to-julia/SKILL.md` 来转换 kernel",即 tilegym-* 系列的出处。
5. **GTC '26 Session S81831 "AI Coding for the GPU: Build a Coding Agent to Help Write CUDA"**(CUDA Intelligence:cloud profiling + Nsight 工具 + 专家级优化技能集成进编码 agent):https://www.nvidia.com/en-us/on-demand/session/gtc26-s81831/
6. **NVIDIA 组织内采用 skills 的仓库**:ai-dynamo/dynamo(`.agents/skills/dynamo-docs`,官方文档 https://docs.nvidia.com/dynamo/reference/agent-skills 说明 `.claude/skills/` 为兼容符号链接)、NVIDIA Model Optimizer(`.agents/skills/` 为规范位置)、NemoClaw(NVIDIA 对 OpenClaw 的 fork,自带 agent skills 体系)、NVIDIA/TileGym、nvidia/cutile-python。
7. **anthropics/skills 官方仓库**:已实测 clone——19 个 skill(docx/pdf/pptx/mcp-builder/skill-creator 等),**确认无任何 CUDA/GPU 条目**;175k stars。Claude 官方技能市场不含算子开发,GPU 领域完全靠 NVIDIA/社区自己 fill。

---

## 四、工具与方法论(非 skill 但直接相关)

1. **huggingface/upskill**:https://github.com/huggingface/upskill —— 723 stars,Apache-2.0。从任务描述或 agent trace 生成 skill,teacher 模型(如 sonnet)生成 + student 模型(haiku/本地模型)评估、自动精修,输出标准 `SKILL.md + references/ + scripts/` 目录;支持 HF Jobs 远程评测。是"技能流水线化生产"的参考实现。
2. **BytedTsinghua-SIA/CUDA-Agent**(字节×清华):https://github.com/BytedTsinghua-SIA/CUDA-Agent,论文 arXiv 2602.24286 —— 大规模 Agentic RL 训练模型生成高性能 CUDA kernel,训练环境即"技能增强的 CUDA 开发环境"(结构化指南+参考脚本+GPU 优化手册+troubleshooting);知乎热议(https://www.zhihu.com/question/2011952640406335922)。非现成 skill 包,但其"技能作为 RL 环境一部分"的路线对本项目有启发。
3. **Kimi Code CLI 等国内工具**已在 `~/.config/agents/skills/` 识别 SKILL.md(maxiaosong1124 仓库的 AGENTS_COMPATIBILITY.md 佐证)。
4. **技能市场/索引站**(均为上述仓库的镜像,可用于发现而非引入):skills.sh、mcpservers.org/agent-skills、getclaudeskills.com(GPU 标签 16 个)、skillsllm.com、agent-skills.cc、skilled.autohand.ai、llmbase.ai、lobehub。
5. **awesome 列表**:VoltAgent/awesome-agent-skills(1000+ 技能,含 NVIDIA/Triton/TensorRT-LLM 条目)、awesomeclaude.ai;**均无独立的官方 CUDA 精选分类**。

---

## 五、素材类(非现成 skill,适合转成 skill)

| 素材 | 位置 | 转化建议 |
|---|---|---|
| CUDA C++ Programming Guide / Best Practices Guide | developer.nvidia.com 官方文档 | 已有 ForceInjection 抓取流水线(scrape_cuda_docs.py)可复用 |
| PTX ISA 9.1(Markdown 化) | technillogue/ptx-isa-markdown(228★) | 直接作为 PTX skill 的 references |
| Nsight Compute 文档 + 指标定义 | developer.nvidia.com;mit-han-lab/ncu-report-skill 的 reference/ 已整理六维分析与诊断 playbook | 直接引入其 reference 目录 |
| CUTLASS 官方仓库 + 文档 | github.com/nvidia/cutlass(含 Python DSL:CuTe DSL/CuTeDSL) | slowlyC/agent-gpu-skills 的 cutlass-skill 已示范"本地源码检索"式 skill |
| CUDA Samples 官方示例 | github.com/nvidia/cuda-samples(支持 CUDA 13.3) | ForceInjection 的 cuda-samples 索引模式可复用 |
| GPU MODE Lectures(106 讲) | gpu-mode 社区讲座库(Youtube + 笔记;Christian Mills 笔记 https://christianjmills.com/posts/cuda-mode-notes/lecture-015/) | 讲座笔记转 knowledge 条目 |
| Colfax CUTLASS 教程系列 | research.colfax-intl.com(cutlass-tutorial-design-of-a-gemm-kernel 等) | GEMM/pipeline 理论素材 |
| Simon Boehm《How to Optimize a CUDA Matmul Kernel for cuBLAS-like Performance》 | siboehm.com/articles/22/CUDA-MMM | 经典迭代优化案例,天然适合"优化阶梯"skill |
| KernelBench | ScalingIntelligence/KernelBench(1230★,Torch→CUDA 基准);Infatoshi/kernelbench.com(76★,面向自主编码 agent 的 v3/v-hard 题库) | 评测集,验证 skill 效果 |
| Tensara | tensara.org(GPU 编程竞赛平台+基准) | 同上;KernelFlow-ops 的 README 即用 Tensara 展示战绩 |
| niehen6174/gpu-kernel-cookbook | CUDA/Triton/CuTe DSL 实现常见 DL 算子的 cookbook | 算子模板素材 |
| AMD AgentKernelArena | rocm.blogs.amd.com(测 Claude 等编码 agent 的 GPU kernel 优化能力) | 跨厂商评测方法论 |
| 论文 "Agent Harnesses for GPU Kernel Optimization" | ceur-ws.org/Vol-4238/paper5.pdf(Codex GPT-5.5 / Claude Opus 4.7 在 H100 上的 harness 基准) | harness 设计参考 |
| NVIDIA NemoClaw / OpenClaw 生态 | github.com/NVIDIA(NemoClaw) | skills 工程化管理(skill 进化、治理)参考 |

---

## 六、格式结论

1. **Claude Code SKILL.md 是事实标准**。YAML frontmatter(name/description,可选 allowed-tools、argument-hint、disable-model-invocation)+ 正文流程指令 + `references/`(深度文档)+ `scripts/`(确定性脚本)。本轮验证的所有高质量仓库(nvidia、HF、FlashInfer、tensormux、KernelFlow、mit-han-lab、slowlyC)全部采用。
2. **Codex 无独立技能格式**。三种实践:(a)同一 SKILL.md 装进 `~/.codex/skills/`(slowlyC 安装器、nvidia/skills 官方宣称支持 Codex);(b)`AGENTS.md` 引用技能或直接内嵌规则(HF KernelBench traces 里 Codex 用注入的 AGENTS.md 规则;ParaCodex 用 AGENTS.md 定义 agent 角色 + Codex CLI skills);(c)少数仓库标注"codex skill"(Ma1oneZhang/nsys-parquet-perfetto-skill)。社区风向(Vercel 研究、HN 讨论)甚至认为"docs index 放 AGENTS.md"效果可匹敌 skills。
3. **`.agents/skills/` 正在成为跨工具规范目录**:NVIDIA Dynamo 与 Model Optimizer 已把 `.agents/skills/` 设为规范位置、`.claude/skills/` 等做成符号链接;TileLang 上游有 `.agents/skills/tilelang-build/SKILL.md`。建议 forge 产出的技能目录同时挂 `.claude/skills/` 与 `.agents/skills/`。
4. **高质量 skill 的共性写法**(可作为 forge 的 NVIDIA skill 模板):
   - 先给"何时不使用"(tensormux GEMM:标准场景直接 cuBLAS/CUTLASS);
   - 硬约束/禁止模式表格(HF:pybind11/setup.py 禁用清单);
   - 证据门槛循环(KernelFlow:编译+正确性+计时+NCU 四道门,未过不生成);
   - 脚本做确定性部分、SKILL.md 只做决策(HF/KernelFlow/ncu-report 一致做法);
   - 按目标 GPU 分 references(H100/A100/T4 各一份优化指南)。

---

## 七、中文渠道检索结果(gitee / gitcode / 知乎 / CSDN)

- **gitee.com**:开源中国官方 `oschina/gitee-agent-skills`(Gitee 平台自身的 skills,无 CUDA);`zsome/agentskills`(格式示例);`ai-large-model-tool/full-stack-skills-main`(通用全栈,支持 Claude Code/Cursor/Trae/Qoder/CodeBuddy);`suosuo1930/agent-skills`。**结论:gitee 无 CUDA 算子专用 skill 仓库**。
- **gitcode.com**:多组关键词检索,**未发现** CUDA 算子技能包。
- **知乎**:《Agent GPU Skills 介绍》(zhuanlan.zhihu.com/p/2011569660810785777)、BBuf 回答"强烈推荐的 Agent Skills"(建议把 CUTLASS/Triton blog 与人类优化库压缩成 SKILL 挂载)、字节 CUDA Agent 论文讨论(技能范式 + Kernel Hub 分发的展望)、《大规模 Agentic RL 实现高性能 CUDA Kernel 生成》(zhuanlan.zhihu.com/p/2012945444167239215)。
- **CSDN**:Kerminal 辅助 CUDA→AscendC 算子迁移实践(agent.csdn.net)——对本项目"跨厂商算子迁移"方向有直接参考价值;CUDA Agent RL 系统解读。

---

## 八、搜索过但确认不存在的路径(避免重复劳动)

1. `anthropics/skills` 官方仓库 —— 实测 clone 确认无 CUDA/GPU/kernel 相关技能(仅 office/文档/MCP/skill-creator 等 19 个)。
2. gitee.com / gitcode.com —— 无 CUDA 算子专用 SKILL.md 仓库(只有平台级或通用技能合集)。
3. GitHub topic `claude-skills` / `claude-code-skills` / `agent-skills` —— 无官方维护的 CUDA 精选;相关条目即本文第二、二章所列社区仓库。
4. OpenAI/Codex 官方技能注册表 —— 不存在;Codex 侧仅有 AGENTS.md 约定与社区兼容目录。
5. `NVIDIA/cuda-cookbook` —— 不存在(易与 `nvidia/cuda-samples` 混淆;后者为官方示例库)。
6. NVIDIA NGC / build.nvidia.com 上独立发布的"CUDA kernel 开发 skill 包" —— 不存在;build.nvidia.com 相关内容仅为 DGX Station AI Skills(设备操作向,非算子开发)。
7. cuBLAS/cuDNN 专用的独立 skill 仓库 —— 未找到独立仓库;相关内容内嵌于 ForceInjection/cuda-code-skill(文档库)、ultimatile/cuda-x-skills(文档检索)与 nvidia/skills 的 cudf/cudnn-frontend 条目中。
8. SASS/反汇编方向的独立 skill —— 未找到独立仓库;SASS 验证作为一环内嵌在 KernelFlow-ops/cuda-optimized-skill 中。

---

## 九、对 forge 的落地建议(优先级排序)

1. **直接引入/改编**:tensormux/kernel-skills 的 cuda+patterns 系列(MIT)→ 作为 NVIDIA 算子开发基础技能;KernelFlow-ops/cuda-optimized-skill(MIT)→ 作为"迭代优化"引擎技能。
2. **分析侧引入**:mit-han-lab/ncu-report-skill(MIT)的 ncu 六维分析与诊断 playbook;其 GB300 变体说明该模式可按 GPU 型号fork。
3. **知识库模式复制**:ForceInjection/cuda-code-skill 的"离线官方文档 + 样例索引 + 抓取流水线"三件套(注意补 LICENSE 沟通或仅借鉴结构自建);ptx-isa-markdown 直接充当 PTX references。
4. **格式规范**:SKILL.md 为主体,同时挂 `.claude/skills/` 与 `.agents/skills/`,references 按目标 GPU(H100/A100/T4/B200)分册,脚本化一切确定性步骤。
5. **验证闭环**:用 KernelBench / kernelbench.com / Tensara 作为引入后技能效果的回归测试;有条件可参考 huggingface/upskill 建立"生成-评估-精修"流水线。

---

## 附:核心来源链接汇总

- https://github.com/nvidia/skills (官方,3236★)
- https://github.com/nvidia/skills/issues/87 (52 个 skill 掉出同步的官方 issue;kernel-triton-writing 等的出处线索)
- https://mcpservers.org/agent-skills/author/nvidia (NVIDIA 全量技能目录镜像索引)
- https://github.com/KernelFlow-ops/cuda-optimized-skill (203★,MIT)
- https://github.com/tensormux/kernel-skills (74★,MIT)
- https://github.com/ForceInjection/cuda-code-skill (25★,中文)
- https://github.com/huggingface/kernels (740★,Apache-2.0) 与 https://huggingface.co/docs/kernels/en/cli-skills
- https://github.com/mit-han-lab/ncu-report-skill (223★,MIT)、https://github.com/mit-han-lab/KernelWiki
- https://github.com/flashinfer-ai/flashinfer (.claude/skills:3 个,6350★)
- https://github.com/slowlyC/agent-gpu-skills (165★,MIT,跨工具安装)
- https://github.com/mohitmishra786/low-level-dev-skills、https://github.com/technillogue/ptx-isa-markdown (228★)
- https://github.com/huggingface/upskill (723★,Apache-2.0)
- https://huggingface.co/blog/custom-cuda-kernels-agent-skills、https://huggingface.co/blog/upskill
- https://build.nvidia.com/station/ai-skills、https://developer.nvidia.com/nsight-ai
- https://developer.nvidia.com/blog/automating-gpu-kernel-translation-with-ai-agents-cutile-python-to-cutile-jl/
- https://github.com/NVIDIA/TileGym、https://github.com/nvidia/cutile-python
- https://github.com/BytedTsinghua-SIA/CUDA-Agent (arXiv 2602.24286)
- https://github.com/ScalingIntelligence/KernelBench (1230★)、https://github.com/Infatoshi/kernelbench.com (76★)、https://tensara.org
- https://github.com/VoltAgent/awesome-agent-skills、https://github.com/anthropics/skills
- 知乎:https://zhuanlan.zhihu.com/p/2011569660810785777、https://www.zhihu.com/question/2011952640406335922、https://zhuanlan.zhihu.com/p/2012945444167239215
- CSDN(Kerminal CUDA→AscendC):https://agent.csdn.net/6a672a2c662f9a54cb94b4f5.html
- 47Billion 分析文:https://47billion.com/blog/custom-cuda-kernels-in-the-age-of-ai-coding-agents-inside-the-new-agent-skill-workflow-for-gpu-kernel-engineering/
