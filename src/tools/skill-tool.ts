import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { readSkillContent, extractSection, type SkillRecord, type SkillsRegistry } from "../kernel/skills.js";
import { truncateForContext } from "../kernel/artifacts.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

const readSchema = Type.Object({
  name: Type.String({ description: "skill 名（skill_list 清单里的 name）" }),
  section: Type.Optional(Type.String({ description: "只取正文里匹配的 ## 标题段（长文档分段读）" })),
});

const listSchema = Type.Object({
  partition: Type.Optional(Type.String({ description: "只看某个分区：common / delta:hygon / vendor:geak / user / compat" })),
  filter: Type.Optional(Type.String({ description: "关键词子串过滤（匹配 name 或 description）" })),
});

/**
 * skills 工具对（rev3：发现性完全交给模型）：
 * · skill_list —— 翻清单（分区/关键词过滤；system prompt 里只有一行摘要，清单按需来翻）；
 * · skill_read —— 读全文（≈ memory_read，D2）。会话内幂等（D7）：同一 skill 重复调用只返回
 *   短注记，不重复注入正文。两者都是工具调用 → 结果 append-only，前缀缓存安全。
 * user-only（invocation.model=false）的 skill 拒绝模型侧调用（对齐 disable-model-invocation）。
 * 每个工具集实例独立 read-set：主 agent 与子 agent 各自记各自的「已读」（上下文本就隔离）。
 */
export function makeSkillTools(registry: SkillsRegistry, workdir: string): AgentHarnessTool<object | undefined>[] {
  const readSet = new Set<string>();

  const skillList: AgentHarnessTool<object | undefined, typeof listSchema, { count: number; shown: number }> = {
    name: "skill_list",
    label: "Skills 清单",
    description:
      "列出可用 skills 的 name + description（system prompt 里只有一行总量摘要，清单用这个翻）。" +
      "partition 按分区收窄（common / delta:<厂商> / vendor:<来源> / user），filter 按关键词过滤。" +
      "看到相关的就用 skill_read(<name>) 读全文。",
    parameters: listSchema,
    execute: async (_id, params, _onUpdate, _toolCtx, _invocation, _ctx) => {
      const q = params.filter?.toLowerCase();
      const selected = registry.records.filter((r) => {
        if (params.partition && r.origin !== params.partition) return false;
        if (q && !`${r.name} ${r.description}`.toLowerCase().includes(q)) return false;
        return true;
      });
      if (!selected.length) {
        const parts = [...new Set(registry.records.map((r) => r.origin))].sort();
        return {
          content: txt(`没有匹配的 skill（partition=${params.partition ?? "-"} filter=${params.filter ?? "-"}）。现有分区：${parts.join("、") || "（空）"}`),
          details: { count: 0, shown: 0 },
        };
      }
      // 按分区分组、组内字母序——输出确定性（同一注册表必产同清单）。
      const byOrigin = new Map<string, SkillRecord[]>();
      for (const r of selected) {
        const arr = byOrigin.get(r.origin) ?? [];
        arr.push(r);
        byOrigin.set(r.origin, arr);
      }
      const groups = [...byOrigin.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([origin, rs]) => `〔${origin}〕${rs.length} 个\n${rs.map((r) => `- ${r.name} — ${r.description.slice(0, 100)}`).join("\n")}`);
      const t = truncateForContext(groups.join("\n\n"), {
        workdir, save: false, hint: "用 partition / filter 参数收窄范围再看",
      });
      return { content: txt(t.text), details: { count: selected.length, shown: selected.length } };
    },
  };

  const skillRead: AgentHarnessTool<object | undefined, typeof readSchema, { name?: string; ok: boolean; deduped?: boolean }> = {
    name: "skill_read",
    label: "读取 skill",
    description:
      "按名加载一条 skill 的全文（skill_list 清单里的 name）。任务匹配某 skill 的 description 时先读它再动手。" +
      "同一 skill 本会话重复调用只会得到短注记（不重复注入）；要找长文档里的某段用 section 参数。",
    parameters: readSchema,
    execute: async (_id, params, _onUpdate, _toolCtx, _invocation, _ctx) => {
      const rec = registry.get(params.name);
      if (!rec) {
        const sug = registry.suggest(params.name);
        return {
          content: txt(`未找到 skill「${params.name}」${sug.length ? `。相近的：${sug.join(", ")}` : ""}（skill_list 可翻全清单）`),
          details: { ok: false },
        };
      }
      if (rec.invocation.model === false) {
        return {
          content: txt(`skill「${rec.name}」为 user-only（disable-model-invocation）：模型侧不可调用；用户可用 /skills ${rec.name} 显式加载。`),
          details: { ok: false, name: rec.name },
        };
      }
      if (readSet.has(rec.name) && !params.section) {
        return {
          content: txt(`skill「${rec.name}」本会话已加载过（见首次 skill_read 结果），不重复注入。要看某一段用 section 参数。`),
          details: { ok: true, name: rec.name, deduped: true },
        };
      }
      const { body, resources } = readSkillContent(rec);
      const text = params.section ? extractSection(body, params.section) : body;
      if (text == null) {
        return {
          content: txt(`skill「${rec.name}」正文里没有匹配「${params.section}」的 ## 标题段。可先不带 section 读全文开头看目录。`),
          details: { ok: false, name: rec.name },
        };
      }
      readSet.add(rec.name);
      registry.noteUsed(rec.name); // 压缩摘要第 10 段 Skills used 的数据源（成功加载才记）
      const header =
        `[skill: ${rec.name}]（${rec.origin}） 源文件 ${rec.filePath}\n` +
        (rec.upstream
          ? `上游快照 ${rec.upstream.repo}@${rec.upstream.ref}` +
            (rec.upstream.commit ? `（commit ${rec.upstream.commit.slice(0, 10)}）` : "") +
            `——vendor 层勿手改（skills:fetch 会整目录覆盖），更新/定制走 skill-maintenance 指引\n`
          : "") +
        `\n`;
      let out = header + text.trim();
      if (resources.length) {
        out += `\n\n〔资源〕${resources.join(" · ")}（相对 skill 目录 ${rec.dir}；项目内可 read_file，全局/内置路径如被读边界拦截则只作参考）`;
      }
      const t = truncateForContext(out, { workdir, save: false, hint: "用 skill_read 的 section 参数按 ## 标题分段读取" });
      return { content: txt(t.text), details: { ok: true, name: rec.name, truncated: t.truncated } };
    },
  };

  return [skillList, skillRead] as unknown as AgentHarnessTool<object | undefined>[];
}
