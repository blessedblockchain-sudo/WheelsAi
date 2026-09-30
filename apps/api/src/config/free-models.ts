/**
 * Free Model Catalog
 *
 * Static catalog of free-tier models available through external providers.
 * These models use platform-level API keys (set in env), not user keys.
 */

import { env } from "./env.js";

export interface FreeModelConfig {
  id: string;
  provider: "groq" | "google" | "together";
  modelName: string;
  displayName: string;
  contextLength: number;
  baseUrl: string;
  envKey: "GROQ_API_KEY" | "GOOGLE_GEMINI_API_KEY" | "TOGETHER_API_KEY";
  notes: string;
}

// Groq retired the Llama 3.x and qwen3-32b models these ids first pointed at;
// the ids stay stable because agent rows and the web wizard store them.
const FREE_MODEL_CATALOG: FreeModelConfig[] = [
  {
    id: "free/groq/llama-3.3-70b",
    provider: "groq",
    modelName: "openai/gpt-oss-120b",
    displayName: "GPT-OSS 120B (Groq)",
    contextLength: 131072,
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    notes: "Best free option, fast inference",
  },
  {
    id: "free/groq/llama-3.1-8b",
    provider: "groq",
    modelName: "openai/gpt-oss-20b",
    displayName: "GPT-OSS 20B (Groq)",
    contextLength: 131072,
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    notes: "Ultra-fast, lighter model",
  },
  {
    id: "free/groq/qwen3-32b",
    provider: "groq",
    modelName: "qwen/qwen3.8-27b",
    displayName: "Qwen3.8 27B (Groq)",
    contextLength: 32768,
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    notes: "Alibaba Qwen, strong reasoning",
  },
  {
    id: "free/gemini/gemini-2.5-flash",
    provider: "google",
    modelName: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash (Google)",
    contextLength: 1_000_000,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GOOGLE_GEMINI_API_KEY",
    notes: "Large context window",
  },
  {
    id: "free/together/llama-3.1-8b",
    provider: "together",
    modelName: "meta-llama/Llama-3.1-8B-Instruct-Turbo",
    displayName: "Llama 3.1 8B Turbo (Together)",
    contextLength: 8192,
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    notes: "Free credits on signup",
  },
];

/** The catalog entry new agents default to. */
export const DEFAULT_FREE_MODEL_ID = "free/groq/llama-3.3-70b";

/**
 * Provider + upstream model name for a free model id, without needing the
 * provider key. Used when generating runtime configs, where the key is
 * injected into the container separately.
 */
export function freeModelProviderAndName(
  modelId: string,
): { provider: string; modelName: string } | null {
  const model = FREE_MODEL_CATALOG.find((m) => m.id === modelId);
  return model ? { provider: model.provider, modelName: model.modelName } : null;
}

/**
 * Returns free models whose provider API key is configured in env
 */
export function getAvailableFreeModels(): FreeModelConfig[] {
  return FREE_MODEL_CATALOG.filter((model) => {
    const key = env[model.envKey];
    return key !== undefined && key.length > 0;
  });
}

/**
 * Check if a model ID is a free-tier model
 */
export function isFreeModel(modelId: string): boolean {
  return modelId.startsWith("free/");
}

/**
 * Resolve a free model ID to its connection config
 */
export function resolveFreeModelConfig(
  modelId: string
): { baseUrl: string; apiKey: string; modelName: string } | null {
  const model = FREE_MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) return null;

  const apiKey = env[model.envKey];
  if (!apiKey) return null;

  return {
    baseUrl: model.baseUrl,
    apiKey,
    modelName: model.modelName,
  };
}

/**
 * Get full catalog (including unavailable models, for UI display)
 */
export function getAllFreeModels(): (FreeModelConfig & { available: boolean })[] {
  return FREE_MODEL_CATALOG.map((model) => ({
    ...model,
    available: Boolean(env[model.envKey]),
  }));
}
