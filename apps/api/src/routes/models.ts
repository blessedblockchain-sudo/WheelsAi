import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getAllFreeModels, getAvailableFreeModels } from "../config/free-models.js";
import { env } from "../config/env.js";
import { getNosanaAccessConfig } from "../config/nosanaAccess.js";
import { isNosanaMockEnabled } from "../services/nosana.js";
import { listDeployableTiers, toNosanaNetwork } from "../services/nosanaMarkets.js";
import { MODEL_CATALOG } from "../config/modelCatalog.js";



// GPU tiers derived from the SAME market table compute metering and
// treasury settlement bill against (services/nosanaMarkets.ts MARKETS). This
// used to be a second hand-typed table whose prices disagreed with both
// the wizard AND the metered rate — a user picked "$0.25/hr" and was
// billed $0.54. One source of truth; if MARKETS moves, every surface
// moves. Availability counts were invented ("150 available") and are
// intentionally absent until the market-sync worker reports real ones.
//
// Only tiers that can actually be DEPLOYED are offered: a tier whose Nosana
// market address is not configured for this network (e.g. the built-in mainnet
// markets on devnet with no NOSANA_MARKETS_JSON override) is not selectable —
// the wizard must not offer what deploy would refuse. The dev-only mock
// (ALLOW_NOSANA_MOCK) offers every tier, since it never touches a market.
//
// "This network" is the one Nosana is reached on, as NosanaClient resolves it:
// derived from SOLANA_NETWORK for a wallet-only setup, as it always was, and
// NOSANA_NETWORK (mainnet by default) when the platform pays with an API key -
// the app's own programs can stay on devnet while compute runs on mainnet.
function nosanaNetwork() {
  const access = getNosanaAccessConfig();
  return access.networkDerived ? toNosanaNetwork(env.SOLANA_NETWORK) : access.network;
}

function getGpuTiers() {
  return listDeployableTiers(nosanaNetwork(), {
    allowMock: isNosanaMockEnabled(),
  }).map(([id, market]) => ({
    id,
    name: market.name,
    vram: market.vram,
    pricePerHour: Math.round(market.pricePerSecond * 3600 * 100) / 100,
  }));
}

export const modelRoutes: FastifyPluginAsync = async (app) => {
  // List free models
  app.get("/free", { schema: { tags: ["Models"], description: "List free-tier models" } }, async () => {
    return {
      models: getAvailableFreeModels(),
      allModels: getAllFreeModels(),
    };
  });

  // List all models
  app.get("/", { schema: { tags: ["Models"], description: "List all models" } }, async (request, _reply) => {
    const { tag, search, engine, tier } = z
      .object({
        tag: z.string().optional(),
        minGpu: z.string().optional(),
        search: z.string().optional(),
        engine: z.enum(["vllm", "ollama"]).optional(),
        tier: z.enum(["free", "gpu", "all"]).optional(),
      })
      .parse(request.query);

    // Return only free models
    if (tier === "free") {
      return {
        models: getAvailableFreeModels().map((m) => ({
          ...m,
          tier: "free" as const,
        })),
        gpuTiers: [],
      };
    }

    let models = [...MODEL_CATALOG];

    if (tag) {
      models = models.filter((m) => m.tags.includes(tag));
    }

    if (engine) {
      models = models.filter((m) => m.supportedEngines.includes(engine));
    }

    if (search) {
      const q = search.toLowerCase();
      models = models.filter(
        (m) =>
          m.displayName.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q)
      );
    }

    const gpuModels = models.map((m) => ({ ...m, tier: "gpu" as const }));

    // Include free models in default response unless tier=gpu
    if (tier === "gpu") {
      return { models: gpuModels, gpuTiers: getGpuTiers() };
    }

    const freeModels = getAvailableFreeModels().map((m) => ({
      id: m.id,
      displayName: m.displayName,
      description: m.notes,
      provider: m.provider,
      contextLength: m.contextLength,
      tier: "free" as const,
    }));

    return {
      models: [...freeModels, ...gpuModels],
      gpuTiers: getGpuTiers(),
    };
  });

  // Get single model
  app.get("/:modelId", async (request, reply) => {
    const { modelId } = z
      .object({ modelId: z.string() })
      .parse(request.params);

    const model = MODEL_CATALOG.find((m) => m.id === modelId);

    if (!model) {
      return reply.notFound("Model not found");
    }

    // Find compatible GPU tiers
    const tierOrder = ["3060", "4070", "4090", "a100", "h100"];
    const minIndex = tierOrder.indexOf(model.minGpuTier);
    const compatibleTiers = getGpuTiers().filter(
      (t) => tierOrder.indexOf(t.id) >= minIndex
    );

    return {
      model,
      compatibleGpuTiers: compatibleTiers,
    };
  });

  // Estimate cost for deployment
  app.post("/:modelId/estimate", async (request, reply) => {
    const { modelId } = z
      .object({ modelId: z.string() })
      .parse(request.params);

    const { gpuTier, replicas, hoursPerMonth, engine } = z
      .object({
        gpuTier: z.string(),
        replicas: z.number().int().min(1).max(10).default(1),
        hoursPerMonth: z.number().default(720), // 24/7
        engine: z.enum(["vllm", "ollama"]).optional(),
      })
      .parse(request.body);

    const model = MODEL_CATALOG.find((m) => m.id === modelId);
    const gpu = getGpuTiers().find((t) => t.id === gpuTier);

    if (!model || !gpu) {
      return reply.badRequest("Invalid model or GPU tier");
    }

    // Validate engine compatibility
    if (engine && !model.supportedEngines.includes(engine)) {
      return reply.badRequest(
        `Model ${model.displayName} does not support ${engine} engine`
      );
    }

    const selectedEngine = engine || model.defaultEngine;
    const monthlyCompute = gpu.pricePerHour * hoursPerMonth * replicas;

    // Ollama typically has slightly lower overhead costs
    const overheadMultiplier = selectedEngine === "ollama" ? 0.95 : 1.0;

    return {
      modelId,
      gpuTier,
      replicas,
      hoursPerMonth,
      engine: selectedEngine,
      estimate: {
        computePerMonth: monthlyCompute * overheadMultiplier,
        currency: "USD",
        breakdown: {
          gpuHourlyRate: gpu.pricePerHour,
          totalGpuHours: hoursPerMonth * replicas,
          engineOverhead: overheadMultiplier,
        },
        note:
          selectedEngine === "ollama"
            ? "Ollama offers simplified deployment with slightly lower overhead"
            : "vLLM provides maximum throughput for production workloads",
      },
    };
  });

  // Get supported engines for a model
  app.get("/:modelId/engines", async (request, reply) => {
    const { modelId } = z
      .object({ modelId: z.string() })
      .parse(request.params);

    const model = MODEL_CATALOG.find((m) => m.id === modelId);

    if (!model) {
      return reply.notFound("Model not found");
    }

    const engines = model.supportedEngines.map((engine) => ({
      id: engine,
      name: engine === "vllm" ? "vLLM" : "Ollama",
      isDefault: engine === model.defaultEngine,
      description:
        engine === "vllm"
          ? "High-throughput serving with PagedAttention"
          : "Simple deployment with OpenAI-compatible API",
      ollamaModelId: engine === "ollama" ? model.ollamaModelId : null,
    }));

    return {
      modelId,
      engines,
      defaultEngine: model.defaultEngine,
    };
  });
};
