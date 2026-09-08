# Forge Skills 管理机制 · 实施计划书

> 2026-09-08 · 调研基线：forge @ main（1f4c35f）· pi-agent-core 0.85.1 · rev2：合并「物理三态 × 逻辑组合」架构（§4 重写）
> 定位：forge 转型「算子开发专用 AI 编程工具」的第一步——把 skills 从「库的一个资源类型」升级为
> **forge 自己的一等机制**：内置算子 skills（昇腾/Triton/天数/沐曦/燧原/海光/NVIDIA/AMD 分区）+ 用户自定义 + 统一索引 + 按需加载。
> 硬约束：DeepSeek 纯前缀磁盘缓存（append-only）、上下文预算、零新依赖、每个功能配 node:test 单测、LIVE-only。

---

## 1. 目标与非目标

### 目标

1. **统一加载**：启动时扫描多个 skills 根目录（内置/全局/项目/兼容目录），识别两种外部格式（Claude Code Agent Skills 与 OpenAI Codex Skills，2026 年已共同收敛到 SKILL.md 开放标准，但目录层级与扩展字段不同），归一化为 forge 内部统一表示（IR）。
2. **索引常驻、正文按需**：对齐 memory.ts 的「MEMORY.md 索引常驻注入 + memory_read 按需召回」先例——skills 索引块进 system prompt（有 token 预算上限），正文经 `skill_read` 工具按需加载（工具结果天然 append-only，不破坏前缀缓存）。
3. **内置算子 skills（物理三态 × 逻辑组合）**：`common`（通用层）+ `delta/<vendor>`（厂商差异层）自建随仓版本化；`vendors/`（上游快照，lock 锁 ref）与自建层经 `targets/*.yaml` manifest **声明式组合**成芯片视图——不复制、不软链、可更新（§4）。
4. **覆盖与禁用**：用户可在项目级或全局级覆盖/禁用内置 skill（overlay + 同名优先级）。
5. **子 agent 共享**：子 agent / Convergent 与主 agent 共享同一份 skills 索引快照与 `skill_read` 能力。

### 非目标

- 不做 skill 的图形化管理界面、不做 skill 市场分发（plugin/marketplace）。
- 不做 Claude Code 的 `context: fork`（skill 跑在隔离子 agent）、`!`cmd`` 动态上下文注入、`$ARGUMENTS` 参数替换、`allowed-tools` 单轮工具预授权——这些依赖 harness 级 Skill 调用管线，收益/成本比低，列入开放问题。
- 不支持 OpenAI 已移除的旧 `~/.codex/prompts` 格式的**写**（读取识别作为兼容项，低优先）。
- 不改库（pi-agent-core）；全部在 forge 应用层实现（符合「原地重构、上层自研」路线）。
- 不做会话中途热重载（watch 文件变化）——与 append-only 缓存约束冲突（见 §5.4），只在下一会话生效。

---

## 2. forge 现状盘点（可直接复用的机制）

| 机制 | 现状 | 与 skills 的关系 |
|---|---|---|
| **skills 加载** | `forge-agent.ts:466` 调库 `loadSkills(env, config.skillsDirs, ctx)`；`config.ts:395` 硬编码 `skillsDirs = [workdir/.forge/skills]`（仅项目级一个目录）。库 loader 递归扫 `SKILL.md` + 根级带 frontmatter 的 `.md`，解析 `name/description/disable-model-invocation`，支持 `.gitignore/.ignore`，name 校验 `[a-z0-9-]`≤64、description ≤1024 | **起点**。格式兼容 Agent Skills 开放标准的核心子集；但只有一个目录、无来源/优先级、无预算控制。现有实例：`.forge/skills/karpathy-guidelines/SKILL.md` |
| **system prompt 注入** | `forge-agent.ts:516-522`：`systemPrompt` 回调拼 `[MAIN_SYSTEM_PROMPT, environmentBlock, formatSkillsForSystemPrompt(skills), memory.indexBlock()]`。库的 `formatSkillsForSystemPrompt` 只注入 `name+description+location` 三元组（**已经是渐进披露**：告诉模型「任务匹配时自己去 read_file 该路径」） | 索引形态可参考，但要换掉：location 对 workdir 外的 skill 不可读（见下一行）、无预算、无分区/来源信息 |
| **索引+按需先例** | `kernel/memory.ts`：`MEMORY.md` 索引常驻（`indexBlock()`），`memory_read/list/write` 工具按需读写；双作用域 project(`.forge/memory`)+global(`~/.forge/memory`)，读时**先项目后全局** | **skills 机制对齐这个模式**：`skill_read` ≈ `memory_read`，索引块 ≈ `indexBlock()` |
| **缓存约束（主题一）** | DeepSeek 纯前缀磁盘缓存、无 Cache Editing API：单 session 严格 append-only；破缓存的改写只搭车 compaction 那一次重建（90% 高水位触发） | skills 索引必须**会话开始时快照、字节级稳定**；正文加载只能以追加形态进上下文 |
| **⚠ 已知隐患（本次必须避开）** | `systemPrompt` 是函数，库在**每次 LLM 调用**时 resolve（`harness/runtime/drive/generation.js:20-26`）；而 `memory.indexBlock()` 每次**重读磁盘** → 会话中 `memory_write` 改了 MEMORY.md 后，下一次请求 system prompt 变化 = **整个前缀缓存作废**。这是现存张力，skills 索引绝不能重蹈 | 设计决策 D1：索引字符串在 `ForgeAgent.create()` 时**算一次存字段**，systemPrompt 回调只读字段 |
| **压缩协调** | `before_compaction` 钩子接管，自研 9 段摘要 + retainedTail；压缩后上下文整体重建（system prompt 自然重新 resolve） | 已加载的 skill 正文在压缩中会被摘要掉；把「本会话用过的 skills 名单」写进摘要模板（防压缩后模型忘记该重新 skill_read） |
| **工具注册** | `src/tools/*` 的 `make*Tools()` 工厂返回 `AgentHarnessTool[]`（typebox 定义参数 schema），在 `ForgeAgent.create` 拼数组；`PermissionPolicy` 按 toolName 分类只读/写 | `skill_read` 照 `memory-tool.ts` 模板写，**只读类、免确认** |
| **读边界** | `fs-tools.ts:resolveReadPath`：`allowReadOutsideWorkdir=false`（默认）时 read_file 锁死 workdir | **全局/内置 skills 在 workdir 外（`~/.forge/skills`、forge 安装目录），read_file 读不到** → 需要 `skill_read` 按白名单根目录读（见 D3） |
| **斜杠命令** | `ui/commands.ts` 的 `COMMANDS` 数组（纯逻辑 `matchCommands/menuShouldOpen/resolveSubmitted` 可单测）+ `app.tsx` 的 `slashHandlers` 分发表。`/skills` 已存在（仅列 name+description） | 扩展 `/skills`：列来源/分区/格式/禁用态；`/skills <name>` 直接把正文作为用户消息注入（append-only，天然合规） |
| **配置** | `forge.config.json` 严格校验（未知字段报错——ssh password 静默丢弃的教训）；env `FORGE_*` 覆盖；`globalConfigDir()=~/.forge`（`FORGE_GLOBAL_DIR` 可覆盖，测试用） | 新增 `skills` 配置段（§8.3）；`FORGE_GLOBAL_DIR` 让单测能隔离全局 skills 目录 |
| **token 估算/截断** | `compaction.ts:estimateTokens`（chars/4）；`kernel/artifacts.ts` 超长工具结果截断留首尾+指针 | 索引预算控制、skill_read 超长正文截断复用它们 |
| **依赖** | 库已依赖 `yaml@2.9.0`（顶层 node_modules 可解析，其 skills.js 自己 import） | frontmatter 解析零新依赖：`import { parse } from "yaml"`（建议同时把它加进 forge 直接依赖声明，版本锁同库） |
| **测试** | node:test（`tsx --test test/*.test.ts`）；纯逻辑抽离可测的惯例 | 每阶段测试见 §9 |

**子 agent 现状**：`runEphemeralAgent`（forge-agent.ts:639）创建独立 harness，**没传 `resources:{skills}`、system prompt 也没拼 skills 块** → 子 agent 目前完全不感知 skills。readonlyToolset 也不含 skill_read（待加）。

---

## 3. 两种 skills 格式对照与统一内部表示

### 3.1 背景一句话

2025-10 Anthropic 推出 Agent Skills 并捐出开放规范（agentskills.io）；OpenAI Codex 于 2025-12 跟进采用**同一 SKILL.md 开放标准**，并在 2026-01（v0.89.0）弃用、v0.117.0 **彻底移除**旧 `~/.codex/prompts`。因此 2026 年「两种格式」的实体差异已从**文件格式**转移到**目录层级、扩展元数据、调用策略与预算**上。

### 3.2 对照表

| 维度 | Anthropic Claude Code | OpenAI Codex（ChatGPT/Codex 同源） | forge 统一内部表示（IR） |
|---|---|---|---|
| 规范基础 | Agent Skills 开放标准 + Claude Code 扩展字段 | 同一开放标准（官方明说 "build on the open agent skills standard"） | 以开放标准为核心，两侧扩展字段都收进可选字段 |
| 核心文件 | `<skill>/SKILL.md`（YAML frontmatter + Markdown 正文） | 同左，必备 `name` + `description` | `SkillRecord.body` + 原始 frontmatter 全量保留 |
| frontmatter 必填 | `name`、`description` | `name`、`description` | `name`（1-64，`[a-z0-9-]`，须匹配父目录名）、`description`（1-1024） |
| frontmatter 可选（标准 6 字段） | `license`、`compatibility`(≤500)、`metadata`(str→str)、`allowed-tools`(空格分隔，实验性) | 同左 | 全部存进 `SkillRecord.meta`；`allowed-tools` 记录但 P0 不实现预授权 |
| 扩展字段 | Claude Code 专有：`disable-model-invocation`、`user-invocable`、`when_to_use`、`context: fork`、`background`、`agent`、`disallowed-tools`、`arguments`、`shell` 等（开放标准外的字段会在上传 claude.ai 时硬报错） | **不支持** `disable-model-invocation` 等前端字段；产品专有配置放 **`agents/openai.yaml`**（`interface`/`policy.allow_implicit_invocation`/`dependencies.tools`） | `invocation: { model: boolean, user: boolean }`：Claude 的 `disable-model-invocation`/`user-invocable` 与 Codex 的 `policy.allow_implicit_invocation` 都归一到这两个布尔 |
| 目录层级 | 企业（受管设置目录内 `.claude/skills`）> 个人 `~/.claude/skills` > 项目 `.claude/skills`；plugin 技能带 `plugin-name:` 命名空间不冲突；monorepo 嵌套 `.claude/skills` 按 `apps/web:deploy` 目录限定名并存；`synced/` 目录名保留 | REPO：从 CWD 逐级向上到 `$REPO_ROOT/.agents/skills` 全部扫描；USER：`~/.agents/skills`；ADMIN：`/etc/codex/skills`；SYSTEM：内置。同名不合并、都显示 | 来源统一为有序列表 `[builtin, global, project]`（+可选兼容目录），同名按**后读覆盖先读**解析（§4.4）；分区 = 路径段 |
| 同名优先级 | 企业 > 个人 > 项目（个人覆盖项目！）；任意级覆盖 bundled；skill 覆盖同名 `.claude/commands` | 不覆盖，并存供选择 | **项目 > 全局 > 内置**（与 forge memory「先项目后全局」一致；与 Claude 相反的理由见 §4.4） |
| 预算 | 列表占上下文 **1%**（`skillListingBudgetFraction`/`SLASH_COMMAND_TOOL_CHAR_BUDGET` 可调）；溢出时从**最少使用**的 skill 开始丢 description；单条 name+desc 合计上限 1536 字符 | 初始列表（含文件路径）最多 **2% 窗口或 8000 字符**（窗口未知时）；先缩 description，大集合可能整条省略 + 警告 | 索引块 token 预算 `skills.indexBudgetTokens` 默认 1500（约 0.75%@200K 虚拟窗口），溢出分层裁剪（§5.3） |
| 调用方式 | `/skill-name` 用户调用；模型经 Skill 工具自动调用（description 匹配）；`$ARGUMENTS`/`$N`/`${CLAUDE_SKILL_DIR}` 替换 | Codex CLI `/skills` 或 `$skill-name` 显式；隐式按 description 匹配 | P1：`skill_read(name)` 工具（模型自主调用，即隐式）+ `/skills <name>`（用户显式注入）；占位符替换不做 |
| 渐进披露 | 三级：元数据(~100 tok) 启动常驻 → 激活时载入正文(建议 <5K tok) → 资源按需 | 同左（初始列表多一个 file path） | 完全一致：索引块 → skill_read 正文 → 正文内相对路径引用的资源（模型自己 read_file；全局 skill 资源经 skill_read 的 `resource` 参数） |
| 正文生命周期 | 作为单条消息进对话、跨 turn 常驻；重复调用同内容只加短注记；自动压缩后**重挂最近一次调用**（每条前 5K tok，合计 25K 预算，最近优先） | —— | 不主动重挂；压缩摘要第 9 段追加「本会话已用 skills」名单，让模型按需重新 skill_read（append-only 合规的替代方案） |
| 禁用机制 | `skillOverrides` 设置：`"on"/"off"/"user-invocable-only"/"name-only"`（`/skills` 菜单 Space 切换写入 settings.local.json）；`disableBundledSkills` 全关 | `~/.codex/config.toml` 的 `[[skills.config]] path=... enabled=false`（需重启）；或 `policy.allow_implicit_invocation: false` | `forge.config.json` 的 `skills.overrides: { "<name>": "on"|"off"|"user-only"|"name-only" }`（对齐 Claude 的四态语义） |
| 热重载 | 监视 skills 目录，会话内增删改即时生效 | 自动检测变更，不生效则重启 | **不做**（缓存约束，§5.4）；`/skills reload` 显式提示「下个会话生效」 |
| 子目录约定 | `scripts/`（可执行）、`references/`（REFERENCE.md 等）、`assets/`（模板/数据） | 同左 + `agents/openai.yaml` | 识别并列出（skill_read 返回正文 + 目录清单），执行交给既有 bash 工具（沙箱照常管） |
| 校验工具 | `claude plugin validate <dir>`；`/skill-doctor` 报使用率与成本 | `skills-ref` 参考库 | `forge skills validate`（可选 CLI 子命令，P3）+ `/skills` 列表显示 token 估算 |

权威链接：
- Claude Code Skills：<https://code.claude.com/docs/en/skills>
- Agent Skills 开放规范（两家共同遵循）：<https://agentskills.io/specification>
- OpenAI/Codex Build Skills：<https://learn.chatgpt.com/docs/build-skills>
- OpenAI API Skills 指南（versioned bundle + SKILL.md manifest）：<https://developers.openai.com/api/docs/guides/tools-skills>
- Anthropic 工程博客：<https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>

### 3.3 统一内部表示（normalized IR）

```ts
// src/kernel/skills.ts（新文件，纯逻辑、可单测）
export type SkillFormat = "agentskills" | "claude-code" | "codex" | "codex-prompt-legacy";

export type SkillSource = "builtin" | "global" | "project" | "compat";

/** 物理归属层：内置三态（common/delta/vendor）+ 用户层（user/compat）。 */
export type SkillLayer = "common" | "delta" | "vendor" | "user" | "compat";

export interface SkillRecord {
  /** 规范 name；同名冲突由注册表按 source 优先级消解。 */
  name: string;
  description: string;
  /** SKILL.md 绝对路径（skill_read 白名单锚点；也是物理去重的 identity）。 */
  filePath: string;
  /** skill 根目录（资源相对路径的基）。 */
  dir: string;
  source: SkillSource;
  layer: SkillLayer;
  /** 经 targets 组合反查的归属标签（物理去重后累积；如 ["ascend","hygon"] 表示两家 target 共用）。user/compat 层为空数组。 */
  targets: string[];
  /** vendor 引用溯源（layer=vendor 时有值，如 "geak:expert_skills/tuning-ck"）。 */
  origin?: string;
  format: SkillFormat;
  invocation: { model: boolean; user: boolean };
  /** 标准可选字段 + 两家扩展字段原样保留（license/compatibility/metadata/allowed-tools/when_to_use...）。 */
  meta: Record<string, unknown>;
  /** 会话开始时不读正文（省内存/IO），按需 skill_read 时才读。索引只需要 name+description。 */
}
```

要点：
- **加载即归一**：扫描阶段把两种外部格式都转成 `SkillRecord`；之后的索引生成、注入、工具、命令全部只看 IR——外部格式差异被封在 loader 一层。
- 格式识别规则（同一目录混放两种格式，逐条独立识别）：`<dir>/SKILL.md` 存在 → agentskills 系；同目录还有 `agents/openai.yaml` → `format: "codex"`；frontmatter 出现 Claude 专有字段（`disable-model-invocation`/`user-invocable`/`when_to_use`…）→ `format: "claude-code"`；根级 `<name>.md` 带 frontmatter → flatten 形态（`dir` 取所在目录、资源按该目录解析）；裸 `.md`（无 frontmatter、仅显式配置的 legacy prompts 目录）→ `codex-prompt-legacy`，name 取文件名、description 取首个非空段落，普通 skills 目录跳过并计 warning。混放识别适用于**所有**物理层（common/delta/vendors/用户目录）——vendor 快照里 Codex/Claude 两种布局共存是常态。
- 复用 vs 自研：库的 `loadSkills` 已实现标准子集解析（含 ignore 文件），**P0 先直接复用它做单目录扫描**（返回 `Skill[]` 后补 source/partition 元数据），仅在其不覆盖的场景（兼容目录、legacy prompts、扩展字段）自己补一层 thin loader——frontmatter 解析用已有的 `yaml` 传递依赖，零新增。

---

## 4. 目录布局：物理三态 × 逻辑组合（rev2 架构）

### 4.1 设计动机

「按芯片一分区了事」有四个结构性矛盾：
1. **不平衡**：NVIDIA/AMD/昇腾 skills 厚，燧原/海光近乎荒漠——物理按芯片分目录会出现空荡分区；
2. **软链接诱惑**：海光要借 AMD 家底、Triton 通用知识要被多家共用，物理目录只能靠 symlink——git 相对路径、工具不 follow、跨机不可移植，一坑到底；
3. **重复注入**：多芯片算子（FlagGems 式）开发时，各芯片分区各带一套重叠 skills，agent 反复 skill_read 同一内容浪费上下文；
4. **更新断层**：把上游内容融合复制进分区 = fork，而上游还在日更（cannbot 当天有提交），拷贝即过时。

解法：**物理维度取「抽象层级」，芯片退化为声明式组合（manifest）**。物理上只有三种存储（自建通用层 / 自建差异层 / 上游快照），「家族」与「芯片 target」都是 manifest 组合出来的视图——不复制、不软链，去重发生在物理文件 identity 层。

### 4.2 物理三态（forge 仓库 `skills/` 目录）

```
skills/
  common/                     ← L0 通用层（自建，MIT/Apache 素材蒸馏，随 forge 版本化）
    triton-kernel-basics/SKILL.md   · perf-methodology/ · bench-method/ …
  delta/                      ← L2 厂商差异层（自建，薄：只存「与家族常识不同之处」）
    hygon/  metax/  iluvatar/  enflame/  nvidia/  amd/  ascend/
    hygon/dtk-vs-rocm/SKILL.md       ← 例：DTK 与 ROCm 的 API/微架构差异表
  vendors/                    ← 上游仓库原样快照（不改一行），可整仓或按子路径引用
    amd-skills/  geak/  tensormux-kernel-skills/  flagos/  tileops-metax/ …
    skills.lock.json          ← 每个 vendor：repo URL + commit ref + license（更新锚点）
  targets/                    ← 逻辑层：每芯片一个 yaml，纯声明、零内容
    nvidia.yaml  amd.yaml  hygon.yaml  metax.yaml  ascend.yaml  triton.yaml …

用户全局 ~/.forge/skills/<name>/SKILL.md（同名覆盖内置）；
项目 <workdir>/.forge/skills/<name>/SKILL.md（最高优先级）；
兼容目录 .claude/skills · .agents/skills（项目+全局，默认关）——用户三层区不变（§4.4）。
```

- **common 只此一份**：Triton 语言、roofline/occupancy 优化方法论、bench 与精度验证方法、kernel 工程规范。多芯片场景它只被注入一次。
- **delta 永远薄**：DUMMA≠WMMA、MACA 语法差异、GCU 算子支持表这类「差异知识」。厂商荒漠没关系——薄 delta + 家底组合就是它的完整视图；海光的 skills 之所以「少」，是因为它本来就 = AMD 家底 + 一层差异。
- **vendors 原样存放**：上游目录结构不动，manifest 按子路径精确引用（如 GEAK 只取 `expert_skills/tuning-ck`）。更新 = 改 lock 的 ref 重拉；自建层与上游零耦合，上游重构目录只改 manifest 一行。
- **「融合复制」永不发生** → 更新永远是 git 级操作。确需深度魔改某上游 skill 时，把它 fork 进 `delta/`（物理拷贝、显式脱离上游），manifest 改引 `delta:` 即可——mirror（快照引用）与 fork（拷贝脱离）两种模式都成立且来源可见。
- 内置目录定位：`resolve(dirname(fileURLToPath(import.meta.url)), "../../skills")`（src/kernel → 仓库根）；找不到则降级「无内置 skills」+ 启动横幅，不崩。运行期只读，沙箱写边界天然保护完整性。

### 4.3 逻辑组合层：targets/*.yaml（manifest）

```yaml
# skills/targets/hygon.yaml —— 海光 = 通用层 + AMD 家底 + 海光差异
name: hygon
label: 海光 DCU（DTK 6.x）
include:                        # 列表顺序即优先级：靠后者覆盖前者（同名整条替换）
  - common                      # 整层：skills/common/
  - vendor:amd-skills           # 整仓：skills/vendors/amd-skills/
  - vendor:geak/expert_skills   # 子路径引用
  - delta:hygon                 # 差异层放最后 = 覆盖家底中的同名条目
```

引用语法四种：`common`（整层）· `delta:<vendor>`（差异层）· `vendor:<name>[/<subpath>]`（上游快照；vendor 名不含 `/` 故无歧义）· `target:<name>`（引用另一 target 的组合结果，**传递解析、禁环**——解析时带已访问集合，环即报错）。

resolve 是纯函数：`(manifest, 目录扫描结果) → SkillRecord[]`。**物理去重**在 `filePath` identity 层：同一物理 skill 被多条目/多 target 引用只登记一条，`targets` 字段累积归属标签。多 target 激活（如同时 `ascend+metax+hygon` 写 FlagGems 式算子）= 各 target resolve 结果按 filePath 去重合并——Triton 通用知识物理上只有一条，agent 只 skill_read 一次；会话内重复调用再被 D7 幂等封死。

### 4.4 扫描顺序与同名优先级（overlay 语义不变）

组合结果（builtin）与用户区的叠加顺序：`builtin → compat-global → compat-project → global → project`（后读覆盖先读，Map 按 name 去重）。

即同名时 **项目 > 全局 > 内置**。与 Claude Code（personal > project）**相反**，理由：
1. 对齐 forge 自己的既有语义——memory.read 就是「先项目后全局」；
2. 算子工具的场景里，项目仓库里的 `.forge/skills` 是「这个仓库的算子栈专用适配」（如锁定的 CANN 版本坑），比用户全局偏好更具体、更应赢；
3. 覆盖（overlay）主要面向「改内置」，项目级是最靠近代码的层。

builtin 内部按各 manifest 的 include 顺序后者胜（delta 放最后即覆盖 vendor 同名）。覆盖是**整条替换**（不合并 frontmatter、不合并正文）；被覆盖条目在 `/skills` 标注来源链（如 `vendor:amd-skills/x（被项目覆盖）`）。

### 4.5 vendors 获取与更新

- `skills/vendors/skills.lock.json`：`{ "amd-skills": { "repo": "https://github.com/amd/skills", "ref": "<commit>", "license": "MIT", "subpath": null } }`；`scripts/skills-fetch.ts`（`npm run skills:fetch`）按 lock 拉取/更新到 `vendors/`，支持 `--vendor <name>` 单独刷新。
- 分发双轨：**精选小仓（MIT/Apache）vendor 进 git**（开箱即用、可 review）；大仓（cannbot 等）gitignore + fetch 脚本按需拉（仓库保持轻）。manifest 引用方式统一，不感知分发差异。
- 协议纪律：vendors/ 只收 MIT/Apache-2.0/BSD；CANN OSL v2.0 等非标协议内容不 vendor，只能进 delta 自建改写（法务审阅后）。
- vendor 缺失（引用了但未 fetch）：manifest 条目降级为 warning + 启动横幅提示 `npm run skills:fetch`，不崩。

### 4.6 多 target 激活与会话锁定

- `forge.config.json` → `"skills": { "targets": ["hygon", "metax"] }`（默认 `["common"]`）。target 集合在**会话开始（create()）锁定**，与索引快照（D1）同生命周期：会话内不可换（`/skills` 提示「改 config 后下个会话生效」）——换 target 意味着索引块变 → 前缀缓存作废，与「变更上车 compaction」的纪律一致。

---

## 5. 统一索引

### 5.1 生成：启动扫描，不落盘

`SkillsRegistry.create(roots, env)` 在 `ForgeAgent.create()` 里**异步工厂阶段**执行一次全量扫描（复用 `loadSkills` + thin 补层），产出：
1. `SkillRecord[]`（注册表本体，供 skill_read / /skills / 子 agent 使用）；
2. **索引字符串**（renderIndex，纯函数）——不写缓存文件、不做 watch。理由：扫描是纯本地 IO（几十个 md 文件，<10ms 量级），缓存文件的失效管理比重扫更贵也更易错；且「不落盘」从机制上杜绝了「索引文件被工具误改 → system prompt 漂移 → 缓存全灭」。

### 5.2 形态：类 MEMORY.md 的常驻索引块（会话级快照）

```
【Skills 索引】任务匹配 description 时用 skill_read(<name>) 加载全文（同一 skill 本会话重复调用只返回短注记，不会重复注入）；skill 可引用其目录下 references/scripts 等资源。
〔common〕
  - triton-kernel-basics — Triton kernel 工程：tiling/vectorize/num_warps 调参…（ascend,hygon 亦用）
〔target · hygon ＝ common + vendor:amd-skills + delta:hygon〕
  - amd-kernel-optimization — MI300 优化循环：roofline 定位 → 占用率/内存层次调优…（vendor）
  - hygon-dtk-vs-rocm — DTK 6.x 与 ROCm 差异：DUMMA≠WMMA、Tensor Core 仅 BF16、hipprof…（delta）
〔用户 · 全局〕
  - karpathy-guidelines — 行为准则：先想后写、最小改动…
（预算截断：amd/targets 还有 17 个未列出，用 /skills 查看全部）
```

- **物理去重 + 分组**：同一物理 skill 只一行（归入其首个引用 target 的分组，行尾标注其余归属）；分组顺序 common → targets 声明序 → user。多芯片激活时 Triton 通用知识只在 common 组出现一次——这正是 rev2 架构要消灭的重复注入。

- 注入点：`systemPrompt` 回调里 `parts.push(this.skillsIndexBlock)`——**推一次算好的字段**（D1），不重扫不重算，会话内字节级不变 → 前缀缓存安全。
- 与 memory 索引块并列，位置固定（在 skills 块之后、按现有顺序），顺序本身也是缓存稳定性的一部分。
- 索引行 = `- name — description`（与 MEMORY.md 同构，DeepSeek 对这种格式的遵循已被 memory 机制验证）。

### 5.3 token 预算与分层裁剪

- 预算：`skills.indexBudgetTokens`，默认 **1500**（estimateTokens = chars/4）。参考系：Claude Code 1% 窗口、Codex 2%/8000 字符；forge 默认虚拟窗口 200K 时 1% = 2000 tok，取 1500 留余量，env `FORGE_SKILLS_BUDGET` 可覆盖。
- 裁剪分层（renderIndex 纯函数内实现，逐层降级直到入预算）：
  1. **截长描述**：单行超 160 字符截断加 `…`（对齐 Claude 单条 1536 字符上限的精神，中文字符密度更高取更紧的值）；
  2. **丢低优先分区的 description**：`compat → user → common → 其他厂商分区` 逆序丢描述、只留 name（等价 Claude 的 `name-only`）；
  3. **丢整分区**：超出时整分区折叠为一行 `（另有 N 个：<name1>, <name2>…）`；
  4. **兜底行**：任何截断都在尾部注明 `（索引自 ±N 项被裁剪，/skills 查看全部）`。
- 裁剪顺序确定性：分组固定序（common → targets 声明序 → user）+ 组内 name 字母序，**同输入必产同输出**（可单测断言字节相等，也保证跨会话缓存前缀尽可能复用）。

### 5.4 与 append-only / compaction 的协调（约束 1 的正面处理）

- **会话内索引恒定**：快照在 create() 时定格；文件后续变更不影响本会话（`/skills` 显示快照 + 「变更下会话生效」提示）。绝不做 Claude 式 live watch——那是缓存杀手。
- **变更上车的唯一通道**：compaction。90% 高水位压缩时上下文整体重建、system prompt 重新 resolve——这是刷新索引快照的**唯一合法时机**（可选 P4：压缩回调里重扫一次，若索引变了就随重建生效；不做也不违反正确性，只是晚一个压缩周期）。
- **正文加载天然合规**：skill_read 是工具调用，结果 append 在消息流尾部，不动任何历史前缀。正文很大时走 artifacts.ts 既有截断（首尾 + 指针 + 按行重读指引）。
- **压缩后不失忆**：自研 9 段摘要模板追加第 10 段「Skills used」（本会话 skill_read 过的 name + 一句话），压缩后模型知道去重新加载——替代 Claude 的「压缩后重挂正文」（其 5K/25K 预算重挂机制我们不做，摘要名单更便宜且 DeepSeek 友好）。

---

## 6. 按需加载：`skill_read` 工具 + `/skills` 命令

### 6.1 新工具 `skill_read`（主形态，对齐 memory_read）

```
参数：{ name: string, section?: string /* 可选：正文内 ## 标题，按段返回 */ }
行为：从注册表按 name 查 SkillRecord → 读 SKILL.md 正文（frontmatter 剥离）→
      返回 [正文] + [skill 目录资源清单（references/ scripts/ assets/ 的文件名）] +
      [「资源相对路径基于 <dir>，项目内可用 read_file；全局/内置资源用 skill_read 的返回路径」提示]
边界：只允许读注册表中登记过的 skill 根目录下的文件（白名单 resolve + startsWith 校验），
      name 不存在返回可读错误 + 按名称前缀的建议列表（不要抛裸异常）
分类：只读、免确认（PermissionPolicy 只读 allowlist 加一条）
缓存兼容：工具结果 append-only；**会话内幂等（D7）**——registry 记本会话已读 name 集合，
          重复调用不再注入正文、只返回一行「<name> 已在上下文中（见首次 skill_read）」。
          这仍是一次新的工具调用（append-only 合规，不改写历史），却封死了多芯片场景
          「每个芯片各读一遍同一套通用 skills」的上下文浪费——Claude 的同款行为依赖其
          Skill 管线，我们在工具层一行判重即可
```

为什么不用「description 触发的自动注入」：模型的隐式选择**就是**调用 skill_read——索引块里写了「任务匹配时用 skill_read 加载」，这与 Claude 的 Skill 工具、Codex 的隐式激活语义等价，但实现上只是普通工具调用，零管线改造、零缓存风险。这是 D2 的核心。

### 6.2 `/skills` 命令族（用户侧）

- `/skills` —— 列出快照内全部 skills：name · 来源/分区 · 格式 · 调用策略 · 是否被覆盖/禁用 · 索引 token 估算；显示「文件有变更，下个会话生效」。
- `/skills <name>` —— 用户显式加载：把 skill 正文**作为一条用户消息**入队（走既有 RunQueue → `agent.run()`），形态如 `[skill: <name>]\n<正文>`。append-only 合规（新消息），且用户意图明确时比等模型自选更可靠。禁用（`off`）的 skill 拒绝并提示用 `skills.overrides` 开启。
- 实现：`commands.ts` 的 COMMANDS 加一条（desc 更新）+ `app.tsx` slashHandlers 分发（读注册表渲染）。斜杠菜单的模糊匹配纯逻辑已有单测覆盖模式。

### 6.3 明确不做

- 不做 Skill 专用管线（Claude 的 Skill tool + allowed-tools 单轮预授权 + 参数替换 + fork 子 agent）。
- 不做自动预载（Codex/部分工具会把「相关 skill 正文」在首轮就注入——我们坚持索引 + 按需，正文只进一次工具结果）。

---

## 7. 内置 skills 的自定义扩展（overlay / 优先级 / 禁用）

| 诉求 | 机制 | 生效层 |
|---|---|---|
| 覆盖内置 | 在 `~/.forge/skills/<同名>/SKILL.md` 或 `<workdir>/.forge/skills/<同名>/SKILL.md` 放新版本；整条替换，`/skills` 标注「内置 x 被项目/全局覆盖」 | 全局 / 项目 |
| 增补内置 | 直接在自己分区放新 skill（无需动 forge 仓库）；想回馈上游给 forge 仓库提 PR | 全局 / 项目 |
| 禁用 | `forge.config.json` → `"skills": { "overrides": { "<name>": "off" } }`（对齐 Claude `skillOverrides` 四态：`on/off/user-only/name-only`）；`off` = 索引与 skill_read 都不可见；`user-only` = 索引不可见但 `/skills <name>` 可用（等价 `disable-model-invocation`）；`name-only` = 索引只列名省描述 | 配置 |
| 换格式来源 | frontmatter `disable-model-invocation: true`（Claude 系）或 `agents/openai.yaml` 的 `policy.allow_implicit_invocation: false`（Codex 系）都会归一到 `invocation.model=false`；forge 自己的 skill 两者都认 | 文件 |
| 全关内置 | `"skills": { "builtin": false }`（调试/最小上下文时用） | 配置 |

禁用判定在**扫描归一化之后、索引渲染之前**统一应用（一处逻辑，`/skills`、索引、skill_read 三处一致）。

---

## 8. 与 forge 现有机制的整合点

### 8.1 system prompt 构建（forge-agent.ts）

```ts
// create() 内：
const skills = await SkillsRegistry.create({ builtinDir, globalDir, projectDir, compat, overrides }, env, config);
this.skillsIndexBlock = skills.renderIndex(config.skills.indexBudgetTokens);   // D1：一次定型
// systemPrompt 回调：
const parts = [MAIN_SYSTEM_PROMPT, environmentBlock(config.workdir)];
if (this.skillsIndexBlock) parts.push(this.skillsIndexBlock);   // 替换 formatSkillsForSystemPrompt(skills)
const memIndex = memory.indexBlock();
if (memIndex) parts.push(memIndex);
```

注意：**替换而非叠加**库的 `formatSkillsForSystemPrompt`——它没有来源/分区/预算，且 location 提示会让模型去 read_file workdir 外路径（默认被读边界拦住）。`resources: { skills }` 是否还传给库：P0 保留（兼容库内部行为），P2 评估移除。

### 8.2 工具与命令

- `src/tools/skill-tool.ts`：`makeSkillTools(registry)` → `[skill_read]`（模板照 memory-tool.ts）。
- 主 agent 工具数组加入；`readonlyToolset()`（子 agent/Convergent 用）也加入——子 agent 的 system prompt 拼同一份 `skillsIndexBlock`（见 8.5）。
- `/skills` 命令族（§6.2）；`/context` 类仪表盘信息暂无（forge 仪表盘是 token/成本向），列进开放问题。

### 8.3 forge.config.json 新配置段

```jsonc
"skills": {
  "builtin": true,                    // 是否加载 forge 内置 skills（三态组合）
  "targets": ["common"],              // 激活的芯片 target（targets/*.yaml；会话内锁定，§4.6）
  "dirs": [],                         // 额外 skills 根目录（绝对路径或 ~ 展开）
  "compat": false,                    // 是否扫描 .claude/skills 与 .agents/skills（项目+全局）
  "indexBudgetTokens": 1500,          // 索引块 token 预算
  "overrides": { "<name>": "on" | "off" | "user-only" | "name-only" }  // 同名禁用/降级
}
```

- `validateConfigFile` 按家规**严格校验**：未知字段报错、类型不对报错（ssh 教训）；`overrides` 值枚举校验。
- env 覆盖：`FORGE_SKILLS_BUILTIN=0` / `FORGE_SKILLS_COMPAT=1` / `FORGE_SKILLS_BUDGET` / `FORGE_SKILLS_DIR`（追加目录，`:` 分隔）。
- 测试隔离：`FORGE_GLOBAL_DIR` 已存在，全局目录测试直接复用。

### 8.4 compaction 协调（compaction.ts / forge-agent.ts）

- 9 段摘要模板追加第 10 段 `Skills used: <name> — <description>`（从注册表反查；无则省略）。纯模板改动，`test/compaction.test.ts` 补用例。
- 压缩是索引唯一刷新点（§5.4）；P4 可选实装。

### 8.5 子 agent 与 Convergent

- `runEphemeralAgent` 的 `systemPrompt` 参数在 `runSubAgentLoop` / `runConvergent` 拼装处追加 `this.skillsIndexBlock`（同一快照引用，不重扫）。
- `readonlyToolset()` 加 `skill_read`（只读、无副作用，符合子 agent 受限工具集定位；Convergent 同样获得——验收时能查算子规范类 skill 是真实收益）。
- 不给子 agent 单独的 skills 配置——共享主 agent 注册表（简单、一致、索引字节相同）。

### 8.6 可观测

- flight recorder：`skills_loaded` 一条（各来源数量、预算内/外条数、诊断 warnings）；
- audit：skill_read 走既有 tool_start/tool_end（自动覆盖）；
- 仪表盘：索引 token 计入 system prompt 用量（既有统计自动包含，无需改）。

---

## 9. 分阶段实施路线图

每阶段独立可合入、可测（`npm test` 全绿 + `tsc --noEmit` clean 为门禁）。

### P0 · IR 与扫描内核 + manifest 组合（纯逻辑，无行为变化）

- 新文件 `src/kernel/skills.ts`：`SkillRecord/SkillSource/SkillLayer/SkillFormat` 类型、frontmatter 解析（`yaml` 传递依赖）、格式识别（§3.3）、目录扫描（common/delta/vendor/用户目录统一走同一识别规则）、**targets manifest 解析与组合 resolve**（四种引用 `common`/`delta:`/`vendor:`/`target:`、传递解析 + 环检测、include 顺序后者胜、filePath 物理去重 + targets 标签累积、vendor 缺失降级 warning）、lock 文件解析、`SkillsRegistry.create()`（builtin 组合结果 + global/project/compat + 覆盖消解 + overrides 四态）、`renderIndex(budget)` 分层裁剪（§5.3，确定性输出）。
- 触达：仅新增（`config.ts` 加 `skills` 配置段：targets/builtin/compat/dirs/indexBudgetTokens/overrides 解析与严格校验）。
- 测试 `test/skills.test.ts`：格式识别矩阵（SKILL.md/openai.yaml/Claude 字段/裸 md）；manifest 组合矩阵（四种引用、target: 传递、环报错、vendor 子路径、include 顺序覆盖、物理去重与 targets 标签）；同名优先级（project>global>builtin、整条替换）；overrides 四态；预算分层裁剪的确定性（同输入两次渲染字节相等）与预算上限断言；name/description 规范校验告警；config 校验（未知字段/枚举值报错）。
- 备注：`loadSkills` 复用库实现扫单目录，thin 层补兼容/legacy——库的 Windows 路径 bug 已随「移除 Windows 支持」消亡，无需 skills-win。

### P1 · 索引注入 + system prompt 快照（替换现有注入）

- 触达：`src/kernel/forge-agent.ts`（create 内建注册表、`skillsIndexBlock` 字段、systemPrompt 回调替换 formatSkillsForSystemPrompt）、`src/config.ts`（skills 段默认值）。
- 测试：`test/config.test.ts` 补 skills 段；forge-agent 侧用既有 e2e 模式（`subagent-e2e` 风格，LIVE key 跑一轮断言 system prompt 含索引块且**两次 run 字节相同**——缓存稳定性的一等断言）。
- 风险控制：此阶段先只挂 `~/.forge/skills` + `.forge/skills`（现状两个目录），内置目录留空跑通管线。

### P2 · `skill_read` 工具 + `/skills` 命令族

- 新文件 `src/tools/skill-tool.ts`；触达 `forge-agent.ts`（工具数组 + readonlyToolset）、`ui/commands.ts`（COMMANDS）、`ui/app.tsx`（slashHandlers：列表渲染 + `/skills <name>` 入队注入）。
- 测试 `test/skill-tool.test.ts`：白名单边界（越界路径拒绝、注册表外 name 报错 + 建议）；正文/资源清单返回形状；**会话内幂等（D7：同 name 二次调用返回短注记、不重复注入正文）**；超长正文截断（artifacts 通路）；`test/commands.test.ts` 补 `/skills` 解析。LIVE 冒烟：真模型任务「按 karpathy-guidelines 审这段代码」断言 flight 日志出现 skill_read 调用。

### P3 · 内置内容（三态）+ 覆盖/禁用 + vendor 获取 + CLI 校验

- 新目录：`skills/common/`（首批 2-4 个通用 skill：triton-kernel-basics、perf-methodology、bench-method…）；`skills/delta/{ascend,hygon,metax,iluvatar,enflame,nvidia,amd}/`（每家 1-2 个差异 skill，如 hygon-dtk-vs-rocm，按 `docs/research/` 报告蒸馏）；`skills/targets/*.yaml`（8 家全量 manifest，hygon 引 vendor:amd-skills 家底）；`skills/vendors/` + `skills.lock.json`（首批 1-2 个精选 MIT 小仓 vendor 进 git，其余登记 lock 待 fetch）；`scripts/skills-fetch.ts`（`npm run skills:fetch`，`--vendor` 单刷）。
- 触达：`kernel/skills.ts`（builtinDir 三态解析、lock 读取、vendor 缺失降级横幅）、`config.ts`。
- 测试：`test/skills.test.ts` 补「仓库 skills/ 真实扫描」（target resolve、物理去重、被项目同名覆盖、vendor 子路径引用）；fetch 脚本单测（lock 解析/目标路径拼接等纯逻辑）；可选 `forge skills validate` CLI 子命令（`src/cli.ts`）+ 单测。
- 内容纪律：每 skill ≤500 行；description 首句写清「何时用」；MIT/Apache 素材**改写而非拷贝**；非标协议（CANN OSL）内容必须自建改写并标注来源。

### P4 · 子 agent 共享 + 压缩协调 + 兼容目录（可选增强）

- 触达：`forge-agent.ts`（runSubAgentLoop/runConvergent 的 systemPrompt、readonlyToolset）、`compaction.ts`（第 10 段 Skills used）、`kernel/skills.ts`（compat 根扫描）。
- 测试：`test/compaction.test.ts` 补摘要段；`test/subagent-e2e.test.ts` 断言子 agent system prompt 含同一索引块；compat 目录识别用例。

---

## 10. 风险与开放问题

### 风险

1. **索引稳定性被无意破坏**（最高风险）：任何人在 systemPrompt 回调里引入重读磁盘/时间戳/随机序，都会让每次请求前缀漂移。缓解：索引只从快照字段读 + P1 的「两次 run system prompt 字节相同」单测钉死；code review 检查清单加一条。
2. **预算不够放多 target 全量索引**：多芯片激活 × vendor 大仓（GEAK 586 篇级）远超 1500 tok。缓解：manifest 精选子路径而非整仓引用 + 分层裁剪内建；长期看需要「项目相关 target 优先」启发（开放问题 Q3）。
3. **description 质量决定隐式召回率**：DeepSeek 对索引行的遵循弱于 Claude，可能该调 skill_read 不调。缓解：索引块头部指令措辞强化（「宁可在不确定时先 skill_read 再动手」）；skill 描述写作规范进 `skills/_index.md`；LIVE 冒烟用例持续覆盖。
4. **`yaml` 是传递依赖**：直接 import 语义上依赖库的依赖。缓解：把 `yaml@2.9.0` 写进 forge `dependencies`（同版本锁，不算「新」依赖，node_modules 无变化）。
5. **`.forge` 在 forge 自己的仓库里是 gitignore 的**：项目级 skills「随仓库分发」在用户项目里取决于对方 gitignore。缓解：文档说明 + `/skills` 提示；是否提供 `forge skills init`（往项目放 `.forge/skills/` 样例 + gitignore 反白名单）留开放。
6. **内置目录定位在打包后失效**（npm 包裁剪/全局安装路径变化）：降级为空内置 + 横幅，不崩（§4.5）。
7. **正文超长**：算子参考类 skill 动辄数百行。缓解：skill_read 走 artifacts 截断 + `section` 参数分段读；写作规范限 SKILL.md ≤500 行（对齐开放标准建议）。
8. **同名覆盖静默**：用户可能不知道自己的 skill 压了内置。缓解：`/skills` 显式标注 + flight `skills_loaded` 记录覆盖关系。
9. **manifest 错误与 vendor 缺失**：环引用、引用不存在的 target/vendor/子路径、vendors/ 未 fetch。缓解：resolve 全程带诊断（错误进 warning 通道 + 启动横幅，缺 vendor 提示 `npm run skills:fetch`），环检测显式报错；`/skills` 显示诊断计数。

### 开放问题（Q）

1. `/skills <name>` 注入的用户消息形态（`[skill: x]` 前缀）会不会污染会话语义/被 resume 重放误解？——JSONL 会话树天然回放一致，但前缀格式想定稿。
2. 要不要支持 Codex 式「REPO 向上扫描」（CWD 逐级到 repo root 的 `.agents/skills`）？monorepo 算子仓库有真实需求，但扫描成本与优先级语义要设计。
3. 分区相关性排序：是否按项目特征（检测 torch-triton / CANN / dtk 依赖）动态提权分区，还是恒定 common→字母序？动态序会破坏「跨会话字节稳定」，需要按「项目指纹」而非会话状态排序。
4. `allowed-tools`（标准实验字段）将来要不要实装成「skill_read 后该轮放宽对应工具确认」？涉及权限闸门语义，暂缓。
5. 库的 `resources: { skills }` 通道是否移除（避免双份注入通路）；0.85 的 `loadSourcedSkills`（带 source 标签）未来可直接替换我们的手写 source 标注——升级库版本时对齐。
6. memory 索引的同款缓存隐患（indexBlock 每次重读磁盘）要不要顺手修（同样快照化）？超出本计划范围，但强烈建议另行立项——skills 的 D1 决策就是照它的正确版本做的。

---

## 附：关键设计决策速览

| # | 决策 | 一句话理由 |
|---|---|---|
| D1 | 索引在 create() 时**一次渲染成字符串字段**，systemPrompt 回调只读字段 | system prompt 是前缀缓存的最前排；库每次 LLM 调用都会 resolve 它，任何重算都可能字节漂移 |
| D2 | 正文加载 = `skill_read` 工具（≈ memory_read），不做自动注入/Skill 专用管线 | 工具结果天然 append-only（约束 1）；对齐 memory 先例（约束：仓内模式复用） |
| D3 | skill_read 按**注册表白名单根目录**读，不放开 read_file 读边界 | 全局/内置 skills 在 workdir 外；专用白名单读既解决可达性又不扩大攻击面 |
| D4 | 同名优先级 **项目 > 全局 > 内置**，整条替换 | 对齐 forge memory「先项目后全局」；算子场景下项目级适配最具体 |
| D5 | 索引预算默认 1500 tok，分层裁剪（截描述→name-only→折叠分组），输出确定性 | 介于 Claude 1% 与 Codex 2% 预算之间取保守值；确定性输出本身是缓存友好性要求 |
| D6 | 物理三态（common/delta/vendors）× 逻辑组合（targets manifest），不复制、不软链 | 不平衡/软链接/重复读/更新断层四个矛盾一次性消解；manifest 是纯数据、resolve 是纯函数，天然可单测；更新 = 改 lock ref，融合永不发生 |
| D7 | skill_read 会话内幂等（重复调用只返回短注记） | 封死多芯片场景「同一套通用 skills 被反复注入」的上下文浪费；仍是一次新的工具调用，append-only 合规 |
