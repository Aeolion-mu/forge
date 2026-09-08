# Forge — 基于 pi-agent-core 自研的轻量编程 Agent 框架内核

> 把「最新一代编程 Agent（Claude Code / Codex 那一代）」的核心机制抽出来，在 `@earendil-works/pi-agent-core`
> 的 `AgentHarness` 之上自研一层重新实现一遍的教学级框架。
> 底层复用库的 agent 主循环 / 会话树 / streamFn，上层全部自研：
> **权限沙箱 · 审计日志 · 上下文工程（记忆 + 压缩）· 子 Agent 编排 · 代码智能（tree-sitter + LSP）· 全链路可观测**。
>
> 规模：自研内核 `src/kernel` ~2000 行，含 UI / 工具层共 ~4.7k 行 TypeScript，24 个测试文件 / 235 个用例。
> 2026-09：升级 pi-agent-core 0.85（异步工厂 + lane + Context 线程化）并重构沙箱为双平台硬沙箱（Linux bwrap / macOS sandbox-exec），Windows 支持已移除。

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

内网/自建 **OpenAI 兼容端点**走 `customModels` 段（免 key 端点也可；`compat` 覆盖非 OpenAI 官方的差异）：

```json
"customModels": [
  { "ref": "glm/glm-5.2", "baseUrl": "http://10.0.0.1/v1", "contextWindow": 200000,
    "reasoning": true, "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" } }
]
```

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

### 写边界（内核保证，不再是正则假墙）

写文件的工具（`write_file`/`edit_file`/`apply_patch`）由 `safePath` 锁死在 workdir 内；`bash` 的写边界由**内核**保证——
2026-09 重构后，旧的两层 best-effort 守卫（正则写边界 + flash 语义裁决）已删，取而代之的是双平台硬沙箱：

| | Linux（bwrap） | macOS（sandbox-exec / Seatbelt） |
|---|---|---|
| 只读根 + 可写白名单 | `--ro-bind / /` + `--bind` 白名单 | `(deny file-write*)` + `(allow … (subpath …))` |
| 读隐藏（`~/.ssh` 等） | 空 tmpfs 盖住 | `(deny file-read* (subpath …))` |
| 断网开关 | `--unshare-net` | `(deny network*)` |
| 私有 /tmp | `--tmpfs /tmp` | 每会话独立 `$TMPDIR` |
| 内存 / 进程限额 | systemd cgroup（MemoryMax/TasksMax）；无 systemd 只隔离不限内存 | **无**（SBPL 无资源限制原语；`ulimit -v` 在 mac 失效）；`ulimit -u` 部分生效 |
| 环境白名单 | `--clearenv` + 13 变量白名单 | `env -i` + 同一份白名单 |

- 默认可写：workdir、`/tmp`、`~/.cache/.npm/.cargo`（**`~/.config` 已收紧**——`git config --global` / `gh hosts.yml` 在里面，确需可写进 `sandbox.writePaths` 显式配）。
- 默认禁读：`~/.ssh`、`~/.aws`、`~/.gnupg`（防「沙箱内读 key 后经网络外传」；全盘默认可读 + 默认联网是真实外泄面）。
- 被拒的写以 `EPERM / Operation not permitted` 出现在 bash 输出里，模型看得见并会自行调整。
- 豁免名单（`sandbox.excluded`）：沙箱内不可嵌套沙箱（`brew` / `swift test` 这类自带沙箱的工具）——命中则不沙箱执行 + 输出前置警告 + 审计。
- 无后端可用时**大声降级**（启动横幅 + TUI 仪表盘显示「⚠ 未沙箱」），不再是静默 no-op。
- 诚实边界：bwrap 共享宿主内核（不防内核 0-day 提权，那是 gVisor/microVM 的活）；seatbelt 是 Apple 名义 deprecated 但自家守护进程都在用的成熟机制（Claude Code / Cursor / Bazel / Homebrew 同款），风险在跨版本行为漂移（内层 shell 钉 `/bin/bash` 规避 zsh 5.9 的 sysctl 坑）。

---

## 架构

`ForgeAgent` 把库的 `AgentHarness` 包一层，在它暴露的钩子 / 事件流上挂自研能力：

```
                 ┌──────────────── ForgeAgent（自研内核）─────────────────┐
   你的输入 ───▶ │  pi-agent-core AgentHarness（复用主循环 / 会话树 / streamFn） │
                 │     │                                                       │
                 │     ├─ hooks.before_tool  ─▶ PermissionPolicy（权限闸门）   │──▶ AuditLog
                 │     ├─ hooks.after_tool    ─▶ 审计 + 编辑后自动 LSP 诊断      │──▶ (.forge/audit.jsonl)
                 │     ├─ hooks.transform_context ─▶ 飞行记录的 context 管线    │
                 │     ├─ hooks.before_compaction  ─▶ 自研压缩（接管库原语）     │
                 │     └─ events.on(全类型)   ─▶ Telemetry + Ink TUI 渲染        │
                 │                                                              │
                 │  systemPrompt: 主提示 + 环境块(sh) + skills + 记忆索引                │
                 │  tools: 文件读写 / 搜索 / 代码智能 / bash / 子 Agent 编排        │
                 └──────────────────────────────────────────────────────────────┘
```

| 文件 | 职责 |
|---|---|
| `src/kernel/forge-agent.ts` | 内核：包 `AgentHarness`，注入全部钩子、子 Agent 编排、压缩触发策略与熔断 |
| `src/kernel/permission.ts` | 权限闸门：灾难命令硬拒绝 + 只读放行 + 写/执行确认（写边界在沙箱内核层）|
| `src/sandbox/policy.ts` | 沙箱策略单一事实源：writePaths / readDeny / excluded / 限额（含默认值）|
| `src/sandbox/exec.ts` | 执行层：平台路由（bwrap/seatbelt/降级）、白名单环境、进程组杀、输出上限 |
| `src/sandbox/bwrap.ts` | Linux 硬沙箱（只读根 + tmpfs 盖敏感目录 + cgroup 限额）|
| `src/sandbox/seatbelt.ts` | macOS 硬沙箱（SBPL profile 生成 + env -i 白名单 + 钉 /bin/bash）|
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
`memory_read` / `memory_write` / `memory_list` · `spawn_subagent` / `subagent_steer` / `subagent_list` / `subagent_cancel`。

---

## 六个核心能力，对应 AgentHarness 的哪个口子

1. **权限沙箱（`hooks.before_tool` + `sandbox/*`）** — 工具调用不是模型说了算，先过一道确定性闸门：
   `rm -rf /`、`mkfs`、fork bomb、`curl|sh` 等直接拒绝（即便 `/pass-permissions` 也硬拦）；
   写/执行类工具触发用户确认；只读工具放行。
   执行层是**双平台内核级硬沙箱**（Linux bwrap / macOS sandbox-exec：只读根 + 可写白名单 + 敏感目录读隐藏 + 断网开关），
   环境走白名单模型（密钥类变量根本不进子进程）、关 stdin、超时杀整棵进程树、输出上限截断。
2. **审计日志（`hooks.before_tool` / `hooks.after_tool`）** — 每一次「决策 / 调用 / 结果」落成结构化 JSONL（`.forge/audit.jsonl`），可事后复盘。
3. **上下文工程（systemPrompt 注入 + `hooks.before_compaction`）** — 会话开头注入持久记忆索引（`.forge/memory` 项目 + 全局双作用域）；
   超 90% 窗口时接管库的压缩原语，用自研 cut point（对齐 turn 边界、留近端 ~20% 窗口）+ 9 段 coding 向摘要，
   prompt 过长时 **map-reduce 二分兜底**（不盲丢最早历史），连续失败 3 次熔断防空烧 API。
4. **子 Agent 编排（自定义工具 + 递归 Harness，fire-and-forget + 双向 steering）** — `spawn_subagent` 把子任务派给隔离子 Agent：
   **立即返回 id、后台异步跑、不阻塞主 Agent**；子 Agent 跑独立会话、用更省的 flash 模型、受限只读工具集、不持有 spawn 工具（防递归）。
   完成后结论经串行队列自动喂回主 Agent —— 经典 orchestrator-worker。
   运行期间**主 Agent（`subagent_steer` 工具）与用户（TUI 子 Agent 视图内输入）都可随时插话**——消息在当前工具步执行完、下一次思考前注入，不打断当前步；
   TUI 底部每个运行中的子 Agent 一行实时状态（轮数/耗时），**点击即进入其上下文**逐条查看它的对话与工具调用（`/agents <id>`、Esc 返回），全部结束后状态行自动消失。
5. **代码智能（tree-sitter + LSP）** — `outline`/`repo_map` 先看结构再精读；`definition`/`references`/`hover`/`rename` 走 LSP（跨文件、比 grep 准）；
   **编辑后自动诊断**：写类工具成功后对受影响文件跑 LSP，有 error 就追加进工具结果让模型立即看到。
6. **全链路可观测（`events.on` 全类型扇出）** — 订阅事件流，实时流式渲染 +
   沉淀 token / 成本（按国产模型真实定价算人民币）/ prompt 缓存命中率 / 各工具调用次数与时延的 trace。

---

## 写进简历的 bullet（可直接改）

- 基于 `pi-agent-core`（OpenClaw 的底层 agent runtime）的 `AgentHarness` 自研轻量**编程 Agent 框架内核 Forge**，
  自研内核 ~2000 行 / 共 ~4.7k 行 TypeScript（235 个单测），复刻最新一代编程 Agent 的核心机制。
- 实现**权限沙箱**：在 before_tool 钩子上做确定性策略闸门（灾难命令黑名单 + 只读放行 + 写操作确认），
  执行层为**双平台内核级硬沙箱**（Linux bwrap 只读根+cgroup / macOS sandbox-exec SBPL，读隐藏敏感目录 + 断网开关 +
  白名单环境），配套结构化 **JSONL 审计日志**；无后端时大声降级而非静默放行。
- 设计**上下文工程层**：多文件记忆索引常驻注入 + 按需召回；超 90% 窗口接管压缩（turn 对齐裁剪 + 9 段摘要 +
  prompt 过长 map-reduce 兜底 + 连续失败熔断），对齐长上下文与记忆架构方案。
- 实现 **fire-and-forget 子 Agent 编排**：主 Agent 派发隔离子 Agent（异步不阻塞、flash 省钱模型、受限工具集、防递归），
  完成后结论经串行队列自动喂回 —— orchestrator-worker 范式。
- 接入 **tree-sitter + LSP 代码智能**（跨文件 definition/references/rename + 编辑后自动诊断），
  并做**全链路 trace 可观测**（token / 真实人民币成本 / prompt 缓存命中率 / 工具指标）。

---

## 它不是什么（诚实边界）

- 压缩是启发式的 cut point + 模型生成摘要；不追求与库 `compact()` 逐字节一致，目的在演示「何时压 / 压哪段 / 怎么兜底」的策略。
- 沙箱已到内核级写边界（bwrap / seatbelt），但**不防内核 0-day 提权**（共享宿主内核，那是 gVisor/microVM 的活）；
  macOS 无内存限额机制（SBPL 无资源限制原语）；沙箱不可嵌套（brew 等走豁免名单）。bwrap 的 Linux 实机验证待有 Linux 环境后补跑（单测已覆盖参数构造）。
- LSP 只接了 Python / TS-JS 两类 server；加语言需同时改 `lsp-client.ts` 的 `SERVERS`、`package.json` 依赖与 tree-sitter wasm。
- 目的：**展示对 agent runtime 内部机制的理解**，而非替代成品编程 Agent。

依赖：[`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi) · `@earendil-works/pi-ai` · `typebox` ·
`web-tree-sitter` · `pyright` · `typescript-language-server`
