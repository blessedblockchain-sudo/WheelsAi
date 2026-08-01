import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getAllFreeModels, getAvailableFreeModels } from "../config/free-models.js";
import { MARKETS } from "../services/nosana.js";

// Model catalog - in MVP this is seeded data, in production fetched from DB
const MODEL_CATALOG = [
  // Llama 3.1 Series
  {
    id: "llama-3.1-8b",
    hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    ollamaModelId: "llama3.1:8b",
    displayName: "Llama 3.1 8B Instruct",
    description:
      "Meta's latest instruction-tuned model. Excellent for general tasks.",
    parameters: 8_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "llama3.1",
    tags: ["chat", "instruct", "general"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },
  {
    id: "llama-3.1-70b",
    hfId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    ollamaModelId: "llama3.1:70b",
    displayName: "Llama 3.1 70B Instruct",
    description:
      "Larger Llama model with superior reasoning and instruction following.",
    parameters: 70_000_000_000,
    minGpuTier: "a100",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "llama3.1",
    tags: ["chat", "instruct", "reasoning"],
    pricingTier: "large",
    pricing: {
      inputPer1k: 0.0009,
      outputPer1k: 0.0036,
    },
  },
  {
    id: "llama-3.2-3b",
    hfId: "meta-llama/Llama-3.2-3B-Instruct",
    ollamaModelId: "llama3.2:3b",
    displayName: "Llama 3.2 3B Instruct",
    description: "Compact Llama model optimized for efficiency.",
    parameters: 3_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 8192,
    license: "llama3.2",
    tags: ["chat", "compact", "efficient"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.0001,
      outputPer1k: 0.0004,
    },
  },

  // Mistral Series
  {
    id: "mistral-7b",
    hfId: "mistralai/Mistral-7B-Instruct-v0.2",
    ollamaModelId: "mistral:7b",
    displayName: "Mistral 7B Instruct",
    description: "Fast and efficient model from Mistral AI.",
    parameters: 7_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "apache-2.0",
    tags: ["chat", "instruct", "fast"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },
  {
    id: "mixtral-8x7b",
    hfId: "mistralai/Mixtral-8x7B-Instruct-v0.1",
    ollamaModelId: "mixtral:8x7b",
    displayName: "Mixtral 8x7B",
    description: "Mixture of Experts model with excellent performance.",
    parameters: 46_700_000_000,
    minGpuTier: "a100",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 32768,
    license: "apache-2.0",
    tags: ["chat", "moe", "high-performance"],
    pricingTier: "large",
    pricing: {
      inputPer1k: 0.0007,
      outputPer1k: 0.0028,
    },
  },

  // Code Models
  {
    id: "codellama-7b",
    hfId: "codellama/CodeLlama-7b-Instruct-hf",
    ollamaModelId: "codellama:7b",
    displayName: "Code Llama 7B",
    description: "Fast code generation model for everyday tasks.",
    parameters: 7_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 16384,
    license: "llama2",
    tags: ["code", "instruct", "programming"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },
  {
    id: "codellama-34b",
    hfId: "codellama/CodeLlama-34b-Instruct-hf",
    ollamaModelId: "codellama:34b",
    displayName: "Code Llama 34B",
    description: "Specialized model for code generation and understanding.",
    parameters: 34_000_000_000,
    minGpuTier: "4090",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 16384,
    license: "llama2",
    tags: ["code", "instruct", "programming"],
    pricingTier: "medium",
    pricing: {
      inputPer1k: 0.0003,
      outputPer1k: 0.0012,
    },
  },
  {
    id: "deepseek-coder-6.7b",
    hfId: "deepseek-ai/deepseek-coder-6.7b-instruct",
    ollamaModelId: "deepseek-coder:6.7b",
    displayName: "DeepSeek Coder 6.7B",
    description: "Efficient code generation model from DeepSeek.",
    parameters: 6_700_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 16384,
    license: "deepseek",
    tags: ["code", "instruct", "programming"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },
  {
    id: "deepseek-coder-33b",
    hfId: "deepseek-ai/deepseek-coder-33b-instruct",
    ollamaModelId: "deepseek-coder:33b",
    displayName: "DeepSeek Coder 33B",
    description: "Excellent code generation model from DeepSeek.",
    parameters: 33_000_000_000,
    minGpuTier: "4090",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 16384,
    license: "deepseek",
    tags: ["code", "instruct", "programming"],
    pricingTier: "medium",
    pricing: {
      inputPer1k: 0.0003,
      outputPer1k: 0.0012,
    },
  },

  // Qwen Series
  {
    id: "qwen2-7b",
    hfId: "Qwen/Qwen2-7B-Instruct",
    ollamaModelId: "qwen2:7b",
    displayName: "Qwen2 7B Instruct",
    description: "Alibaba's multilingual model with strong performance.",
    parameters: 7_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 32768,
    license: "apache-2.0",
    tags: ["chat", "multilingual", "long-context"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },
  {
    id: "qwen2.5-coder-7b",
    hfId: "Qwen/Qwen2.5-Coder-7B-Instruct",
    ollamaModelId: "qwen2.5-coder:7b",
    displayName: "Qwen2.5 Coder 7B",
    description: "Specialized coding model from Alibaba.",
    parameters: 7_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 32768,
    license: "apache-2.0",
    tags: ["code", "multilingual", "programming"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },

  // Phi Series (Microsoft)
  {
    id: "phi-3-mini",
    hfId: "microsoft/Phi-3-mini-4k-instruct",
    ollamaModelId: "phi3:mini",
    displayName: "Phi-3 Mini 4K",
    description: "Microsoft's compact but capable model.",
    parameters: 3_800_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 4096,
    license: "mit",
    tags: ["chat", "compact", "efficient"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.0001,
      outputPer1k: 0.0004,
    },
  },
  {
    id: "phi-3-medium",
    hfId: "microsoft/Phi-3-medium-4k-instruct",
    ollamaModelId: "phi3:medium",
    displayName: "Phi-3 Medium 4K",
    description: "Larger Phi-3 model with enhanced capabilities.",
    parameters: 14_000_000_000,
    minGpuTier: "4070",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 4096,
    license: "mit",
    tags: ["chat", "reasoning", "efficient"],
    pricingTier: "medium",
    pricing: {
      inputPer1k: 0.0002,
      outputPer1k: 0.0008,
    },
  },

  // Gemma Series (Google)
  {
    id: "gemma-2b",
    hfId: "google/gemma-2b-it",
    ollamaModelId: "gemma:2b",
    displayName: "Gemma 2B Instruct",
    description: "Google's lightweight open model.",
    parameters: 2_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 8192,
    license: "gemma",
    tags: ["chat", "compact", "efficient"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.0001,
      outputPer1k: 0.0004,
    },
  },
  {
    id: "gemma-7b",
    hfId: "google/gemma-7b-it",
    ollamaModelId: "gemma:7b",
    displayName: "Gemma 7B Instruct",
    description: "Google's capable 7B open model.",
    parameters: 7_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "gemma",
    tags: ["chat", "instruct", "general"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },
  {
    id: "gemma2-9b",
    hfId: "google/gemma-2-9b-it",
    ollamaModelId: "gemma2:9b",
    displayName: "Gemma 2 9B Instruct",
    description: "Google's latest Gemma 2 model with improved performance.",
    parameters: 9_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "gemma",
    tags: ["chat", "instruct", "reasoning"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },

  // Specialized Models
  {
    id: "neural-chat-7b",
    hfId: "Intel/neural-chat-7b-v3-1",
    ollamaModelId: "neural-chat:7b",
    displayName: "Neural Chat 7B",
    description: "Intel's optimized chat model.",
    parameters: 7_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 8192,
    license: "apache-2.0",
    tags: ["chat", "instruct", "optimized"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },
  {
    id: "stablelm-2-zephyr",
    hfId: "stabilityai/stablelm-2-zephyr-1_6b",
    ollamaModelId: "stablelm2:1.6b",
    displayName: "StableLM 2 Zephyr 1.6B",
    description: "Stability AI's ultra-compact chat model.",
    parameters: 1_600_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 4096,
    license: "stability-ai-community",
    tags: ["chat", "compact", "fast"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.0001,
      outputPer1k: 0.0004,
    },
  },
  {
    id: "yi-6b",
    hfId: "01-ai/Yi-6B-Chat",
    ollamaModelId: "yi:6b",
    displayName: "Yi 6B Chat",
    description: "01.AI's efficient chat model with strong Chinese support.",
    parameters: 6_000_000_000,
    minGpuTier: "3060",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "ollama",
    contextLength: 4096,
    license: "yi",
    tags: ["chat", "multilingual", "chinese"],
    pricingTier: "small",
    pricing: {
      inputPer1k: 0.00015,
      outputPer1k: 0.0006,
    },
  },
  {
    id: "yi-34b",
    hfId: "01-ai/Yi-34B-Chat",
    ollamaModelId: "yi:34b",
    displayName: "Yi 34B Chat",
    description: "01.AI's large chat model with excellent capabilities.",
    parameters: 34_000_000_000,
    minGpuTier: "4090",
    supportedEngines: ["vllm", "ollama"],
    defaultEngine: "vllm",
    contextLength: 4096,
    license: "yi",
    tags: ["chat", "multilingual", "reasoning"],
    pricingTier: "medium",
    pricing: {
      inputPer1k: 0.0003,
      outputPer1k: 0.0012,
    },
  },

  // vLLM-only Large Models
  {
    id: "llama-3.1-405b",
    hfId: "meta-llama/Meta-Llama-3.1-405B-Instruct",
    ollamaModelId: null,
    displayName: "Llama 3.1 405B Instruct",
    description: "Meta's flagship model with unmatched capabilities.",
    parameters: 405_000_000_000,
    minGpuTier: "h100",
    supportedEngines: ["vllm"],
    defaultEngine: "vllm",
    contextLength: 8192,
    license: "llama3.1",
    tags: ["chat", "instruct", "flagship"],
    pricingTier: "enterprise",
    pricing: {
      inputPer1k: 0.005,
      outputPer1k: 0.015,
    },
  },
];

// GPU tiers derived from the SAME market table compute metering and
// treasury settlement bill against (services/nosana.ts MARKETS). This
// used to be a second hand-typed table whose prices disagreed with both
// the wizard AND the metered rate — a user picked "$0.25/hr" and was
// billed $0.54. One source of truth; if MARKETS moves, every surface
// moves. Availability counts were invented ("150 available") and are
// intentionally absent until the market-sync worker reports real ones.
const GPU_TIERS = Object.entries(MARKETS).map(([id, market]) => ({
  id,
  name: market.name,
  vram: market.vram,
  pricePerHour: Math.round(market.pricePerSecond * 3600 * 100) / 100,
}));

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
      return { models: gpuModels, gpuTiers: GPU_TIERS };
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
      gpuTiers: GPU_TIERS,
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
    const compatibleTiers = GPU_TIERS.filter(
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
    const gpu = GPU_TIERS.find((t) => t.id === gpuTier);

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
