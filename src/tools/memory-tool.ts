import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { Memory, MemoryScope } from "../kernel/memory.js";

const txt = (t: string): TextContent[] => [{ type: "text", text: t }];

const readSchema = Type.Object({ name: Type.String({ description: "记忆名（索引里的 name）" }) });
const listSchema = Type.Object({});
const writeSchema = Type.Object({
  name: Type.String({ description: "记忆名（简短 kebab；同名会覆盖）" }),
  scope: Type.String({ description: "project=仅本项目 / global=全局（跨项目）" }),
  description: Type.String({ description: "一句话描述，进索引、决定召回相关性" }),
  content: Type.String({ description: "记忆正文" }),
  type: Type.Optional(Type.String({ description: "user | feedback | project | reference，默认 project" })),
});

/** 记忆工具：read（召回）/ list（看索引）只读，write（记录）写类经确认。 */
export function makeMemoryTools(mem: Memory): AgentTool[] {
  const memoryRead: AgentTool<typeof readSchema, { name: string }> = {
    name: "memory_read",
    label: "读取记忆",
    description: "按名加载一条具体记忆的全文（先查项目、再查全局）。索引里看到相关记忆时用它召回。",
    parameters: readSchema,
    execute: async (_id, params) => ({ content: txt(mem.read(params.name)), details: { name: params.name } }),
  };

  const memoryList: AgentTool<typeof listSchema, { ok: boolean }> = {
    name: "memory_list",
    label: "记忆索引",
    description: "列出全部记忆索引（全局 + 本项目）。",
    parameters: listSchema,
    execute: async () => ({ content: txt(mem.list()), details: { ok: true } }),
  };

  const memoryWrite: AgentTool<typeof writeSchema, { file: string }> = {
    name: "memory_write",
    label: "记录记忆",
    description:
      "记录一条**会改变未来会话决策**的持久事实，写成独立 md + 更新索引。" +
      "✅ 该记：架构/约定、构建运行命令、项目布局、用户明确的偏好或纠正（尤其反复出现的）、重要决策及理由。" +
      "❌ 不该记：一次性任务/巡检/测试结果、只在本次对话有用的信息、代码或 README 里读得到的事实、只涉及单处的步骤。" +
      "记之前自问：下次新会话真的需要它吗？不确定就别记（记忆系统的失败模式是『记太多』）。" +
      "scope: project(仅本项目)/global(跨项目)。写操作经权限闸门。",
    parameters: writeSchema,
    execute: async (_id, params) => {
      const scope: MemoryScope = params.scope === "global" ? "global" : "project";
      const file = mem.write({ name: params.name, scope, description: params.description, type: params.type, content: params.content });
      return { content: txt(`已记录记忆「${params.name}」（${scope}）`), details: { file } };
    },
  };

  return [memoryRead, memoryList, memoryWrite] as unknown as AgentTool[];
}
