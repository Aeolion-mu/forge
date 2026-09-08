import { Type } from "typebox";
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { readSkillContent, extractSection, type SkillsRegistry } from "../kernel/skills.js";
import { truncateForContext } from "../kernel/artifacts.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

const readSchema = Type.Object({
  name: Type.String({ description: "skill 名（索引块里的 name）" }),
  section: Type.Optional(Type.String({ description: "只取正文里匹配的 ## 标题段（长文档分段读）" })),
});

/**
 * skill_read：skills 正文按需加载（≈ memory_read，D2）。
 * · 只读注册表登记过的 skill（白名单即注册表本身——name 查表得 filePath，无路径拼接即无穿越面）；
 * · 会话内幂等（D7）：同一 skill 重复调用只返回短注记，不重复注入正文——封死多芯片场景
 *   「每芯片各读一遍同一套通用 skills」的上下文浪费。仍是新的工具调用，append-only 合规；
 * · user-only（invocation.model=false）的 skill 拒绝模型隐式调用（对齐 disable-model-invocation 语义）；
 * · 超长正文走 artifacts 既有截断（首尾 + 指针引导 section 分段读）。
 * 每个工具集实例独立 read-set：主 agent 与子 agent 各自记各自的「已读」（上下文本就隔离）。
 */
export function makeSkillTools(registry: SkillsRegistry, workdir: string): AgentHarnessTool<object | undefined>[] {
  const readSet = new Set<string>();

  const skillRead: AgentHarnessTool<object | undefined, typeof readSchema, { name?: string; ok: boolean; deduped?: boolean }> = {
    name: "skill_read",
    label: "读取 skill",
    description:
      "按名加载一条 skill 的全文（【Skills 索引】块里的 name）。任务匹配某 skill 的 description 时先读它再动手。" +
      "同一 skill 本会话重复调用只会得到短注记（不重复注入）；要找长文档里的某段用 section 参数。",
    parameters: readSchema,
    execute: async (_id, params, _onUpdate, _toolCtx, _invocation, _ctx) => {
      const rec = registry.get(params.name);
      if (!rec) {
        const sug = registry.suggest(params.name);
        return {
          content: txt(`未找到 skill「${params.name}」${sug.length ? `。相近的：${sug.join(", ")}` : ""}（/skills 可查看全部）`),
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
      const header = `[skill: ${rec.name}]${rec.origin ? `（${rec.origin}）` : ""} 源文件 ${rec.filePath}\n\n`;
      let out = header + text.trim();
      if (resources.length) {
        out += `\n\n〔资源〕${resources.join(" · ")}（相对 skill 目录 ${rec.dir}；项目内可 read_file，全局/内置路径如被读边界拦截则只作参考）`;
      }
      const t = truncateForContext(out, { workdir, save: false, hint: "用 skill_read 的 section 参数按 ## 标题分段读取" });
      return { content: txt(t.text), details: { ok: true, name: rec.name, truncated: t.truncated } };
    },
  };

  return [skillRead] as unknown as AgentHarnessTool<object | undefined>[];
}
