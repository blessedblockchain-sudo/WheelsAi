import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { MODEL_CATALOG } from "../config/modelCatalog.js";
import {
  TRAINABLE_MODELS,
  TRAINING_FIGURES_BASIS,
  TRAINING_GPU_COUNT,
  TRAINING_METHODS,
  findTrainableModel,
  listTrainableModels,
  planningSetupSeconds,
  planningTokensPerSecond,
  selectTraining,
  trainableTiers,
  type TrainingTierTable,
} from "../config/trainingCatalog.js";
import { BUILTIN_MARKETS } from "../services/nosanaMarkets.js";
import {
  ESTIMATE_HIGH_FACTOR,
  ESTIMATE_LOW_FACTOR,
  estimateTraining,
  type TrainingEstimateInput,
} from "../services/trainingEstimate.js";
import { trainingHoldCents } from "../services/trainingBilling.js";

// The table deployments are billed from: 3060 (8 GB), 4070 (12), 4090 (24),
// a100 (40), h100 (80).
const TIERS: TrainingTierTable = BUILTIN_MARKETS;

// ============================================
// The catalog
// ============================================

test("catalog: every trainable model is a row of the model catalog with the same Hugging Face id", () => {
  assert.ok(TRAINABLE_MODELS.length > 0);
  const ids = new Set<string>();
  for (const model of TRAINABLE_MODELS) {
    assert.equal(ids.has(model.modelId), false, `${model.modelId} listed once`);
    ids.add(model.modelId);
    const row = MODEL_CATALOG.find((entry) => entry.id === model.modelId);
    assert.ok(row, `${model.modelId} is in the model catalog`);
    assert.equal(model.hfId, row.hfId);
    assert.ok(model.paramsBillions > 0);
    assert.ok(Object.keys(model.minVramGb).length > 0, "at least one method");
    for (const method of Object.keys(model.minVramGb)) {
      assert.ok((TRAINING_METHODS as readonly string[]).includes(method), method);
    }
  }
  // The ids the old route listed that never existed are not here.
  for (const gone of ["qwen2.5-7b", "qwen2.5-14b", "qwen2.5-72b"]) {
    assert.equal(findTrainableModel(gone), null);
  }
});

test("catalog: only LoRA and QLoRA, on one GPU, and the figures are labelled as planning", () => {
  assert.deepEqual([...TRAINING_METHODS], ["lora", "qlora"]);
  assert.equal(TRAINING_GPU_COUNT, 1);
  assert.equal(TRAINING_FIGURES_BASIS, "planning");
});

test("catalog: an ungated model exists for a server with no Hugging Face token", () => {
  const open = TRAINABLE_MODELS.filter((model) => !model.gated).map((model) => model.modelId);
  assert.deepEqual(open, ["phi-3-mini", "qwen2-7b"]);
  for (const id of ["llama-3.2-3b", "llama-3.1-8b", "mistral-7b", "llama-3.1-70b"]) {
    assert.equal(findTrainableModel(id)?.gated, true, id);
  }
});

test("tiers: a model and method run on every tier with enough memory, cheapest first", () => {
  const phi = findTrainableModel("phi-3-mini")!;
  assert.deepEqual(
    trainableTiers(phi, "qlora", TIERS).map((t) => t.tier),
    ["4070", "4090", "a100", "h100"],
    "12 GB and up; the 8 GB tier is too small",
  );
  assert.deepEqual(trainableTiers(phi, "lora", TIERS).map((t) => t.tier), ["4090", "a100", "h100"]);

  const qwen = findTrainableModel("qwen2-7b")!;
  assert.deepEqual(trainableTiers(qwen, "qlora", TIERS).map((t) => t.tier), ["4090", "a100", "h100"]);
  assert.deepEqual(trainableTiers(qwen, "lora", TIERS).map((t) => t.tier), ["a100", "h100"]);

  const big = findTrainableModel("llama-3.1-70b")!;
  assert.deepEqual(trainableTiers(big, "qlora", TIERS).map((t) => t.tier), ["h100"]);
  assert.deepEqual(trainableTiers(big, "lora", TIERS), [], "not offered");

  const first = trainableTiers(phi, "qlora", TIERS)[0]!;
  assert.deepEqual(first, { tier: "4070", vramGb: 12, pricePerSecondUsd: 0.00015 }, "the deployment price");
  assert.deepEqual(trainableTiers(phi, "qlora", {}), []);
});

const select = (overrides: Partial<Parameters<typeof selectTraining>[0]> = {}) =>
  selectTraining({
    modelId: "phi-3-mini",
    method: "qlora",
    tier: "4070",
    hfTokenConfigured: false,
    tiers: TIERS,
    ...overrides,
  });

test("select: an accepted choice carries the VRAM requirement and the tier's own price", () => {
  const result = select();
  assert.ok(result.ok);
  assert.equal(result.requiredVramGb, 12);
  assert.equal(result.pricePerSecondUsd, BUILTIN_MARKETS["4070"]!.pricePerSecond);
  assert.equal(result.model.hfId, "microsoft/Phi-3-mini-4k-instruct");
  assert.equal(result.method, "qlora");

  const larger = select({ tier: "a100", method: "lora" });
  assert.ok(larger.ok);
  assert.equal(larger.requiredVramGb, 24);
  assert.equal(larger.pricePerSecondUsd, 0.0008);
  assert.ok(select({ gpuCount: 1 }).ok);
});

test("select: full fine-tuning and unknown methods are refused", () => {
  for (const method of ["full", "8bit", "", "LoRA"]) {
    const result = select({ method });
    assert.equal(result.ok, false, method);
    if (!result.ok) assert.equal(result.code, "unsupported_method");
  }
  const loraOn70b = select({ modelId: "llama-3.1-70b", method: "lora", tier: "h100", hfTokenConfigured: true });
  assert.equal(loraOn70b.ok ? null : loraOn70b.code, "unsupported_method");
});

test("select: more than one GPU is refused", () => {
  for (const gpuCount of [2, 0, 4]) {
    const result = select({ gpuCount });
    assert.equal(result.ok ? null : result.code, "unsupported_gpu_count", String(gpuCount));
  }
});

test("select: a model outside the catalog is refused", () => {
  for (const modelId of ["llama-3.1-405b", "mixtral-8x7b", "qwen2.5-7b", "", "constructor"]) {
    const result = select({ modelId });
    assert.equal(result.ok ? null : result.code, "model_not_trainable", modelId);
  }
});

test("select: a gated model needs the Hugging Face token", () => {
  const without = select({ modelId: "llama-3.2-3b" });
  assert.equal(without.ok ? null : without.code, "hf_token_required");
  assert.ok(select({ modelId: "llama-3.2-3b", hfTokenConfigured: true }).ok);
  assert.ok(select({ modelId: "phi-3-mini", hfTokenConfigured: false }).ok, "an open model does not");
});

test("select: an unknown tier is refused, never priced at a fallback", () => {
  for (const tier of ["rtx-4090", "a100-80gb", "", "toString", "5090"]) {
    const result = select({ tier });
    assert.equal(result.ok ? null : result.code, "unknown_gpu_tier", tier);
  }
  // A tier that exists but is not deployable here is simply not in the table.
  const { "4070": _gone, ...without4070 } = BUILTIN_MARKETS;
  const result = select({ tiers: without4070 });
  assert.equal(result.ok ? null : result.code, "unknown_gpu_tier");
});

test("select: a tier with too little memory is refused with what is needed", () => {
  const result = select({ tier: "3060" });
  assert.equal(result.ok, false);
  if (!result.ok && result.code === "tier_too_small") {
    assert.equal(result.requiredVramGb, 12);
  } else {
    assert.fail("expected tier_too_small");
  }
  const lora = select({ method: "lora", tier: "4070" });
  assert.equal(lora.ok ? null : lora.code, "tier_too_small");
});

test("list: every model with its tiers, and why it cannot start when it cannot", () => {
  const without = listTrainableModels({ tiers: TIERS, hfTokenConfigured: false });
  assert.deepEqual(without.map((m) => m.modelId), TRAINABLE_MODELS.map((m) => m.modelId), "nothing is hidden");
  const phi = without.find((m) => m.modelId === "phi-3-mini")!;
  assert.equal(phi.available, true);
  assert.equal(phi.unavailableReason, null);
  assert.deepEqual(phi.methods.map((m) => [m.method, m.requiredVramGb, m.recommendedTier]), [
    ["lora", 24, "4090"],
    ["qlora", 12, "4070"],
  ]);
  const llama = without.find((m) => m.modelId === "llama-3.1-8b")!;
  assert.equal(llama.available, false);
  assert.equal(llama.unavailableReason, "hf_token_required");

  const withToken = listTrainableModels({ tiers: TIERS, hfTokenConfigured: true });
  assert.equal(withToken.every((m) => m.available), true);
  assert.deepEqual(withToken.find((m) => m.modelId === "llama-3.1-70b")!.methods.map((m) => m.method), ["qlora"]);

  // Only the small tiers are deployable on this server.
  const small = listTrainableModels({
    tiers: { "3060": BUILTIN_MARKETS["3060"]!, "4070": BUILTIN_MARKETS["4070"]! },
    hfTokenConfigured: true,
  });
  assert.equal(small.find((m) => m.modelId === "phi-3-mini")!.available, true);
  const qwen = small.find((m) => m.modelId === "qwen2-7b")!;
  assert.equal(qwen.available, false);
  assert.equal(qwen.unavailableReason, "no_tier_available");
  assert.equal(qwen.methods.every((m) => m.recommendedTier === null), true);
});

test("planning figures: larger models and smaller cards are slower; QLoRA is slower than LoRA", () => {
  const small = { paramsBillions: 3.8 };
  const large = { paramsBillions: 7.6 };
  assert.ok(planningTokensPerSecond(small, "lora", 24) > planningTokensPerSecond(large, "lora", 24));
  assert.ok(planningTokensPerSecond(small, "lora", 24) > planningTokensPerSecond(small, "qlora", 24));
  assert.ok(planningTokensPerSecond(small, "qlora", 24) > planningTokensPerSecond(small, "qlora", 12));
  assert.ok(planningTokensPerSecond(small, "qlora", 80) > planningTokensPerSecond(small, "qlora", 40));
  assert.ok(planningTokensPerSecond({ paramsBillions: 5000 }, "qlora", 8) >= 1, "never zero");
  assert.ok(planningSetupSeconds(large) > planningSetupSeconds(small));
  assert.ok(Number.isInteger(planningSetupSeconds(small)));
});

// ============================================
// The estimate
// ============================================

const RUN_LIMIT = { minSeconds: 300, maxSeconds: 21_600 - 900 };

function estimateInput(overrides: Partial<TrainingEstimateInput> = {}): TrainingEstimateInput {
  return {
    model: findTrainableModel("phi-3-mini")!,
    method: "qlora",
    tierVramGb: 24,
    pricePerSecondUsd: BUILTIN_MARKETS["4090"]!.pricePerSecond,
    rows: 10_000,
    avgTokensPerRow: 400,
    hyperparams: {},
    runLimit: RUN_LIMIT,
    ...overrides,
  };
}

function estimated(overrides: Partial<TrainingEstimateInput> = {}) {
  const result = estimateTraining(estimateInput(overrides));
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result.estimate;
}

test("estimate: tokens, steps and seconds from the dataset and the resolved hyperparameters", () => {
  const e = estimated();
  assert.equal(e.basis, "planning");
  // 10,000 rows x 400 tokens x 3 epochs (the trainer's default).
  assert.equal(e.trainTokens, 12_000_000);
  // 16 rows per optimiser step (batch 4 x accumulation 4): 625 a epoch.
  assert.equal(e.steps, 1875);
  assert.equal(e.tokensPerSecond, planningTokensPerSecond({ paramsBillions: 3.8 }, "qlora", 24));
  assert.equal(e.seconds.train, Math.ceil(12_000_000 / e.tokensPerSecond));
  assert.equal(e.seconds.setup, planningSetupSeconds({ paramsBillions: 3.8 }));
  assert.equal(e.seconds.trainer, e.seconds.setup + e.seconds.train + e.seconds.wrapUp);
  assert.equal(e.seconds.total, e.seconds.imagePull + e.seconds.trainer);
  assert.equal(e.estimate.seconds, e.seconds.total);
});

test("estimate: rows longer than maxSeqLength are counted at maxSeqLength", () => {
  assert.equal(estimated({ avgTokensPerRow: 5000 }).trainTokens, 10_000 * 1024 * 3);
  assert.equal(
    estimated({ avgTokensPerRow: 5000, hyperparams: { maxSeqLength: 256, epochs: 1 } }).trainTokens,
    10_000 * 256,
  );
});

test("estimate: maxSteps cuts the run short", () => {
  const e = estimated({ hyperparams: { maxSteps: 100 } });
  assert.equal(e.steps, 100);
  assert.equal(e.trainTokens, 100 * 16 * 400);
  assert.equal(estimated({ hyperparams: { maxSteps: 20_000 } }).steps, 1875, "a limit past the end changes nothing");
});

test("estimate: a low and a high bound around the estimate, in the price table's money", () => {
  const e = estimated();
  assert.equal(e.pricePerSecondUsd, 0.00025);
  assert.equal(e.priceMicroUsdPerSecond, 250n);
  assert.equal(e.low.seconds, Math.round(e.seconds.total * ESTIMATE_LOW_FACTOR));
  assert.equal(e.high.seconds, Math.round(e.seconds.total * ESTIMATE_HIGH_FACTOR));
  assert.ok(e.low.cents < e.estimate.cents && e.estimate.cents < e.high.cents);
  // Exactly price x seconds, rounded up to a cent.
  assert.equal(e.estimate.cents, BigInt(Math.ceil((e.estimate.seconds * 250) / 10_000)));
  assert.ok(e.high.cents <= e.maximumCents, "never above what is held");
});

test("estimate: the suggested run limit is twice the trainer's planned time, in whole minutes", () => {
  const e = estimated();
  assert.equal(e.runLimit.suggestedSeconds % 60, 0);
  assert.ok(e.runLimit.suggestedSeconds >= e.seconds.trainer * 2);
  assert.ok(e.runLimit.suggestedSeconds < e.seconds.trainer * 2 + 60);
  assert.equal(e.runLimit.appliedSeconds, e.runLimit.suggestedSeconds, "no limit chosen yet");
  assert.equal(e.maximumCents, trainingHoldCents(250n, e.runLimit.suggestedSeconds), "the hold");
  assert.equal(e.fitsRunLimit, true);
  assert.equal(e.suggestionCapped, false);
  assert.deepEqual([e.runLimit.minSeconds, e.runLimit.maxSeconds], [300, 20_700]);
});

test("estimate: a tiny job is still suggested fifteen minutes", () => {
  const e = estimated({ rows: 40, avgTokensPerRow: 70 });
  assert.equal(e.runLimit.suggestedSeconds, 900);
  assert.equal(e.maximumCents, 23n, "900 s on a 4090: 22.5 cents, rounded up");
});

test("estimate: the user's own run limit sets the hold and caps every figure", () => {
  const suggested = estimated();
  const chosen = estimated({ maxRuntimeSeconds: 1800 });
  assert.equal(chosen.runLimit.appliedSeconds, 1800);
  assert.equal(chosen.runLimit.suggestedSeconds, suggested.runLimit.suggestedSeconds, "the suggestion does not move");
  assert.equal(chosen.maximumCents, trainingHoldCents(250n, 1800));
  assert.equal(chosen.maximumCents, 45n);
  for (const bound of [chosen.low, chosen.estimate, chosen.high]) {
    assert.ok(bound.cents <= chosen.maximumCents);
    assert.ok(bound.seconds <= 1800);
  }
  assert.equal(chosen.fitsRunLimit, false, "planned to stop at the limit with a partial adapter");
  assert.equal(estimated({ maxRuntimeSeconds: 20_700 }).fitsRunLimit, true);
});

test("estimate: a run limit outside what the server allows is refused", () => {
  for (const maxRuntimeSeconds of [299, 20_701, 0, -60, 600.5, Number.NaN]) {
    const result = estimateTraining(estimateInput({ maxRuntimeSeconds }));
    assert.equal(result.ok ? null : result.code, "run_limit_out_of_range", String(maxRuntimeSeconds));
  }
  assert.ok(estimateTraining(estimateInput({ maxRuntimeSeconds: 300 })).ok);
  assert.ok(estimateTraining(estimateInput({ maxRuntimeSeconds: 20_700 })).ok);
  // The batch timeout leaves no room after the allowance.
  const none = estimateTraining(estimateInput({ runLimit: { minSeconds: 300, maxSeconds: 200 } }));
  assert.equal(none.ok ? null : none.code, "run_limit_out_of_range");
});

test("estimate: a job too long for the longest limit is suggested that limit and says so", () => {
  const e = estimated({ rows: 200_000, avgTokensPerRow: 1024, hyperparams: { epochs: 10 } });
  assert.equal(e.runLimit.suggestedSeconds, 20_700);
  assert.equal(e.suggestionCapped, true);
  assert.equal(e.fitsRunLimit, false);
  assert.equal(e.maximumCents, trainingHoldCents(250n, 20_700));
  assert.equal(e.high.cents, e.maximumCents, "cut at the hold");
  assert.equal(e.high.seconds, 20_700);
});

test("estimate: a dataset with no counted rows or no measured tokens cannot be estimated", () => {
  for (const rows of [0, -1, 1.5, Number.NaN]) {
    const result = estimateTraining(estimateInput({ rows }));
    assert.equal(result.ok ? null : result.code, "invalid_estimate_input", String(rows));
  }
  for (const avgTokensPerRow of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = estimateTraining(estimateInput({ avgTokensPerRow }));
    assert.equal(result.ok ? null : result.code, "invalid_estimate_input", String(avgTokensPerRow));
  }
  assert.equal(estimateTraining(estimateInput({ tierVramGb: 0 })).ok, false);
  assert.equal(estimateTraining(estimateInput({ pricePerSecondUsd: -1 })).ok, false);
});

test("estimate: a slower tier takes longer; a dearer one costs more for the same time", () => {
  const on4090 = estimated();
  const on4070 = estimated({ tierVramGb: 12, pricePerSecondUsd: BUILTIN_MARKETS["4070"]!.pricePerSecond });
  assert.ok(on4070.seconds.train > on4090.seconds.train);
  const onA100 = estimated({ tierVramGb: 40, pricePerSecondUsd: BUILTIN_MARKETS.a100!.pricePerSecond });
  assert.ok(onA100.seconds.train < on4090.seconds.train);
  assert.ok(onA100.estimate.cents > on4090.estimate.cents);
  assert.equal(estimated({ pricePerSecondUsd: 0 }).maximumCents, 0n, "a free tier holds nothing");
});
