/**
 * 进程内 mock 模型 provider —— 端到端测试的地基（无 HTTP、无真实 key）。
 *
 * 原理：pi-ai 的 ProviderStreams 是纯接口（stream/streamSimple 返回
 * AssistantMessageEventStream）。用 createProvider 挂一个直出事件流的假 API，
 * 再 createModels + setProvider + setModelsInstance 注入 forge 的 getModels 单例。
 * 每次 LLM 调用都经过真实链路（harness → Models → provider → 事件流 → agent loop），
 * 只是「模型」是测试脚本编排的 MockResponder。
 */

import { createModels, createProvider, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Message, Model, Usage } from "@earendil-works/pi-ai";
import { setModelsInstance } from "../../src/kernel/models.js";

/** 一次编排的模型回复：纯文本，或工具调用（可同时有）。 */
export interface MockReply {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

/** 喂给 responder 的一次调用快照（主/子 agent 靠 systemPrompt 区分）。 */
export interface MockCall {
  /** 本次调用的 system prompt（子 agent 带 SUBAGENT[role] 前缀）。 */
  systemPrompt: string;
  /** 最后一条用户消息文本（steer 注入的消息也会出现在这里）。 */
  lastUserText: string;
  /** 全部消息序列化摘要（调试/断言 steer 送达用）。 */
  transcript: string;
}

/** 编排器：按调用序号/上下文决定回什么。 */
export type MockResponder = (call: MockCall, callIndex: number) => MockReply | Promise<MockReply>;

export interface MockProvider {
  /** 已发生的 LLM 调用快照（含主/子）。 */
  calls: MockCall[];
  /** 安装为 forge 的全局 Models 单例（测试前调用；用完 restoreModels）。 */
  install(): void;
}

const zeroUsage = (): Usage => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** 从消息列表提取纯文本（user / assistant / toolResult 通吃，断言/摘要用）。 */
function textOfMessage(m: Message): string {
  const c = m.content as unknown;
  if (typeof c === "string") return c;
  return (c as Array<{ type: string; text?: string }>).filter((x) => x.type === "text").map((x) => x.text ?? "").join("");
}

function lastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return textOfMessage(m);
  }
  return "";
}

/** 构造 mock provider 并返回控制面。modelRef 形如 "mock/main"。 */
export function mockProvider(modelRef: string, responder: MockResponder): MockProvider {
  const slash = modelRef.indexOf("/");
  const providerId = slash > 0 ? modelRef.slice(0, slash) : "mock";
  const modelId = slash > 0 ? modelRef.slice(slash + 1) : modelRef;
  const model: Model<never> = {
    id: modelId,
    name: modelId,
    api: "mock" as never,
    provider: providerId,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
  const calls: MockCall[] = [];
  let seq = 0;

  const makeStream = (ctx: Context): AssistantMessageEventStream => {
    const s = new AssistantMessageEventStream();
    const call: MockCall = {
      systemPrompt: ctx.systemPrompt ?? "",
      lastUserText: lastUserText(ctx.messages),
      transcript: ctx.messages.map((m) => `[${m.role}] ${textOfMessage(m).slice(0, 200)}`).join("\n"),
    };
    const index = calls.length;
    calls.push(call);
    // 异步填充：responder 可以 await（测试里用来做门控/时序控制）。
    void (async () => {
      try {
        const reply = await responder(call, index);
        const content: AssistantMessage["content"] = [];
        if (reply.text) content.push({ type: "text", text: reply.text });
        for (const [i, tc] of (reply.toolCalls ?? []).entries()) {
          content.push({ type: "toolCall", id: `call_${seq}_${i}`, name: tc.name, arguments: tc.args });
        }
        const message: AssistantMessage = {
          role: "assistant",
          content,
          api: "mock" as never,
          provider: providerId,
          model: modelId,
          usage: zeroUsage(),
          stopReason: reply.toolCalls?.length ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        seq += 1;
        // 最小事件序列：start → 文本 → done（agent loop 只需要这几个）。
        s.push({ type: "start", partial: message });
        if (reply.text) {
          s.push({ type: "text_start", contentIndex: 0, partial: message });
          s.push({ type: "text_delta", contentIndex: 0, delta: reply.text, partial: message });
          s.push({ type: "text_end", contentIndex: 0, content: reply.text, partial: message });
        }
        s.push({ type: "done", reason: reply.toolCalls?.length ? "toolUse" : "stop", message });
      } catch (err) {
        s.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], api: "mock" as never, provider: providerId, model: modelId,
          usage: zeroUsage(), stopReason: "error", errorMessage: String((err as Error).message ?? err), timestamp: Date.now(),
        } });
      }
    })();
    return s;
  };

  const provider = createProvider({
    id: providerId,
    name: providerId,
    baseUrl: "http://mock.invalid",
    auth: {
      apiKey: {
        name: "mock key",
        resolve: async () => ({ auth: { apiKey: "mock" }, source: "mock" }),
      },
    },
    models: [model],
    api: {
      stream: (_m, ctx) => makeStream(ctx),
      streamSimple: (_m, ctx) => makeStream(ctx),
    },
  });
  return {
    calls,
    install() {
      const models = createModels();
      models.setProvider(provider as never);
      setModelsInstance(models as never);
    },
  };
}
