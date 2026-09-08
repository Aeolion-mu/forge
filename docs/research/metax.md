# 沐曦（MetaX）算子开发 Skills 调研报告

> 调研日期：2026-09-08
> 调研目标：确认沐曦（曦云 C280/C500 系列 GPU，软件栈 MACA / MXMACA）是否存在官方或社区的 Claude Code（SKILL.md）/ Codex 格式算子开发技能包；若无，给出最佳替代素材与转化路径。
> 调研渠道：github.com（API + `git clone --depth 1` 实测）、gitee.com（组织页 + 克隆实测）、gitcode.com（搜索）、沐曦官网/开发者社区/教材站（web 抓取）、中英文关键词 14+ 组。

---

## 一、总结论

1. **沐曦官方没有独立发布的"算子开发 skills 仓库"**（对比华为昇腾的 `Ascend/agent-skills`，沐曦无对应物）。
2. 但**存在三处"现成或半现成"的 Claude Code / Codex 格式 agent 技能资产**，且其中一处为沐曦官方维护：
   - `MetaX-MACA/TileOPs-Metax`（官方 fork）内嵌 **14 个 Claude Code 格式 SKILL.md** + domain-rules / review-checklists + 根 `CLAUDE.md`；
   - `tile-ai/tilelang-metax`（沐曦适配 TileLang 分支）内嵌 **6 个 Codex `.agents/skills` 格式 SKILL.md**；
   - `flagos-ai/skills`（智源 BAAI 众智 FlagOS，多厂商含沐曦）：标准 Agent Skills 开放标准仓库，Claude Code 插件 / Codex / Cursor 三形态，算子生成 skill `kernelgen-flagos` 支持以 MetaX 为目标后端。
3. 上述 skills 均偏「工作流编排」或「多厂商通用」，**不含 MACA 编程领域知识**（C500 架构、`__buildin_mxc_*`、kWarpSize=64、mc 编译器参数等）。这部分知识的最佳载体是官方素材仓库 `mxmaca-performance-tuning-guide`（Gitee），是自建 skill 的首选原料。

---

## 二、现成 / 半现成 Skills 资产（重点）

### 2.1 MetaX-MACA/TileOPs-Metax —— 官方，Claude Code 格式 ★核心发现

| 项 | 内容 |
|---|---|
| URL | https://github.com/MetaX-MACA/TileOPs-Metax （Gitee 镜像：https://gitee.com/metax-maca/TileOPs-Metax） |
| 维护方 | 沐曦官方（MetaX Integrated Circuits (Shanghai) Co., Ltd.），fork 自 tile-ai/TileOPs |
| 活跃度 | 极活跃，最近提交 2026-09-07（`[Fix][Benchmark] Handle unavailable GEMM baselines on MACA (#138)`）；GitHub 7 stars |
| License | MIT（Tile-AI + MetaX 双版权声明） |
| 定位 | "Spec-driven LLM operators across backends — built by agents"：用 agent 按规格（manifest）生产 TileLang 算子 |

实际克隆验证的内容结构：

```
TileOPs-Metax/
├── CLAUDE.md                        # 项目总纲：设计优先、manifest 权威、按域加载规则
├── .claude/
│   ├── settings.json
│   ├── skills/                      # 14 个 Claude Code SKILL.md（YAML frontmatter）
│   │   ├── align-op/  align-family/          # 编排器（日常入口，/align-op <op_name>）
│   │   ├── scaffold-op/  implement-op/  test-op/  bench-op/   # 原子子技能
│   │   ├── add-manifest/  fix-manifest/  audit-family/
│   │   ├── review-tileops/（含 loop.sh 自主循环评审 PR）
│   │   ├── resolve-tileops/  follow-up/
│   │   └── …每个目录含 SKILL.md + procedure.md + criteria.md + preflight/round 脚本
│   ├── domain-rules/                # ops-design / manifest-spec / benchmark / testing-budget / design-docs
│   ├── review-checklists/           # feature / refactor / testing / benchmark / approval-gate 等 8 份
│   ├── rules/（code-style、security）、conventions/
├── docs/tileops-skills.md           # 「意图 → skill」决策表（slash 命令映射）
└── src/tileops/kernels/…            # 含 MACA 专用 kernel：gemm_maca.py、attention/gqa_bwd_maca.py 等
```

- skill 内容为**算子库工程流程**（scaffold→test→implement→bench→review 的 spec 驱动闭环、双路径迁移策略、PR 自主评审循环），`SKILL.md` 里不含 MACA 语法知识（grep 无 metax/maca 命中），MACA 特定内容在 kernels 与 CI 里。
- 对 forge 的意义：**可整包借鉴其 skill 组织范式**（orchestrator/atomic 分层、criteria/procedure 分文件、review-checklist 体系）。

### 2.2 tile-ai/tilelang-metax —— 沐曦适配 TileLang，Codex `.agents` 格式

| 项 | 内容 |
|---|---|
| URL | https://github.com/tile-ai/tilelang-metax （沐曦适配分支；赛事用 race 分支） |
| 维护方 | tile-ai 社区 + 沐曦（`tilelang-metax` 为沐曦后端适配版；沐曦 2025 WAIC 官宣支持 TileLang） |
| 活跃度 | 最近提交 2026-09-06 |
| License | Apache-2.0（随上游 TileLang） |

克隆验证：含 `.agents/skills/` 目录，**Codex 风格**（配套 `agents/openai.yaml` 定义 display_name / default_prompt）：

- `tilelang-semantic`（附 references：loop-rules / memory-concurrency / operations-layout）
- `tilelang-tvm-ir`、`tilelang-build`、`tilelang-backend`、`tilelang-layout`、`tilelang-cpp-style`

内容偏 TileLang 编译器开发（上游继承），`.agents/skills` 中无 MACA 字样；MACA 后端实现在代码（`tilelang` python 包 maca target）。另有 `docs/`（Sphinx：get_started / developer_guide / compiler_internals / deeplearning_operators）。

### 2.3 flagos-ai/skills —— 智源众智 FlagOS Skills，多厂商（含沐曦）

| 项 | 内容 |
|---|---|
| URL | https://github.com/flagos-ai/skills （19 stars） |
| 维护方 | 智源 BAAI「众智 FlagOS」生态（社区/机构，非沐曦官方） |
| 活跃度 | 最近提交 2026-07-18；FlagOS 2.0 发布会宣称 12 种 Skills、32 款芯片、497 算子 |
| License | Apache-2.0 |
| 格式 | **遵循 Agent Skills 开放标准（agentskills.io）**：每 skill 一个 `SKILL.md`（YAML frontmatter：name/description/allowed-tools/metadata）+ references/ + scripts/；仓库级提供 `.claude-plugin/`（Claude Code 插件市场）、`.cursor-plugin/`、Codex `$skill-installer` 与 `.agents/skills` 目录约定、Gemini CLI、`npx skills add` CLI |

skill 清单（12 个）：`kernelgen-flagos`（算子生成/优化/特化/提交反馈）、`gpu-container-setup-flagos`、`install-stack-flagos`、`model-migrate-flagos`、`model-verify-flagos`、`perf-test-flagos`、`flagrelease-entrance-flagos`、`vllm-plugin-fl-setup-flagos`、`flaggems-pr-review/submit-flagos`、`tle-developer-flagos`、`skill-creator-flagos`。

沐曦覆盖点（克隆 grep 实证，53 处 metax/沐曦、11 处 maca）：

- `kernelgen-flagos`：示例提示词「使用 kernelgen-flagos 生成 ReLU 算子，使用沐曦（MetaX），集成至 vLLM」；生成目标是 FlagGems 的 `src/flag_gems/runtime/backend/_metax/ops/`（厂商后端目录之一，同列还有 _ascend/_cambricon/_mthreads/_iluvatar/_hygon/_amd/_kunlunxin 等）。**注意：算子生成实际依赖外部 MCP 服务 `https://kernelgen.flagos.io/sse`（需申请 KernelGen Token）**，本地 SKILL.md 主要是流程编排。
- `gpu-container-setup-flagos`：references/image-sources.md 记录了 **MetaX 镜像仓库 `cr.metax-tech.com`**（推荐镜像 `public-ai-release/maca/vllm-metax:0.13.0-maca.ai3.3.0.303-torch2.8-py312-ubuntu22.04`、`public-library/maca-pytorch:3.3.0.4-torch2.8-py312`），`detect_gpu.py` 可识别沐曦卡。
- `install-stack-flagos`：vendor-mappings.md 含 `metax → USE_METAX=1`、torch wheel tag `metax`。
- `vllm-plugin-fl-setup-flagos`：多硬件后端（NVIDIA/昇腾/MetaX/天数/摩尔线程）装 vLLM-Plugin-FL + FlagGems。

### 2.4 InternLM/Kernel-Smith —— 沐曦 × 上海AI实验室算子生成智能体（不开源 agent）

| 项 | 内容 |
|---|---|
| URL | https://github.com/InternLM/Kernel-Smith （Apache-2.0，2026-03 建） |
| 维护方 | 上海人工智能实验室 + 沐曦股份（基于 Intern-S1-Pro） |
| 内容 | README 明确：**「暂不计划开源模型权重与 agent 代码」**，仓库只放生成 kernel、benchmark 与文档；在线 demo：https://chat.intern-ai.org.cn/kernel-smith ；论文 arXiv:2603.28342 |
| 落地 | SGLang PR#20778（4.78x）、LMDeploy PR#4345（DeepSeek MoE 路由 1.36x）、DLBlas PR#102（DeepSeek Engram）；支持 NVIDIA Triton 与 **MetaX MACA** 双后端 |

结论：**不是可取用的 skills/prompt 包**，仅作生态佐证。

---

## 三、素材类仓库（适合转成 skill 的官方文档/样例）

### 3.1 mxmaca-performance-tuning-guide ★最佳转化素材

- URL：https://gitee.com/metax-maca/mxmaca-performance-tuning-guide （Gitee 组织内星标最高之一：5 star / 4 fork / 7 watch；最近更新约 2026-04）
- 维护方：沐曦官方（文中留有内部联系人"李兆石"钉钉，属官方工程师）
- License：**未见 LICENSE 文件**（引用/改写需注意）
- 内容（克隆实测）：
  - `guide/` 10 章中文文档：ch1 异构编程入门(vectoradd)、**ch2 曦云 C500 芯片架构**（AP/PEU 模型、三级存储、microbenchmark 写法）、ch3 Kernel 编程入门(reduction)、ch4 Kernel 性能建模(SGEMM、屋檐模型/延迟隐藏)、**ch5 Kernel 性能优化技巧**（13 条策略 Checklist 表 + 逐条展开）、ch6 性能分析工具（探针/Tracer/Cycle trace/perf counter）、ch7 Host 代码优化、ch8 张量编程 HGEMM、**ch9 C500 HW Limitation**（Private Memory / Partial Write / Page Size / Shuffle 延迟 / Partial Read 的识别与规避表）、ch10 常用 Compiler 参数与 Driver 环境变量；
  - `case/` 配套渐进式代码：vector_add（CPU→GPU→warmup）、reduction（global→shared→去分支→去 bank conflict→shuffle，含 roofline 微基准）、sgemv、sgemm（naive→coalesced→tiling→bank conflict→double buffer，对照 mcBLAS）；
  - `microbenchmark/`：C500 与 A100 微架构参数测试工程。
- 沐曦特有知识密度最高：kWarpSize=64（A100 为 32）、每 AP 最多 32 warp/2048 线程、`__buildin_mxc_*` 数学内建函数、`mx-smi`、`rmmod metax`/`xcore_page_size` 等。

### 3.2 maca-samples —— MXMACA 编程样例库（官方）

- URL：https://github.com/MetaX-MACA/maca-samples （Gitee 同名；最近提交 2025-08）
- 内容：CUDA-samples 同构目录（`0_Introduction/` 等）：vectorAdd_mcrtc（`.maca` kernel 文件 + mcrtc 运行时）、sharedMemory、asyncMemcpy、pinnedMemory、dynamicParallelism、多卡/IPC、`Common/helper_*` 工具头。
- License：BSD 式（LICENSE 为 "Redistribution and use..." 条款）。
- 用途：MXMACA C/C++ 基础 API 与 mcrtc 的最小可运行参照，适合做 skill 的 references 代码样例。

### 3.3 mxmaca-courses —— 官方课程与教材体系

- URL：https://gitee.com/metax-maca/mxmaca-courses （Apache-2.0）
- 关键外链（克隆 README 实证）：
  - 电子教材站：**https://maca-school.metax-tech.com/**（SPA，需浏览器访问）
  - 实体教材：《沐曦异构并行计算软件栈——MXMACA C/C++ 程序设计入门教程》（电子工业出版社）
  - 书中示例代码：https://github.com/bxttttttt/getting-started-guide-and-introduction-to-MXMACA （Gitee 镜像 gitee.com/Inkstoneydz/…）
  - 云端实践平台：**https://compiler.metax-tech.com/**（Web/ssh 登录的沐曦 GPU 开发环境）

### 3.4 op_optimization —— 2026 揭榜挂帅赛事文档（官方）

- URL：https://github.com/MetaX-MACA/op_optimization （无 license；最近提交 2026-05）
- 内容（4 份 md）：赛题说明（**赛题二明确「立足 AI Agent 开发新范式」：用 Agent 完成算子迁移/代码理解/性能分析/Kernel 自动优化/Benchmark 迭代**）；`tilelang_maca_build_guide_模力方舟.md`（C500 / MACA 3.5.3.20 下从源码编译 tilelang-metax 全流程踩坑）；`race_tests_run_guide…md`（race 分支 MLA/MoE/NSA 三算子跑通测试）；《基于 AI Agent 开发范式的国产 GPU 大模型算子推理库优化方案》。
- 是把「沐曦自己如何用 Agent 做算子」流程转成 skill 的直接蓝本。

### 3.5 其他官方算子/适配仓库（MetaX-MACA 组织内）

| 仓库 | 说明 | License/活跃 |
|---|---|---|
| mcoplib | 官方高性能算子 kernel 库（HD 平台） | Apache-2.0，2026-08 更新 |
| mcPytorch | PyTorch 2.4 沐曦后端（torch 扩展层） | 2026-08 更新 |
| mcTriton / mcTVM / mcTlass | Triton / TVM / CUTLASS 沐曦适配 | 活跃度中 |
| flashattn / McFlashInfer / FlashMLA / mcFlashMLA / MXDeepEP | attention/推理算子适配 | 部分 2026 年更新 |
| mccl-nccl / mccl_tests / mcSparse / mcSolver / mcEigen | 通信库与数值库适配 | 低频维护 |
| vLLM-metax | vLLM 沐曦插件（**170 stars，组织最热**） | Apache-2.0，日更级 |
| gpuBenchmark | GPU 基准（Cuda 方言） | Apache-2.0 |
| TileKernels-Metax | TileLang kernel 库 fork | 2026-07 更新 |
| cu-bridge（仅 Gitee） | CUDA→多后端迁移工具（fork P4ul/cu-bridge），沐曦用它做 CUDA 项目迁移 | Gitee 更新勤 |
| modelzoo（Gitee/GitHub） | 官方模型库 | 2023 年后低活跃 |

MXMACA 3.3.0.X 官方技术报告称按「含 CUDA 关键字且 star>1 且活跃」筛选 4490 个 GitHub 仓库做兼容性验证，无缝迁移率 92.94%（来源：腾讯云开发者社区解析文）。

### 3.6 社区仓库

- **QingCheng-AI/muxi_native_layout_kernels**（https://github.com/QingCheng-AI/muxi_native_layout_kernels，Apache-2.0）：面向沐曦 GPU 的 native layout 优化算子——GeMV、窄 GeMM、fused MoE（.cu，fp16/bf16/软 fp8），含超参离线调优脚本与图解文档。社区少见的高质量沐曦算子实现参考。

### 3.7 官方站点与文档渠道

| 站点 | 说明 |
|---|---|
| https://developer.metax-tech.com/ | 沐曦开发者社区：**软件栈 SDK 下载**（`/softnova/download?package_kind=SDK`：C/C++ 组件、运行时库、编译器、集合通信库、算子加速库、调试工具、示例）、论坛、博客（含「沐曦 × 模力方舟 AI 技能认证」——面向**人**的认证，非 agent skills）。SPA + 登录墙，机器抓取仅得元数据 |
| https://maca-school.metax-tech.com/ | MXMACA 电子教材站 |
| https://compiler.metax-tech.com/ | 沐曦云端 GPU 在线实践平台（Web/ssh） |
| https://www.metax-tech.com/ndetail/* | 官网新闻：TileLang-MetaX 开源、Kernel-Smith 发布、Day0 适配等 |
| sw-wiki（内部） | 性能指南 README 提到"sw-wiki 上内容大而全"，即开发者社区 wiki，需登录 |

---

## 四、官方账号 / 组织清单

| 平台 | 组织 | 说明 |
|---|---|---|
| GitHub | **github.com/metax-maca**（即 MetaX-MACA） | 主组织，70+ 仓库（本文清单来自 API 全量拉取）；另有组织站仓库 MetaX-MACA.github.io。**注意：GitHub 上不存在 "MetaX-MetaX" 组织** |
| Gitee | **gitee.com/metax-ics** | 沐曦集成电路（上海）有限公司，Gitee 企业版，49 仓库（多为镜像+私有生态） |
| Gitee | **gitee.com/metax-maca** | 开源组织，18 仓库（cu-bridge、maca-samples、mxmaca-courses、mxmaca-performance-tuning-guide、TileOPs-Metax 等，与 GitHub 大体同步） |
| Gitee | gitee.com/metax-ai | 「沐曦人工智能」组织，**0 公开仓库**（2 成员：Kevin Zhang、RobinHan） |
| GitCode | 无沐曦官方组织 | 仅相关博客/镜像（如 Chitu v0.3.1 增强沐曦 GPU 支持的报道 blog.gitcode.com） |

---

## 五、建议转化路径（给 forge）

1. **立即可用（外部依赖）**：把 `flagos-ai/skills` 的 `kernelgen-flagos` + `gpu-container-setup-flagos` 接入 forge 沐曦场景——镜像源（cr.metax-tech.com）、`USE_METAX=1`、metax wheel 映射都是现成的；但算子生成本体走 KernelGen MCP（需 token，云端）。
2. **自建「MACA 算子开发」skill（推荐主路径）**：
   - 主体知识：`mxmaca-performance-tuning-guide/guide/` ch2（C500 架构）、ch5（优化 Checklist）、ch9（HW limitation 规避表）、ch10（编译参数/环境变量）→ 蒸馏进 SKILL.md 与 references；
   - 代码样例：`case/` + `maca-samples`（BSD 式，可安全引用）；
   - CUDA→MACA 迁移规则：参考 cu-bridge 与官方 92.94% 兼容口径，总结差异点（kWarpSize=64、`__buildin_mxc_*`、mccl/mcBLAS 对应关系、.maca/mcrtc）；
   - 工程流程骨架：照搬 TileOPs-Metax 的 `.claude/skills` 范式（scaffold/test/implement/bench 分离 + review checklist）。
3. **TileLang 路线**（沐曦官方主推方向，曦云 C500 赛事即此路线）：把 `op_optimization` 的两份 build/race-test 指南转成 `tilelang-maca-build`、`tilelang-maca-bench` skills；`tilelang-metax/.agents/skills` 可作 Codex 形态参考。
4. **License 风险提示**：`mxmaca-performance-tuning-guide` 与 `op_optimization` **无 license**——改写转述、不逐字拷贝；`maca-samples`（BSD 式）、`mxmaca-courses`/`flagos-ai/skills`/`tilelang-metax`（Apache-2.0）、`TileOPs-Metax`（MIT）可较自由引用。

---

## 六、顺带记录：其他国产芯片算子 skills 线索

- **华为昇腾**：`github.com/Ascend/agent-skills`（官方，将昇腾软件栈专家经验模块化为 Agent Skills）；`github.com/ascend-ai-coding/awesome-ascend-skills`（面向 NPU 开发者，Claude Code/OpenCode/Cursor/Trae/Codex 可直接读）；`github.com/pgg3/cann-claude-tools`（Claude Code 迭代式 CANN Ascend C 算子生成，自动迭代选最优）；华为开发者论坛有 CANNBot-skills 实践帖。**昇腾是目前唯一有官方 skills 仓库的国产厂商，可作对标杆**。
- **摩尔线程**：MusaCoder（开源算子生成专用代码大模型，mthreads.com/news/318）、MUSACODE（AI 编程能力矩阵，含智能体辅助/多智能体协同）、TileLang-MUSA 开源；未发现公开 Claude/Codex 格式 skill 仓库。
- **智源 FlagOS 2.0**（聚合器）：32 款芯片（沐曦/摩尔线程/寒武纪/海光/天数/昆仑芯/平头哥/昇腾…）、497 算子、12 种 Skills，KernelGen 2.0 提供 Web + Skill + MCP 三形态；FlagGems C++ Wrapper 由多家厂商支持。
- **寒武纪/天数/海光/昆仑芯**：未见独立 skills 仓库，能力经 FlagOS/FlagGems 间接覆盖（厂商后端目录 `_cambricon`、`_iluvatar`、`_hygon`、`_kunlunxin`）。

---

## 七、搜索过程记录（关键词/轮次）

中文：沐曦 MACA 算子开发 github；沐曦 算子 skill Claude SKILL.md；沐曦 gitee MACA 软件栈仓库；gitee 沐曦 MACA 仓库；gitcode 沐曦 metax 算子；"沐曦" "claude code" skill 算子开发 智能体；Kernel-Smith 沐曦 上海AI实验室 算子 智能体；国产芯片 算子开发 skills github 摩尔线程 寒武纪 昇腾 claude；摩尔线程 MUSA skill 智能体 算子开发。
英文：MetaX-MetaX github MACA；metax skill；metax maca（GitHub API repos 搜索）；flagos skills；Kernel-Smith GitHub operator agent Shanghai AI Lab MetaX。
组织遍历：GitHub `metax-maca` 全量 70+ 仓库（API）；Gitee `metax-maca`（18 仓库页面全文）、`metax-ai`；GitCode 搜索（无官方组织）。
实测克隆（/tmp/metax-research/）：flagos-skills、TileOPs-Metax、tilelang-metax、Kernel-Smith、muxi_native_layout_kernels、op_optimization、maca-samples、QuickGuide、Materials、mxmaca-performance-tuning-guide、mxmaca-courses。

---

## 八、主要来源链接

- https://github.com/metax-maca （官方 GitHub 组织）
- https://github.com/MetaX-MACA/TileOPs-Metax ／ https://gitee.com/metax-maca/TileOPs-Metax
- https://github.com/tile-ai/tilelang-metax
- https://github.com/flagos-ai/skills ／ 文档 https://docs.flagos.io/projects/kernelgen/
- https://github.com/InternLM/Kernel-Smith ／ 论文 https://arxiv.org/html/2603.28342v1 ／ Demo https://chat.intern-ai.org.cn/kernel-smith
- https://gitee.com/metax-maca/mxmaca-performance-tuning-guide
- https://github.com/MetaX-MACA/maca-samples ／ https://gitee.com/metax-maca/maca-samples
- https://gitee.com/metax-maca/mxmaca-courses ／ https://maca-school.metax-tech.com/ ／ https://compiler.metax-tech.com/
- https://github.com/MetaX-MACA/op_optimization
- https://github.com/MetaX-MACA/mcoplib ／ mcPytorch ／ vLLM-metax（170★）
- https://gitee.com/metax-maca/cu-bridge
- https://github.com/QingCheng-AI/muxi_native_layout_kernels
- https://developer.metax-tech.com/ （SDK：/softnova/download?package_kind=SDK）
- https://www.metax-tech.com/ndetail/12590.html （TileLang-MetaX 开源）／ /ndetail/12575.html （Kernel-Smith 发布）
- https://gitee.com/metax-ics ／ https://gitee.com/metax-maca ／ https://gitee.com/metax-ai
- 其他厂商：https://github.com/Ascend/agent-skills ；https://github.com/ascend-ai-coding/awesome-ascend-skills ；https://github.com/pgg3/cann-claude-tools ；https://www.mthreads.com/news/318 （MusaCoder）；
- 背景报道：https://zhuanlan.zhihu.com/p/2024207186176288648 、https://zhuanlan.zhihu.com/p/2022976367738758188 （FlagOS Skills 详解）；https://hub.baai.ac.cn/view/53601 （FlagOS 2.0 发布）；https://cloud.tencent.com/developer/article/2610971 （MXMACA 3.3 兼容性 92.94%）；https://juejin.cn/post/7663672346381697078 （沐曦选 Gitee 企业版）
