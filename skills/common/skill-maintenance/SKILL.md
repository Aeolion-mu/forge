---
name: skill-maintenance
description: 维护本机 skills 集合时必读。用户要求更新/同步某个 vendor skill、拉取上游、魔改定制、新增或删除 skill 时，先读这个再动手——改错层会被静默覆盖或丢失。
---

# skills 维护指引

本机 skills 分层，**改哪一层决定改动是否存活**。动手前先 `skill_list(partition=...)` 确认目标 skill 的归属：

| 层 | 位置（forge 源码仓库内） | 性质 | 可否直接编辑 |
|---|---|---|---|
| common | `skills/common/` | 自建通用方法论 | ✅ |
| delta | `skills/delta/<厂商>/` | 自建厂商差异（压过 vendor 同名） | ✅ |
| vendor | `skills/vendors/<name>/` | 上游仓库快照 | ❌ 禁止手改 |
| user | `~/.forge/skills`（全局）· `<workdir>/.forge/skills`（项目） | 用户自置 | ✅ |

## 更新 vendor skill（同步上游）

在 **forge 源码仓库根**执行（`skills/vendors/skills.lock.json` 锁定每家的 repo/ref/license）：

```bash
npm run skills:fetch                  # 全量刷新
npm run skills:fetch -- --vendor geak # 只刷一家（名字 = origin 冒号后那段）
```

- 网络不通先挂代理前缀：`https_proxy=http://127.0.0.1:7897 npm run skills:fetch …`（fetch 内部走 git clone over https）
- fetch 会**整目录覆盖** `vendors/<name>/`，并重写其中的 `.vendor-meta.json`（repo / ref / 解析到的 commit）
- 某家当前钉在哪个 commit：读 `skills/vendors/<name>/.vendor-meta.json`；各家 repo 地址见 `skills.lock.json`
- 刷新后**重启 forge 会话**才生效（注册表在 create() 时一次成型，会话中不重扫）

## 为什么绝对不能手改 vendors/ 下的文件

1. 手改会在下一次 `skills:fetch` 被**无条件覆盖丢弃**（fetch 是 rmSync + 重拷，不看本地差异）；
2. `vendors/*` 被 .gitignore 排除（仅 `skills.lock.json` 进 git），手改不进版本库——丢了也无痕。

## 定制/魔改上游内容 → fork 进 delta

把要改的 skill 目录整体拷进 `skills/delta/<厂商>/`（跨厂商通用的进 `common/`），正文头部标注来源：

```markdown
> fork 自 vendor:geak 的 xxx-skill（commit e867fa4），2026-09-10 起脱离上游自行维护。
```

fork 后靠「delta 在 vendor 之后叠加」的机制天然压过上游同名，上游更新不再自动跟进。改 delta 前先 `skill_read` 原版通读一遍，只搬需要的部分——delta 的纪律是**薄**（只存与家族常识不同之处）。

## 新增 skill

- 目录名 = name（`[a-z0-9-]`，≤64 字符），frontmatter 必含 `description`——首句写清「何时用」（它是 skill_list 匹配和模型触发的唯一依据）
- 正文 ≤500 行；超长内容拆进 `references/`，正文里留目录指引（`skill_read` 的 section 参数按 `## 标题` 分段读）
- 附带资源：`references/`（参考文档）· `scripts/`（可执行）· `assets/`（模板/数据）
- 引用外部上游素材注意协议：vendors/ 只收 MIT/Apache-2.0/BSD；非标协议内容必须改写进 delta，不得原样拷贝
