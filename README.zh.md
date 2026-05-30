# 🔥 Forge

**一个轻量、可观测的编程 Agent 框架（harness）—— 并用一次严格的同条件横评，证明它在相同模型上能跑赢业界成熟框架。**

<sub>🌏 [English README →](./README.md)</sub>

> 在 **SWE-bench Verified** 的 50 题随机子集上、模型固定为 **DeepSeek V4 Pro**，Forge 成功修复 **39 / 50（78%）**—— 高于 SWE-bench 官方基线 `mini-swe-agent`（74%），也高于 Claude Code 与另一主流框架（均 70%）。

![harness](https://img.shields.io/badge/type-coding%20agent%20harness-orange) ![lang](https://img.shields.io/badge/TypeScript-5.9-blue) ![bench](https://img.shields.io/badge/SWE--bench%20Verified%20(n%3D50)-78%25-success) ![license](https://img.shields.io/badge/license-MIT-green)

---

## 为什么做 Forge？

一个编程 Agent 的成败，取决于**框架（harness，即模型外层的调度）**的程度，不亚于模型本身。Forge 是从零自研的框架，用来验证一个假设：

> **显式的纪律，胜过对模型的隐式信任。**

多数框架默认"指望"模型自觉：改动最小、自己验收、不乱动无关文件。这在它调优的那个模型上很好用——换个模型就悄悄退化。Forge 反其道而行，把纪律做成**一等公民的机制**：自主验收闭环、写边界守卫、"先理解再动手 / 最小化 diff / 收尾自审"的硬契约。

换模型的一刻，差距就显现：顶尖框架在它的目标模型上顶尖，换到第三方模型未必领先。Forge 这套**显式、不依赖特定模型脾气**的纪律，正是它能在所有对比框架都没调优过的 DeepSeek V4 Pro 上夺冠的原因。

---

## 📊 跑分

**SWE-bench Verified** 是业界修复真实 GitHub issue 的权威基准：给 Agent 一个仓库 + 一个 issue，要求产出补丁，只有该仓库自带的 `FAIL_TO_PASS` + `PASS_TO_PASS` 测试集在官方评分器下全部通过，才算 *resolved（解决）*。

四个框架：**同样 50 题、同一模型（`deepseek-v4-pro`）、同一官方 `run_evaluation` 评分器**。

| 框架 | 批1 | 批2 | 批3–5 | **解决 / 50** | **解决率** | 空补丁 |
|---|---|---|---|---|---|---|
| **🔥 Forge（本仓库）** | 7/10 | 7/10 | 25/30 | **39 / 50** | **78%** | **0** |
| `mini-swe-agent`（官方基线） | 6/10 | 8/10 | 23/30 | 37 / 50 | 74% | 0 |
| `hermes-agent` | 6/10 | 6/10 | 23/30 | 35 / 50 | 70% | 5 |
| Claude Code | 6/10 | 6/10 | 23/30 | 35 / 50 | 70% | 3 |

**排名：Forge 39 > mini 37 > hermes = Claude Code 35。**

几点值得说：

- **可信度 sanity check**：DeepSeek V4 Pro 在*全* 500 题上的官方自报成绩是 **80.6%**，Forge 在这 50 题子集上 **78%** 与之高度吻合——有力佐证整条流水线（镜像 / 适配器 / 评分）无系统性偏差，且 Forge 几乎榨出了模型的全部编程能力。
- **Forge 每题都产出了补丁（空补丁 0）**：收尾自审让 diff 更小，但没有误伤产出；其他框架偶有"引导不出可用 diff"的空补丁。
- **"顶尖框架是模型相关的"**：Claude Code 是优秀框架，但接到*非目标*模型（DeepSeek）只有 70%，并不自动领先；Forge 的显式纪律迁移性更好。

### 诚实的口径保留（让数字站得住）

- **n = 50 随机子集**，非全 500 题 → 绝对值有约 ±6% 噪声。请理解为"SWE-bench Verified 的 50 题子集"，而非全集。
- **pass@1 单次采样**（与官方榜单同口径）。单批波动真实存在，只有 50 题累计才有意义。
- **Claude Code 经 Anthropic 兼容翻译代理接 DeepSeek**（非标准 setup），其数字可能略有低估。
- 评分为**确定性的官方 `run_evaluation`**、基于固定预测补丁，重跑判定一致（已验证幂等）。

---

## 🧭 设计理念

1. **显式纪律 > 隐式克制**：先定位根因再动手；优先最小 diff；除非 bug 就在那里，否则不碰 build/依赖配置；收尾前对 `git diff` 做一次自审。这些是**强制执行**的，不是"指望"。
2. **默认可观测**：每一轮（思考 / 工具调用 / 参数 / 输出）都被飞行记录仪记录、可回放。"Agent 到底做了什么、为什么"永远答得出来。
3. **构造即安全**：写边界守卫在 shell 命令执行前静态检查；权限层管控有副作用的工具。
4. **自带模型即可**：provider 无关（DeepSeek / Anthropic / OpenAI），纪律不假设任何单一模型的脾气。

---

## ✨ 独特功能

| 功能 | 作用 |
|---|---|
| **自主验收闭环**（`/converge`） | 改完后，Agent 自动重新推导验收标准、检查是否*真的*解决了任务——而不是在第一个看起来合理的改动上就宣布完成。 |
| **写边界守卫** | 静态解析 shell 命令、拦截逃逸出工作目录的写操作；并用"flash 语义裁决"避免误伤只读命令（如代码里含 `>` 比较符、`cd` 进子目录）。 |
| **飞行记录仪** | 全轮次结构化审计日志（思考 + 工具调用 + 参数 + 结果），可回放、可调试。 |
| **自研上下文压缩** | 针对推理模型调优的长对话摘要，独立于底座运行时的启发式（见"踩坑实录"——把它做*对*比看上去难）。 |
| **代码智能** | LSP 集成（pyright / TS）、仓库地图、符号大纲、内容检索——让 Agent 按结构导航，而非盲目 grep。 |
| **子 Agent** | 派发带独立上下文预算的受限子 Agent，做扇出式检索 / 调研。 |
| **内置 SSH 工具** | 一等公民的远程执行工具（密码 / 密钥认证），供需要操作远端主机的 Agent 使用。 |
| **终端体验** | 忙时插话引导、语法高亮 diff、多行输入。 |

---

## 🛠️ 踩坑实录 —— 遇到的问题与解决

真实的调试过程，不是功能宣传册。这些是真正费时间的坑。

### 1. 永不触发的压缩（两个叠加 bug）
一次长程压测里，上下文窗口一路涨到爆限，而自研压缩**从没触发**。两个独立根因：
- **锚定了陈旧用量**：压缩触发读的是上一轮缓存的 token 用量，于是永远"看不到"上下文越线。修法：触发改用*实时真实*用量。
- **token 估算漏算**：估"这条消息多大"的函数忽略了模型的 `thinking` 块和工具调用参数——而推理模型上这二者才是大头。估值长期偏小，多段摘要器从没被调起。修法：把 thinking + 工具参数计入估算。

教训：触发器的好坏取决于它读的信号。两个 bug 都是静默的——没报错，功能就是*没跑*。

### 2. 过度编辑 → 显式纪律（赢下跑分的那一改）
在自由度高的框架里，强模型（DeepSeek 也在内）倾向**没理清就动手**：整文件重写、"顺手修"无关的 build 配置、产出大补丁却 apply 失败或撞挂原本通过的测试。Forge 的解法不是"求模型乖一点"的更花哨提示词，而是**强制纪律**：
- 系统契约：*先找根因；diff 尽量小；除非 bug 在那里否则别碰 `pyproject.toml`/`setup.py`/`package.json`；能用定点编辑就不要整文件重写*；
- **收尾自审**：跑 `git diff`（连 shell 改的也抓得到，不只是编辑工具）、还原一切无关改动。

这正是"显式优于隐式"的论点落地，也是为什么四个框架里只有 Forge 在每一题都产出了干净、最小、能 apply 的补丁。

### 3. 只有推理、正文为空的轮次
DeepSeek 的推理模型偶尔返回一轮：`thinking` 很丰富，但**可见正文为空**。天真处理会以为"Agent 啥也没说"。Forge 检测并处理这种 reasoning-only 情况，而不是卡死。

### 4. 在抖动网络的沙箱里做评测
在网络受限的机器上搭评测，暴露出三个长得很像、其实各自独立的"挂起"：Hugging Face 一个元数据请求*连得上却不返回*（→ 强制离线，数据集本地已缓存）；评分器深处一个**无超时**的 `requests.get` 在取各仓库的测试依赖（→ 打补丁加超时 + 重试）；以及被 kill 的评测残留的同名容器冲突（→ 每轮前清理）。最大的教训、也是最终数字可信的原因：**永远别信中间汇总，每个分数都从每题的 `report.json` ground truth 重新聚合**。（有个框架一度看着像"13/30"，其实是 16 题报错的脏数；逐题核验后真实成绩是 23/30。）

---

## 🏗️ 架构

```
src/
├── kernel/         # 大脑
│   ├── forge-agent.ts      # 主循环、系统契约、收尾自审
│   ├── compaction.ts       # 自研上下文压缩
│   ├── converge.ts         # 自主验收（/converge）
│   ├── write-guard.ts      # shell 写边界守卫
│   ├── flight-recorder.ts  # 全轮次审计 / 回放
│   ├── code-outline.ts · lsp-client.ts · subagent-registry.ts
│   ├── memory.ts · permission.ts · telemetry.ts · pricing.ts · ...
├── tools/          # Agent 能做的事
│   ├── bash.ts · fs-tools.ts · apply-patch.ts · ssh.ts
│   ├── search-tools.ts · repo-map.ts · outline.ts · lsp-tools.ts
│   ├── subagent.ts · diagnostics.ts · converge-tool.ts · memory-tool.ts
├── ui/             # 终端 UI（ink/React）
│   ├── render.ts · diff.ts · highlight.ts · markdown.ts
│   ├── run-queue.ts · text-editor.ts · keybinds.ts · theme.ts · ...
└── sandbox/        # 命令执行沙箱
```

构建于 [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) Agent 运行时之上；Forge 是其上的**框架层**——纪律、工具、可观测性与 TUI。

---

## 🚀 快速开始

```bash
# 1. 安装
npm install

# 2. 配置
cp forge.config.example.json forge.config.json   # 模型清单（无密钥）
cp .env.example .env                              # 在这里填 API key
#   → 设置 DEEPSEEK_API_KEY=...（或 ANTHROPIC_/OPENAI_）

# 3. 启动 TUI
npm run forge

# 开发检查
npm run typecheck
npm test
```

Forge 设计为 LIVE-only：选定模型的 provider key 缺失会直接报错退出，而不是静默 mock。

---

## 🙏 致谢

Forge 构建于 [`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) Agent 运行时之上。评测使用 [SWE-bench Verified](https://www.swebench.com/) 及其官方评分器，并与 [`mini-swe-agent`](https://github.com/SWE-agent/mini-swe-agent) 等开源框架对比。

## 📄 许可证

[MIT](./LICENSE)
