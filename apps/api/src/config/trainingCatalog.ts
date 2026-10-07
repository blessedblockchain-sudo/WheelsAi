/**
 * The trainable catalog: which base models can be fine-tuned, with which
 * method, and on which GPU tiers.
 *
 * Only LoRA and QLoRA on one GPU are offered. "full" fine-tuning and more
 * than one GPU are refused by the API: the training image does neither.
 *
 * EVERY NUMBER IN THIS FILE IS A PLANNING FIGURE
 * ----------------------------------------------
 * Nothing here has been measured: no job has run on a GPU yet
 * (infra/training/README.md, "Not proven until a GPU run"). The VRAM figures
 * decide which tier the API accepts, the throughput and set-up figures feed
 * the estimate shown before a job starts, and both are to be replaced by what
 * metrics.json reports (gpu.peakVramGb, trainTokensPerSecond, timings) after
 * the first paid runs. `TRAINING_FIGURES_BASIS` is returned with every
 * estimate so no page presents them as measurements. Because the tier a job
 * is accepted on rests on these figures, a run that runs out of memory is
 * charged nothing (classifyTrainingOutcome).
 *
 * Prices are not here: a tier's price per second is the one deployments are
 * billed at (MARKETS in services/nosanaMarkets.ts).
 *
 * Pure: the market table is passed in.
 */

export const TRAINING_METHODS = ["lora", "qlora"] as const;
export type TrainingMethod = (typeof TRAINING_METHODS)[number];

/** Always 1: the training image uses one GPU. */
export const TRAINING_GPU_COUNT = 1;

export const TRAINING_FIGURES_BASIS = "planning" as const;

export interface TrainableModel {
  /** A row of `models` (config/modelCatalog.ts). */
  modelId: string;
  /** The same Hugging Face id that catalog row carries. */
  hfId: string;
  /** Billions of parameters, for the throughput and set-up figures. */
  paramsBillions: number;
  /**
   * The Hugging Face repository asks for an accepted licence: offered only
   * when HF_TOKEN is configured. From the model pages, not from a pull.
   */
  gated: boolean;
  /** GB of GPU memory each method is planned to need; absent = not offered. */
  minVramGb: Partial<Record<TrainingMethod, number>>;
}

/**
 * QLoRA loads the base in 4 bits, LoRA in bf16 (about 2 GB per billion
 * parameters before activations): that difference is the whole table.
 */
export const TRAINABLE_MODELS: readonly TrainableModel[] = [
  {
    modelId: "phi-3-mini",
    hfId: "microsoft/Phi-3-mini-4k-instruct",
    paramsBillions: 3.8,
    gated: false,
    minVramGb: { qlora: 12, lora: 24 },
  },
  {
    modelId: "qwen2-7b",
    hfId: "Qwen/Qwen2-7B-Instruct",
    paramsBillions: 7.6,
    gated: false,
    minVramGb: { qlora: 24, lora: 40 },
  },
  {
    modelId: "llama-3.2-3b",
    hfId: "meta-llama/Llama-3.2-3B-Instruct",
    paramsBillions: 3.2,
    gated: true,
    minVramGb: { qlora: 12, lora: 24 },
  },
  {
    modelId: "llama-3.1-8b",
    hfId: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    paramsBillions: 8,
    gated: true,
    minVramGb: { qlora: 24, lora: 40 },
  },
  {
    modelId: "mistral-7b",
    hfId: "mistralai/Mistral-7B-Instruct-v0.2",
    paramsBillions: 7.2,
    gated: true,
    minVramGb: { qlora: 24, lora: 40 },
  },
  {
    // QLoRA only, and only on the 80 GB tier.
    modelId: "llama-3.1-70b",
    hfId: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    paramsBillions: 70,
    gated: true,
    minVramGb: { qlora: 80 },
  },
];

export function findTrainableModel(
  modelId: string,
  catalog: readonly TrainableModel[] = TRAINABLE_MODELS,
): TrainableModel | null {
  return catalog.find((model) => model.modelId === modelId) ?? null;
}

export function isTrainingMethod(value: unknown): value is TrainingMethod {
  return typeof value === "string" && (TRAINING_METHODS as readonly string[]).includes(value);
}

// ============================================
// Tiers
// ============================================

/** The two facts of a GPU tier this file needs (a NosanaMarket has both). */
export interface TrainingTierInfo {
  /** GB of GPU memory. */
  vram: number;
  /** USD per second, retail: what a deployment on the tier is billed. */
  pricePerSecond: number;
}

export type TrainingTierTable = Readonly<Record<string, TrainingTierInfo>>;

export type TrainingSelectionRefusal =
  | { ok: false; code: "model_not_trainable"; message: string }
  | { ok: false; code: "unsupported_method"; message: string }
  | { ok: false; code: "unsupported_gpu_count"; message: string }
  | { ok: false; code: "hf_token_required"; message: string }
  | { ok: false; code: "unknown_gpu_tier"; message: string }
  | { ok: false; code: "tier_too_small"; message: string; requiredVramGb: number };

export type TrainingSelectionResult =
  | {
      ok: true;
      model: TrainableModel;
      method: TrainingMethod;
      tier: string;
      /** The job definition's required_vram. */
      requiredVramGb: number;
      pricePerSecondUsd: number;
    }
  | TrainingSelectionRefusal;

export interface TrainingSelectionInput {
  modelId: string;
  /** As the request sent it: "full" and anything unknown are refused here. */
  method: string;
  tier: string;
  gpuCount?: number;
  hfTokenConfigured: boolean;
  /** The tiers a job may be placed on, e.g. Object.fromEntries(listDeployableTiers(...)). */
  tiers: TrainingTierTable;
  catalog?: readonly TrainableModel[];
}

/**
 * Checks one (model, method, tier) choice. All refusals are 400s of
 * POST /api/training/jobs except model_not_trainable (404) - none moves a row
 * or a credit. An unknown tier is refused, never priced at a fallback.
 */
export function selectTraining(input: TrainingSelectionInput): TrainingSelectionResult {
  const model = findTrainableModel(input.modelId, input.catalog);
  if (!model) {
    return {
      ok: false,
      code: "model_not_trainable",
      message: `Model '${input.modelId}' cannot be fine-tuned`,
    };
  }
  if (!isTrainingMethod(input.method)) {
    return {
      ok: false,
      code: "unsupported_method",
      message: "Only LoRA and QLoRA fine-tuning are offered",
    };
  }
  const requiredVramGb = model.minVramGb[input.method];
  if (requiredVramGb === undefined) {
    return {
      ok: false,
      code: "unsupported_method",
      message: `${model.modelId} can only be fine-tuned with ${Object.keys(model.minVramGb).join(" or ")}`,
    };
  }
  if (input.gpuCount !== undefined && input.gpuCount !== TRAINING_GPU_COUNT) {
    return {
      ok: false,
      code: "unsupported_gpu_count",
      message: "Fine-tuning runs on one GPU",
    };
  }
  if (model.gated && !input.hfTokenConfigured) {
    return {
      ok: false,
      code: "hf_token_required",
      message: `${model.modelId} is not available for fine-tuning right now`,
    };
  }
  const tier = Object.hasOwn(input.tiers, input.tier) ? input.tiers[input.tier] : undefined;
  if (!tier) {
    return {
      ok: false,
      code: "unknown_gpu_tier",
      message: `GPU tier '${input.tier}' is not available`,
    };
  }
  if (tier.vram < requiredVramGb) {
    return {
      ok: false,
      code: "tier_too_small",
      message: `${model.modelId} with ${input.method} needs ${requiredVramGb} GB of GPU memory; '${input.tier}' has ${tier.vram} GB`,
      requiredVramGb,
    };
  }
  return {
    ok: true,
    model,
    method: input.method,
    tier: input.tier,
    requiredVramGb,
    pricePerSecondUsd: tier.pricePerSecond,
  };
}

export interface TrainableTierOption {
  tier: string;
  vramGb: number;
  pricePerSecondUsd: number;
}

/** The tiers a model and method can run on, cheapest first. */
export function trainableTiers(
  model: TrainableModel,
  method: TrainingMethod,
  tiers: TrainingTierTable,
): TrainableTierOption[] {
  const requiredVramGb = model.minVramGb[method];
  if (requiredVramGb === undefined) return [];
  return Object.entries(tiers)
    .filter(([, tier]) => tier.vram >= requiredVramGb)
    .map(([tier, info]) => ({
      tier,
      vramGb: info.vram,
      pricePerSecondUsd: info.pricePerSecond,
    }))
    .sort((a, b) => a.pricePerSecondUsd - b.pricePerSecondUsd || a.vramGb - b.vramGb);
}

export interface TrainableModelOption {
  modelId: string;
  hfId: string;
  gated: boolean;
  /** False with a reason when the model is listed but cannot be started here. */
  available: boolean;
  unavailableReason: "hf_token_required" | "no_tier_available" | null;
  methods: Array<{
    method: TrainingMethod;
    requiredVramGb: number;
    tiers: TrainableTierOption[];
    /** The cheapest tier that fits, or null when none is available. */
    recommendedTier: string | null;
  }>;
}

/**
 * The catalog as a page should show it: every model, each with the tiers it
 * fits on and, when it cannot be started on this server, why.
 */
export function listTrainableModels(args: {
  tiers: TrainingTierTable;
  hfTokenConfigured: boolean;
  catalog?: readonly TrainableModel[];
}): TrainableModelOption[] {
  return (args.catalog ?? TRAINABLE_MODELS).map((model) => {
    const methods = TRAINING_METHODS.filter((method) => model.minVramGb[method] !== undefined).map(
      (method) => {
        const tiers = trainableTiers(model, method, args.tiers);
        return {
          method,
          requiredVramGb: model.minVramGb[method]!,
          tiers,
          recommendedTier: tiers[0]?.tier ?? null,
        };
      },
    );
    const unavailableReason =
      model.gated && !args.hfTokenConfigured
        ? ("hf_token_required" as const)
        : methods.every((entry) => entry.tiers.length === 0)
          ? ("no_tier_available" as const)
          : null;
    return {
      modelId: model.modelId,
      hfId: model.hfId,
      gated: model.gated,
      available: unavailableReason === null,
      unavailableReason,
      methods,
    };
  });
}

// ============================================
// Planning figures for the estimate
// ============================================

/**
 * Training tokens per second of a 1-billion-parameter model with LoRA on a
 * 24 GB card; divided by the model's size and scaled per tier below.
 */
const PLANNING_TOKENS_PER_SECOND_PER_BILLION = 12_000;

/** QLoRA computes through 4-bit weights and gradient checkpointing. */
const PLANNING_QLORA_SLOWDOWN = 0.75;

/** Relative speed of a tier, by GPU memory (24 GB = 1). */
function planningTierSpeed(vramGb: number): number {
  if (vramGb >= 80) return 2;
  if (vramGb >= 40) return 1.1;
  if (vramGb >= 24) return 1;
  if (vramGb >= 12) return 0.55;
  return 0.35;
}

/** Planned training tokens per second. Never a measurement. */
export function planningTokensPerSecond(
  model: Pick<TrainableModel, "paramsBillions">,
  method: TrainingMethod,
  tierVramGb: number,
): number {
  const perSecond =
    (PLANNING_TOKENS_PER_SECOND_PER_BILLION / model.paramsBillions) *
    planningTierSpeed(tierVramGb) *
    (method === "qlora" ? PLANNING_QLORA_SLOWDOWN : 1);
  return Math.max(1, Math.round(perSecond));
}

/**
 * Planned seconds from the trainer starting to its first step: downloading
 * the base model (about 2 GB per billion parameters at about 100 MB/s),
 * loading it and tokenising. This counts against the user's run limit; the
 * image pull before it does not (the set-up allowance covers that).
 */
export function planningSetupSeconds(model: Pick<TrainableModel, "paramsBillions">): number {
  return Math.round(90 + 25 * model.paramsBillions);
}

/**
 * Planned seconds a node spends pulling the image before the trainer starts.
 * Billable when Nosana counts it in the job's run time (not known until a
 * run), so the estimate includes it.
 */
export const PLANNING_IMAGE_PULL_SECONDS = 240;

/** Planned seconds for the last evaluation, the save and the upload. */
export const PLANNING_WRAP_UP_SECONDS = 60;
