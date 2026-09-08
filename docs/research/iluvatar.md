# 天数智芯（Iluvatar Corex / IX 系列 GPU）算子开发 Agent Skills 调研报告

> 调研日期：2026-09-08。调研方式：GitHub/Gitee API + tarball 实测下载（github.com:443 直连 git clone 不通，改用 api.github.com tarball；Gitee API 直连可用）+ Web 搜索中英文 17+ 组关键词。gitcode.com 未发现天数智芯相关仓库。
> 同系列报告：`ascend-cann.md`（昇腾标杆 cannbot-skills）、`metax.md`（沐曦）。

---

## 0. 核心结论（先回答问题）

**天数智芯官方不存在类似华为 cannbot-skills 的独立算子开发 Skills 仓库；但「现成可用的天数算子开发 skills」确实存在，来自第三方生态 FlagOS（智源 BAAI 牵头的众智开源栈）**，且天数官方的一个仓库（Deep-Spark/FlyDSL）内嵌了 Claude Code 项目级配置。具体：

1. **flagos-ai/skills**（社区/智源，非天数官方）：12 个 Agent Skills 开放标准（agentskills.io）格式 skills，即 **Claude Code SKILL.md 规范**，同时带 `.cursor-plugin/`、`gemini-extension.json`、`agents/openai.yaml`（Codex 安装适配）。其中 `kernelgen-flagos`、`tle-developer-flagos`、`install-stack-flagos`、`vllm-plugin-fl-setup-flagos` 四个 skill 直接覆盖天数智芯算子路径（`_iluvatar` 后端 / `USE_ILUVATAR_COREX=1` / BI-V150）。**这是目前唯一现成的、含天数后端知识的 SKILL.md 技能包。**
2. **Deep-Spark/FlyDSL**（天数官方组织，fork 自 AMD ROCm/FlyDSL）：仓库内 `.claude/skills/` 有 **16 个 kernel 开发 SKILL.md**（布局代数、tile 编程、GEMM 优化、kernel 调试/trace 分析、LDS 优化、OOB 检测等）——内容继承自 AMD 上游、非天数特化；天数新增的是 `.cursor/rules/` 3 条 iluvatar 专属规则（SME G2S 32B 对齐、CI GPU pool、注释风格）+ `README_Iluvatar.md`（FlyIXDL 天数后端完整文档）+ 63 个 iluvatar kernel 源文件。**这是天数官方仓库中唯一自带 Claude Code/Cursor agent 配置的实例，也是最佳的天数特化 agent 素材来源。**
3. 天数官方 SDK（IXUCA/CoreX）本体不开源、需联系 services@iluvatar.com 获取；官方文档在知识库 ixkb.iluvatar.com.cn（部分免登录）与 support.iluvatar.com（需登录）。

---

## 1. 官方组织盘点：Deep-Spark（GitHub）/ deep-spark（Gitee）

天数智芯官方开源组织：**GitHub `Deep-Spark`**（25 仓库）+ **Gitee `deep-spark`**（24 仓库，互为镜像）。GitCode 上无官方组织。

与「算子/开发」相关仓库清单（其余为 K8s 设备插件、监控、容器、调度等运维件）：

| 仓库 | 内容 | 与算子开发的关系 | 活跃度 | License |
|---|---|---|---|---|
| Deep-Spark/**FlyDSL** | Python layout DSL + MLIR 编译栈（fork ROCm/FlyDSL），含天数 FlyIXDL 后端 | **核心**：天数新一代 kernel 开发路径，自带 .claude/skills + .cursor/rules | 2026-09-07 仍在推送（极活跃） | Apache-2.0 |
| Deep-Spark/**iluvatar-corex-ixrt** | IxRT 推理引擎开源组件（插件、部署工具、样例） | `samples/plugins`、`samplePyPlugin`：自定义算子插件开发样例 | 2026-08-14 | 见仓库 |
| Deep-Spark/DeepSparkHub | 百大应用算法与模型库（应用层，非算子库） | 弱 | 2026-09-02 | — |
| Deep-Spark/DeepSpark | 社区主仓库（平台/评测） | 弱 | 2026-07-27 | — |
| Deep-Spark/DeepSparkInference | 216+ 推理模型示例（跑在 ixRT/IGIE 上） | 弱（模型层） | 2026-09-08 | — |
| Deep-Spark/ixGDB | 天数 GPU 调试工具（CUDA-GDB 扩展） | kernel 调试配套 | 2025-06 停更 | — |
| Gitee deep-spark/developer-doc | 开发者文档反馈仓（仅一个 README，空壳） | 无实质内容 | — | — |

**官方组织中没有任何名为 skill/agent/llm/prompts 的仓库**；带 agent 配置的只有 FlyDSL（见 §3）。

---

## 2. 现成 Skills 仓库一：flagos-ai/skills（重点，含天数后端）

### 2.1 基本信息

| 项 | 内容 |
|---|---|
| 仓库 | https://github.com/flagos-ai/skills （★19，2026-09-07 更新） |
| 维护方 | **FlagOS 社区（智源 BAAI 牵头，十余家机构共建）——非天数官方，但天数是 FlagOS 支持的 32 款芯片之一** |
| 定位 | "FlagOS skills for model deployment, HW adaptation, train&infer, eval, kernel dev and perf" |
| License | Apache-2.0（根 LICENSE + 每个 skill 目录 LICENSE.txt） |
| 安装 | `npx skills add flagos-ai/skills`；或 Claude Code 插件市场 `/plugin marketplace add flagos-ai/skills`；或 `/plugin install flagos-skills@flagos-skills` |

### 2.2 格式归属

**主体 = Claude Code SKILL.md（Agent Skills 开放标准 agentskills.io）**，frontmatter 含 `name`/`description`/`argument-hint`/`user-invokable`/`allowed-tools`/`compatibility`/`metadata` 等 Claude Code 规范字段。分发层为 **Claude Code Plugin Marketplace**（`.claude-plugin/marketplace.json` + `plugin.json`）。同时提供多工具适配：`.cursor-plugin/`（Cursor 插件清单）、`gemini-extension.json`（Gemini）、`agents/openai.yaml`（Codex/OpenAI 接口描述，如 tle-developer 的 display_name + default_prompt）、`npx skills` CLI（--agent claude-code/cursor/...）。仓库根另有 `CLAUDE.md` 与 `agents/AGENTS.md`。

### 2.3 Skills 清单（12 个）与天数覆盖点

| Skill | 用途 | 天数相关 |
|---|---|---|
| **kernelgen-flagos** | GPU 算子生成/优化总控（自动识别 FlagGems/vLLM/通用 Triton 项目并分派子 skill；含 MCP 迭代优化） | **直接**：`references` 明确 `_iluvatar` (Tianshu/天数) 后端算子目录规范；别名映射「天数/Tianshu/天数智芯 → tianshu」 |
| **tle-developer-flagos** | TLE（Triton Language Extension）kernel 编写/优化/调试全流程 | **直接**：TLE 支持 6 款芯片（NVIDIA/海光/摩尔/昇腾/**天数**/沐曦）；带 `agents/openai.yaml`（Codex） |
| **install-stack-flagos** | 芯片软件栈环境安装/校验 | **直接**：`references/vendor-mappings.md` 有 `USE_ILUVATAR_COREX=1`、adaptor `iluvatar_corex` 行 |
| **vllm-plugin-fl-setup-flagos** | vLLM FlagOS 插件部署 | **直接**：`references/iluvatar_gpu.md` 整篇讲 BI-V150（构建 flag、超时环境变量、enforce_eager=True、多机网卡） |
| model-migrate-flagos / model-verify-flagos / perf-test-flagos | 模型迁移/验证/性能测试 | 间接（天数是可迁移目标） |
| flagrelease-entrance-flagos | FlagRelease 模型迁移自动化（Claude Code 驱动）入口 | 间接 |
| gpu-container-setup-flagos | GPU 容器环境 | 间接 |
| flaggems-pr-review/submit-flagos | FlagGems PR 自动化 | 间接 |
| skill-creator-flagos | 教 agent 创建新 skill | 通用 |

kernelgen-flagos 结构（多文件渐进披露范式，值得 forge 借鉴）：`SKILL.md`（总控/分派）+ `kernelgen-generate.md` / `-optimize.md` / `-specialize.md` / `-mcp-setup.md` / `-submit-feedback.md` + `kernelgen-generate-for-flaggems.md` / `-for-vllm.md` / `kernelgen-optimize-for-flaggems.md` / `-for-vllm.md`（按目标仓库细分）。

### 2.4 关联仓库（同组织 flagos-ai，52 仓库）

- **FlagGems**（★1110）：Triton 算子库，`src/flag_gems/runtime/backend/_iluvatar/` 有 **53 个天数专属算子文件**（mm/matmul_bf16/matmul_int8/linear/conv_depthwise2d/scatter_add/…），多数文件头标注 **"Generated by KernelGen"**——即这些天数算子本身就是 agent 工作流的产物。
- **FlagTree**（★346）：fork 自 triton-lang/triton 的多芯片统一编译器（18 后端），天数后端在内；TLE 语言随 FlagTree 发布。
- **KernelGen**（★77）：AI 驱动 Triton kernel 自动生成平台（skills 的内核本体，README 未单列天数但支持矩阵含天数）。
- KernelGenBench（★14，210 算子基准）、awesome-LLM-driven-kernel-generation（★308）。
- FlashAttention / FlagAttention（★308）、FlagCX（跨芯片通信库）、vllm-plugin、TransformerEngine-FL、Megatron-LM-FL、FlagScale。

---

## 3. 现成 Skills 仓库二：Deep-Spark/FlyDSL（天数官方，唯一带 agent 配置的官方仓库）

### 3.1 基本信息

| 项 | 内容 |
|---|---|
| 仓库 | https://github.com/Deep-Spark/FlyDSL （fork 自 ROCm/FlyDSL；默认分支 **`iluvatar`**；Gitee 镜像 gitee.com/deep-spark/FlyDSL） |
| 维护方 | **天数智芯官方（Deep-Spark 组织）**；创建 2026-03-20，2026-09-07 仍在推送 |
| License | Apache-2.0 |
| 定位 | FlyDSL（Flexible Layout Python DSL）+ FlyIXDL 方言：天数 GPU kernel 编写的新编译栈，`fly -> FlyIXDL -> IXDL LLVM IR -> fatbin` |

### 3.2 仓库内的 agent 配置（实测下载确认）

- **`.claude/skills/` 16 个 SKILL.md**（Claude Code 项目级 skills，git-tracked）：
  `flydsl-kernel-authoring`（布局代数/tiled copy/MMA/SharedAllocator/autotune 完整参考）、`flydsl-tile-programming`（分步向导：classify→skeleton→compute→control flow→test）、`debug-flydsl-kernel`（NaN/错误结果诊断）、`gemm-optimization`、`lds-optimization`、`prefetch-data-load`、`kernel-trace-analysis`（含 `scripts/hotspot_analyzer.py`、`pmc_l2_analyzer.py`）、`capture-kernel-trace`、`bisect-perf-regression`、`oob-detection`、`add-target-atom-op`、`api-stability`、`build-flydsl`、`build-rocm-image`、`format-code`、`kernel-code-cleanup`。
  **注意：这 16 个 skills 在上游 ROCm/FlyDSL 中即存在（逐一核对一致），内容以 AMD MI300X/MI350 为目标（gfx942/gfx950、MFMA、HSACO），grep 全部 .claude/ 无 iluvatar/ixdl 字样——即天数 fork 原样继承、未做天数特化改写。**
- **`.cursor/rules/` 8 条规则——上游无此目录，为天数 fork 新增**，其中 3 条 iluvatar 专属：
  - `iluvatar-sme-g2s-align.mdc`（alwaysApply）：**天数 SME G2S leading-stride 与 packed base 必须 32 对齐**，违反不报错而是静默数值污染（附正误代码对照）——高价值天数硬件约束知识；
  - `iluvatar-ci-gpu-pool.mdc`：天数 CI GPU 资源池约定；
  - `iluvatar-comment-style.mdc`：注释风格。
  另 5 条为 kernel 命名/profiler 名称/lane-id intrinsic 等通用规则。
- **`CLAUDE.md`**：FlyDSL 项目指南（Agent Operating Guidelines：Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution）+ 仓库布局索引；目录树注明 `.claude/skills/  # Project-local Claude Code skills ... git-tracked`。

### 3.3 天数算子素材（同仓库）

- `README_Iluvatar.md`：**FlyIXDL 后端完整文档**——MR/CQ 两代硬件的 SME async copy、CQ SMEX G2S/矩阵拷贝双契约、nbarrier/pipebar 流水同步、MRMma 16x16x16 f16 与 16x16x32 i8、生产级 HGEMM/IGEMM/GEMV/MoE grouped GEMM/flex-attention L3（含 bwd）、RMSNorm/LayerNorm/split-K/atomic CAS 等。
- `kernels/**/iluvatar/`：**63 个天数 kernel 源文件**（attention 20+：flash_attn_varlen/kvcache/paged_kv/decode_mma/flex_attention*/fused_rope；gemm/moe/conv 等）。
- `python/flydsl/expr/ixdl/`（mr.py/cq.py/sync.py/ops.py）、`compiler/backends/iluvatar.py`、`runtime/device_runtime/iluvatar.py`：天数后端实现。
- `tests/kernels/test_iluvatar_*`、`.github/workflows/*iluvatar*`（CI）。

---

## 4. 素材类资源汇总（非现成 skill、适合转化为 skill）

| 资源 | URL | 维护方 | 内容 / 转化建议 |
|---|---|---|---|
| 天数智芯知识库（SDK 安装实操手册 V1.0 等） | https://ixkb.iluvatar.com.cn:9443/ | 官方 | 免登录可读：软件栈安装（驱动/函数库/编译器/ixSMI/ixPROF/ixKN/ixSYS/ixGDB）、x86/C86/ARM 架构；检索页 JS 动态加载需逐篇抓取。→ 转「环境搭建 skill」 |
| 在线支持管理平台 | https://support.iluvatar.com/ | 官方 | 需登录；完整 SDK 文档、算子开发指南大概率在此（或经 services@iluvatar.com 申请） |
| IXUCA 软件栈介绍 | https://www.iluvatar.com/software?fullCode=cpjs-rj-rjz | 官方 | 天数智算软件栈总览：兼容 CUDA 编程模型、Clang 编译器重编译即迁移、自研算子库 + IXCCL 通信库 |
| FlagGems `_iluvatar` 后端 | https://github.com/flagos-ai/FlagGems/tree/master/src/flag_gems/runtime/backend/_iluvatar | 社区（智源/FlagOS） | 53 个天数 Triton 算子 + `op_black_list.yaml`（黑名单）+ `tune_configs.yaml`（调优配置）+ `fused/` 融合算子。→ 天数算子样例库，直接可喂 skill |
| iluvatar-corex-ixrt samples | https://github.com/Deep-Spark/iluvatar-corex-ixrt （`samples/plugins`、`samples/samplePyPlugin`） | 官方 | IxRT 自定义算子插件（C++/Python）样例。→ 推理引擎算子插件开发 skill |
| FlyDSL README_Iluvatar + kernels/iluvatar | 见 §3 | 官方 | 最深的天数 kernel 工程实践（MR/CQ 双硬件代差异、对齐陷阱）。→ 天数 kernel 开发 skill 的核心语料 |
| sanbuphy/iluvatar-quick-start | https://github.com/sanbuphy/iluvatar-quick-start | 社区（个人） | 天数 GPGPU 环境配置：驱动+CoreX/SDK+框架包版本强绑定组合、SDK 镜像需联系客服、COREX_HOME=/usr/local/corex |
| 天数服务器使用指南 | https://github.com/LearningInfiniTensor/.github/blob/main/server/iluvatar/doc.md | 社区（InfiniTensor） | 天垓100 实操：CUDA 编译差异、xmake 开发 CUDA C、与 NVIDIA CUDA 的差异点 |
| 飞桨天数 GPGPU 文档 | https://www.paddlepaddle.org.cn/documentation/docs/zh/hardware_support/iluvatar_gpu/index_cn.html | 百度 PaddlePaddle | Paddle-iluvatar 适配构建流程 |
| CSDN 信创系列：天数 GPU 芯片适配 | https://blog.csdn.net/weixin_49199313/article/details/163851730 等 | 社区（博客） | 算子适配分块策略、共享内存优化实战；另有 IXUCA 生态解读（zhangfeng1133 系列：自研算子库+IXCCL、天垓100/150、与海光 DTK 对比） |
| FlagTree / TLE 文档 | https://github.com/flagos-ai/FlagTree ；知乎「Triton-TLE 深度解读」 | 社区（FlagOS） | Triton→天数编译路径；TLE 三阶算子开发体系（Triton-TLE-TLE-Raw） |

---

## 5. 其他国产芯片 skills 线索（顺带记录）

- **华为昇腾**：gitcode.com/cann/cannbot-skills——目前国产芯片中唯一官方重型 skills 仓（Agent Skills 标准 + Claude 插件市场 + 多工具适配），详见本目录 `ascend-cann.md`。
- **FlagOS skills 天然多芯片**：同一套 skills 覆盖摩尔线程（`_mthreads`/`USE_MUSA=1`）、沐曦（`_metax`）、寒武纪（`_cambricon`）、海光（`_hygon`）、昆仑芯（`_kunlunxin`）、平头哥（`_thead`）等 17+ 后端目录（FlagGems `runtime/backend/` 实测 17 个 `_vendor` 目录）——做 forge 多芯片 skills 时可一次接入。
- **NVIDIA**：官方 Agent Skills 门户 https://docs.nvidia.com/skills （CUDA-X 库 skills，格式标杆）。
- **slowlyC/agent-gpu-skills**：https://github.com/slowlyC/agent-gpu-skills ——社区做的 GPU kernel 开发 skill 集合（CUDA/PTX 官方文档快照 + Triton/Gluon/CUTLASS/CuTeDSL/TileLang 本地源码检索），NVIDIA 向，结构可借鉴。
- **摩尔线程 / 壁仞 / 沐曦**：未发现官方 agent skills；壁仞（birentech）与沐曦（developer.metax-tech.com）做的是面向人的「AI 技能认证」培训体系，非 SKILL.md。
- **ros-claw/ty1200-platform**：天数 TY1200 具身智能盒子的运维 skill（skills/ty1200-platform-ops，平台检测/ixsmi 遥测/modeld）——非算子开发，排除，但证明天数硬件上已有社区在做 agent skill 化运维。

---

## 6. 对 forge 的建议：转化路径

1. **直接引入 flagos-ai/skills 作为基底**（Apache-2.0）：`kernelgen-flagos` + `tle-developer-flagos` 是现成的多芯片（含天数）算子生成/优化 skill；可用 `/plugin marketplace add flagos-ai/skills` 实测，再把其中 iluvatar 分支知识（vendor-mappings、kernelgen-generate-for-flaggems 的 `_iluvatar` 规范、vllm-plugin 的 iluvatar_gpu.md）抽出来做成 forge 的 `iluvatar-operator-dev` skill。
2. **从 Deep-Spark/FlyDSL 提取天数特化知识**（Apache-2.0）：`.cursor/rules/iluvatar-*.mdc`（SME 对齐等硬约束）+ `README_Iluvatar.md`（MR/CQ 差异、指令语义）+ `kernels/**/iluvatar/`（63 个真实 kernel）是官方仓库中最纯的天数算子开发语料，适合蒸馏为「天数 kernel 开发规范 skill」；其 16 个上游 AMD skills（kernel authoring/tile programming/gemm optimization）可作为 skill 编写范式参考。
3. **FlagGems `_iluvatar` 53 算子 + tune_configs.yaml** 做成检索型参考资料（样例库 + 调优参数表）挂进 skill。
4. 缺口需自建：天数 IXUCA C++/CUDA 兼容层 API 差异（官方文档需登录 support.iluvatar.com 或联系 services@iluvatar.com 获取 SDK），目前公开面只有知识库安装手册与社区博客，可先用 CSDN/InfiniTensor/quick-start 三方资料拼一版「CUDA→天数迁移差异」参考。

---

## 7. 搜索过程记录（关键词 × 渠道）

GitHub/Gitee/GitCode + Web（中英文）共 17+ 组：天数智芯 算子开发 github；天数智芯 skill SKILL.md claude 大模型 算子；Iluvatar Corex operator development SDK github；IluvatarCorex github organization repositories；gitee 天数智芯 DeepSpark 算子 iluvatar；FlagGems iluvatar backend triton；天数智芯 开发者文档 IXUCA SDK 文档站；gitcode.com 天数智芯；"天数智芯" 算子开发 实战 CSDN CUDA 迁移；flagos-ai Kernel Engineering；TLE Triton Language Extension 天数；摩尔线程 寒武纪 壁仞 claude skills；千芯 算子 / 天数智芯 MCP server；GitHub API 仓库搜索（iluvatar+skill、天数智芯、ixpu、topic:iluvatar、org:flagos-ai）；Deep-Spark / deep-spark 组织逐仓盘点；doc.iluvatar.com（DNS 不存在）、ixkb.iluvatar.com.cn:9443（可读）、support.iluvatar.com（需登录）、gitcode.com 搜索（无结果）。实测 tarball 下载：flagos-ai/skills、Deep-Spark/FlyDSL、Deep-Spark/iluvatar-corex-ixrt（限流改用 Gitee API 盘点）。
