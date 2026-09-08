# 昇腾（Ascend/CANN）算子开发 Agent Skills 调研报告

> 调研日期：2026-09-08。调研方式：git clone --depth 1 实测（gitcode.com 直连可用；github.com 需重试）+ Web 搜索（中英文多轮）。
> 目的：为 forge 的「算子开发 skills 体系」提供标杆剖析（cannbot-skills）与全生态素材清单。

---

## 任务一：cannbot-skills 深度剖析（标杆仓库）

### 1.1 基本信息

| 项 | 内容 |
|---|---|
| 仓库 | https://gitcode.com/cann/cannbot-skills （华为 CANN 官方 `cann` 组织） |
| 定位 | 面向 CANN 开发的系列智能体 CANNBot 的可复用 Agent Skills 模块仓，覆盖 Ascend C / Catlass / PyPTO / TileLang / Triton 算子开发、torch.compile 图模式、模型推理优化、Runtime 适配 |
| 活跃度 | **极高**：最后提交 2026-09-08（调研当天）；CHANGELOG 按天记条目；gitcode 组织页显示 1303 stars / 858 forks / 97 open MR |
| License | CANN Open Software License v2.0（华为自定义开源协议，非标准 OSI；商用需审阅） |
| 治理 | 有 SIG（gitcode.com/cann/community → CANN/sigs/cannbot）、GOVERNANCE.md、CONTRIBUTING.md、OAT.xml 开源审计 |
| 安装器 | npm 包 `@cannbot-ai/install-helper`（install.sh 的本质是引导安装该 npm 包），支持 latest/beta 通道 |

### 1.2 格式归属结论（核心问题的直接回答）

**主体格式 = Agent Skills 开放标准（agentskills.io），即 Claude Code 的 SKILL.md 规范；分发层 = Claude Code 插件市场（Plugin Marketplace）格式；同时做了多工具（OpenCode/Codex/Trae/Cursor/Copilot/CodeArts）适配。不是 OpenAI Codex 原生格式（Codex 只是它支持的安装目标之一）。**

证据链：

1. 每个 skill 是一个目录 + `SKILL.md`（YAML frontmatter：`name` + `description`），README 明文声明「遵循 [Agent Skills](https://agentskills.io) 开放标准」，badge 也指向 agentskills.io。
2. frontmatter 中出现 **Claude Code 专属字段**：`disable-model-invocation`（38 处）、`argument-hint`（20 处）、`allowed-tools`（7 处）、`user-invocable`（2 处）——这些是 Claude Code Agent Skills 的规范字段。
3. 根目录 `.claude-plugin/marketplace.json` 是 **Claude Code Plugin Marketplace 清单**（引用 anthropic 的 marketplace 约定，`plugins[]` 每项有 name/description/source/version/category/skills 列表）；每个 plugin 目录内有自己的 `.claude-plugin/plugin.json`（含 name、version、license、`agents: [./agents/*.md]` 引用）。
4. Codex 兼容体现在安装层而非格式层：各 plugin 的 `init.sh project codex` 把 SKILL.md 安装为 Codex 可读的 prompts；插件内还有 `.opencode/`、`.claude/`、`.codex-plugin/`、`.cursor-plugin/` 等目录做工具适配（见 plugins-community/catlass-dsl-generator，一个插件同时带 4 套工具配置）。
5. 仓库根有 `AGENTS.md`——但这是「给贡献者/Agent 看的工程指南」（Codex/通用约定），不是 Codex 技能包格式本身。

自定义扩展字段（超出现行 Claude Code 规范、属于该仓库私有能力）：`license`（6）、`workflow-hook`/`workflow-stages`/`standalone`（各 6，插件工作流挂钩，如 `workflow-hook: after:4.1`）、`permission`（3）、`metadata`（2）、`effort`（2）、`hooks`（2）、`trigger`、`context`、`subagent`（各 1）。

### 1.3 目录结构全景（可直接照抄的层级设计）

```
cannbot-skills/
├── .claude-plugin/marketplace.json   # Claude Code 市场清单（把领域目录注册为 plugin）
├── AGENTS.md                         # 工程师指南（贡献者规范：核心原则/架构/结构）
├── install.sh / install.ps1          # 一键安装（引导 npm @cannbot-ai/install-helper）
├── CHANGELOG.md / LICENSE / OAT.xml / .gitcode/（CI、Issue/PR 模板）
│
├── ops/        # 算子 Skills（70 个，最大领域；按编程范式前缀分组）
├── model/      # 模型推理/训练优化 Skills（19 个）
├── graph/      # 图编译/torch.compile Skills（10 个）
├── runtime/    # CANN Runtime Skills（2 个）
├── infra/      # 基础设施 Skills（5 个：skill 审查、GitCode PR/Issue 自动化）
├── tools/      # CANN 工具链 Skills（3 个：asys/msaicerr/msnpureport，命名 {工具名}-toolkit）
│
├── plugins-official/     # 官方 Plugin（= Skills + Agents + Workflows + init.sh + quickstart.md）
├── plugins-community/    # 社区 Plugin（同结构，实验性）
├── docs/                 # STANDARDS/CONTRIBUTING/GOVERNANCE/installation-guide/feature-list/architecture-design/skills-usage
├── tests/                # 自动化测试框架（behavior/benchmark/integration/system/unit）
└── tools（顶层无）       # （注意：skills/tools 是领域目录，与 tests 平级的 tools/ 不存在）
```

**三层架构（官方定义）**：Plugin（应用编排层，`AGENTS.md` 定义 Agent 协作顺序）→ Agent（角色执行层：architect/developer/reviewer/tester 等 `.md` 定义）→ Skill（知识能力层）。Plugin 通过 `.claude-plugin/plugin.json` 声明依赖（如 ops-direct-invoke 依赖 `ops-direct-invoke-skills` + `infra-skills`）并引用 `agents/*.md`。

**Skill 内部标准布局**（渐进式披露）：`SKILL.md`（核心，1.1KB~37KB）+ 可选资源目录。统计 251 个非隐藏 SKILL.md 中：`references/` 159 个、`evals/` 123 个、`scripts/` 86 个、`templates/` 24 个、`examples/` 8 个、`assets/` 6 个、`tests/` 6 个；少数特殊：`workflows/`、`schemas/`、`registries/`、`benchmark/`、`knowledge/`、`steps/`、`core/`。

### 1.4 Skill 计数

- 顶层领域目录共 **109 个 skill**：ops 70 + model 19 + graph 10 + runtime 2 + infra 5 + tools 3。
- ops 内有嵌套子 skill（父 skill 目录下再挂子 SKILL.md）：`pypto-op-perf-tune/`（perf-analyzer、tune-frontend、tune-incore、tune-orchestrator、tune-swimlane 5 个子 skill）、`pypto-precision-compare/`（precision-binary-search、precision-pass、precision-verify 3 个）、`ops-profiling/msopprof-visualization/` 1 个，共 9 个。
- plugins-official + plugins-community 内约 133 个 skill（官方插件复用 ops/ 里的 skill 名，社区插件自带 skills/）。
- 全仓含隐藏目录（`.opencode/`、`.claude/` 下的工具适配副本）合计 **259 个 SKILL.md**。

### 1.5 完整 Skill 清单（109 个顶层 skill，按领域）

#### ops/（70，算子开发核心）

**Ascend C 体系（ascendc-* / cann / npu / ops 通用）33 个：**

| Skill | 用途 | 资源 |
|---|---|---|
| aiss-tiling-solver | AISS-TilingSolver 自动求解 MatMul/Vector 最优 Tiling | — |
| ascendc-api-best-practices | Ascend C API 最佳实践（算术/归约/搬运/Buffer/精度转换/通信） | references(21) |
| ascendc-blaze-best-practice | Ascend 950/DAV_3510 Blaze/tensor_api 开发 Matmul 家族 | references(56), assets(26) |
| ascendc-blaze-migration | ops-nn 等仓 950 Kernel 迁移到 Blaze/tensor_api | references(10) |
| ascendc-code-review | 代码检视（文件/PR/大型PR/快速 4 工作流，假设检验+证据框架） | references(15), scripts(12), workflows(5), core(2), steps(20) |
| ascendc-crash-debug | 卡死/崩溃/Coredump 调试路由 | references(4), scripts(3) |
| ascendc-direct-invoke-template | `<<<>>>` Kernel 直调工程模板（add_custom 样例） | references(55) |
| ascendc-direct-invoke-to-registry-invoke | 直调转自定义算子工程 | references(6) |
| ascendc-docs-gen | 算子文档模板（需求/详设/迭代计划/aclnnAPI/README） | references(6) |
| ascendc-docs-search | 文档检索（本地索引优先、在线兜底） | references(3), scripts(6) |
| ascendc-env-check | npu-smi 设备查询 + CANN 环境验证 | references(5), scripts(4) |
| ascendc-mc2-best-practice | MC2 通算融合算子（通信+计算融合）开发 | references(115), docs(4) |
| ascendc-perf-optimize | 性能优化策略（卡间/核间/核内三层流水） | references(57) |
| ascendc-performance-best-practices | 按算子族组织的性能优化经验库 | references(76) |
| ascendc-precision-debug | 精度调试（症状速查/常见陷阱/DumpTensor/printf） | references(13), scripts(2) |
| ascendc-regbase-best-practice | DAV_3510 RegBase 算子 API 约束与陷阱 | references(23) |
| ascendc-registry-invoke-template | 完整自定义算子工程模板（UT/ST 样例、多芯片参考） | references(93) |
| ascendc-registry-invoke-to-direct-invoke | 注册算子转 `<<<>>>` 直调 | references(2) |
| ascendc-runtime-debug | 运行时错误码解析（161xxx/361xxx/561xxx） | references(3), scripts(1) |
| ascendc-simt-best-practices | SIMT 编程实践与 API 索引 | references(13) |
| ascendc-simt-tiling-design | SIMT 切分设计（核数/线程/DCache/UB） | references(1) |
| ascendc-st-design | ST 系统测试设计（L0/L1 用例生成） | references(5), scripts(7) |
| ascendc-sync-audit | SetFlag/WaitFlag/CrossCore 同步检验修正 | references(14), scripts(5), benchmark(25), data(3), workflows(4) |
| ascendc-tiling-design | Tiling 设计方法论（多核切分/UB/Buffer/分支覆盖） | references(40) |
| ascendc-ut-develop | UT 开发与覆盖率增强 | references(16), scripts(2), assets(12) |
| ascendc-whitebox-design | 白盒测试用例自动生成（参数组合枚举） | references(30), scripts(21) |
| cann-env-setup | CANN 安装与环境配置 | references(1) |
| npu-arch | NPU 架构知识（芯片型号映射、archXX 特性、条件编译） | references(4) |
| ops-precision-standard | 精度标准（dtype→atol/rtol 混合容差） | references(7), scripts(4) |
| ops-profiling | msprof 算子级瓶颈定位 + kernel 对比测试 | references(4), scripts(3) + 子skill msopprof-visualization |
| ops-simulator | CANN Simulator（精度/性能仿真、流水线分析，无硬件验证） | references(8), scripts(1) |
| ops-spec-gen | 算子 spec.yaml 生成/校验（L0 数学约束真值） | references(5), scripts(17), schemas(1), registries(13), examples(13), tests(18) |
| torch-ascendc-op-extension | 算子接入 PyTorch（PTA 接口开发） | references(6), templates(12), routes, |

**Catlass 3 个：** catlass-op-design（组件选型 ArchTag/TileShape/DispatchPolicy）、catlass-op-develop（模板拼装生成 kernel）、catlass-op-perf-tune（TileShape/Swizzle 调优）。

**PyPTO（昇腾原生 Python Tile 编程）18 个：** pypto-api-explore、pypto-docs-search、pypto-general-debug、pypto-golden-generate、pypto-intent-understand、pypto-memory-template、pypto-op-construct、pypto-op-design（生成 DESIGN.md）、pypto-op-develop、pypto-op-knowledge、pypto-op-plan、pypto-op-review、pypto-op-verify、pypto-orchestration-manual、pypto-precision-debug、pypto-precision-compare（+3 子skill）、pypto-op-perf-tune（+5 子skill）、pypto-intent-understand 等。

**TileLang 10 个：** tilelang-api-best-practices、tilelang-env-check、tilelang-op-design、tilelang-op-develop、tilelang-op-test-design、tilelang-perf-optimization、tilelang-programming-model-guide（Developer/Expert 模式选择）、tilelang-review、tilelang-submodule-pull。

**Triton（triton_ascend）7 个：** triton-latency-optimizer、triton-op-coding、triton-op-designer、triton-op-verifier、triton-precision-debug、triton-simulator-optimizer、triton-task-extractor（均带 argument-hint 字段，支持命令式调用）。

**其他：** torch-ops-profiler（torch_npu.profiler 用例维护）。

#### model/（19）

model-infer-fusion（torch_npu 融合算子替换）、model-infer-graph-mode（torch.compile 图模式适配）、model-infer-harmony（麒麟 Kirin9030 端侧 ASR 量化/omg/CANNPAK）、model-infer-kvcache（Paged Attention/MLA/SlidingWindow）、model-infer-migrator（HF 模型适配部署基线）、model-infer-multi-stream（多流/控核/npu_stream_switch）、model-infer-parallel-analysis（TP/EP/DP 推荐）、model-infer-parallel-impl（并行切分实施）、model-infer-perf-breakdown、model-infer-precision-debug、model-infer-prefetch（npu_prefetch 权重预取）、model-infer-profiling、model-infer-quantization（compressed-tensors 量化接入）、model-infer-runtime-debug、model-infer-superkernel（SK 二进制融合）、model-recommend-analysis（推荐模型 Profiling 分析）、model-train-accuracy-debug、model-train-log-visualization、model-train-oom-analysis。

#### graph/（10）

ge-coredump-diagnose（GE 崩溃 coredump 诊断）、ge-dynamic-shape-diagnose（unknown shape/动态调度）、ge-fusion-pass-skill（自定义融合 pass 开发）、torch-custom-ops-guide（自定义算子入图）、torch-npugraph-ex-compile-error-diagnosis、torch-npugraph-ex-dfx-triage（DFX 分诊入口→路由 4 专科）、torch-npugraph-ex-knowledge、torch-npugraph-ex-performance-diagnosis（reinplace 未命中审计）、torch-npugraph-ex-runtime-error-diagnosis、torch-npugraph-ex-template（MRE 模板）。

#### runtime/（2）

runtime_migration（CUDA Runtime 层迁移到 CANN Runtime，references(4)+assets(23)）、runtime-llt-generator（Runtime LLT 测试生成，2026-09-08 新增）。

#### infra/（5）

cannbot-skill-reviewer（skill 入库质量审查：结构门禁+九维评分）、gitcode-issue-gen、gitcode-issue-handler（Issue 端到端处理状态机，最重组：references(18)+scripts(15)+knowledge(18)+tests(10)）、gitcode-pr-handler（PR 标题/描述重生成）、gitcode-toolkit（GitCode API 基础参考，disable-model-invocation:true 仅内部引用）。

#### tools/（3)

asys-toolkit（一键故障信息收集）、msaicerr-toolkit（AI Core Error 分析）、msnpureport-toolkit（Device 侧日志导出）。

#### plugins-official（10 个插件，端到端工作流入口）

ops-direct-invoke（直调开发 Team：PM+architect/developer(-code/-test/-doc)/qa 六角色、8 阶段 7 CP）、ops-direct-invoke-flash（快速直调）、ops-registry-invoke（ACLNN/GEIR 注册调用）、catlass-op-generator、pypto-op-orchestrator（planner/mathematician/architect/designer/coder/verifier/debugger/optimizer 8 角色）、tilelang-op-orchestrator、triton-op-generator、torch-compile、model-infer-optimize、ops-code-reviewer。插件自带 agents/*.md、hooks/、workflows/、evals/、init.sh、quickstart.md、.claude-plugin/plugin.json。

#### plugins-community（17 个插件）

ascendc-port-orchestrator（aog-* 10 skill：算子移植编排）、autoresearch、cannbot-dsl（31 个 cannbotdsl-* skill：自定义 DSL）、cannbot-insight（Web 分析平台）、cannbot-knowledge（9 个 knowledge-*/ops-knowledge-* skill）、catlass-dsl-generator（5 skill，含 .codex-plugin/.cursor-plugin/.opencode/.claude-plugin 四套工具配置）、collaborative-agent-kernel-evolution（21 个 cake-*/dsl-* skill）、cuda2ascend（22 个 workflow-cp0~cp5/repo-* skill，CUDA 迁移全流程）、install-helper（即 npm 安装器本体源码）、ops-easyasc-dsl、ops-perf-evolution、ops-perf-optimize、ops-qa-suite（.opencode 下 12 个 scan-*/tool-* skill）、science-model-npu-migration、shmem-ops-generator（11 个 shmem-ops-* skill）、tilelang2ascendc-ops-generator（6 skill）、triton-optimizer（2 skill）。

### 1.6 质量工程（对 forge 最有参考价值的部分）

- **evals 评测**：123/251 个 skill 带 `evals/evals.json`（格式：`{eval_mode, evals: [{id, title, config{max_tokens, ascend_platforms[A2 等]}, prompt, expected_output, files, expectations}]}`）。CI 有硬性门禁 `S-EVAL-01`：所有 skill 必须带合法 evals.json（含 skill_name 字段）。
- **tests/ 五层测试框架**：unit（install/skills/agents/teams/infra）、behavior、integration、system、benchmark（config/prompts/runner）。
- **命名规范**（STANDARDS.md）：`{domain}-{name}` kebab-case；SKILL.md 严格大写命名；skill 目录内禁放 README.md，文档一律进 SKILL.md 或 references/。
- **五分类体系**：知识库类（被动查询）/ 工程模板类 / 调试与诊断类 / 测试开发类 / 工具辅助类。
- **知识依赖单向性**：标识「真源 skill」，下游消费上游、禁止反向自引用。
- **三层信息来源纪律**（AGENTS.md）：技术信息必须来自 CANN 官方文档/社区代码仓/CANN 安装路径/用户明确提供，禁止编造 API。
- **分发渠道**：① install-helper（npm，完整安装含 Agents+Workflows+外部依赖如 asc-devkit/pypto/tilelang-ascend/cann-samples）；② `npx skills add https://gitcode.com/cann/cannbot-skills.git --skill xxx --agent claude-code`（vercel-labs/skills CLI，独立 skill 安装到 70+ 工具）；③ Claude Code marketplace.json。

---

## 任务二：其他昇腾/CANN 相关 Agent Skills 与素材

### 2.1 官方仓库（华为/昇腾）

| 仓库 | 位置 | 内容与格式 | 活跃度 |
|---|---|---|---|
| **Ascend/agent-skills**（gitcode 版，**推荐主参照**） | https://gitcode.com/Ascend/agent-skills | 昇腾官方「Agent Skills 总分发仓」：216 个 SKILL.md。结构 `official/{产品线}/`（CANNBot(submodule 指向 cann/cannbot-skills)、Common、MindCluster、MindEdge、MindIE、MindSeriesSDK(AgentSDK/RAGSDK/RecSDK)、MindSpeed、MindStudio(约 35 个 profiler/量化/msmodelslim skill，subtree)、PyTorch(npu-graph-skill、torch-npu-pr-review、op-adaptation 等 20+)、sglang、verl、vllm-ascend）+ `community/{Op,Tools,Train,Infer,Recommend}/`（Op 下 50+ 个 ascendc-/catlass-/shmem-/triton-/tilelang- 算子 skill）。自带 .claude-plugin/marketplace.json（33 个 plugin 条目）。安装用 `npx skills`。命名规范同 cannbot | 2026-08-17 最后提交；gitcode（gitcode.com/Ascend/agent-skills） |
| **Ascend/agent-skills**（GitHub 镜像） | https://github.com/Ascend/agent-skills | `skills/` 扁平结构 59 个 skill（ascendc-operator-{dev,design,code-gen,code-review,doc-gen,testcase-gen,project-init,compile-debug,precision-*,performance-*,mssanitizer}、triton-operator-* 7 个、catlass-operator-* 4 个、megatron-* 4 个、verl-*、vllm-ascend-*、npu-smi、atc-model-converter、skill-auditor 等）+ docs/设计文档 | 39 stars；2026-05-07 后未更新（内容落后 gitcode 版）；MulanPSL-2.0 license |
| **ascend-ai-coding/awesome-ascend-skills** | https://github.com/ascend-ai-coding/awesome-ascend-skills | 社区聚合仓（华为系维护者）：`skills/{base,inference,ops,profiling,training,agent-tools,ai-for-science}/` 73 个 SKILL.md + `external/` 通过 GitHub Actions 自动同步三源：cannbot-skills（marketplace 模式）、gitcode.com/Ascend/agent-skills（flat 模式）、kali20gakki/mindstudio-skills。也是 .claude-plugin/marketplace.json 格式；发布到 skills.sh | 167 stars / 57 forks；2026-09-08 仍更新（三源中活跃度最高的聚合入口） |
| **kali20gakki/mindstudio-skills** | https://github.com/kali20gakki/mindstudio-skills | MindStudio Profiler 诊断 skill 集：10 个（ascend-profiler-db-explorer、cluster-fast-slow-rank-detector、op-mfu-calculator、msmodelslim-model-adapt/analysis、mindstudio_profiler_data_check 等） | 8 stars；2026-04-15 |

### 2.2 社区/研究仓库

| 仓库 | 位置 | 内容 | 活跃度 |
|---|---|---|---|
| **Just-it/AscendOpGenAgent** | https://github.com/Just-it/AscendOpGenAgent | 自动化算子生成与评测框架：AKG-Triton Agent（任务提取→生成→评测）、AutoResearch（plan→edit→eval→keep/discard 闭环，**Claude Code hook 约束的阶段机**）、Lingxi_code Agent（AscendC 交互生成）、Benchmark-Evaluator。内含 `skills/{triton,ascendc}/` 11 个 SKILL.md（kernel-designer/generator/verifier、tilelang-designer、ascendc-translator 等，与 cannbot-skills 的 triton 系 skill 同源） | 38 stars / 51 forks；Apache-2.0；2026-06-17 |
| **Westreety/Code-Review-Agent-for-Ascend-Operators** | https://github.com/Westreety/Code-Review-Agent-for-Ascend-Operators | 面向三方 Ascend C 算子的 Code Review Agent | 0 stars；Apache-2.0；2026-06-18 |
| **Ascend/ascendc-kernelgen-data**（gitcode） | https://gitcode.com/Ascend/ascendc-kernelgen-data | **AscendC 算子代码生成训练数据集**（多算子类型，供代码生成模型训练/评估）——做 skill 语料/微调的重要素材 | gitcode Ascend 组织在列 |
| **Ascend org 其他 agent 仓（gitcode）** | gitcode.com/Ascend/{model-agent, msagent, MindSpeed-Agent, MindSpeed-Ops, solution-agent, ops-rec} | model-agent（模型落地全流程）、msagent（MindStudio 智能体：性能/精度自动分析）、MindSpeed-Agent 等 | 均在 gitcode Ascend 组织 |

### 2.3 算子实现与工具链素材仓（skill 知识源，非 skill 格式）

均位于 gitcode `cann` 组织（https://gitcode.com/cann，组织页 2026-07 数据）：

| 仓库 | 说明 | 热度 |
|---|---|---|
| ops-math | CANN 数学类基础算子库（即 cann-ops 主仓；原 gitee cann-ops-adv 已停止维护并迁移） | 1227★/1320 fork |
| ops-transformer | transformer 类大模型算子库 | 1001★ |
| pypto | PyPTO（Parallel Tensor/Tile Operation 编程范式，昇腾原生 Python 算子编程） | 758★ |
| ascendc-api-adv（gitee: ascend/ascendc-api-adv，gitcode: Ascend org） | Ascend C 编程语言/类库（算子开发语言本体） | 632★/907 fork |
| catlass | CANN 算子模板库（NPU 高性能 Matmul 及融合算子模板样例） | 434★ |
| hccl / hcomm / shmem | 集合通信库 / 通信基础库 / OpenSHMEM 多机多卡内存通信库 | 391★ / 350★ / 169★ |
| cann-bench | 评测 AI 处理 CANN 领域代码任务能力（算子生成/优化），CANN 领域评测平台 | 97★ |
| ops-nn、ops-blas、ops-solver、ops-sparse、ops-rand、ops-fft、ops-tensor、ops-gnn、ops-cv、ops-rec、ops-multimodal-fusion、ops-collections、catccos（通算融合模板库）、asc-comm | 各细分算子库 | — |
| ops-test-kit | TTK 算子全链路自动化批量测试框架 | — |
| cann-samples / asc-devkit / cann-recipes-{infer,train,embodied-ai,harmony-infer,spatial-intelligence} | 官方样例、开发套件、模型 recipe（cannbot-skills 安装时会克隆为外部依赖） | — |
| cannbot / cannbot-dsl / pypto-gym | CANNBot plugin/hook 仓 / CANNBot-DSL 复杂算子示例集 / PyPTO 样例 gym | — |
| ge / metadef / runtime / driver / graph-autofusion / pto-isa / xla-npu / tensorflow / torchtitan-npu | GE 图编译器、元定义、Runtime、驱动等底层 | — |

**GitHub Ascend 组织**（https://github.com/Ascend）：pytorch（573★，torch_npu adapter）、triton-ascend（128★，triton_ascend DSL 本体）、triton-ascend-ops（22★，官方 Triton 算子仓）、torchair（27★）、AgentSDK、samples（166★，老样例仓）、cann_op_contrib（已停滞 2023）。
**tile-ai 组织**：tilelang-ascend（Expert 模式→AscendC 后端）、tilelang-mlir-ascend（Developer 模式→AscendNPU IR）、tilelang 主仓。cannbot-skills 的 tilelang-* 系列 skill 即针对它们。
**gitee**：gitee.com/ascend/{cann-ops-adv(停维护), ascendc-api-adv, catlass, cann-ops 镜像}——gitee 已整体让位 gitcode，仅作历史镜像。

### 2.4 论文（方法素材，非 skill）

- **AgenticCANN: Automated Ascend C Operator Generation via Knowledge-Augmented Agentic Evolution** — arxiv.org/abs/2607.26661（知识增强智能体进化生成 Ascend C 算子；910B1 实测，54+ 算子）
- **AscendOptimizer: Episodic Agent for Ascend NPU Operator Optimization** — arxiv.org/abs/2603.23566（免训练情景记忆 RAG agent 优化 Ascend C 算子）
- **AscendCraft: Automatic Ascend NPU Kernel Generation via DSL** — arxiv.org/abs/2601.22760
- **AKG Kernel Agent: Multi-Agent Framework for Cross-Platform Kernel Synthesis** — arxiv.org/abs/2512.23424
- **CANN Bench: Benchmarking Agent Generated Kernels against Real Workloads** — arxiv.org/abs/2607.20518
- 检索「CAGA」无此缩写的昇腾算子论文，最接近的是 AgenticCANN。

### 2.5 文档站与社区入口

- 昇腾算子开发官方专区：https://www.hiascend.com/cn/developer/operator
- CANN 官方文档（Ascend C 算子开发指南/API）：https://www.hiascend.com/document
- CANNBot 使用经验（官方博客）：https://www.hiascend.com/developer/blog/details/02176215687448878284
- CANNBot FFT 算子智能开发实践：https://www.hiascend.com/developer/blog/details/02141212740341582013
- CANNBot SIG：https://gitcode.com/cann/community/tree/master/CANN/sigs/cannbot
- CSDN 昇腾 Agent-Skills 实操专栏（12 篇）：https://hwcomputing.csdn.net/column/6a28c8ceb5b4b577d3cccab9
- skills.sh 聚合页：https://skills.sh/ascend-ai-coding/awesome-ascend-skills
- Agent Skills 开放标准：https://agentskills.io ；vercel skills CLI：https://github.com/vercel-labs/skills

---

## 三、对 forge skills 体系的直接结论

1. **格式选择**：照抄 cannbot-skills 的路线——`SKILL.md`（Agent Skills/Claude Code 规范，frontmatter 仅 `name` + `description` 为必填，`disable-model-invocation`/`argument-hint`/`allowed-tools` 按需）+ Claude Code `.claude-plugin/marketplace.json` 做分发；多工具适配放安装层而非格式层。
2. **目录结构**：顶层按「领域」分目录（对应 forge 的厂商→芯片→领域），skill 目录用 `{domain}-{name}` kebab-case；skill 内 `references/`（渐进披露文档）+ `scripts/`（可执行）+ `templates/` + `evals/evals.json`（评测）四件套是事实标准。
3. **生态分工参考**：官方实现仓（cannbot-skills，按技术路线 ops/model/graph 分）+ 官方总分发仓（Ascend/agent-skills，按产品线 official/ + community/）+ 社区聚合仓（awesome-ascend-skills，external/ 自动同步）。forge 若做多厂商体系，cannbot-skills 对应「厂商内实现仓」，Ascend/agent-skills 对应「跨产品线分发仓」。
4. **质量工程**：evals.json 全覆盖 + CI 门禁 + 五层测试 + skill-reviewer skill 自审，是其区别于业余 skill 集的核心。
5. **法务注意**：cannbot-skills 为 CANN OSL v2.0（非标准 OSI 协议），借鉴结构可以，直接拷贝内容需审阅协议；Ascend/agent-skills GitHub 版为 MulanPSL-2.0。

---

## 四、检索过但确认不存在/无结果的路径

以下关键词组合均已检索（WebSearch，中文+英文），确认无独立成果，避免后续重复怀疑遗漏：

1. 「CAGA 昇腾/Ascend」——不存在该缩写论文或项目（最接近 AgenticCANN）。
2. 「OpenAI Codex 格式的昇腾技能包」——不存在 Codex 原生格式的昇腾 skill 仓；Codex 只作为 cannbot-skills/agent-skills 的安装目标（`.codex-plugin/` 适配目录存在，但 skill 本体仍是 SKILL.md）。
3. gitee.com 上独立的「昇腾算子 agent skill 仓」——gitee 只有算子代码仓（cann-ops-adv 等，且已停维护迁往 gitcode），无 skill 仓；skill 生态全部在 gitcode + github。
4. GitHub 上除 Ascend/agent-skills、ascend-ai-coding/awesome-ascend-skills、Just-it/AscendOpGenAgent、Westreety/Code-Review-Agent-for-Ascend-Operators、kali20gakki/mindstudio-skills 外，未发现其他维护中的昇腾算子 skill 仓库（检索词：ascend skill / cann skill / ascendc agent / npu operator skill / 昇腾 算子 skill 等）。
5. gitcode `cann` 组织 69 个仓库、`Ascend` 组织相关仓库已全部枚举（API 分页拉取），skill 相关仅 cannbot-skills、cannbot、cannbot-dsl、cann-bench（评测）；`Ascend` 组织另有 agent-skills、model-agent、msagent、MindSpeed-Agent、solution-agent、ascendc-kernelgen-data。
6. npm 上除 `@cannbot-ai/install-helper` 外无其他昇腾 skill 分发包。
7. gitcode API v5 的仓库级端点（/api/v5/repos/{owner}/{repo}）对本组织仓库返回空（仅组织级 /orgs/{org}/repos 可用），单仓 stars 以组织主页展示数据为准。

## 附：本次实测克隆的仓库（/tmp/，可复查）

- /tmp/cannbot-skills（gitcode 深克隆）
- /tmp/ascend-agent-skills（GitHub 版）
- /tmp/ascend-agent-skills-gitcode（gitcode 版，含 216 SKILL.md）
- /tmp/awesome-ascend-skills
- /tmp/AscendOpGenAgent
- /tmp/mindstudio-skills
