/**
 * How fine-tuning is worded and worked out in the dashboard. Run with:
 *   cd apps/web && npx tsx --test src/lib/training.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ApiError, type TrainableModel, type TrainingCapabilities, type TrainingJob } from "./api";
import { HOSTED_GROUP_LABEL } from "./model-choice";
import {
  DEPLOY_UNAVAILABLE_MESSAGE,
  NOSANA_RECORD_EXPLANATION,
  NOSANA_RECORD_HEADING,
  canCancelTraining,
  canRetryTraining,
  deployUnavailableMessage,
  fineTunedModelAgentHint,
  nosanaRecordView,
  datasetFileTypeFromName,
  datasetRowFormat,
  datasetTrainingBlocker,
  formatBytes,
  formatGpuRate,
  formatHourlyRate,
  formatParameters,
  hyperparamError,
  hyperparamFormDefaults,
  hyperparamFormErrors,
  hyperparamsToSend,
  insufficientCreditsSentence,
  isLegacyTrainingJob,
  isTerminalTrainingStatus,
  lossPolyline,
  methodBlocker,
  methodOf,
  runLimitError,
  runLimitMinuteBounds,
  tierChoices,
  trainingCostView,
  trainingLedgerLabel,
  trainingRefusal,
  trainingSettlement,
  trainingStatusView,
  trainingTimeline,
  trainingTotals,
} from "./training";

const here = dirname(fileURLToPath(import.meta.url));
const page = (path: string) =>
  readFileSync(join(here, "../app/(dashboard)/dashboard", path), "utf8");

const STATES = [
  "pending",
  "submitting",
  "queued",
  "running",
  "finalizing",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
] as const;

function job(overrides: Partial<TrainingJob> = {}): TrainingJob {
  return {
    id: "j1",
    name: "job",
    baseModelId: "phi-3-mini",
    baseModelHfId: "microsoft/Phi-3-mini-4k-instruct",
    datasetId: "d1",
    datasetName: "data",
    method: "lora",
    gpuTier: "4090",
    gpuCount: 1,
    status: "pending",
    progress: 0,
    currentEpoch: null,
    totalEpochs: null,
    currentStep: null,
    totalSteps: null,
    trainingLoss: null,
    evalLoss: null,
    failureCode: null,
    lastError: null,
    failure: null,
    maxRuntimeSeconds: 3600,
    estimatedCostCents: null,
    reservationCents: 540,
    costSoFarCents: null,
    actualCostCents: null,
    billedSeconds: null,
    charged: null,
    pricePerSecondUsd: 0.0015,
    outputModelId: null,
    createdAt: "2026-10-12T10:00:00.000Z",
    queuedAt: null,
    startedAt: null,
    cancelRequestedAt: null,
    gpuStoppedAt: null,
    completedAt: null,
    settledAt: null,
    ...overrides,
  };
}

// ============================================
// States
// ============================================

test("every one of the nine states has a label and a sentence", () => {
  for (const state of STATES) {
    const view = trainingStatusView(state);
    assert.ok(view.label.length > 0, state);
    assert.ok(view.description.length > 0, state);
  }
});

test("a state this build does not know is shown as it is, with no invented meaning", () => {
  assert.deepEqual(trainingStatusView("paused"), { label: "paused", variant: "secondary", description: "" });
});

test("queued says the wait is free; cancelling says the stop is not charged", () => {
  assert.match(trainingStatusView("queued").description, /free/);
  assert.match(trainingStatusView("cancelling").description, /not charged/);
});

test("terminal, cancellable and retryable states match the API's rules", () => {
  assert.deepEqual(STATES.filter(isTerminalTrainingStatus), ["completed", "failed", "cancelled"]);
  // CANCELLABLE_TRAINING_STATES of the API: finalizing and cancelling answer 409.
  assert.deepEqual(STATES.filter(canCancelTraining), ["pending", "submitting", "queued", "running"]);
  assert.deepEqual(STATES.filter(canRetryTraining), ["failed", "cancelled"]);
});

// ============================================
// Money
// ============================================

test("cost of a queued job is the hold", () => {
  const view = trainingCostView(job({ status: "queued" }));
  assert.equal(view.kind, "held");
  assert.equal(view.label, "Held");
  assert.equal(view.text, "$5.40");
});

test("cost of a running job is the cost so far, not the hold", () => {
  const view = trainingCostView(job({ status: "running", costSoFarCents: 123 }));
  assert.equal(view.kind, "so_far");
  assert.equal(view.text, "$1.23");
});

test("cost of a settled job is the charge", () => {
  const view = trainingCostView(
    job({ status: "completed", actualCostCents: 210, settledAt: "2026-10-12T11:00:00.000Z" }),
  );
  assert.equal(view.kind, "charged");
  assert.equal(view.text, "$2.10");
});

test("a settled job charged nothing says so, and never shows the hold as a cost", () => {
  const view = trainingCostView(
    job({ status: "failed", actualCostCents: 0, settledAt: "2026-10-12T11:00:00.000Z" }),
  );
  assert.equal(view.kind, "not_charged");
  assert.equal(view.text, "$0.00");
});

test("a row from before holds existed has no cost figure invented for it", () => {
  const view = trainingCostView(job({ status: "completed", reservationCents: null }));
  assert.equal(view.kind, "unknown");
  assert.equal(view.cents, null);
});

test("settlement is the hold, the charge and the rest returned", () => {
  assert.equal(trainingSettlement(job()), null);
  assert.deepEqual(
    trainingSettlement(job({ actualCostCents: 210, settledAt: "2026-10-12T11:00:00.000Z" })),
    { holdCents: 540, chargeCents: 210, returnedCents: 330 },
  );
  assert.deepEqual(
    trainingSettlement(job({ actualCostCents: null, settledAt: "2026-10-12T11:00:00.000Z" })),
    { holdCents: 540, chargeCents: 0, returnedCents: 540 },
  );
});

test("totals are sums of API fields: charges of settled jobs, holds of live ones", () => {
  const settled = "2026-10-12T11:00:00.000Z";
  const totals = trainingTotals([
    job({ status: "completed", actualCostCents: 210, billedSeconds: 1400, settledAt: settled }),
    job({ status: "failed", actualCostCents: 0, billedSeconds: 0, settledAt: settled }),
    job({ status: "cancelled", actualCostCents: 40, billedSeconds: 300, settledAt: settled }),
    job({ status: "running", costSoFarCents: 99 }),
    job({ status: "queued", reservationCents: 100 }),
  ]);
  assert.deepEqual(totals, {
    total: 5,
    active: 2,
    running: 1,
    completed: 1,
    chargedCents: 250,
    heldCents: 640,
    billedSeconds: 1700,
  });
});

test("totals of no jobs are zero, not a placeholder", () => {
  assert.deepEqual(trainingTotals([]), {
    total: 0,
    active: 0,
    running: 0,
    completed: 0,
    chargedCents: 0,
    heldCents: 0,
    billedSeconds: 0,
  });
});

test("a GPU rate is shown per second and per hour", () => {
  assert.equal(formatGpuRate(0.00015), "$0.00015 per second ($0.54 per hour)");
  assert.equal(formatHourlyRate(0.00015), "$0.54/hr");
});

test("ledger types have plain labels; an unknown one is shown as it is", () => {
  assert.equal(trainingLedgerLabel("training_reservation"), "Hold taken");
  assert.equal(trainingLedgerLabel("training_reservation_release"), "Hold returned");
  assert.equal(trainingLedgerLabel("training_usage"), "Charge for GPU time");
  assert.equal(trainingLedgerLabel("other"), "other");
});

// ============================================
// Time
// ============================================

test("the timeline lists only the times the API recorded, in order", () => {
  const timeline = trainingTimeline(
    job({
      status: "cancelled",
      queuedAt: "2026-10-12T10:00:05.000Z",
      startedAt: "2026-10-12T10:04:00.000Z",
      cancelRequestedAt: "2026-10-12T10:10:00.000Z",
      gpuStoppedAt: "2026-10-12T10:10:20.000Z",
      completedAt: "2026-10-12T10:10:21.000Z",
      settledAt: "2026-10-12T10:10:21.500Z",
    }),
  );
  assert.deepEqual(
    timeline.map((entry) => entry.key),
    ["created", "queued", "started", "cancelRequested", "gpuStopped", "completed", "settled"],
  );
  assert.equal(timeline.find((entry) => entry.key === "completed")!.label, "Cancelled");
  assert.deepEqual(
    trainingTimeline(job()).map((entry) => entry.key),
    ["created"],
  );
});

test("a row from before jobs held credits is not described as held or settled", () => {
  const legacy = job({ status: "completed", reservationCents: null });
  assert.equal(isLegacyTrainingJob(legacy), true);
  assert.equal(trainingTimeline(legacy)[0]!.label, "Created");
  assert.equal(trainingTimeline(job())[0]!.label, "Created, credits held");
  assert.equal(isLegacyTrainingJob(job({ status: "queued", reservationCents: null })), false);
  assert.equal(
    isLegacyTrainingJob(job({ status: "completed", settledAt: "2026-10-12T11:00:00.000Z" })),
    false,
  );
});

test("run limit bounds in minutes stay inside the API's bounds in seconds", () => {
  assert.deepEqual(runLimitMinuteBounds({ minSeconds: 300, maxSeconds: 85_500 }), {
    minMinutes: 5,
    maxMinutes: 1425,
  });
  // 301 s is more than 5 minutes: 5 would be refused by the API.
  assert.equal(runLimitMinuteBounds({ minSeconds: 301, maxSeconds: 659 }).minMinutes, 6);
  assert.equal(runLimitMinuteBounds({ minSeconds: 301, maxSeconds: 659 }).maxMinutes, 10);
});

test("a run limit outside the bounds, or not a whole number, is refused in words", () => {
  const bounds = { minSeconds: 300, maxSeconds: 3600 };
  assert.equal(runLimitError("30", bounds), null);
  assert.equal(runLimitError("5", bounds), null);
  assert.equal(runLimitError("60", bounds), null);
  assert.match(runLimitError("4", bounds)!, /from 5 to 60 minutes/);
  assert.match(runLimitError("61", bounds)!, /from 5 to 60 minutes/);
  assert.match(runLimitError("7.5", bounds)!, /whole number/);
  assert.match(runLimitError("abc", bounds)!, /whole number/);
});

// ============================================
// Datasets
// ============================================

test("the file type comes from the extension, by the API's rule", () => {
  assert.equal(datasetFileTypeFromName("train.jsonl"), "jsonl");
  assert.equal(datasetFileTypeFromName("train.NDJSON"), "jsonl");
  assert.equal(datasetFileTypeFromName("train.json"), "jsonl");
  assert.equal(datasetFileTypeFromName("rows.csv"), "csv");
  assert.equal(datasetFileTypeFromName("rows.v2.parquet"), "parquet");
  assert.equal(datasetFileTypeFromName("notes.txt"), null);
  assert.equal(datasetFileTypeFromName("archive.tar.gz"), null);
  assert.equal(datasetFileTypeFromName("noextension"), null);
});

test("the detected row format is named; none and unknown ones are not dressed up", () => {
  assert.equal(datasetRowFormat("alpaca").label, "Alpaca");
  assert.match(datasetRowFormat("completion").shape!, /prompt, completion/);
  assert.deepEqual(datasetRowFormat(null), { label: "Not detected yet", shape: null });
  assert.deepEqual(datasetRowFormat("custom"), { label: "custom", shape: null });
});

test("a dataset that the API would refuse to train on carries the reason", () => {
  const ok = { isValidated: true, rowCount: 120, contentSha256: "a".repeat(64) };
  assert.equal(datasetTrainingBlocker(ok), null);
  assert.match(datasetTrainingBlocker({ ...ok, isValidated: false })!, /has not passed validation/);
  assert.match(datasetTrainingBlocker({ ...ok, rowCount: null })!, /could not be counted/);
  assert.match(datasetTrainingBlocker({ ...ok, contentSha256: null })!, /Validate it again/);
});

test("sizes read in the unit that fits", () => {
  assert.equal(formatBytes(12), "12 bytes");
  assert.equal(formatBytes(340 * 1024), "340 KB");
  assert.equal(formatBytes(1.2 * 1024 * 1024), "1.20 MB");
  assert.equal(formatBytes(2 * 1024 ** 3), "2.00 GB");
});

// ============================================
// Models, methods and tiers
// ============================================

const capabilities = {
  nosana: {
    configured: true,
    mock: false,
    tiers: [
      { tier: "a100", name: "A100", vramGb: 40, pricePerSecondUsd: 0.0005, deployable: true },
      { tier: "3060", name: "RTX 3060", vramGb: 12, pricePerSecondUsd: 0.00005, deployable: true },
      { tier: "4090", name: "RTX 4090", vramGb: 24, pricePerSecondUsd: 0.00015, deployable: true },
      { tier: "h100", name: "H100", vramGb: 80, pricePerSecondUsd: 0.001, deployable: false },
    ],
  },
} satisfies Pick<TrainingCapabilities, "nosana">;

const model: TrainableModel = {
  id: "llama-3.1-8b",
  hfId: "meta-llama/Llama-3.1-8B-Instruct",
  displayName: "Llama 3.1 8B",
  parameters: 8_000_000_000,
  gated: true,
  available: true,
  unavailableReason: null,
  unavailableMessage: null,
  methods: [
    {
      method: "qlora",
      requiredVramGb: 24,
      tiers: [
        { tier: "4090", vramGb: 24, pricePerSecondUsd: 0.00015 },
        { tier: "a100", vramGb: 40, pricePerSecondUsd: 0.0005 },
      ],
      recommendedTier: "4090",
    },
    { method: "lora", requiredVramGb: 80, tiers: [], recommendedTier: null },
  ],
  supportedMethods: ["qlora", "lora"],
  recommendedGpuTier: "4090",
  figuresBasis: "planning",
};

test("tiers the API offers for the method are selectable; the rest carry their reason", () => {
  const choices = tierChoices(capabilities, methodOf(model, "qlora"));
  assert.deepEqual(
    choices.map((c) => [c.tier, c.selectable]),
    [
      ["3060", false],
      ["4090", true],
      ["a100", true],
      ["h100", false],
    ],
  );
  assert.match(choices[0]!.reason!, /Too small: this needs 24 GB/);
  assert.equal(choices[1]!.reason, null);
  assert.equal(choices[3]!.reason, "Not available right now.");
});

test("with no method chosen no tier is selectable", () => {
  assert.ok(tierChoices(capabilities, undefined).every((c) => !c.selectable && c.reason !== null));
});

test("a method that fits no tier of this server says what it needs", () => {
  assert.equal(methodBlocker(methodOf(model, "qlora")!), null);
  assert.match(methodBlocker(methodOf(model, "lora")!)!, /80 GB.*none is available/);
  assert.equal(methodOf(model, "full"), undefined);
});

test("parameter counts are shortened", () => {
  assert.equal(formatParameters(8_000_000_000), "8B");
  assert.equal(formatParameters(3_800_000_000), "3.8B");
  assert.equal(formatParameters(70_000_000_000), "70B");
  assert.equal(formatParameters(null), null);
});

// ============================================
// Hyperparameters
// ============================================

const hyperparameters: TrainingCapabilities["hyperparameters"] = {
  bounds: {
    epochs: { min: 1, max: 10, integer: true },
    batchSize: { min: 1, max: 16, integer: true },
    gradientAccumulationSteps: { min: 1, max: 32, integer: true },
    learningRate: { min: 1e-6, max: 1e-3, integer: false },
    warmupRatio: { min: 0, max: 0.2, integer: false },
    loraAlpha: { min: 1, max: 128, integer: true },
    loraDropout: { min: 0, max: 0.3, integer: false },
    maxSeqLength: { min: 128, max: 4096, integer: true },
  },
  defaults: {
    epochs: 3,
    batchSize: 4,
    gradientAccumulationSteps: 4,
    learningRate: 2e-4,
    warmupRatio: 0.03,
    loraR: 16,
    loraAlpha: 32,
    loraDropout: 0.05,
    targetModules: "all-linear",
    maxSeqLength: 1024,
    maxSteps: null,
    evalSplit: null,
    seed: 42,
  },
  loraRanks: [4, 8, 16, 32, 64],
};

test("the form starts from the API's defaults and sends nothing when nothing changed", () => {
  const form = hyperparamFormDefaults(hyperparameters);
  assert.equal(form.epochs, "3");
  assert.equal(form.learningRate, "0.0002");
  assert.equal(form.loraR, "16");
  assert.deepEqual(hyperparamFormErrors(form, hyperparameters), {});
  assert.deepEqual(hyperparamsToSend(form, hyperparameters), {});
});

test("only the changed values are sent, as numbers, and never a key the trainer does not have", () => {
  const form = { ...hyperparamFormDefaults(hyperparameters), epochs: "5", loraR: "32", learningRate: "1e-4" };
  const sent = hyperparamsToSend(form, hyperparameters);
  assert.deepEqual(sent, { epochs: 5, learningRate: 0.0001, loraR: 32 });
  for (const key of Object.keys(sent)) assert.ok(key in hyperparameters.defaults, key);
});

test("values outside the API's bounds are refused in words before anything is sent", () => {
  assert.equal(hyperparamError("Epochs", "3", hyperparameters.bounds.epochs), null);
  assert.match(hyperparamError("Epochs", "11", hyperparameters.bounds.epochs)!, /from 1 to 10/);
  assert.match(hyperparamError("Epochs", "2.5", hyperparameters.bounds.epochs)!, /whole number/);
  assert.match(hyperparamError("Epochs", "", hyperparameters.bounds.epochs)!, /must be a number/);
  assert.match(hyperparamError("Learning rate", "0.01", hyperparameters.bounds.learningRate)!, /from 0.000001 to 0.001/);
  const errors = hyperparamFormErrors(
    { ...hyperparamFormDefaults(hyperparameters), batchSize: "64", loraR: "7" },
    hyperparameters,
  );
  assert.deepEqual(Object.keys(errors).sort(), ["batchSize", "loraR"]);
  assert.match(errors.loraR!, /one of 4, 8, 16, 32, 64/);
});

// ============================================
// Refusals
// ============================================

test("a refusal keeps the API's code, sentence and figures", () => {
  const view = trainingRefusal(
    new ApiError(402, "Payment Required", {
      error: "insufficient_credits",
      message: "Not enough credits.",
      requiredCents: 540,
      balanceCents: 120,
    }),
  );
  assert.deepEqual(view, {
    status: 402,
    code: "insufficient_credits",
    message: "Not enough credits.",
    requiredCents: 540,
    balanceCents: 120,
    field: null,
  });
  assert.equal(
    insufficientCreditsSentence(view!),
    "This run holds $5.40 and your balance is $1.20. Add at least $4.20 to start it.",
  );
});

test("402 without figures still says what happened and invents no amount", () => {
  assert.equal(
    insufficientCreditsSentence({ requiredCents: null, balanceCents: null }),
    "Your balance does not cover the amount this run would hold.",
  );
  assert.equal(
    insufficientCreditsSentence({ requiredCents: 540, balanceCents: null }),
    "This run holds $5.40, which is more than your balance.",
  );
});

test("a hyperparameter refusal names its field; a non-API error is not a refusal", () => {
  const view = trainingRefusal(
    new ApiError(400, "Bad Request", {
      error: "invalid_hyperparameter",
      field: "epochs",
      message: "epochs must be a whole number from 1 to 10",
    }),
  );
  assert.equal(view!.field, "epochs");
  assert.equal(trainingRefusal(new Error("network")), null);
});

// ============================================
// Loss
// ============================================

test("a loss series becomes a line inside its box; fewer than two points draw nothing", () => {
  assert.equal(lossPolyline(undefined, 300, 80), null);
  assert.equal(lossPolyline([[1, 2.5]], 300, 80), null);
  assert.equal(
    lossPolyline(
      [
        [0, 2],
        [50, 1.5],
        [100, 1],
      ],
      300,
      80,
    ),
    "0.0,0.0 150.0,40.0 300.0,80.0",
  );
  // A flat series must not divide by zero.
  assert.equal(lossPolyline([[0, 1], [10, 1]], 300, 80), "0.0,80.0 300.0,80.0");
});

// ============================================
// The pages
// ============================================

const TRAINING_PAGES = [
  "training/page.tsx",
  "training/new/page.tsx",
  "training/[id]/page.tsx",
  "training/datasets/page.tsx",
  "training/models/[id]/page.tsx",
];

test("no training page carries a price, a tier or a model id of its own", () => {
  for (const path of TRAINING_PAGES) {
    const source = page(path);
    // The old pages priced GPU time at a constant and listed tiers by hand.
    assert.doesNotMatch(source, /\$0\.\d+|\/ 50\b|rtx-\d|costPerHour/, path);
    assert.doesNotMatch(source, /"(3060|4070|4090|a100|h100)"/, path);
    assert.doesNotMatch(source, /liveProgress|quantizationBits|warmupSteps/, path);
  }
});

test("the list and the new-job page read capabilities and show its blockers", () => {
  for (const path of ["training/page.tsx", "training/new/page.tsx", "training/[id]/page.tsx"]) {
    const source = page(path);
    assert.match(source, /trainingApi\.getCapabilities\(\)/, path);
    assert.match(source, /<TrainingBlockers /, path);
  }
  // The sentences are the API's: the component prints blocker.message as it is.
  assert.match(page("training/_components/training-blockers.tsx"), /\{blocker\.message\}/);
});

test("the action is disabled, not hidden, when a job cannot start", () => {
  assert.match(page("training/page.tsx"), /<Button size="sm" disabled data-testid="new-training-job">/);
  assert.match(page("training/new/page.tsx"), /disabled=\{!capabilities\.canStart\}/);
});

test("the new-job page honours ?dataset= and sends the reviewed run limit", () => {
  const source = page("training/new/page.tsx");
  assert.match(source, /useSearchParams\(\)\.get\("dataset"\)/);
  // The reviewed limit is the hold's, which exists with or without an estimate.
  assert.match(source, /const held = estimate\.hold;/);
  assert.match(source, /maxRuntimeSeconds: held\.maxRuntimeSeconds/);
  assert.match(source, /href="\/dashboard\/billing"/);
});

test("the new-job page can start a job on a dataset with no estimate (Parquet): run limit required, hold reviewed", () => {
  // Found by review: Start was reachable only through a successful estimate,
  // and a Parquet dataset never has one.
  const source = page("training/new/page.tsx");
  assert.match(source, /const needsRunLimit = dataset !== null && dataset\.avgTokensPerRow === null;/);
  assert.match(source, /needsRunLimit && runLimitMinutes\.trim\(\) === ""/);
  assert.match(source, /data-testid="training-no-estimate"/);
  assert.match(source, /Hold \{formatCents\(hold\.cents\)\} and start/);
  assert.doesNotMatch(source, /e\.maximumCents/);
});

test("deployment creation sends fineTunedModelId and no modelId for a fine-tuned model", () => {
  const source = page("deployments/new/page.tsx");
  assert.match(source, /useSearchParams\(\)\.get\("fineTunedModel"\)/);
  assert.match(source, /\? \{ fineTunedModelId: selectedFineTuned\.id \}\s+: \{ modelId: selectedModel\.id \}/);
});

// ============================================
// The record on Nosana, and using a fine-tuned model
// ============================================

// The form of a Solana address; not a job that exists.
const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const JOB_URL = `https://explore.nosana.com/jobs/${ADDRESS}`;

test("a run's record on Nosana is shown as the API gave it", () => {
  assert.deepEqual(nosanaRecordView({ deploymentId: "dep-1", jobAddress: ADDRESS, jobUrl: JOB_URL }), {
    jobAddress: ADDRESS,
    jobUrl: JOB_URL,
    deploymentId: "dep-1",
  });
  // An address with no page to link to (a devnet run): the address, no link.
  assert.deepEqual(nosanaRecordView({ deploymentId: null, jobAddress: ADDRESS, jobUrl: null }), {
    jobAddress: ADDRESS,
    jobUrl: null,
    deploymentId: null,
  });
  // Submitted, no job yet: the deployment id alone.
  assert.deepEqual(nosanaRecordView({ deploymentId: "dep-1", jobAddress: null, jobUrl: null }), {
    jobAddress: null,
    jobUrl: null,
    deploymentId: "dep-1",
  });
});

test("no record is shown for a job that never reached Nosana, or for an API that does not send one", () => {
  assert.equal(nosanaRecordView(undefined), null);
  assert.equal(nosanaRecordView(null), null);
  assert.equal(nosanaRecordView({}), null);
  assert.equal(nosanaRecordView({ deploymentId: null, jobAddress: null, jobUrl: null }), null);
  assert.equal(nosanaRecordView({ deploymentId: "", jobAddress: "  ", jobUrl: null }), null);
  // A link with nothing it is the page of is not a record.
  assert.equal(nosanaRecordView({ deploymentId: null, jobAddress: null, jobUrl: JOB_URL }), null);
});

test("only Nosana's own page for a job is ever a link", () => {
  for (const jobUrl of [
    "javascript:alert(1)",
    `http://explore.nosana.com/jobs/${ADDRESS}`,
    `https://explore.nosana.com.example.org/jobs/${ADDRESS}`,
    `https://example.org/jobs/${ADDRESS}`,
    `https://explore.nosana.com/jobs/${ADDRESS}/../x`,
    `https://explore.nosana.com/jobs/${ADDRESS}?next=x`,
    "https://explore.nosana.com/jobs/",
    `https://explore.nosana.com/jobs/${ADDRESS}?network=devnet`,
  ]) {
    const view = nosanaRecordView({ deploymentId: null, jobAddress: ADDRESS, jobUrl });
    assert.equal(view?.jobUrl, null, jobUrl);
    assert.equal(view?.jobAddress, ADDRESS);
  }
});

test("the words of the record on Nosana", () => {
  assert.equal(NOSANA_RECORD_HEADING, "Record on Nosana");
  assert.equal(
    NOSANA_RECORD_EXPLANATION,
    "This run is a job on the Nosana network. Anyone can look it up by its address.",
  );
});

test("Deploy is offered unless the API says a fine-tuned model cannot be deployed", () => {
  const blocker = { code: "adapter_storage_not_configured", message: DEPLOY_UNAVAILABLE_MESSAGE };
  assert.equal(deployUnavailableMessage({ deploy: { available: true, blockers: [] } }), null);
  // Not read yet, failed to load, or an older API: the button stays as it was.
  assert.equal(deployUnavailableMessage(null), null);
  assert.equal(deployUnavailableMessage(undefined), null);
  assert.equal(deployUnavailableMessage({}), null);
  assert.equal(deployUnavailableMessage({ deploy: { available: false, blockers: [blocker] } }), blocker.message);
  // The first blocker's sentence, as the API wrote it.
  assert.equal(
    deployUnavailableMessage({
      deploy: {
        available: false,
        blockers: [
          { code: "a", message: "First sentence." },
          { code: "b", message: "Second sentence." },
        ],
      },
    }),
    "First sentence.",
  );
  // Not available and no sentence: the one sentence of the contract.
  assert.equal(deployUnavailableMessage({ deploy: { available: false, blockers: [] } }), DEPLOY_UNAVAILABLE_MESSAGE);
  assert.equal(
    DEPLOY_UNAVAILABLE_MESSAGE,
    "Deploying fine-tuned models is temporarily unavailable. Try again later.",
  );
});

test("the agent hint names the picker's group by the picker's own label", () => {
  assert.equal(
    fineTunedModelAgentHint({ deployments: [] }),
    `Once it is deployed and running, this model can power an agent: choose it in the agent's Settings, under "Your models on Nosana".`,
  );
  assert.equal(
    fineTunedModelAgentHint({ deployments: [{ status: "stopped" }, { status: "running" }] }),
    `This model can power an agent: choose it in the agent's Settings, under "Your models on Nosana".`,
  );
  assert.ok(fineTunedModelAgentHint({ deployments: [{ status: "running" }] }).includes(`"${HOSTED_GROUP_LABEL}"`));
  // One copy of the group's name: the helper file never spells it out.
  const helpers = readFileSync(join(here, "training.ts"), "utf8");
  assert.doesNotMatch(helpers, /Your models on Nosana/);
});

test("the agent hint speaks in the present only for a running deployment", () => {
  const later = fineTunedModelAgentHint({ deployments: [] });
  // The API counts these as active deployments, and the agent's picker does not list them all.
  for (const status of ["pending", "building", "deploying", "provisioning", "stopped", "failed"]) {
    assert.equal(fineTunedModelAgentHint({ deployments: [{ status }] }), later, status);
  }
  // An answer without the list does not break the page.
  assert.equal(fineTunedModelAgentHint({}), later);
  assert.equal(fineTunedModelAgentHint({ deployments: null }), later);
});

test("the job page and the model page show the same record block, above the ledger on the job page", () => {
  const jobPage = page("training/[id]/page.tsx");
  assert.match(jobPage, /<NosanaRecord nosana=\{job\.nosana\} className="mt-4" \/>/);
  assert.ok(jobPage.indexOf("<NosanaRecord") < jobPage.indexOf('data-testid="training-ledger"'));
  assert.ok(jobPage.indexOf("<NosanaRecord") > jobPage.indexOf('data-testid="training-money"'));
  assert.match(page("training/models/[id]/page.tsx"), /<NosanaRecord nosana=\{model\.trainingJob\?\.nosana\}/);

  const block = readFileSync(join(here, "../components/dashboard/nosana-record.tsx"), "utf8");
  assert.match(block, /data-testid="training-nosana"/);
  assert.match(block, /nosanaRecordView\(nosana\)/);
  assert.match(block, /target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(block, /View on Nosana/);
  // The address is shown whole and can wrap; no link is built on the page.
  assert.match(block, /break-all font-mono/);
  assert.doesNotMatch(block, /\.slice\(/);
  assert.doesNotMatch(block, /https?:\/\//);
});

test("the model page disables Deploy with the API's sentence and tells the owner about agents", () => {
  const source = page("training/models/[id]/page.tsx");
  assert.match(source, /setDeployUnavailable\(deployUnavailableMessage\(capabilities\)\)/);
  // A failed read leaves the button as it was.
  assert.match(source, /\(\) => setDeployUnavailable\(null\)/);
  // Disabled, outside any link, and tied to its sentence for a screen reader.
  assert.match(
    source,
    /<Button\s+className="w-full"\s+disabled\s+aria-describedby="model-deploy-unavailable"\s+data-testid="model-deploy"\s+>/,
  );
  assert.match(
    source,
    /id="model-deploy-unavailable"[^>]*data-testid="model-deploy-unavailable"\s*>\s+\{deployUnavailable\}/,
  );
  assert.match(source, /data-testid="model-agent-hint">\s+\{fineTunedModelAgentHint\(model\)\}/);
  assert.equal(source.match(/getCapabilities\(\)/g)?.length, 1);
});

test("the job page disables Deploy on its model card the same way", () => {
  const source = page("training/[id]/page.tsx");
  assert.match(source, /setDeployUnavailable\(deployUnavailableMessage\(capabilities\)\)/);
  assert.match(source, /<Button disabled aria-describedby="training-deploy-unavailable" data-testid="training-deploy">/);
  assert.match(source, /id="training-deploy-unavailable"[^>]*>\s+\{deployUnavailable\}/);
  assert.equal(source.match(/getCapabilities\(\)/g)?.length, 1);
});

test("the fine-tuned models list disables Deploy with the sentence as its title", () => {
  const source = page("training/page.tsx");
  assert.match(source, /const deployUnavailable = deployUnavailableMessage\(data\?\.capabilities\);/);
  assert.match(
    source,
    /<Button\s+size="sm"\s+disabled\s+title=\{deployUnavailable\}\s+aria-describedby="deploy-fine-tuned-unavailable"\s+data-testid="deploy-fine-tuned"\s+>/,
  );
  // A disabled button shows no title, so the sentence is also on the page.
  assert.match(source, /id="deploy-fine-tuned-unavailable"[^>]*>\s+\{deployUnavailable\}/);
});
