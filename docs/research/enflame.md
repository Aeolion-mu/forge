# 燧原科技（Enflame）算子开发 Skills 调研报告

> 调研日期：2026-09-08
> 调研目标：确认燧原（云燧/DTU 系列加速卡，软件栈 TopsRider 驭算 / torch-gcu / Triton-GCU）是否存在官方或社区的 Claude Code（SKILL.md）/ Codex 格式算子开发技能包；若无，给出最佳替代素材与转化路径。
> 调研渠道：github.com（org API 全量盘点 + tarball 实测克隆内容）、gitee.com（官方组织页 + web 抓取）、gitcode.com（搜索）、ModelScope Skills 中心、docs.flagos.io / flagos-wiki、模力方舟（moark/Gitee AI）文档站、中英文关键词 15+ 组。

---

## 一、总结论

1. **燧原官方不存在任何 Claude Code / Codex 格式的算子开发 skills**。官方组织 `EnflameTechnology`（GitHub 31 仓库 / Gitee 24 仓库，两处为镜像）全部是软件栈、推理框架、编解码插件、监控工具类仓库，**没有任何带 agent / skill / LLM / prompt 字样的仓库，也没有任何仓库内嵌 SKILL.md / AGENTS.md / .claude 目录**（对比：沐曦有 `TileOPs-Metax` 内嵌 14 个 SKILL.md，华为昇腾有 `Ascend/agent-skills`，燧原无对应物）。
2. **存在一条间接的、燧原官方参与的 skills 路径**：燧原是智源（BAAI）FlagOS 生态成员，官方仓库 `EnflameTechnology/FlagOS` 明确列出燧原在 FlagOS 各组件中的接入点（FlagTree Triton 编译后端、FlagGems `_enflame` 算子后端、FlagCX 通信适配、FlagScale 训练平台）。而 **`flagos-ai/skills` 是标准 Agent Skills 仓库（Claude Code 插件市场 + Codex `agents/AGENTS.md` + Cursor + Gemini CLI 四种形态）**，其中的 `kernelgen-flagos` 是算子生成/优化/平台特化 skill——但注意：其 `specialize_kernel` MCP 目前只内置华为昇腾 target，燧原 GCU 只出现在 FlagCX 安装映射（`USE_ENFLAME=1`）里，**没有燧原专属的 skill 文件**。
3. **官方文档站（TopsRider 手册、topscc 编程指南、Topsop 算子库文档）不公开**，需联系燧原获取 TopsRider installer；`developer.enflame.com` 无法访问。但 GitHub 上 `torch-gcu` 仓库的 `manuals/`（Sphinx RST）公开了相当完整的算子开发文档（自定义算子指南、算子支持列表、CUDA→GCU 迁移对照、算子调试、profiler），是自建 skill 的**首选原料**。
4. 最佳替代素材（按价值排序）：
   `torch-gcu/manuals/`（自定义算子 + 迁移对照 + 算子清单）→ `FlagGems _enflame` 后端（412 个 GCU Triton 算子源码，gcu300/gcu400 分代）→ `hlir_builder_sample`（43 个 C++ TopsGraph 算子示例 + TopsGraph API HTML 手册）→ `FlagTree third_party/enflame`（Triton-GCU 编译后端 + S60 Docker 环境）→ `findtops`（CMake TOPS 语言一等支持）→ 模力方舟 S60 运维文档（精度限制/版本管理/efsmi）。

---

## 二、现成 / 半现成 Skills 资产

### 2.1 flagos-ai/skills —— 智源 FlagOS 官方多芯片 Skills 库（半现成，燧原为受支持 vendor 之一）★唯一发现

| 项 | 内容 |
|---|---|
| URL | https://github.com/flagos-ai/skills （ModelScope 合集：https://modelscope.cn/collections/FlagRelease/FlagOS-Skills） |
| 维护方 | 智源 BAAI「众智 FlagOS」社区（FlagOS Contributors），非燧原官方，但燧原官方仓库直接引用 FlagOS 生态 |
| 格式 | **Claude Code 插件市场**（`.claude-plugin/marketplace.json` + `.cursor-plugin/` + `gemini-extension.json` + **Codex 用 `agents/AGENTS.md`**，即同时覆盖 Claude Code 与 Codex 两种格式）；每个 skill = SKILL.md（YAML frontmatter，含 allowed-tools/argument-hint）+ references/ + scripts/ |
| License | Apache-2.0；版本 1.1.0；CI 活跃（update-skills-catalog、validate_skills 等工作流） |
| 安装 | `npx` 一键装（推荐），另有 Claude Code / Cursor / Codex / Gemini CLI 分节说明 |

12 个已落地 skill（2026-09 快照）：`flagrelease-entrance-flagos`、`gpu-container-setup-flagos`、`install-stack-flagos`、`kernelgen-flagos`、`model-migrate-flagos`、`model-verify-flagos`、`perf-test-flagos`、`skill-creator-flagos`、`tle-developer-flagos`、`vllm-plugin-fl-setup-flagos`、`flaggems-pr-review-flagos`、`flaggems-pr-submit-flagos`。

与算子开发直接相关：
- **`kernelgen-flagos`**（核心）：统一算子生成/优化入口，自动识别目标仓库（FlagGems / vLLM / 通用 Triton），子技能含 generate / optimize（MCP 迭代优化到目标加速比）/ specialize（GPU→昇腾 NPU 平台特化）/ mcp-setup / submit-feedback。依赖 KernelGen MCP 服务（https://kernelgen.flagos.io/ ，KernelGen 2.1.0 支持 7 款芯片）。
- **`tle-developer-flagos`**：TLE（Triton Language Extension，`triton.experimental.tle`）内核开发编排 skill——注意 FlagGems 的燧原 VendorDescriptor 里 **`tle_enabled=True`**，即燧原 GCU 是 TLE 启用后端，此 skill 对燧原也适用。
- **`flaggems-pr-review/submit-flagos`**：FlagGems 算子 PR 评审/提交（benchmark 模式、PR 模板测试平台含 Nvidia/Tianshu/Muxi/Ascend/Hygon）。
- 规划中（README 标注 *规划中*，恰是燧原可搭车的方向）：「FlagGems 芯片后端」skill（生成 `_vendor/` 脚手架：`__init__.py` VendorInfoBase + heuristics + tune_configs + ops/）、「复杂算子开发」（fused attention / fused MoE 骨架）、「算子诊断」。

**燧原在其中的现状（实测 grep 全仓库）**：`enflame/GCU` 仅出现于 `skills/install-stack-flagos/references/vendor-mappings.md`（FlagCX 通信库构建 flag `USE_ENFLAME=1`、adaptor `enflame`）；`kernelgen-specialize.md` 的 `target_platform` 目前只写了 `"huawei"`。**即：多芯片框架已把燧原列为一级 vendor，但算子特化 skill 尚无 enflame target，需要自建或等上游补**。

### 2.2 燧原官方组织盘点（确认无 skills）

GitHub `EnflameTechnology`（https://github.com/EnflameTechnology，32 repos 含 1 test）全量清单（名称/star/语言/最近 push/license）：

| 仓库 | 内容 | 活跃度 | License |
|---|---|---|---|
| **torch-gcu** | PyTorch PrivateUse1 后端扩展（算子覆盖、transfer_to_gcu 一键迁移、AMP、profiler、算子调试、**manuals/ 完整 RST 手册含自定义算子指南**） | 2026-06 仍推送 | BSD 风格（源自 PyTorch，© 燧原科技） |
| **vllm-gcu** | vLLM 适配 S60（需 TopsRider i3x 3.6+），38 star | 2026-07 | Apache-2.0 |
| **hlir_builder_sample** | **43 个 C++ TopsGraph(HLIR) 算子示例** + `doc/TopsGraph API参考+用户手册`（HTML） | 2023-03 后未更 | Apache-2.0 |
| **findtops** | CMake FindTOPS 模块：把 `.tops`/topscc 注册为 CMake 一等语言 | 2026-07 | 无 SPDX（自定义） |
| **tops_inference_sample** | TopsInference 2.0 C++/Python 推理样例 | 2026-01 | Apache-2.0 |
| **ModelZoo** / paddlepaddle_model_zoo | 模型集合（CV/NLP/推荐，训练+推理示例） | 2025-01 / 2022-11 | Apache-2.0 |
| **FFmpeg-GCU** + tops-codec-headers | topscodec 视频编解码 FFmpeg 插件 | 2026-07 / 2025-11 | GPL-2.0 / Apache-2.0 |
| **candle / candle-vllm / candle-gcu / candle-vllm-gcu** | Rust Candle 推理栈 GCU 适配 | 2026-07~08 | Apache-2.0/MIT |
| **flash-attention / DeepGEMM** | 2026-08 新 fork（算子/kernel 移植进行中，值得跟踪） | 2026-08 | BSD-3 / MIT |
| **gcu-exporter / gcushare / Ubridge / UHHI / nvtop / FlagOS / nixl / ucx / DeepSpeed / eigen / ccache / sccache / sast / CICD / ci-demo / test / test2** | 监控、通信、CI、三方 fork、FlagOS 燧原支持分支 | — | 混合 |

Gitee `EnflameTechnology`（https://gitee.com/EnflameTechnology，24 仓库）为同一组织的镜像+精选（vllm-gcu / ModelZoo / FFmpeg-GCU / candle-vllm-gcu），2026-03 入驻（[知乎公告](https://zhuanlan.zhihu.com/p/2017962132357018306)）；其软件栈分层图明确：工具链层 **Triton-GCU、TileLang-GCU、TopsGDB、TopsProf、Visual Profiler**，库层 **Topsop 算子库、GCU 加速库、KV Cache 库、通信库**——除已开源 4 仓外其余标绿「后续开源」，**目前均未开源、无 skill 形态**。GitCode 上无燧原官方组织，仅 `flagos-ai/flagtree`（含 enflame 后端）与 FastDeploy 镜像、MinerU GCU 部署博客等间接内容。

---

## 三、FlagOS 生态中的燧原算子接入点（燧原官方指定）

`EnflameTechnology/FlagOS` 仓库 README（仅 4 行外链，即燧原的 FlagOS 支持分支索引）：

| 组件 | 燧原代码位置 | 说明 |
|---|---|---|
| **FlagTree** | `flagos-ai/FlagTree` 分支 `triton_v3.3.x` 的 `third_party/enflame/`（backend/ language/ python/ include/ cmake/ triton_gcu/ triton_enflame.cc + README/README_cn） | **Triton 编译器 GCU 后端**。README 提供 S60 + Docker 全流程（预构建镜像 `enflame/flagtree:0.3.1`、驱动 `enflame-x86_64-gcc-1.6.3.12` run 包）。GitCode 镜像：https://gitcode.com/flagos-ai/flagtree |
| **FlagGems** | `flagos-ai/FlagGems` 的 `src/flag_gems/runtime/backend/_enflame/` | **Triton 算子库燧原后端：共 412 个文件**，按代际分 `gcu300/`、`gcu400/`（ops/ 每代 ~180 个单算子 + fused/ 融合算子：flash_mla、sparse_mla、fused_add_rms_norm、rotary_embedding、silu_and_mul、moe_align_block_size、gelu_and_mul、skip_layernorm、cross_entropy_loss 等），另有 `core_shapes.yaml`。`__init__.py` 定义 `VendorDescriptor(vendor_name="enflame", device_name="gcu", dispatch_key="PrivateUse1", fp64_enabled=False, int64_enabled=False, tle_enabled=True)`，驱动优先 `triton.backends.enflame` 回退 `triton_gcu`，`ARCH_MAP={"3":"gcu300","4":"gcu400"}`，并维护 gcu300 的 int64 受限黑名单（addmm/bmm/pad/concat 等）——**这些约束正是 skill 需要承载的领域知识** |
| **FlagCX** | `flagcx/adaptor/ccl/eccl_adaptor.cc` | ECCL 通信适配（`FLAGCX_ADAPTOR=enflame`） |
| **FlagScale** | `Megatron-LM-FL` 的 `megatron/plugin/platform/platform_enflame.py` | 异构训练平台层 |
| **Torch-FL** | `flagos-ai/Torch-FL` 的 `docs/vendors/gcu/installation.md` | GCU 走 `libtopsaten.so` 原生算子（非 CUDA boxing），`ACCELERATOR=gcu` 构建、`scripts/codegen_gcu.py` 按 `nm -DC libtopsaten.so` 的 `topsatenXxx` 符号做算子覆盖校验 |

---

## 四、素材类资源（自建 skill 的原料，全部公开可抓取）

### 4.1 torch-gcu `manuals/`（RST，已实测抓取）★首选

| 文件 | 行数 | 内容 |
|---|---|---|
| `manuals/user_guide/content/source/torch_gcu_custom_op.rst` | — | **自定义算子开发全流程**：topscc 编写 kernel→`/opt/tops/bin/topscc -shared -fPIC ... -ltops -ltopsrt` 编译 so→`TORCH_LIBRARY` 定义 + `TORCH_LIBRARY_IMPL(..., PrivateUse1, ...)` 注册→python custom op→setup.py CppExtension→测试。这是公开渠道唯一的燧原自定义算子 step-by-step |
| `manuals/oplist_torch_gcu/content/source/torch_gcu_op.rst` | 989 | **算子支持列表**（v3.7.1）：逐算子标注「支持 / 不支持 / 限 empty Tensor、dim=None 等条件」 |
| `manuals/user_guide/content/source/transfer_to_gcu.rst` | 368 | **CUDA→GCU 一键迁移**：`from torch_gcu import transfer_to_gcu` 后 `.cuda()` 自动映射；torch.* 接口转换对照表 |
| `manuals/user_guide/content/source/torch_gcu_op_debug.rst` | — | 算子级调试（同步模式、CPU 回退、算子统计、I/O dump；`ENFLAME_LOG_DEBUG_LEVEL/MOD`） |
| `manuals/user_guide/content/source/torch_gcu_profiler.rst`、index.rst 其余章节 | — | profiler、AMP、分布式、GCU Graph、stream、libtorch_gcu；配套关系表（TopsRider 版本×torch_gcu×PyTorch） |

### 4.2 hlir_builder_sample（C++ TopsGraph 算子示例 + API 手册）

- URL：https://github.com/EnflameTechnology/hlir_builder_sample（已克隆 /tmp 实测）
- 43 个 op 示例（Add/Mul/Conv2D/Gemm/Softmax/TopK/Resize/MaxPool/BatchNorm/ResidualBlock 等，含 fp16 变体），`cmake .. -DOPType=Add` 单算子构建；`common/dtu_utils.*` 设备初始化；`doc/TopsGraph API参考+用户手册/`（doxygen 风格 HTML，**公开的编译器图 API 手册**）。README 标注 i20 2.0 production SDK 验证 38/43 通过。适合转成「C++ TopsGraph 算子开发」skill 的示例库与 API 摘要。

### 4.3 findtops（topscc/CMake 工程化）

- URL：https://github.com/EnflameTechnology/findtops
- 「FindTOPS 之于 topscc 相当于 FindCUDA 之于 nvcc」：`.tops` 源文件成为 CMake 一等语言（`enable_language(TOPS)`、`CMAKE_TOPS_STANDARD` 11/14/17、工具链自动发现 `/opt/tops/bin`）。skill 中「如何编译燧原算子工程」一节的权威参考。

### 4.4 tops_inference_sample / ModelZoo / vllm-gcu / flash-attention / DeepGEMM

- tops_inference_sample：TopsInference 2.0 C++/Python 推理样例（ONNX→engine）。
- ModelZoo：各领域模型训练/推理示例，验证 GCU 兼容性与性能基线。
- vllm-gcu：大模型推理系统（含 TopsCompressor 量化），适合「模型迁移」类 skill。
- flash-attention、DeepGEMM fork（2026-08 新建）：燧原正在移植高性能 kernel，后续可能成为 GCU kernel 写法范例。

### 4.5 模力方舟（moark / Gitee AI）燧原 S60 运维文档

- URL：https://moark.com/docs/compute/clusters_gpu/ef_gpu （同内容 https://ai.gitee.com/docs/compute/clusters_gpu/ef_gpu ）
- 社区（模力方舟，Gitee 生态）维护，内容极实用：**S60 不支持 FP8**（强载报错）、FP16/BF16/INT8/FP32 支持；`topsinfo` 查版本；不兼容原生 CUDA、`transfer_to_gcu` 用法；`pip list | grep gcu` 识别 `+gcu` 适配版（torch-gcu / triton-gcu / vllm_gcu / flash-attn+gcu / onnxruntime-gcu / xformers+gcu）、严禁 `pip install --upgrade` 覆盖；S60 已适配模型清单（DeepSeek/Qwen3 全系/GLM-4/FLUX 重点优化/Whisper/Wan2.1 等）；`efsmi` 命令速查（-dmon/-pmon/-q/-ptopo）。另有「国产芯片 AI 技能认证」课程体系（燧原参与签章，属课程非 skill）。

### 4.6 其他生态文档

- 飞桨 GCU 文档：安装（https://www.paddlepaddle.org.cn/documentation/docs/zh/3.1/hardware_support/gcu/install_cn.html ）、PaddleX 教程、GCU 验证模型列表。
- KernelGen 文档：https://docs.flagos.io/projects/kernelgen/ （release notes：V2.1.0 支持芯片 6→7，新增 Sunrise；TLE 实验特性）。
- FlagGems 文档/Wiki：https://docs.flagos.io/projects/FlagGems/ 、https://flagos-wiki.baai.ac.cn/flagos-ai/FlagGems （目标平台含 Enflame GCU）。
- 腾讯开悟 AI 公开赛（2024）GCU 算子开发赛道：基于 TopsCC 在 GCU 多核/多级存储架构下开发算子（说明 topscc 编程手册存在于比赛渠道，未公开索引）。

### 4.7 不可得（记录在案）

- **TopsRider 安装手册 / topscc 编程指南 / Topsop 算子库文档 / TileLang-GCU**：均随 TopsRider installer 分发或需联系燧原（opensource@enflame-tech.com / info@enflame-tech.com），公网检索不到；`developer.enflame.com` 连接失败。燧原文档中心与软件栈白皮书仅从官网/模力方舟入口跳转，直链未公开索引。

---

## 五、建议转化路径（供 forge 制作燧原算子 skill）

1. **直接复用**：引入 `flagos-ai/skills` 的 `kernelgen-flagos`（Claude Code 插件或 Codex AGENTS.md 形态）作为通用 Triton 算子生成底座——燧原 GCU 经 FlagTree/FlagGems 已可跑 Triton，生成通用 Triton kernel 后在 GCU 上验证。
2. **自建 enflame 专属 skill**（推荐命名 `gcu-operator-dev` 之类），内容来源拼装：
   - 自定义算子流程 → `torch-gcu/manuals/.../torch_gcu_custom_op.rst`（topscc 编译命令、TORCH_LIBRARY/PrivateUse1 注册模板、setup.py 配置）；
   - 算子支持边界 → `torch_gcu_op.rst`（989 行支持/限制清单）+ FlagGems `_enflame/__init__.py` 的 gcu300 int64 黑名单、`fp64_enabled=False`；
   - CUDA 迁移 → `transfer_to_gcu.rst`（接口对照表 + `.cuda()` 自动映射 + nccl→eccl）；
   - Triton 范式 → FlagGems `_enflame/gcu400/ops|fused` 412 个现成 GCU kernel（pointwise_dynamic 装饰器模式）；
   - C++ 图算子 → `hlir_builder_sample`（43 例 + TopsGraph API HTML）；
   - 构建工程 → `findtops`（CMake TOPS 语言）；
   - 环境与避坑 → 模力方舟 S60 页（FP8 禁用、+gcu 版本纪律、efsmi/topsinfo、ENFLAME_LOG 调试变量）。
3. **上游共建**：给 `flagos-ai/skills` 提 `kernelgen-specialize` 的 enflame target 或「FlagGems 芯片后端」规划中 skill 的燧原实例（上游 README 已把该项列为 planned，接受社区贡献，Apache-2.0）。

---

## 六、搜索中遇到的其他国产芯片算子 skills 线索（供并行调研参考）

- **智源 FlagOS**（总入口）：`flagos-ai/skills`（多厂商 Claude Code/Codex skills）、`flagos-ai/FlagGems`（Triton 算子库，后端含 enflame/mthreads/metax/iluvatar/sunrise 等）、`flagos-ai/FlagTree`（Triton 多芯片统一编译器）、KernelGen MCP（7 芯片）。
- **昇腾**：`gitee.com/ascend/cann-ops`（CANN 算子仓库，已停止维护）；`triton-lang/triton-ascend` docs/zh 有完整《Triton 算子开发指南》（分核/片上内存/访存/Tiling 专题）+ GPU 迁移指南，质量高；Ascend C 官方算子开发文档齐全。
- **沐曦 MetaX**：`MetaX-MACA/TileOPs-Metax`（官方 fork，内嵌 14 个 Claude Code SKILL.md）；TileLang-MUSA 已并入 tilelang 主线（详见本目录 metax.md）。
- **TileLang 生态**：`tile-ai/TileOPs`（"Built for agents" 的 LLM 算子库）、`tile-ai/tilelang-ascend`、DeepSeek `TileKernels`；燧原 TileLang-GCU 未开源、无公开 fork。
- **天数智芯 / 寒武纪 / 摩尔线程 / 海光**：均以 FlagGems/FlagOS 后端形式出现；寒武纪 NeuWare 支持 Triton 算子开发（developer.cambricon.com）。

---

## 七、来源汇总

官方：https://github.com/EnflameTechnology （org API 全量）｜https://gitee.com/EnflameTechnology ｜https://www.enflame-tech.com
重点仓库：https://github.com/EnflameTechnology/torch-gcu （manuals RST 实测抓取）｜hlir_builder_sample｜findtops｜tops_inference_sample｜FlagOS（索引仓库）
FlagOS 生态：https://github.com/flagos-ai/skills （tarball 实测）｜https://github.com/flagos-ai/FlagGems （`_enflame` 412 文件实测列举）｜https://github.com/flagos-ai/FlagTree/tree/triton_v3.3.x/third_party/enflame ｜https://github.com/flagos-ai/Torch-FL/blob/main/docs/vendors/gcu/installation.md ｜https://docs.flagos.io/projects/kernelgen/ ｜https://flagos-wiki.baai.ac.cn/flagos-ai/FlagGems ｜https://modelscope.cn/collections/FlagRelease/FlagOS-Skills
社区/文档：https://moark.com/docs/compute/clusters_gpu/ef_gpu ｜https://ai.gitee.com/docs/compute/clusters_gpu/ef_gpu ｜https://zhuanlan.zhihu.com/p/2017962132357018306 （燧原入驻 Gitee）｜https://zhuanlan.zhihu.com/p/2022976367738758188 （FlagOS Skills 发布）｜https://digital.gmw.cn/2026-03/30/content_38680080.htm （FlagOS 2.0：32 芯片 497 算子）｜https://www.paddlepaddle.org.cn/documentation/docs/zh/3.1/hardware_support/gcu/install_cn.html ｜https://gitcode.com/flagos-ai/flagtree/blob/main/third_party/enflame/README_cn.md ｜https://blog.gitcode.com/2dce09b1d50e0f23fac36a7ee7a8a3c4.html （MinerU GCU 部署）
