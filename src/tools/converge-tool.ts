import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * submit_for_review —— 主 agent「显式声明完成」的唯一无歧义信号。
 *
 * /converge 目标激活时，主 agent 认为达成就调它（附理由）→ 触发 Convergent 验收。
 * 这把「我做完了」与「我停下来问用户」干净分开：停下问问题不会调它，控制权正常交回用户。
 */

const schema = Type.Object({
  justification: Type.String({ description: "你认为目标已达成的简短理由（做了什么 / 凭什么算达成）。" }),
});

export function makeConvergeTools(onSubmit: (justification: string) => void): AgentTool[] {
  const submit: AgentTool<typeof schema, { submitted: true }> = {
    name: "submit_for_review",
    label: "提交验收",
    description:
      "当前若有 /converge 目标且你认为已达成时调用本工具（附理由）声明完成 —— 这会触发独立验收 agent 核验。" +
      "没通过会带着具体反馈让你继续。注意：需要用户澄清才能继续时请正常提问，**不要**调用本工具。",
    parameters: schema,
    execute: async (_id, p) => {
      onSubmit(p.justification);
      return {
        content: [{ type: "text", text: "已提交验收，等待 Convergent 核验结论。" }],
        details: { submitted: true as const },
      };
    },
  };
  return [submit] as unknown as AgentTool[];
}
