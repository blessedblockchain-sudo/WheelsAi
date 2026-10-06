import { seg, type WheelsAIClient } from "../client.js";

/** A deployable GPU model from the catalog (`tier: "gpu"`). */
export interface Model {
  id: string;
  hfId?: string;
  ollamaModelId?: string;
  displayName: string;
  description?: string;
  parameters?: number;
  /** A GPU tier id such as `3060`, `a100`. */
  minGpuTier?: string;
  supportedEngines?: Array<"vllm" | "ollama">;
  defaultEngine?: "vllm" | "ollama";
  contextLength: number;
  license?: string;
  tags?: string[];
  pricingTier?: string;
  pricing?: { inputPer1k: number; outputPer1k: number };
  /** Free-tier models carry a provider instead. */
  provider?: string;
  tier?: "free" | "gpu";
}

/** A GPU tier this API can deploy to right now. */
export interface GpuTier {
  id: string;
  name: string;
  /** GB of VRAM. */
  vram: number;
  /** USD. */
  pricePerHour: number;
}

export interface FreeModel {
  id: string;
  provider: string;
  displayName: string;
  contextLength: number;
  notes: string;
  [field: string]: unknown;
}

export function modelsResource(client: WheelsAIClient) {
  return {
    /**
     * The model catalog plus `gpuTiers`: the GPU tier ids this API can deploy
     * (an empty list means nothing is deployable on this server).
     */
    list: (params?: {
      tag?: string;
      search?: string;
      engine?: "vllm" | "ollama";
      tier?: "free" | "gpu" | "all";
    }) =>
      client.get<{ models: Model[]; gpuTiers: GpuTier[] }>("/api/models", params),

    /**
     * The deployable GPU tiers (`GET /api/models?tier=gpu`). The list is empty when this
     * server has no compute configured (no Nosana wallet or markets). A model deployment
     * is then refused up front (501 or 400). An agent deployment is accepted and reserves
     * credits first; it ends as `failed` with the reason in `lastError`, and the reservation
     * is released.
     */
    gpuTiers: async (): Promise<GpuTier[]> => {
      const { gpuTiers } = await client.get<{ models: Model[]; gpuTiers: GpuTier[] }>("/api/models", {
        tier: "gpu",
      });
      return gpuTiers;
    },

    get: (modelId: string) =>
      client.get<{ model: Model; compatibleGpuTiers: GpuTier[] }>(`/api/models/${seg(modelId)}`),

    free: () =>
      client.get<{ models: FreeModel[]; allModels: FreeModel[] }>("/api/models/free"),

    engines: (modelId: string) =>
      client.get<{
        modelId: string;
        engines: Array<{ id: string; name: string; isDefault: boolean; description: string; ollamaModelId: string | null }>;
        defaultEngine: string;
      }>(`/api/models/${seg(modelId)}/engines`),

    estimate: (
      modelId: string,
      gpuTier: string,
      replicas: number,
      hoursPerMonth: number,
      engine?: "vllm" | "ollama",
    ) =>
      client.post<{
        modelId: string;
        gpuTier: string;
        replicas: number;
        hoursPerMonth: number;
        engine: string;
        estimate: {
          computePerMonth: number;
          currency: string;
          breakdown: { gpuHourlyRate: number; totalGpuHours: number; engineOverhead: number };
          note: string;
        };
      }>(`/api/models/${seg(modelId)}/estimate`, { gpuTier, replicas, hoursPerMonth, engine }),
  };
}
