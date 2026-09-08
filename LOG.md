# Forge 开发记录

> 时间线流水：每个里程碑一节，**新的在最上面**。每完成一批工作（提交时）在顶部追加一节。
> 三份文档分工：**LOG.md**（本文件）记「什么时候做成了什么」；**学习路径.md** 记「为什么这么做、
> 踩了什么坑、学到什么」（按主题，含 commit 对照）；**docs/** 存机制设计与调研底稿。
>
> 注：git 仓库历史自 2026-09-07 重新开始（36 个 commit 的打磨冲刺）；更早的地基期无逐 commit
> 记录，由 学习路径.md 的主题表回溯补齐。

---

## 2026-09-08 · Skills 管理机制全链路（算子工具转型第一步）

**转型定调**：forge → 算子开发专用 AI 编程工具（昇腾 / Triton / 天数智芯 / 沐曦 / 燧原 / 海光 / NVIDIA / AMD）。

| 项 | 内容 |
|---|---|
| 调研 | 8 个并行 agent 深扫 GitHub/GitCode/Gitee（含 clone 核验），产出 `docs/research/` 八份厂商报告 + 总览。关键发现：两格式已收敛到 SKILL.md 开放标准；FlagOS+FlagGems 是国产线公共底座；昇腾/NVIDIA/AMD 有现成 skills，燧原/海光荒漠需蒸馏自建 → 催生三态架构 |
| 计划书 | `docs/skills-management-plan.md`（rev2）：**物理三态（common/delta/vendors）× 逻辑组合（targets manifest）**——不复制、不软链、可更新，物理去重解决多芯片重复注入 |
| P0 | `kernel/skills.ts`：IR + 四格式扫描归一 + manifest resolve（传递/禁环/后者胜/filePath 去重）+ 确定性索引渲染（预算分层裁剪，默认 1500 tok）|
| P1 | 索引与 memory 索引 create() 时定格快照，systemPrompt 只读字段；**修复存量 bug：memory_write 后整个前缀缓存作废**（indexBlock 每次重读磁盘） |
| P2 | `skill_read` 工具（白名单=注册表、会话内幂等、section 分段、截断）+ `/skills` 命令族（`/skills <name>` 显式注入） |
| P3 | 内置内容：common 3 个通用 skill + 7 家 delta + 10 个 target manifest + vendors lock（6 家 MIT/Apache）+ `npm run skills:fetch`；CANN OSL 非标协议内容不 vendor |
| P4 | 子 agent / Convergent 共享同一索引快照；压缩摘要第 10 段 Skills used |
| 验证 | 测试 308 → **354**（+46：46 单测 + 3 e2e），typecheck clean。e2e 钉子：磁盘变更后 system prompt 字节不变；skill_read 真链路幂等；子 agent 拿到同一索引字符串 |
| commits | `6e0db9c` 调研+计划书 · `0bf1f91` 机制实现 · 本笔（LOG + 文档同步） |

细节与坑见 学习路径.md「主题十二」。

**后续（同日）**：`npm run skills:fetch` 实拉 6 家 vendor（82 个 skill，端到端验证了 fetch 脚本）；修 lock 三处（GEAK 真实路径 `perf_knowledge/expert_skills`、tensormux 默认分支 master、TileOPs-Metax 默认分支 dev）；仓库测试改用 skills/ 拷贝剔除 vendors（不受本机是否 fetch 影响）；`/skills` 增加「未激活 target」提示（发现性：default 只挂 common 时用户看不到还有 ascend/amd/… 可开）。**待办**：delta 内容按计划书纪律深化（PR 评审）。

---

## 2026-09-07 ~ 09-08 · TUI / CLI 打磨冲刺（git 历史 36 commits）

会话管理：`/resume` 字节级还原（修三处根因：空会话/冻结/转录倒序）+ `/rewind` 回滚重编辑（修渲染缓存陈旧）；resume 后输入历史种子。
子 agent：运行中 steer（`subagent_steer`，registry channel）+ 子上下文切换视图 + 空闲自消状态行。
输入/选区：输入框内鼠标选区、Claude Code 风格选区渲染（#224466、选中色让位）、全屏覆盖选区、bracketed paste 多行粘贴、↑↓ 历史浏览保草稿。
转录 UI：复制 toast 系列、chrome 行可拖选、用户消息灰底条、逐轮 Thought 摘要行、流式 reasoning 显示。
CLI：全局 `forge` 命令（bin 启动器 + `~/.forge` 配置兜底 + `--resume` 修复）。
测试地基：进程内 mock provider + 完整子 agent 回路 + App 交互套件。LSP：符号定位回退语法链（无行号查询不再落注释）。

---

## 2026-05 及更早 · 地基期（回溯，详见 学习路径.md 主题表）

- **阶段 0**：AgentHarness 参照原型、工具集、软沙箱、多文件记忆、计费、Ink TUI、diff 渲染、权限闸门、生产硬化。
- **主题一~二**：上下文工程——append-only 吃满 DeepSeek 前缀缓存、90% 高水位单次压缩、9 段摘要、artifacts 截断指针；/compact 进度、斜杠菜单。
- **主题三~六**：跨项目能力（`~/.forge` 全局配置）；code-intel 三层（outline → repo_map → LSP）；实测驱动打磨闭环。
- **主题七**：子 agent 编排演进（异步/后台、完成喂回、用量单独计量）。
- **主题八~九**：飞行记录仪、内置 SSH 工具。
- **主题十~十一**：多行输入框（替换 ink-text-input）；忙时插话 steer、diff 语法高亮、两个压缩 bug 根因（飞书压测实测）。
- 2026-09 初（历史重启前）：升级 pi-agent-core 0.85、双平台硬沙箱重构（Linux bwrap / macOS sandbox-exec）、移除 Windows 支持。
