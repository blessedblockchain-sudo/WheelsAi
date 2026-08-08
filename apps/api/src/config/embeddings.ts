/**
 * Embedding provider resolution (W2 RAG).
 *
 * Embeddings come from an OpenAI-compatible `/v1/embeddings` endpoint —
 * the same architecture as every other model call on the platform, so
 * there is no second inference stack to operate.
 *
 * IMPORTANT: Groq is NOT an option. Groq serves chat completions only and
 * has no embeddings endpoint, so configuring it would produce a 404 on the
 * first search rather than a clear failure. env.ts refuses it at boot by
 * name — the platform's only configured key today is Groq's, which is
 * exactly why this needs to fail loudly instead of looking configured.
 *
 * With no provider set, semantic search is simply unavailable and the
 * knowledge search path reports `mode: "keyword"` honestly rather than
 * calling word overlap "semantic".
 */

import { env } from "./env.js";

export type EmbeddingProviderId = "openai" | "together" | "google";

export interface EmbeddingProviderConfig {
  provider: EmbeddingProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Providers that expose an OpenAI-compatible /embeddings endpoint. */
export const EMBEDDING_PROVIDERS: Record<
  EmbeddingProviderId,
  { baseUrl: string; envKey: "OPENAI_API_KEY" | "TOGETHER_API_KEY" | "GOOGLE_GEMINI_API_KEY"; suggestedModel: string }
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    envKey: "OPENAI_API_KEY",
    suggestedModel: "text-embedding-3-small",
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    envKey: "TOGETHER_API_KEY",
    suggestedModel: "BAAI/bge-base-en-v1.5",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GOOGLE_GEMINI_API_KEY",
    suggestedModel: "text-embedding-004",
  },
};

/** Providers people reasonably assume work, and why they don't. */
export const UNSUPPORTED_EMBEDDING_PROVIDERS: Record<string, string> = {
  groq: "Groq serves chat completions only — it has no /embeddings endpoint",
};

/**
 * Returns the active embedding configuration, or null when embeddings are
 * not configured. Null is a first-class state: callers degrade to keyword
 * search and SAY SO rather than pretending to be semantic.
 */
export function resolveEmbeddingConfig(): EmbeddingProviderConfig | null {
  const provider = env.EMBEDDING_PROVIDER;
  if (!provider || provider === "none") return null;

  const spec = EMBEDDING_PROVIDERS[provider as EmbeddingProviderId];
  if (!spec) return null;

  const apiKey = env[spec.envKey];
  const model = env.EMBEDDING_MODEL;
  // env.ts makes both boot-fatal when a provider is set; this keeps the
  // function total for callers that run before/without that validation.
  if (!apiKey || !model) return null;

  return {
    provider: provider as EmbeddingProviderId,
    baseUrl: spec.baseUrl,
    apiKey,
    model,
  };
}

export function embeddingsEnabled(): boolean {
  return resolveEmbeddingConfig() !== null;
}
