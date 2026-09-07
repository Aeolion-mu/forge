# Forge — 基于 pi-agent-core 自研的轻量编程 Agent 框架内核

> 把「最新一代编程 Agent（Claude Code / Codex 那一代）」的核心机制抽出来，在 `@earendil-works/pi-agent-core`
> 的 `AgentHarness` 之上自研一层重新实现一遍的教学级框架。
> 底层复用库的 agent 主循环 / 会话树 / streamFn，上层全部自研：
> **权限沙箱 · 审计日志 · 上下文工程（记忆 + 压缩）· 子 Agent 编排 · 代码智能（tree-sitter + LSP）· 全链路可观测**。
>
> 规模：自研内核 `src/kernel` ~2000 行，含 UI / 工具层共 ~4.7k 行 TypeScript，22 个测试文件 / 121 个用例。

---

## 30 秒跑起来

需要一个真实模型 key（**LIVE-only，无离线 mock 兜底**）。默认模型是 `deepseek/deepseek-v4-pro`，
所以最省事是填 `DEEPSEEK_API_KEY`：

```bash
cd forge
npm install
cp .env.example .env        # 填入对应 provider 的 key
npx tsx src/index.ts        # 交互式 TUI（Ink）
npx tsx src/index.ts "把 src 下的文件列出来并数一下行数"   # 一次性任务
```

缺当前模型 provider 的 key 会直接报错退出（不再有 mock 模式）。

### 模型配置与切换

模型清单 + 默认模型固定在 **`forge.config.json`**（不含任何密钥；密钥只在 `.env`，已 gitignore）：

```json
{
  "defaultModel": "deepseek/deepseek-v4-pro",
  "maxContextTokens": 200000,
  "models": [
    { "ref": "deepseek/deepseek-v4-pro", "label": "DeepSeek V4 Pro · 推理强（默认）" },
    { "ref": "deepseek/deepseek-v4-flash", "label": "DeepSeek V4 Flash · 快 / 省" },
    { "ref": "anthropic/claude-haiku-4-5", "label": "Claude Haiku 4.5" }
  ]
}
```

`maxContextTokens` 是「虚拟上下文窗口」：DeepSeek 真实窗口很大、压测压缩太贵，降到 200K 可低成本验证压缩质量。
要用满真实窗口删掉此行即可。可选 `pricing` 字段（`{ "provider/model": { cacheHit, miss, output } }`，每百万 token 人民币）
会覆盖/扩充内置定价表，价格促销变动时改配置即可、不必改代码。

切换优先级：环境变量 `FORGE_MODEL` > `forge.config.json` 的 `defaultModel` > 内置兜底。
切模型时按 provider 动态解析 key；子 Agent 优先用更省的 `deepseek-v4-flash`，缺 key 时回退主模型。

### 斜杠命令（交互式 TUI 内）

```
/converge <目标>    持续工作直到目标达成，由独立验收 agent Convergent 取证核验（见下）
/converge           查看当前 /converge 目标与上轮验收结论
/converge clear     清除当前目标
/compact            手动触发一次完整压缩（9 段摘要）
/skills             列出已加载的 skills
/stats              打印本次会话的 token / 成本 / 工具调用指标
/pass-permissions   跳过写/执行类确认（灾难命令仍硬拦）
/exit               退出
```

#### `/converge` —— 工作到目标达成 + 自主取证验收

设定一个完成条件后，主 agent 持续工作；它认为达成时**必须调用 `submit_for_review`**（这是「宣称完成」的唯一无歧义信号，
和「停下来问用户」天然区分）。此时派出独立的验收 agent **Convergent**：

- **fresh session + 与主 agent 同级权限**（只读检索 + bash，能自己跑测试 / 复现实现 agent 声称的事实 / 核查某处实现）；
- 只拿到「目标原文 + 改动文件路径清单 + 自我声明」，**diff 不推给它，让它自己按需去读/去跑**（既抗「漂亮交付文档造假」，又不撑爆上下文）；
- **只认自己拉到/跑出来的证据**，不信主 agent 的叙述；**判 NO 需明确反证，拿不准就放行**（用户是最终复核人）。

Convergent 判 NO → 把具体反馈喂回主 agent 自动再来一轮；判 YES → 达成；来回超过上限（`FORGE_CONVERGENT_MAX_TURNS`，默认 30）→ 停。
没调 `submit_for_review` 就停下时，用 flash 廉价三分类（在问用户 / 卡住 / 像是做完了），只有「像是做完了」才触发 Convergent。

底部仪表盘实时显示：模型名 · 上下文用量/窗口(%) · 轮数 · ↑↓ token · prompt 缓存命中率 · 累计成本(¥)。
子 Agent 在跑时另起一行单独统计其 flash 用量。

### 常用环境变量

`FORGE_MODEL` · `FORGE_WORKDIR` · `FORGE_THINKING` · `FORGE_MAX_CONTEXT_TOKENS` ·
`FORGE_RESERVE_TOKENS` · `FORGE_KEEP_RECENT_TOKENS` · `FORGE_MAX_RETRIES` · `FORGE_MAX_RETRY_DELAY_MS` ·
`FORGE_TIMEOUT_MS` · `FORGE_ALLOW_READ_OUTSIDE` · `FORGE_ALLOW_WRITE_OUTSIDE` · `FORGE_SUBAGENT_MAX_TURNS` · `FORGE_AUTO_DIAGNOSE_TIMEOUT_MS` · `FORGE_CONVERGENT_MAX_TURNS`。

### 写边界（自主写代码的护栏）

写文件的工具（`write_file`/`edit_file`/`apply_patch`）由 `safePath` **锁死在 workdir** 内。`bash` 则额外过一道
**best-effort 写边界守卫**：尽力拦住「往 workdir 外写」——重定向(`>`/`>>`)出界、写命令(`cp`/`mv`/`Copy-Item`…)目标出界、
先 `cd ..` 再写，命中即 `deny`（即便 autoApprove / Convergent 也拦）。**诚实边界**：shell 解析是对抗性难题，这不是真墙
（拦不住 `curl -o /外面`、`git config --global` 这类隐式写家目录、env 变量/子壳混淆的路径），真要 airtight 需 OS 级隔离（容器/VM）；
配合「每条 bash 全量落审计 `.forge/audit.jsonl`」+ 用户复核兜底。确需越界写设 `FORGE_ALLOW_WRITE_OUTSIDE=1` 关闭守卫。

---

## 架构

`ForgeAgent` 把库的 `AgentHarness` 包一层，在它暴露的钩子 / 事件流上挂自研能力：

```
                 ┌──────────────── ForgeAgent（自研内核）─────────────────┐
   你的输入 ───▶ │  pi-agent-core AgentHarness（复用主循环 / 会话树 / streamFn） │
                 │     │                                                       │
                 │     ├─ on("tool_call")     ─▶ PermissionPolicy（权限闸门）  │──▶ AuditLog
                 │     ├─ on("tool_result")   ─▶ 审计 + 编辑后自动 LSP 诊断     │──▶ (.forge/audit.jsonl)
                 │     ├─ on("context")       ─▶ 记录上下文 token（供压缩触发）  │
                 │     ├─ on("session_before_compact") ─▶ 自研压缩（接管库原语） │
                 │     └─ subscribe()         ─▶ Telemetry + Ink TUI 渲染        │
                 │                                                              │
                 │  systemPrompt: 主提示 + 环境块(PowerShell/sh) + skills + 记忆索引 │
                 │  tools: 文件读写 / 搜索 / 代码智能 / bash / 子 Agent 编排        │
                 └──────────────────────────────────────────────────────────────┘
```

| 文件 | 职责 |
|---|---|
| `src/kernel/forge-agent.ts` | 内核：包 `AgentHarness`，注入全部钩子、子 Agent 编排、压缩触发策略与熔断 |
| `src/kernel/permission.ts` | 权限闸门：灾难命令硬拒绝（bash + PowerShell）+ 只读放行 + 写/执行确认 |
| `src/sandbox/exec.ts` | 沙箱执行：剔除密钥环境变量、关 stdin、超时杀整棵进程树、输出上限截断 |
| `src/kernel/audit.ts` | 结构化审计日志（JSONL） |
| `src/kernel/compaction.ts` | 上下文压缩纯逻辑：turn 对齐裁剪点 + 9 段摘要模板 + map-reduce 兜底 |
| `src/kernel/memory.ts` | 多文件记忆：`MEMORY.md` 索引常驻注入，`<name>.md` 按需召回（项目 + 全局双作用域）|
| `src/kernel/lsp-client.ts` | 最小 LSP 客户端：pyright / typescript-language-server，跨文件 definition/references/hover/rename/诊断 |
| `src/kernel/code-outline.ts` | tree-sitter 符号大纲（read_file 之前先看结构，省上下文）|
| `src/kernel/telemetry.ts` + `pricing.ts` | 可观测：token / 时延 / 工具指标 + 按国产模型真实定价算成本（人民币）|
| `src/kernel/artifacts.ts` | 工具输出的上下文友好截断：超长落 `.forge/artifacts`，上下文里只留首尾 + 指针 |
| `src/tools/*` | 内置工具集（见下）|
| `src/ui/app.tsx` | Ink TUI：滚动输出区 + 输入框 + 底部仪表盘 + 串行 run 队列 |

**工具集**：`read_file` · `list_dir` · `write_file` · `edit_file` · `apply_patch` · `glob` · `grep` ·
`outline` · `repo_map` · `definition` · `references` · `hover` · `rename` · `diagnostics` · `bash` ·
`memory_read` / `memory_write` / `memory_list` · `spawn_subagent` / `subagent_list` / `subagent_cancel`。

---

## 六个核心能力，对应 AgentHarness 的哪个口子

1. **权限沙箱（`on("tool_call")` + `sandbox/exec.ts`）** — 工具调用不是模型说了算，先过一道确定性闸门：
   `rm -rf /`、`mkfs`、fork bomb、`curl|sh`、PowerShell `iex(下载)` / `format-volume` / `diskpart clean` 等直接拒绝
   （即便 `/pass-permissions` 也硬拦）；写/执行类工具触发用户确认；只读工具放行。
   执行层再隔离一道：子进程**剔除所有像密钥的环境变量**（防 `echo $env:*_API_KEY` 泄密）、关 stdin、超时杀整棵进程树。
2. **审计日志（`on("tool_call")` / `on("tool_result")`）** — 每一次「决策 / 调用 / 结果」落成结构化 JSONL（`.forge/audit.jsonl`），可事后复盘。
3. **上下文工程（systemPrompt 注入 + `on("session_before_compact")`）** — 会话开头注入持久记忆索引（`.forge/memory` 项目 + 全局双作用域）；
   超 90% 窗口时接管库的压缩原语，用自研 cut point（对齐 turn 边界、留近端 ~20% 窗口）+ 9 段 coding 向摘要，
   prompt 过长时 **map-reduce 二分兜底**（不盲丢最早历史），连续失败 3 次熔断防空烧 API。
4. **子 Agent 编排（自定义工具 + 递归 Harness，fire-and-forget）** — `spawn_subagent` 把子任务派给隔离子 Agent：
   **立即返回 id、后台异步跑、不阻塞主 Agent**；子 Agent 跑独立会话、用更省的 flash 模型、受限只读工具集、不持有 spawn 工具（防递归）。
   完成后结论经串行队列自动喂回主 Agent —— 经典 orchestrator-worker。
5. **代码智能（tree-sitter + LSP）** — `outline`/`repo_map` 先看结构再精读；`definition`/`references`/`hover`/`rename` 走 LSP（跨文件、比 grep 准）；
   **编辑后自动诊断**：写类工具成功后对受影响文件跑 LSP，有 error 就追加进工具结果让模型立即看到。
6. **全链路可观测（`subscribe()`）** — 订阅事件流，实时流式渲染 +
   沉淀 token / 成本（按国产模型真实定价算人民币）/ prompt 缓存命中率 / 各工具调用次数与时延的 trace。

---

## 写进简历的 bullet（可直接改）

- 基于 `pi-agent-core`（OpenClaw 的底层 agent runtime）的 `AgentHarness` 自研轻量**编程 Agent 框架内核 Forge**，
  自研内核 ~2000 行 / 共 ~4.7k 行 TypeScript（121 个单测），复刻最新一代编程 Agent 的核心机制。
- 实现**权限沙箱**：在 `tool_call` 钩子上做确定性策略闸门（bash + PowerShell 双套灾难命令黑名单 + 只读放行 + 写操作确认），
  工具调用无法绕过；执行层再隔离（剔密钥环境变量 / 超时杀进程树），配套结构化 **JSONL 审计日志**。
- 设计**上下文工程层**：多文件记忆索引常驻注入 + 按需召回；超 90% 窗口接管压缩（turn 对齐裁剪 + 9 段摘要 +
  prompt 过长 map-reduce 兜底 + 连续失败熔断），对齐长上下文与记忆架构方案。
- 实现 **fire-and-forget 子 Agent 编排**：主 Agent 派发隔离子 Agent（异步不阻塞、flash 省钱模型、受限工具集、防递归），
  完成后结论经串行队列自动喂回 —— orchestrator-worker 范式。
- 接入 **tree-sitter + LSP 代码智能**（跨文件 definition/references/rename + 编辑后自动诊断），
  并做**全链路 trace 可观测**（token / 真实人民币成本 / prompt 缓存命中率 / 工具指标）。

---

## 它不是什么（诚实边界）

- 压缩是启发式的 cut point + 模型生成摘要；不追求与库 `compact()` 逐字节一致，目的在演示「何时压 / 压哪段 / 怎么兜底」的策略。
- 权限模型是教学级：纯 Node、无容器，**限不了 CPU/内存、拦不住网络、挡不住往任意绝对路径写**，
  做到的是「隔离 + 防密钥泄漏 + 健壮」。真实场景需 seccomp / 容器 / VM 级隔离。
- LSP 只接了 Python / TS-JS 两类 server；加语言需同时改 `lsp-client.ts` 的 `SERVERS`、`package.json` 依赖与 tree-sitter wasm。
- 目的：**展示对 agent runtime 内部机制的理解**，而非替代成品编程 Agent。

依赖：[`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) · `@earendil-works/pi-ai` · `typebox` ·
`web-tree-sitter` · `pyright` · `typescript-language-server`
