import type { WheelsAIClient } from "../client.js";

export interface Model {
  id: string;
  hfId: string;
  displayName: string;
  description?: string;
  parameters: number;
  minGpuTier: string;
  supportedEngines: string[];
  defaultEngine: string;
  contextLength: number;
  tags: string[];
  pricingTier: string;
  pricing?: { inputPer1k: number; outputPer1k: number };
  tier?: "free" | "gpu";
}

export interface GpuTier {
  id: string;
  name: string;
  vram: number;
  available: number;
  pricePerHour: number;
}

export function modelsResource(client: WheelsAIClient) {
  return {
    list: (params?: { tag?: string; search?: string; tier?: "free" | "gpu" | "all" }) =>
      client.get<{ models: Model[]; gpuTiers: GpuTier[] }>("/api/models", params),

    get: (modelId: string) =>
      client.get<{ model: Model; compatibleGpuTiers: GpuTier[] }>(`/api/models/${modelId}`),

    free: () =>
      client.get<{ models: Model[]; allModels: Model[] }>("/api/models/free"),

    estimate: (modelId: string, gpuTier: string, replicas: number, hoursPerMonth: number) =>
      client.post<{ estimate: { computePerMonth: number } }>(`/api/models/${modelId}/estimate`, {
        gpuTier,
        replicas,
        hoursPerMonth,
      }),
  };
}
