import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Api, AuthResult, Model, Models, Provider } from "@earendil-works/pi-ai";

/** forge.config.json `customModels` 的一条：OpenAI 兼容自建/内网端点。 */
export interface CustomModelEntry {
  /** "provider/modelId" 形式，如 "glm/glm-5.2"。 */
  ref: string;
  /** 可选展示名（模型切换菜单用）。 */
  label?: string;
  /** OpenAI 兼容 baseUrl（SDK 自动拼 /chat/completions；vLLM 风格通常带 /v1）。 */
  baseUrl: string;
  contextWindow: number;
  /** 输出上限，默认 8192。 */
  maxTokens?: number;
  /** 是否 reasoning 模型（决定默认 thinkingLevel）。默认 false。 */
  reasoning?: boolean;
  /** 取 API key 的环境变量名；内网免鉴权端点可不填（免 key）。 */
  apiKeyEnv?: string;
  /**
   * pi-ai openai-completions 兼容层覆盖（透传到 Model.compat），如
   * `{"supportsDeveloperRole": false, "maxTokensField": "max_tokens"}`。
   * 非 OpenAI 官方端点常需要（拒绝 developer 角色 / 不认 max_completion_tokens / 不认 store）。
   */
  compat?: Record<string, unknown>;
}

/** 单例 Models 实例（auth 由 provider 自解析，见各 provider 的 envApiKeyAuth）。 */
let instance: Models | null = null;

/**
 * Models 单例 —— 0.85 起 harness 的必填项 `models: Models`，auth（env API key）由 provider 自己解析
 * （如 deepseek provider 内置 envApiKeyAuth(["DEEPSEEK_API_KEY"])），旧 `getApiKeyAndHeaders` 移除不替代。
 * `builtinModels()` 注册全部内置 provider；customModels（内网/自建 OpenAI 兼容端点）额外 setProvider。
 */
export function getModels(customs: CustomModelEntry[] = []): Models {
  if (instance) return instance;
  const models = builtinModels();
  for (const p of customProviders(customs)) models.setProvider(p);
  instance = models;
  return instance;
}

/** 把一条 customModels 配置变成完整 Model 对象（config.resolveModel 与 provider 注册共用，避免两处漂移）。 */
export function buildCustomModel(e: CustomModelEntry): Model<Api> {
  const slash = e.ref.indexOf("/");
  const provider = slash > 0 ? e.ref.slice(0, slash) : "custom";
  const id = slash > 0 ? e.ref.slice(slash + 1) : e.ref;
  return {
    id,
    name: e.label ?? id,
    api: "openai-completions",
    provider,
    baseUrl: e.baseUrl,
    reasoning: e.reasoning ?? false,
    input: ["text"],
    // 自建端点没有公开定价 → 记 0 成本（真要算可往 forge.config.json 的 pricing 段配）。
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: e.contextWindow,
    maxTokens: e.maxTokens ?? 8192,
    ...(e.compat ? { compat: e.compat } : {}),
  } as Model<Api>;
}

/** customModels 按 provider 前缀分组建 Provider（一个 provider 可挂多个模型）。 */
export function customProviders(customs: CustomModelEntry[]): Provider[] {
  const byProvider = new Map<string, CustomModelEntry[]>();
  for (const e of customs) {
    const slash = e.ref.indexOf("/");
    const pid = slash > 0 ? e.ref.slice(0, slash) : "custom";
    if (!byProvider.has(pid)) byProvider.set(pid, []);
    byProvider.get(pid)!.push(e);
  }
  return [...byProvider.entries()].map(([pid, entries]) => {
    const first = entries[0]!;
    return createProvider({
      id: pid,
      name: pid,
      baseUrl: first.baseUrl,
      // 免鉴权内网端点给恒定 dummy key（请求会带上但服务端忽略）；配了 apiKeyEnv 则走 env 解析。
      auth: { apiKey: first.apiKeyEnv ? envApiKeyAuth(`${pid} API key`, [first.apiKeyEnv]) : keylessAuth(pid) },
      models: entries.map(buildCustomModel),
      api: openAICompletionsApi(),
    });
  });
}

/** 恒定可用的 keyless auth（内网免鉴权端点：resolve 永远成功，key 是占位符）。 */
function keylessAuth(name: string) {
  return {
    name: `${name} (keyless)`,
    resolve: async (): Promise<AuthResult> => ({
      auth: { apiKey: "forge-keyless" },
      source: "keyless",
    }),
  };
}

/** 单测用：重置单例。 */
export function resetModels(): void {
  instance = null;
}

/** 单测用：直接安装预构建的 Models 实例（如进程内 mock provider），绕过内置注册表。 */
export function setModelsInstance(models: Models): void {
  instance = models;
}
