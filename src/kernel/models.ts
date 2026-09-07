import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai";

/**
 * Models 单例 —— 0.85 起 harness 的必填项 `models: Models`，auth（env API key）由 provider 自己解析
 * （如 deepseek provider 内置 envApiKeyAuth(["DEEPSEEK_API_KEY"])），旧 `getApiKeyAndHeaders` 移除不替代。
 * `builtinModels()` 注册全部内置 provider，模型目录与 /compat 的 getModel 一致。
 */
let instance: Models | null = null;

export function getModels(): Models {
  return (instance ??= builtinModels());
}

/** 单测用：重置单例。 */
export function resetModels(): void {
  instance = null;
}
