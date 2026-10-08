import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelTrainingJob,
  createTrainingJob,
  estimateTrainingJob,
  finalizeTrainingJob,
  fineTunedModelSlug,
  getTrainingJobDetail,
  getTrainingJobLogs,
  describeTrainingCapabilities,
  listTrainingModels,
  placeableTrainingTiers,
  readTrainerJobResult,
  reconcileTrainingJob,
  recordTrainingEvent,
  retryTrainingJob,
  submitTrainingJob,
  trainingArtifactKeys,
  trainingOperatorBlockers,
  TRAINING_UNAVAILABLE_MESSAGE,
  TRAINING_SUBMIT_LOOKUP_GIVE_UP_SECONDS,
  TRAINING_SUBMIT_TIMEOUT_SECONDS,
} from "../services/trainingJobs.js";
import { adapterNameForSlug } from "../services/nosana.js";
import { TRAINING_TRANSITIONS } from "../services/trainingStateMachine.js";
import {
  DATASET,
  eventLine,
  IMAGE,
  JOB_INPUT,
  jobResult,
  makeWorld,
  ORG,
  OTHER_ORG,
  trainerEvent,
  withRowLocks,
  type World,
} from "./trainingFakes.js";

// The training job service against a fake Nosana port, a fake object store
// and a fake ledger. 4090: 250 micro-dollars per second, so the hold for the
// one-hour run limit used here is 90 cents and 600 seconds cost 15.
const HOLD = 90n;
const START_BALANCE = 10_000n;

const RESERVATION = { type: "training_reservation", amountCents: -HOLD, balanceAfter: START_BALANCE - HOLD };
const RELEASE = { type: "training_reservation_release", amountCents: HOLD, balanceAfter: START_BALANCE };
const usage = (cents: bigint) => ({
  type: "training_usage",
  amountCents: -cents,
  balanceAfter: START_BALANCE - cents,
});

async function admit(w: World, input: Record<string, unknown> = {}) {
  const result = await createTrainingJob(w.deps, { orgId: ORG, input: { ...JOB_INPUT, ...input } });
  assert.equal(result.ok, true, result.ok ? "" : result.code);
  if (!result.ok) throw new Error("unreachable");
  return result.job.id;
}

async function toQueued(w: World) {
  const jobId = await admit(w);
  await w.drain();
  assert.equal(w.db.job(jobId).status, "queued");
  return jobId;
}

/** A job a node has picked up: Nosana says running, started now. */
async function toRunning(w: World) {
  const jobId = await toQueued(w);
  const deployment = w.nosana.only();
  deployment.status = "running";
  deployment.jobs = [{ job: "job-address-1", status: "RUNNING" }];
  deployment.job = { state: "running", timeStart: new Date(w.clock.now), timeEnd: null, jobResult: null };
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.equal(result.to, "running");
  return jobId;
}

/** The Nosana job ended now with this exit code and log. */
function endRun(w: World, exitCode: number | null, logLines: string[] = [], deploymentStatus = "stopped") {
  const deployment = w.nosana.only();
  deployment.status = deploymentStatus;
  deployment.job = {
    state: "completed",
    timeStart: deployment.job?.timeStart ?? null,
    timeEnd: new Date(w.clock.now),
    jobResult: jobResult(exitCode, logLines),
  };
}

function untouched(w: World, jobsBefore = 0) {
  assert.equal(w.db.jobs.length, jobsBefore, "no job row");
  assert.equal(w.db.ledger.length, 0, "no ledger entry");
  assert.equal(w.db.balance(), START_BALANCE, "no credit moved");
  assert.deepEqual(w.events(), [], "no webhook");
  assert.equal(w.deferred.length, 0, "no submit");
  assert.equal(w.nosana.deployments.size, 0, "nothing on Nosana");
}

// ============================================
// Create
// ============================================

test("create: one transaction writes the row and the hold; training.started fires once; the submit is deferred", async () => {
  const w = makeWorld();
  const result = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const job = w.db.job(result.job.id);
  assert.equal(job.status, "pending");
  assert.equal(job.reservationCents, HOLD);
  assert.equal(job.priceMicroUsdPerSecond, 250n);
  assert.equal(job.maxRuntimeSeconds, 3_600);
  assert.equal(job.nosanaTimeoutSeconds, 3_600 + 900, "the run limit plus the set-up allowance");
  assert.deepEqual(job.hyperparams, { epochs: 2 });
  assert.equal(job.datasetSha256, w.db.datasets[0]!.contentSha256);
  assert.equal(job.baseModelHfId, "microsoft/Phi-3-mini-4k-instruct");
  assert.deepEqual(result.reservation, { cents: 90, maxRuntimeSeconds: 3_600, pricePerSecondUsd: 0.00025 });
  assert.equal(result.estimate?.basis, "planning");

  assert.deepEqual(w.db.ledgerOf(job.id), [RESERVATION]);
  assert.equal(w.db.balance(), START_BALANCE - HOLD);
  assert.deepEqual(w.events(), ["training.started"]);
  assert.equal(w.deferred.length, 1);
  // The pre-flight was asked about a batch job with THIS job's timeout.
  assert.deepEqual(w.nosana.calls, ["preflight:4090:batch:4500"]);
});

test("create: every refusal of the documented order, each leaving no row and no ledger entry", async () => {
  const w = makeWorld();
  const dataset = w.db.datasets[0]!;
  const input: Record<string, unknown> = { ...JOB_INPUT };
  const storedDataset = [...w.realStore.objects.entries()][0]!;
  // Two jobs in progress fill the quota (they are the only rows throughout).
  const blockers = [
    w.db.insertJob({ id: "aaaaaaaa-1111-4111-8111-000000000001", status: "running", reservationCents: 0n }),
    w.db.insertJob({ id: "aaaaaaaa-1111-4111-8111-000000000002", status: "queued", reservationCents: 0n }),
  ];
  // Three runs that failed free in the last day fill the free-failure limit.
  const freeFailures = [3, 4, 5].map((n) =>
    w.db.insertJob({
      id: `aaaaaaaa-1111-4111-8111-00000000000${n}`,
      status: "failed",
      failureCode: "out_of_memory",
      reservationCents: 90n,
      actualCostCents: 0n,
      settledAt: new Date(w.clock.now.getTime() - n * 3_600_000),
    }),
  );

  // Each step: [expected status, expected code, how it is put right]. Every
  // later condition is ALREADY broken when a step is checked, so each answer
  // proves its place in the order.
  const steps: Array<[number, string, () => void]> = [
    [400, "invalid_hyperparameter", () => (input.hyperparams = { epochs: 2 })],
    [400, "run_limit_out_of_range", () => (input.maxRuntimeSeconds = 3_600)],
    [404, "dataset_not_found", () => (dataset.deletedAt = null)],
    [404, "model_not_found", () => (input.baseModelId = "gemma-2b")],
    [404, "model_not_trainable", () => (input.baseModelId = "phi-3-mini")],
    [409, "dataset_not_validated", () => (dataset.isValidated = true)],
    [422, "dataset_row_count_unknown", () => (dataset.rowCountKnown = true)],
    [409, "dataset_changed_since_validation", () => w.realStore.objects.set(...storedDataset)],
    [400, "unsupported_method", () => (input.method = "lora")],
    [400, "unsupported_gpu_count", () => (input.gpuCount = 1)],
    [400, "unknown_gpu_tier", () => (input.gpuTier = "3060")],
    [400, "tier_too_small", () => {
      input.gpuTier = "4090";
      // Storage goes away only now: until here it was needed to see the swap.
      w.world.store = null;
    }],
    [503, "dataset_storage_not_configured", () => (w.world.store = w.realStore)],
    [501, "training_image_not_configured", () => (w.world.runtime.image = { configured: true, reference: IMAGE, registry: null })],
    [501, "training_requires_real_nosana", () => (w.world.runtime.nosanaMock = false)],
    [501, "nosana_not_configured", () => (w.nosana.state.preflightError = { code: "market_not_configured" })],
    [501, "gpu_market_not_configured", () => (w.nosana.state.preflightError = { code: "nosana_credits_low" })],
    [503, "compute_capacity_unavailable", () => (w.nosana.state.preflightError = new Error("socket hang up"))],
    [503, "nosana_unavailable", () => (w.nosana.state.preflightError = null)],
    [503, "training_callbacks_not_configured", () => (w.world.runtime.publicApiUrl = "https://api.example.com")],
    [503, "training_poller_disabled", () => (w.world.runtime.pollIntervalMs = 15_000)],
    [503, "training_orphan_sweep_disabled", () => (w.world.runtime.orphanSweepEnabled = true)],
    [409, "training_quota_exceeded", () => blockers.forEach((job) => (job.status = "completed"))],
    [409, "training_free_failure_limit", () => (freeFailures[0]!.settledAt = new Date(w.clock.now.getTime() - 25 * 3_600_000))],
    [402, "insufficient_credits", () => (w.db.balances[0]!.balanceCents = START_BALANCE)],
  ];

  // Break everything at once.
  input.hyperparams = { epochs: 99 };
  input.maxRuntimeSeconds = 10;
  dataset.deletedAt = new Date();
  input.baseModelId = "no-such-model";
  dataset.isValidated = false;
  dataset.rowCountKnown = false;
  w.realStore.objects.set(storedDataset[0], Buffer.from("another file entirely"));
  input.method = "full";
  input.gpuCount = 2;
  input.gpuTier = "rtx-4090";
  w.world.runtime.image = { configured: false, reason: "TRAINING_IMAGE not set" };
  w.world.runtime.nosanaMock = true;
  w.nosana.state.preflightError = { code: "nosana_not_configured" };
  w.world.runtime.publicApiUrl = null;
  w.world.runtime.pollIntervalMs = 0;
  w.world.runtime.orphanSweepEnabled = false;
  w.db.balances[0]!.balanceCents = 10n;

  for (const [status, code, fix] of steps) {
    const result = await createTrainingJob(w.deps, { orgId: ORG, input: input as never });
    assert.equal(result.ok, false, `expected ${code}`);
    if (result.ok) return;
    assert.deepEqual([result.status, result.code], [status, code]);
    assert.ok(result.message.length > 10, "a sentence a user can read");

    assert.equal(w.db.jobs.length, 5, `${code}: no job row`);
    assert.equal(w.db.ledger.length, 0, `${code}: no ledger entry`);
    assert.deepEqual(w.events(), [], `${code}: no webhook`);
    assert.equal(w.deferred.length, 0, `${code}: no submit`);
    assert.equal(w.nosana.deployments.size, 0);
    if (code === "insufficient_credits") {
      assert.equal(w.db.balance(), 10n);
      assert.deepEqual(result.extra, { requiredCents: 90, balanceCents: 10 });
    }
    fix();
  }

  const ok = await createTrainingJob(w.deps, { orgId: ORG, input: input as never });
  assert.equal(ok.ok, true, "with everything put right the job is admitted");
});

test("free failures: at the limit create and retry are refused with when the next run can start (R4)", async () => {
  const w = makeWorld();
  w.world.runtime.maxActiveJobsPerOrg = 10;
  const hoursAgo = (hours: number) => new Date(w.clock.now.getTime() - hours * 3_600_000);
  const row = (n: number, fields: Record<string, unknown>) =>
    w.db.insertJob({
      id: `cccccccc-1111-4111-8111-${String(n).padStart(12, "0")}`,
      reservationCents: 90n,
      actualCostCents: 0n,
      status: "failed",
      failureCode: "out_of_memory",
      settledAt: hoursAgo(1),
      ...fields,
    });
  // None of these counts: charged, a day old, from before billing, a plain cancel.
  row(1, { actualCostCents: 15n, failureCode: "dataset_error" });
  row(2, { settledAt: hoursAgo(25) });
  row(3, { reservationCents: null });
  row(4, { status: "cancelled", failureCode: null });
  // These do: two failures and a cancel that landed after a free failure.
  row(5, { settledAt: hoursAgo(20) });
  row(6, { settledAt: hoursAgo(3), failureCode: "base_model_download_failed" });
  assert.equal((await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT })).ok, true, "two of three");
  const third = row(7, {
    status: "cancelled",
    failureCode: "gpu_out_of_memory",
    settledAt: hoursAgo(2),
    hyperparams: { epochs: 2 },
    maxRuntimeSeconds: 3_600,
  });

  const refused = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.deepEqual([refused.status, refused.code], [409, "training_free_failure_limit"]);
  // The oldest of the three is 20 hours old: the next run in 4 hours.
  const retryAt = new Date(w.clock.now.getTime() + 4 * 3_600_000);
  assert.deepEqual(refused.extra, { limit: 3, retryAt: retryAt.toISOString() });
  assert.match(refused.message, /until 2026-10-12 14:00 UTC/);
  assert.equal(w.db.ledger.filter((entry) => entry.type === "training_reservation").length, 1);

  const retried = await retryTrainingJob(w.deps, { orgId: ORG, jobId: third.id });
  assert.equal(!retried.ok && retried.code, "training_free_failure_limit");

  // GET /capabilities names it for this organization, in the same sentence.
  const capabilities = await describeTrainingCapabilities(w.deps, { orgId: ORG });
  assert.equal(capabilities.canStart, false);
  assert.deepEqual(capabilities.blockers, [{ code: "training_free_failure_limit", message: refused.message }]);
  assert.deepEqual((await describeTrainingCapabilities(w.deps, { orgId: OTHER_ORG })).blockers, []);
  assert.equal(capabilities.limits.freeFailuresPerDay, 3);

  w.advance(4 * 3_600 + 1);
  assert.equal((await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT })).ok, true, "a day after the oldest");
});

test("free failures: one settled between the check and the transaction is caught inside it, under the lock (R4)", async () => {
  const w = makeWorld();
  w.world.runtime.maxActiveJobsPerOrg = 10;
  w.world.runtime.freeFailuresPerDay = 1;
  const prisma = w.deps.prisma;
  w.deps.prisma = {
    ...prisma,
    $transaction: async (fn) => {
      w.db.insertJob({
        id: "cccccccc-2222-4222-8222-000000000001",
        status: "failed",
        failureCode: "out_of_memory",
        reservationCents: 90n,
        actualCostCents: 0n,
        settledAt: new Date(w.clock.now),
      });
      return prisma.$transaction(fn);
    },
  };
  const refused = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.deepEqual(!refused.ok && [refused.status, refused.code], [409, "training_free_failure_limit"]);
  assert.match(!refused.ok ? refused.message : "", /until 2026-10-13 10:00 UTC/);
  assert.equal(w.db.ledger.length, 0);
  assert.equal(w.db.jobs.length, 1, "only the failure");
});

test("create: with no Nosana credential the tier check passes and the refusal is 501 nosana_not_configured", async () => {
  // Found by the local end-to-end proof: a server with no credential lists no
  // deployable tier, so every create answered 400 unknown_gpu_tier while
  // GET /capabilities named nosana_not_configured.
  const w = makeWorld();
  const all = w.world.runtime.allTiers;
  w.world.runtime.nosanaConfigured = false;
  w.nosana.state.preflightError = { code: "nosana_not_configured" };

  // What the composition root did before: nothing is deployable, so nothing is placeable.
  w.world.runtime.tiers = {};
  const misleading = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(!misleading.ok && misleading.code, "unknown_gpu_tier");

  w.world.runtime.tiers = placeableTrainingTiers({
    deployable: {},
    all,
    nosanaMock: false,
    nosanaConfigured: false,
  });
  const refused = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.deepEqual(!refused.ok && [refused.status, refused.code], [501, "nosana_not_configured"]);
  untouched(w);
  // A tier that is in no price table is still refused by name.
  const unknown = await createTrainingJob(w.deps, { orgId: ORG, input: { ...JOB_INPUT, gpuTier: "rtx-4090" } });
  assert.equal(!unknown.ok && unknown.code, "unknown_gpu_tier");
});

test("placeableTrainingTiers: every tier with the mock on or no credential, the deployable ones otherwise", () => {
  const all = { "3060": { name: "NVIDIA 3060", vram: 8, pricePerSecond: 0.0001 }, "4090": { name: "NVIDIA 4090", vram: 24, pricePerSecond: 0.00025 } };
  const deployable = { "4090": all["4090"] };
  assert.equal(placeableTrainingTiers({ deployable, all, nosanaMock: false, nosanaConfigured: true }), deployable);
  assert.equal(placeableTrainingTiers({ deployable, all, nosanaMock: true, nosanaConfigured: true }), all);
  assert.equal(placeableTrainingTiers({ deployable, all, nosanaMock: false, nosanaConfigured: false }), all);
});

test("create: a gated model is refused without a Hugging Face token and admitted with one", async () => {
  const w = makeWorld();
  const input = { ...JOB_INPUT, baseModelId: "llama-3.1-8b", method: "qlora" };
  const refused = await createTrainingJob(w.deps, { orgId: ORG, input });
  assert.equal(!refused.ok && refused.code, "hf_token_required");
  untouched(w);

  w.world.runtime.hfToken = "hf_abcdefghijklmnop";
  const admitted = await createTrainingJob(w.deps, { orgId: ORG, input });
  assert.equal(admitted.ok, true);
});

test("create: a dataset validated without a content hash cannot be pinned, so it is refused", async () => {
  const w = makeWorld();
  w.db.datasets[0]!.contentSha256 = null;
  const result = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(!result.ok && result.code, "dataset_not_validated");
  untouched(w);
});

test("create: with no run limit the suggestion is applied and held; without an estimate one must be chosen", async () => {
  const w = makeWorld();
  const { maxRuntimeSeconds: _limit, ...noLimit } = JOB_INPUT;
  const result = await createTrainingJob(w.deps, { orgId: ORG, input: noLimit });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reservation.maxRuntimeSeconds, result.estimate!.runLimit.suggestedSeconds);
  assert.equal(result.reservation.cents, result.estimate!.maximumCents);

  const w2 = makeWorld();
  w2.db.datasets[0]!.avgTokensPerRow = null; // Parquet
  const refused = await createTrainingJob(w2.deps, { orgId: ORG, input: noLimit });
  assert.equal(!refused.ok && refused.code, "run_limit_required");
  untouched(w2);
  const chosen = await createTrainingJob(w2.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(chosen.ok && chosen.estimate, null);
});

test("create: another organization's dataset is not found", async () => {
  const w = makeWorld();
  const result = await createTrainingJob(w.deps, { orgId: OTHER_ORG, input: JOB_INPUT });
  assert.equal(!result.ok && result.code, "dataset_not_found");
  untouched(w);
});

test("create: two jobs against a balance that covers one - the second is refused and leaves nothing", async () => {
  const w = makeWorld({ balanceCents: 100n });
  const [a, b] = await Promise.all([
    createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT }),
    createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT }),
  ]);
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
  assert.equal(w.db.jobs.length, 1);
  assert.equal(w.db.ledger.length, 1);
  assert.equal(w.db.balance(), 10n);
});

test("create: concurrent creates cannot pass the quota together - the organization's lock comes first (R3)", async () => {
  // Found by review: each transaction counted the active jobs before any of
  // the others had written its row, so all of them passed the quota.
  const w = makeWorld();
  w.deps.prisma = withRowLocks(w.db);
  w.world.runtime.maxActiveJobsPerOrg = 2;
  w.db.insertJob({ id: "aaaaaaaa-2222-4222-8222-000000000001", status: "running", reservationCents: 0n });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT })),
  );
  assert.deepEqual(
    results.map((result) => (result.ok ? "admitted" : result.code)).sort(),
    ["admitted", "training_quota_exceeded", "training_quota_exceeded", "training_quota_exceeded", "training_quota_exceeded"],
  );
  assert.equal(w.db.jobs.filter((job) => job.status === "pending").length, 1);
  assert.equal(w.db.ledger.length, 1, "one hold");
  assert.equal(w.db.balance(), START_BALANCE - HOLD);
  assert.deepEqual(w.events(), ["training.started"]);
});

test("create: an organization with no credit balance row is refused 402 and nothing is written", async () => {
  const w = makeWorld();
  w.db.balances.length = 0;
  const result = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.deepEqual(!result.ok && [result.status, result.code], [402, "insufficient_credits"]);
  assert.equal(w.db.jobs.length, 0);
  assert.equal(w.db.ledger.length, 0);
});

test("estimate: planning figures with a range; no row, no credit", async () => {
  const w = makeWorld();
  const result = await estimateTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(result.ok, true);
  if (!result.ok || !result.estimate) return;
  assert.equal(result.estimate.basis, "planning");
  assert.ok(result.estimate.low.cents <= result.estimate.estimate.cents);
  assert.ok(result.estimate.estimate.cents <= result.estimate.high.cents);
  assert.equal(result.estimate.maximumCents, 90);
  assert.equal(typeof result.estimate.maximumCents, "number");
  assert.deepEqual(result.hold, { cents: 90, maxRuntimeSeconds: 3_600, pricePerSecondUsd: 0.00025 });
  untouched(w);
});

test("estimate: a dataset with no tokens per row (Parquet) - the hold for a chosen run limit, or 422 asking for one", async () => {
  // Found by review: the page reaches Start only through a successful
  // estimate, and the API refused every estimate of such a dataset with a
  // message telling the user to choose a run limit, which did not help.
  const w = makeWorld();
  w.db.datasets[0]!.avgTokensPerRow = null;
  const withLimit = await estimateTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(withLimit.ok, true, withLimit.ok ? "" : withLimit.code);
  if (!withLimit.ok) return;
  assert.equal(withLimit.estimate, null);
  assert.deepEqual(withLimit.hold, { cents: 90, maxRuntimeSeconds: 3_600, pricePerSecondUsd: 0.00025 });
  untouched(w);

  const { maxRuntimeSeconds: _limit, ...noLimit } = JOB_INPUT;
  const none = await estimateTrainingJob(w.deps, { orgId: ORG, input: noLimit });
  assert.deepEqual(!none.ok && [none.status, none.code], [422, "training_estimate_unavailable"]);
  assert.match(!none.ok ? none.message : "", /Choose a run limit/);
  assert.doesNotMatch(!none.ok ? none.message : "", /JSON Lines or CSV/);

  // What the estimate promised is what create holds.
  const created = await createTrainingJob(w.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(created.ok && created.reservation.cents, withLimit.hold.cents);
});

// ============================================
// Submit
// ============================================

test("credits pay: a short job's Nosana timeout is raised to the 50-minute minimum everywhere it is used; the run limit and the hold are not", async () => {
  const w = makeWorld();
  // What resolveTrainingRuntime sets when the API key is the paying credential.
  w.runtime.nosanaMinTimeoutSeconds = 3_000;
  const result = await createTrainingJob(w.deps, { orgId: ORG, input: { ...JOB_INPUT, maxRuntimeSeconds: 1_200 } });
  assert.equal(result.ok, true, result.ok ? "" : result.code);
  if (!result.ok) return;

  // 20 minutes of training plus the 15-minute allowance is 35 minutes, which
  // Nosana accepts and then never assigns. 50 minutes is asked about, stored
  // and sent.
  assert.deepEqual(w.nosana.calls, ["preflight:4090:batch:3000"], "the credit estimate is for what is sent");
  const job = w.db.job(result.job.id);
  assert.equal(job.nosanaTimeoutSeconds, 3_000, "the stored timeout is the one Nosana is given");
  assert.equal(job.maxRuntimeSeconds, 1_200, "the trainer's own run limit is the customer's");
  assert.equal(job.reservationCents, 30n, "the hold is the retail price times the run limit: 250 x 1200");
  assert.deepEqual(result.reservation, { cents: 30, maxRuntimeSeconds: 1_200, pricePerSecondUsd: 0.00025 });

  await w.drain();
  const deployment = w.nosana.only();
  assert.equal(deployment.timeoutSeconds, 3_000);
  const env = (deployment.definition as any).ops[0].args.env;
  assert.equal(env.MAX_RUNTIME_SECONDS, "1200", "the trainer still ends at the run limit");

  // A job already above the minimum is unchanged, and so is wallet access.
  const long = makeWorld();
  long.runtime.nosanaMinTimeoutSeconds = 3_000;
  const longJob = await createTrainingJob(long.deps, { orgId: ORG, input: JOB_INPUT });
  assert.equal(longJob.ok && long.db.job(longJob.job.id).nosanaTimeoutSeconds, 4_500);
  const wallet = makeWorld();
  const walletJob = await createTrainingJob(wallet.deps, { orgId: ORG, input: { ...JOB_INPUT, maxRuntimeSeconds: 1_200 } });
  assert.equal(walletJob.ok && wallet.db.job(walletJob.job.id).nosanaTimeoutSeconds, 2_100);
});

test("submit: pending -> submitting -> queued, with the id, its access mode, a deterministic name and the job's timeout", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  await w.drain();

  const job = w.db.job(jobId);
  const deployment = w.nosana.only();
  assert.equal(job.status, "queued");
  assert.equal(job.nosanaJobId, deployment.id);
  assert.equal(job.nosanaAccessMode, "api_key", "stored with the id");
  assert.deepEqual(job.queuedAt, w.clock.now);
  assert.match(job.submitNonce!, /^[a-z0-9]{8,32}$/);
  assert.equal(deployment.name, `wheelsai-train-${jobId}-${job.submitNonce}`);
  assert.equal(deployment.timeoutSeconds, 4_500);

  const env = (deployment.definition as any).ops[0].args.env;
  assert.equal(env.JOB_ID, jobId);
  assert.equal(env.MAX_RUNTIME_SECONDS, "3600", "the trainer gets the run limit, not the Nosana timeout");
  assert.equal(env.DATASET_SHA256, w.db.datasets[0]!.contentSha256, "the dataset is pinned");
  assert.equal(env.DATASET_FORMAT, "completion");
  assert.equal(env.DATASET_FILE_TYPE, "jsonl");
  assert.equal(env.HYPERPARAMS, '{"epochs":2}');
  assert.equal(env.HF_TOKEN, undefined, "an open model gets no token");
  assert.equal(env.CALLBACK_URL, `https://api.example.com/api/training/jobs/${jobId}/events?n=${job.submitNonce}`);
  assert.match(env.CALLBACK_SECRET, /^[0-9a-f]{64}$/);
  // Queue timeout + run limit + allowance + margin.
  const ttl = 1_800 + 3_600 + 900 + 3_600;
  const keys = trainingArtifactKeys(ORG, jobId);
  assert.ok(env.DATASET_URL.includes(`ttl=${ttl}`) && env.DATASET_URL.includes("op=get"));
  assert.ok(env.ADAPTER_UPLOAD_URL.includes(keys.adapterKey) && env.ADAPTER_UPLOAD_URL.includes(`ttl=${ttl}`));
  assert.ok(env.METRICS_UPLOAD_URL.includes(keys.metricsKey));
  assert.equal((deployment.definition as any).ops[0].args.image, IMAGE);

  // Only one submitter ever claims a row.
  const again = await submitTrainingJob(w.deps, jobId);
  assert.deepEqual(!again.ok && again.code, "not_pending");
  assert.equal(w.nosana.deployments.size, 1);
  assert.deepEqual(w.events(), ["training.started"]);
});

test("submit: Nosana refuses and nothing exists there - looked up by name, then failed with the whole hold returned", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  w.nosana.state.createError = Object.assign(new Error("market closed"), { code: "nosana_create_failed" });
  await w.drain();

  const job = w.db.job(jobId);
  assert.equal(job.status, "failed");
  assert.equal(job.failureCode, "submit_failed");
  assert.equal(job.actualCostCents, 0n);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
  assert.equal(w.db.balance(), START_BALANCE);
  assert.deepEqual(w.events(), ["training.started", "training.failed"]);
  // Neither the key nor the name (for one created before keys were sent) finds anything.
  assert.deepEqual(
    w.nosana.calls.filter((call) => /^(key|find):/.test(call)).map((call) => call.split(":")[0]),
    ["key", "find"],
    "looked up before the refund",
  );
});

test("lost deployment: the create call throws after Nosana acted - found by its idempotency key and stopped before the refund", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  w.nosana.state.createThenThrow = true;
  w.nosana.state.stopReclaims = false;
  await w.drain();

  const job = w.db.job(jobId);
  const deployment = w.nosana.only();
  assert.equal(job.status, "failed");
  assert.equal(job.nosanaJobId, null, "the id never reached the row");
  assert.equal(deployment.status, "stopped", "what was created was found and stopped");
  // The name is the idempotency key: the exact lookup finds it, and the
  // name filter (for a deployment created before keys were sent) is not needed.
  const order = w.nosana.calls.filter((call) => /^(key|find|stop):/.test(call)).map((call) => call.split(":")[0]);
  assert.deepEqual(order, ["key", "stop"]);
  assert.equal(w.nosana.calls.find((call) => call.startsWith("key:")), `key:${deployment.name}`);
  // Stopped but the funding is not verified released: the sweep gets it, with its credential.
  assert.deepEqual(w.orphans, [
    { nosanaDeploymentId: deployment.id, sourceKind: "training", sourceId: jobId, reason: "submit_lost", accessMode: "api_key" },
  ]);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
});

test("lost deployment: when Nosana's list cannot be read the hold is NOT returned; the poller asks again", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  w.nosana.state.createThenThrow = true;
  w.nosana.state.listError = new Error("list unavailable");
  await w.drain();

  assert.equal(w.db.job(jobId).status, "submitting");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION], "no refund on a guess");

  // Inside the submit window the poller leaves it alone.
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "waiting");
  // Past it, with the list still unreadable: still no refund.
  w.advance(TRAINING_SUBMIT_TIMEOUT_SECONDS + 1);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "stop_retry");
  assert.equal(w.db.job(jobId).status, "submitting");

  // The list is back: the deployment is found, stopped, and only then refunded.
  w.nosana.state.listError = null;
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.equal(result.to, "failed");
  assert.equal(w.nosana.only().status, "stopped");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
  assert.deepEqual(w.events(), ["training.started", "training.failed"]);
});

test("lost deployment: a list that never comes back does not hold the user's credits for ever", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  w.nosana.state.createThenThrow = true;
  w.nosana.state.listError = new Error("list unavailable");
  await w.drain();
  w.advance(TRAINING_SUBMIT_LOOKUP_GIVE_UP_SECONDS + 1);
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.equal(result.to, "failed");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
});

test("submit: a failure past creation carries the id - it goes to the sweep unless its cleanup was verified", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  w.nosana.state.createError = Object.assign(new Error("start failed"), {
    code: "nosana_start_failed",
    deploymentId: "dep-partial",
    accessMode: "wallet",
    cleanup: { stopped: true, reclaimed: false },
  });
  await w.drain();
  assert.equal(w.db.job(jobId).status, "failed");
  assert.deepEqual(w.orphans, [
    { nosanaDeploymentId: "dep-partial", sourceKind: "training", sourceId: jobId, reason: "submit_failed", accessMode: "wallet" },
  ]);
  assert.equal(w.nosana.calls.some((call) => /^(key|find):/.test(call)), false, "the id is known: no lookup");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
});

test("submit: a dataset swapped after admission is refused before anything reaches Nosana", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  const key = [...w.realStore.objects.keys()][0]!;
  w.realStore.objects.set(key, Buffer.from("swapped"));
  await w.drain();
  assert.equal(w.db.job(jobId).status, "failed");
  assert.equal(w.db.job(jobId).failureCode, "submit_failed");
  assert.equal(w.nosana.calls.some((call) => call.startsWith("create:")), false);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
});

test("submit: a mock deployment is never accepted as a training run", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  w.nosana.state.mock = true;
  await w.drain();
  assert.equal(w.db.job(jobId).status, "failed");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
});

test("recovery: a pending row whose submitter died is submitted by the poller, once it is old enough", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  w.deferred.length = 0; // the process died before it submitted
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "waiting");
  w.advance(61);
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.deepEqual([result.from, result.to, result.action], ["pending", "queued", "submitted"]);
});

test("recovery: a row from before fine-tuning was billed is ended as failed, never submitted, with no money moved", async () => {
  const w = makeWorld();
  for (const [index, status] of ["pending", "queued", "running", "cancelling"].entries()) {
    const id = `bbbbbbbb-0000-4000-8000-00000000000${index}`;
    w.db.insertJob({ id, status, reservationCents: null, method: "full", gpuTier: "rtx-4090" });
    const result = await reconcileTrainingJob(w.deps, id);
    assert.equal(result.to, status === "cancelling" ? "cancelled" : "failed", status);
    assert.equal(w.db.job(id).settledAt !== null, true);
  }
  assert.equal(w.db.ledger.length, 0);
  assert.equal(w.db.balance(), START_BALANCE);
  assert.equal(w.nosana.calls.some((call) => call.startsWith("create:")), false);
});

// ============================================
// Queued
// ============================================

test("queued -> running when a node starts the job; billable time starts at the Nosana start", async () => {
  const w = makeWorld();
  const jobId = await toQueued(w);
  const deployment = w.nosana.only();
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "waiting");

  w.advance(120);
  const nosanaStart = new Date(w.clock.now.getTime() - 30_000);
  deployment.status = "running";
  deployment.jobs = [{ job: "job-address-1", status: "RUNNING" }];
  deployment.job = { state: "running", timeStart: nosanaStart, timeEnd: null, jobResult: null };
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.deepEqual([result.from, result.to], ["queued", "running"]);
  assert.deepEqual(w.db.job(jobId).startedAt, nosanaStart);
  assert.equal(w.db.job(jobId).nosanaJobAddress, "job-address-1");
  // Every read went through the credential that created the deployment.
  assert.ok(w.nosana.calls.includes(`status:${deployment.id}:api_key`));
  assert.ok(w.nosana.calls.includes(`job:${deployment.id}:job-address-1:api_key`));
});

test("queued: a Nosana start time that cannot be right is not billed from", async () => {
  const w = makeWorld();
  const jobId = await toQueued(w);
  const deployment = w.nosana.only();
  w.advance(60);
  deployment.status = "running";
  deployment.jobs = [{ job: "j", status: "RUNNING" }];
  // Seconds read as milliseconds: 1970.
  deployment.job = { state: "running", timeStart: new Date(1_791_800_000), timeEnd: null, jobResult: null };
  await reconcileTrainingJob(w.deps, jobId);
  assert.deepEqual(w.db.job(jobId).startedAt, w.clock.now);
});

test("queue timeout: no node took the job - stopped, failed no_capacity, charged nothing", async () => {
  const w = makeWorld();
  const jobId = await toQueued(w);
  w.advance(1_799);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "waiting");
  w.advance(2);
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.equal(result.to, "failed");
  const job = w.db.job(jobId);
  assert.equal(job.failureCode, "no_capacity");
  assert.equal(job.actualCostCents, 0n);
  assert.equal(job.billedSeconds, 0);
  assert.equal(w.nosana.only().status, "stopped");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
  assert.deepEqual(w.events(), ["training.started", "training.failed"]);
});

test("queued: a deployment that went to error or out of platform funds fails free", async () => {
  for (const [status, code] of [
    ["error", "nosana_error"],
    ["insufficient_funds", "nosana_insufficient_funds"],
  ] as const) {
    const w = makeWorld();
    const jobId = await toQueued(w);
    w.nosana.only().status = status;
    assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "failed");
    assert.equal(w.db.job(jobId).failureCode, code);
    assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
  }
});

test("a Nosana read that fails changes nothing", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.nosana.state.readError = new Error("502");
  w.advance(300);
  const before = structuredClone(w.db.job(jobId));
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.deepEqual([result.from, result.to, result.action], ["running", "running", "waiting"]);
  assert.deepEqual(w.db.job(jobId), before);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION]);
});

// ============================================
// Running to the end, and who pays
// ============================================

test("completed: exit 0 with the adapter stored -> finalizing -> completed, charged the seconds run", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(600);
  const uploaded = w.storeAdapter(jobId);
  endRun(w, 0, [
    eventLine(trainerEvent(1, "started")),
    eventLine(trainerEvent(2, "uploaded", uploaded)),
    eventLine(trainerEvent(3, "completed")),
  ]);

  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.deepEqual([result.from, result.to, result.action], ["running", "completed", "completed"]);

  const job = w.db.job(jobId);
  assert.equal(job.actualCostCents, 15n, "600 s at 250 micro-dollars");
  assert.equal(job.billedSeconds, 600);
  assert.equal(job.progress, 100);
  assert.ok(job.settledAt && job.completedAt);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE, usage(15n)]);
  assert.equal(w.db.balance(), START_BALANCE - 15n);

  assert.equal(w.db.fineTuned.length, 1);
  const model = w.db.fineTuned[0]!;
  assert.equal(job.outputModelId, model.id);
  assert.equal(model.orgId, ORG);
  assert.equal(model.trainingJobId, jobId);
  assert.equal(model.adapterKey, trainingArtifactKeys(ORG, jobId).adapterKey);
  assert.equal(model.adapterBytes, BigInt(uploaded.adapterBytes));
  assert.equal(model.adapterSha256, uploaded.adapterSha256);
  assert.equal(model.loraR, 16, "the trainer's default rank");
  assert.equal(model.slug, `support-bot-v1-${jobId.slice(0, 8)}`);
  assert.equal(model.liveSlug, model.slug);
  assert.equal(model.status, "ready");

  assert.equal(w.nosana.stops().length, 1, "the deployment was stopped and released");
  assert.deepEqual(w.orphans, []);
  assert.deepEqual(w.events(), ["training.started", "training.completed"]);
  assert.equal(w.emitted[1]!.data.fineTunedModelId, model.id);
  assert.equal(w.emitted[1]!.data.chargedCents, 15);
});

interface BillingCase {
  name: string;
  exitCode: number | null;
  event?: Record<string, unknown>;
  deploymentStatus?: string;
  /** Seconds the run lasted. */
  ran?: number;
  failureCode: string;
  chargedCents: bigint;
}

// One row per class of D4. 600 s cost 15 cents; the hold is 90.
const FAILURES: BillingCase[] = [
  { name: "dataset error (the data caused it)", exitCode: 11, event: trainerEvent(2, "failed"), failureCode: "dataset_row_invalid", chargedCents: 15n },
  { name: "dataset error, no event read", exitCode: 11, failureCode: "dataset_error", chargedCents: 15n },
  { name: "loss diverged", exitCode: 14, event: trainerEvent(2, "failed", { exitCode: 14, code: "loss_not_finite", message: "loss is NaN at step 40", phase: "train" }), failureCode: "loss_not_finite", chargedCents: 15n },
  { name: "dataset could not be downloaded (our URL)", exitCode: 11, event: trainerEvent(2, "failed", { code: "dataset_download_failed" }), failureCode: "dataset_download_failed", chargedCents: 0n },
  { name: "base model could not be pulled", exitCode: 12, event: trainerEvent(2, "failed", { exitCode: 12, code: "base_model_download_failed", phase: "load_model" }), failureCode: "base_model_download_failed", chargedCents: 0n },
  { name: "upload failed", exitCode: 20, event: trainerEvent(2, "failed", { exitCode: 20, code: "adapter_upload_failed", phase: "upload" }), failureCode: "adapter_upload_failed", chargedCents: 0n },
  { name: "out of memory on an accepted tier", exitCode: 13, failureCode: "out_of_memory", chargedCents: 0n },
  { name: "trainer refused its configuration", exitCode: 10, failureCode: "invalid_config", chargedCents: 0n },
  { name: "unexpected crash", exitCode: 1, failureCode: "unexpected", chargedCents: 0n },
  { name: "killed on the node", exitCode: 137, failureCode: "killed", chargedCents: 0n },
  { name: "interrupted, not by us", exitCode: 30, failureCode: "interrupted", chargedCents: 0n },
  // Past the run limit (Nosana's timeout after a slow image pull): the trainer
  // stops itself at the limit with exit 0, so an interruption is the node (R1).
  { name: "interrupted past the user's run limit", exitCode: 30, ran: 4_000, event: trainerEvent(2, "failed", { exitCode: 30, code: "interrupted", message: "Stopped by SIGTERM", phase: "train" }), failureCode: "interrupted", chargedCents: 0n },
  { name: "interrupted past the user's run limit, no event read", exitCode: 30, ran: 4_000, failureCode: "interrupted", chargedCents: 0n },
  { name: "deployment went to error", exitCode: null, deploymentStatus: "error", failureCode: "nosana_error", chargedCents: 0n },
  { name: "deployment ran out of platform funds", exitCode: null, deploymentStatus: "insufficient_funds", failureCode: "nosana_insufficient_funds", chargedCents: 0n },
  { name: "no exit code at all", exitCode: null, failureCode: "no_exit_code", chargedCents: 0n },
];

for (const row of FAILURES) {
  test(`who pays: ${row.name} -> failed ${row.failureCode}, charged ${row.chargedCents} cents`, async () => {
    const w = makeWorld();
    const jobId = await toRunning(w);
    w.advance(row.ran ?? 600);
    endRun(w, row.exitCode, row.event ? [eventLine(row.event)] : [], row.deploymentStatus);

    let result = await reconcileTrainingJob(w.deps, jobId);
    if (row.exitCode === null) {
      // No word and no exit code: the result gets a little time to appear.
      assert.equal(result.action, "waiting");
      assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION]);
      w.advance(301);
      result = await reconcileTrainingJob(w.deps, jobId);
    }
    assert.equal(result.to, "failed");

    const job = w.db.job(jobId);
    assert.equal(job.failureCode, row.failureCode);
    assert.equal(job.actualCostCents, row.chargedCents);
    assert.ok(job.lastError && job.lastError.length > 5);
    assert.deepEqual(
      w.db.ledgerOf(jobId),
      row.chargedCents > 0n ? [RESERVATION, RELEASE, usage(row.chargedCents)] : [RESERVATION, RELEASE],
    );
    assert.equal(w.db.balance(), START_BALANCE - row.chargedCents);
    assert.equal(w.db.fineTuned.length, 0);
    assert.deepEqual(w.events(), ["training.started", "training.failed"]);
    assert.equal(w.emitted[1]!.data.failureCode, row.failureCode);
    assert.equal(w.nosana.stops().length, 1, "the deployment was retired");

    // A second reconcile finds a terminal row and changes nothing.
    const again = await reconcileTrainingJob(w.deps, jobId);
    assert.equal(again.action, "none");
    assert.equal(w.db.ledgerOf(jobId).length, row.chargedCents > 0n ? 3 : 2);
  });
}

test("who pays: stopped by the trainer at its own run limit - completed with a partial adapter, charged", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(3_400);
  const uploaded = w.storeAdapter(jobId, Buffer.from("partial"), { stopReason: "max_runtime", steps: 40 });
  endRun(w, 0, [
    eventLine(trainerEvent(1, "uploaded", uploaded)),
    eventLine(trainerEvent(2, "completed", { stopReason: "max_runtime", steps: 40 })),
  ]);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "completed");
  assert.equal(w.db.job(jobId).actualCostCents, 85n);
  assert.equal(w.emitted[1]!.data.partial, true);
  const detail = await getTrainingJobDetail(w.deps, { orgId: ORG, jobId });
  assert.equal(detail!.partial, true);
});

test("who pays: the charge never exceeds the hold, however long Nosana let the job run", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  // Past the run limit, inside the set-up allowance the platform carries.
  w.advance(4_200);
  const uploaded = w.storeAdapter(jobId);
  endRun(w, 0, [eventLine(trainerEvent(1, "uploaded", uploaded)), eventLine(trainerEvent(2, "completed"))]);
  await reconcileTrainingJob(w.deps, jobId);
  const job = w.db.job(jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.actualCostCents, HOLD);
  assert.equal(job.billedSeconds, 3_600);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE, usage(HOLD)]);
});

test("the trainer's terminal event is trusted over the exit code when both are known", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(600);
  const uploaded = w.storeAdapter(jobId);
  // It printed `completed`, then was killed while its callbacks drained.
  endRun(w, 1, [eventLine(trainerEvent(1, "uploaded", uploaded)), eventLine(trainerEvent(2, "completed"))]);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "completed");
});

test("running: a run far past its Nosana timeout is stopped by us", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(4_500 + 601);
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.equal(result.action, "stop_retry");
  assert.equal(w.nosana.only().status, "stopped");
  assert.equal(w.db.job(jobId).status, "running", "the next tick reads how it ended");
});

test("running, credits pay: a short run whose trainer hangs is stopped at its own limit, not at the 50-minute Nosana timeout", async () => {
  const w = makeWorld();
  w.runtime.nosanaMinTimeoutSeconds = 3_000;
  // 20 minutes of training plus the 15-minute allowance: 2100 seconds. The
  // timeout Nosana was given is the 3000-second minimum.
  const jobId = await admit(w, { maxRuntimeSeconds: 1_200 });
  await w.drain();
  assert.equal(w.db.job(jobId).nosanaTimeoutSeconds, 3_000);
  const deployment = w.nosana.only();
  deployment.status = "running";
  deployment.jobs = [{ job: "job-address-1", status: "RUNNING" }];
  deployment.job = { state: "running", timeStart: new Date(w.clock.now), timeEnd: null, jobResult: null };
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "running");

  // Within the run limit, the allowance and the grace: left alone.
  w.advance(2_100 + 600);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "waiting");
  assert.equal(w.nosana.only().status, "running");

  // One second past it, still 299 seconds short of Nosana's own timeout.
  w.advance(1);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "stop_retry");
  assert.equal(w.nosana.only().status, "stopped");
  assert.equal(w.db.job(jobId).status, "running", "the next tick reads how it ended");
});

// ============================================
// Finalise
// ============================================

async function toFinalizing(w: World, prepare: (jobId: string) => string[]) {
  const jobId = await toRunning(w);
  w.advance(600);
  endRun(w, 0, prepare(jobId));
  return jobId;
}

test("finalise: success reported but no adapter in storage -> failed adapter_missing, charged nothing", async () => {
  const w = makeWorld();
  const jobId = await toFinalizing(w, () => [eventLine(trainerEvent(1, "completed"))]);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "failed");
  assert.equal(w.db.job(jobId).failureCode, "adapter_missing");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
  assert.equal(w.db.fineTuned.length, 0);
});

test("finalise: the stored adapter is not the one the trainer reported -> failed adapter_invalid, charged nothing", async () => {
  const cases: Array<[string, (w: World, jobId: string) => string[]]> = [
    ["another sha256", (w, jobId) => {
      const uploaded = w.storeAdapter(jobId);
      return [eventLine(trainerEvent(1, "uploaded", { ...uploaded, adapterSha256: "f".repeat(64) }))];
    }],
    ["another size", (w, jobId) => {
      const uploaded = w.storeAdapter(jobId);
      return [eventLine(trainerEvent(1, "uploaded", { ...uploaded, adapterBytes: uploaded.adapterBytes + 1 }))];
    }],
    ["replaced after the report", (w, jobId) => {
      const uploaded = w.storeAdapter(jobId);
      w.realStore.objects.set(trainingArtifactKeys(ORG, jobId).adapterKey, Buffer.from("ADAPTER-BYTES"));
      return [eventLine(trainerEvent(1, "uploaded", uploaded))];
    }],
    ["over the size limit", (w, jobId) => {
      const uploaded = w.storeAdapter(jobId, Buffer.alloc(1024 * 1024 + 1));
      return [eventLine(trainerEvent(1, "uploaded", uploaded))];
    }],
    ["nothing says what was uploaded", (w, jobId) => {
      w.storeAdapter(jobId);
      w.realStore.objects.delete(trainingArtifactKeys(ORG, jobId).metricsKey);
      return [];
    }],
  ];
  for (const [name, prepare] of cases) {
    const w = makeWorld();
    const jobId = await toFinalizing(w, (id) => [...prepare(w, id), eventLine(trainerEvent(2, "completed"))]);
    assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "failed", name);
    assert.equal(w.db.job(jobId).failureCode, "adapter_invalid", name);
    assert.equal(w.db.job(jobId).actualCostCents, 0n, name);
    assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE], name);
    assert.equal(w.db.fineTuned.length, 0, name);
  }
});

test("finalise: with no `uploaded` event the adapter is checked against metrics.json", async () => {
  const w = makeWorld();
  const jobId = await toFinalizing(w, (id) => {
    w.storeAdapter(id);
    return [];
  });
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "completed");
});

test("finalise: a crash between the model row and the settlement - the rerun completes without a second model", async () => {
  const w = makeWorld();
  const jobId = await toFinalizing(w, (id) => [
    eventLine(trainerEvent(1, "uploaded", w.storeAdapter(id))),
    eventLine(trainerEvent(2, "completed")),
  ]);
  w.db.failNextTransactions(1);
  await assert.rejects(reconcileTrainingJob(w.deps, jobId), /commit failed/);
  assert.equal(w.db.job(jobId).status, "finalizing");
  assert.equal(w.db.fineTuned.length, 1, "the model row was written before the crash");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION], "the settlement rolled back whole");

  const result = await finalizeTrainingJob(w.deps, jobId);
  assert.equal(result.to, "completed");
  assert.equal(w.db.fineTuned.length, 1);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE, usage(15n)]);
  assert.deepEqual(w.events(), ["training.started", "training.completed"]);
});

test("finalise: storage that cannot be read is retried, not judged", async () => {
  const w = makeWorld();
  const jobId = await toFinalizing(w, (id) => [
    eventLine(trainerEvent(1, "uploaded", w.storeAdapter(id))),
    eventLine(trainerEvent(2, "completed")),
  ]);
  w.realStore.failHead = true;
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.deepEqual([result.to, result.action], ["finalizing", "waiting"]);
  w.realStore.failHead = false;
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "completed");
});

test("finalise: a deployment that can be neither stopped nor recorded keeps the job from settling", async () => {
  const w = makeWorld();
  const jobId = await toFinalizing(w, (id) => [
    eventLine(trainerEvent(1, "uploaded", w.storeAdapter(id))),
    eventLine(trainerEvent(2, "completed")),
  ]);
  w.nosana.state.stopError = new Error("stop refused");
  w.world.orphanRecordFails = true;
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "stop_retry");
  assert.equal(w.db.job(jobId).status, "finalizing");
  // The record can be written: the sweep owns the stop, with the credential's mode.
  w.world.orphanRecordFails = false;
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "completed");
  assert.deepEqual(w.orphans.map((o) => [o.reason, o.accessMode]), [["training_completed", "api_key"]]);
  assert.equal(w.db.fineTuned.length, 1);
});

test("the model slug is strict whatever the job is called", () => {
  const id = "aaaaaaaa-0000-4000-8000-000000000001";
  for (const name of ["Support bot v1", "  $(rm -rf /) ", "日本語", "a".repeat(100), "--x--"]) {
    assert.match(fineTunedModelSlug(name, id), /^[a-z0-9][a-z0-9-]{0,47}$/);
    assert.match(fineTunedModelSlug(name, id, true), /^[a-z0-9][a-z0-9-]{0,71}$/);
  }
  assert.equal(fineTunedModelSlug("日本語", id), "model-aaaaaaaa");
  // And it is one the serving side accepts as an adapter name.
  for (const long of [false, true]) {
    assert.match(adapterNameForSlug(fineTunedModelSlug("a".repeat(100), id, long)) ?? "", /^ft-/);
  }
});

test("the end of a run is logged once, with what Nosana reported and the times billed from", async () => {
  const w = makeWorld();
  const seen: Array<{ context: Record<string, unknown>; message: string }> = [];
  w.deps.log.info = (context, message) => void seen.push({ context, message });
  const jobId = await toRunning(w);
  w.advance(40);
  // A data failure: the run ends failed, with no adapter to look for.
  endRun(w, 11, [eventLine(trainerEvent(1, "failed", { exitCode: 11, code: "dataset_empty", message: "The dataset has no rows", phase: "tokenize" }))]);
  await reconcileTrainingJob(w.deps, jobId);
  await reconcileTrainingJob(w.deps, jobId);

  const ended = seen.filter((entry) => entry.message === "Training run ended");
  assert.equal(ended.length, 1, "once per job, however many reconciles see the end");
  const { context } = ended[0]!;
  assert.equal(context.jobId, jobId);
  assert.equal(context.exitCode, 11);
  assert.equal(context.deploymentState, "ended");
  assert.equal(context.trainerEvent, "failed");
  assert.equal(context.trainerEventFrom, "nosana_result");
  assert.equal(context.startFromNosana, true);
  assert.equal(context.endFromNosana, true);
  assert.ok(Object.hasOwn(context, "rawTimeStart") && Object.hasOwn(context, "rawTimeEnd"));
  assert.ok((context.resultLogChars as number) > 0);
  // No credential and no URL is part of it.
  assert.doesNotMatch(JSON.stringify(context), /https?:|secret|token/i);
});

// ============================================
// No callback ever arrived
// ============================================

test("a job that ended with no callback is read from the WHEELSAI_EVENT lines of its log", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(600);
  const uploaded = w.storeAdapter(jobId);
  endRun(w, 0, [
    "Downloading shards: 100%",
    eventLine(trainerEvent(1, "started")),
    // A runtime's timestamp in front of the line is taken off.
    `2026-10-12T10:05:00.123456789Z ${eventLine(trainerEvent(2, "step", { step: 50, totalSteps: 100, loss: 1.2 }))}`,
    eventLine(trainerEvent(3, "eval", { step: 50, evalLoss: 1.1 })),
    // A line that merely quotes an event is not one.
    `ValueError: bad row: ${eventLine(trainerEvent(9, "failed"))}`,
    eventLine(trainerEvent(4, "uploaded", uploaded)),
    eventLine(trainerEvent(5, "completed", { finalTrainLoss: 0.8, finalEvalLoss: 0.95 })),
  ]);
  assert.equal(w.db.job(jobId).lastEventSeq, 0, "no callback was ever recorded");

  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "completed");
  const job = w.db.job(jobId);
  assert.equal(job.lastEventSeq, 5);
  assert.equal(job.currentStep, 100);
  assert.equal(job.totalSteps, 100);
  assert.equal(job.trainingLoss, 0.8);
  assert.equal(job.evalLoss, 0.95);
  assert.equal((job.reportedOutcome as any).type, "completed");
  assert.deepEqual((job.metrics as any).uploaded, uploaded);
  assert.equal((job.metrics as any).started.gpu, "RTX 4090");
  assert.equal((job.metrics as any).result.stopReason, "finished");

  const logs = await getTrainingJobLogs(w.deps, { orgId: ORG, jobId, tail: 1000 });
  assert.equal(logs!.source, "nosana_result");
  assert.ok(logs!.logs.includes("Downloading shards"));
  assert.equal(logs!.totalLines, 7);
});

test("no callback, a failed run: the failure reason comes from the log", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(600);
  endRun(w, 11, [eventLine(trainerEvent(1, "failed", { message: "Row 7: completion is empty" }))]);
  await reconcileTrainingJob(w.deps, jobId);
  const job = w.db.job(jobId);
  assert.equal(job.failureCode, "dataset_row_invalid");
  assert.equal(job.lastError, "Row 7: completion is empty");
  assert.equal(job.actualCostCents, 15n);
});

test("readTrainerJobResult: tolerant of every shape it does not know", () => {
  for (const odd of [null, undefined, 3, "x", [], {}, { opStates: "no" }, { opStates: [null] }, { opStates: [{ logs: "x" }] }]) {
    assert.deepEqual(readTrainerJobResult(odd), { exitCode: null, logText: null });
  }
  assert.deepEqual(readTrainerJobResult(jobResult(0, ["a", "b\n"])), { exitCode: 0, logText: "a\nb\n" });
  // The op named "train" is the one read; stdin is not a log.
  const two = {
    opStates: [
      { operationId: "other", exitCode: 5, logs: [] },
      { operationId: "train", exitCode: 14, logs: [{ type: "stdin", log: "no" }, { type: "stderr", log: "yes" }] },
    ],
  };
  assert.deepEqual(readTrainerJobResult(two), { exitCode: 14, logText: "yes\n" });
  assert.equal(readTrainerJobResult({ opStates: [{ exitCode: 1.5, logs: [] }] }).exitCode, null);
});

// ============================================
// Callbacks
// ============================================

test("callback: progress is recorded under the sequence guard", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  const first = await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(1, "started")));
  assert.deepEqual(first, { ok: true, applied: true });
  const step = await recordTrainingEvent(
    w.deps,
    w.callback(jobId, trainerEvent(2, "step", { step: 25, totalSteps: 100, loss: 1.7, epoch: 1.2 })),
  );
  assert.deepEqual(step, { ok: true, applied: true });

  const job = w.db.job(jobId);
  assert.equal(job.lastEventSeq, 2);
  assert.deepEqual(job.lastEventAt, w.clock.now);
  assert.equal(job.progress, 25);
  assert.equal(job.currentStep, 25);
  assert.equal(job.currentEpoch, 1);
  assert.equal(job.trainingLoss, 1.7);
  assert.deepEqual((job.metrics as any).trainLoss, [[25, 1.7]]);
  assert.equal(job.logs!.split("\n").filter(Boolean).length, 2);
  assert.ok(!job.logs!.includes("jobId"), "stored as the trainer printed it");
  assert.equal(w.deferred.length, 0, "a progress event asks for no reconcile");

  // A replay, and an event that arrives late, are acknowledged and ignored.
  for (const seq of [2, 1]) {
    const replay = await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(seq, "step", { loss: 9 })));
    assert.deepEqual(replay, { ok: true, applied: false });
  }
  assert.equal(w.db.job(jobId).trainingLoss, 1.7);
});

test("callback: signature, nonce, timestamp, size and shape are checked before anything is written", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  const good = w.callback(jobId, trainerEvent(1, "started"));
  const before = structuredClone(w.db.job(jobId));
  const refused = async (args: Parameters<typeof recordTrainingEvent>[1], status: number, code: string) => {
    const result = await recordTrainingEvent(w.deps, args);
    assert.deepEqual(!result.ok && [result.status, result.code], [status, code]);
    assert.deepEqual(w.db.job(jobId), before, `${code}: nothing written`);
  };

  await refused({ ...good, signatureHeader: undefined }, 401, "invalid_callback_signature");
  await refused({ ...good, signatureHeader: "t=1,v1=zz" }, 401, "invalid_callback_signature");
  await refused({ ...good, rawBody: good.rawBody.replace('"seq":1', '"seq":7') }, 401, "invalid_callback_signature");
  // Signed with the secret of another submit attempt, or of another job.
  await refused(w.callback(jobId, trainerEvent(1, "started"), { secretNonce: "othernonce01" }), 401, "invalid_callback_signature");
  await refused({ ...good, jobId: "aaaaaaaa-0000-4000-8000-999999999999" }, 401, "invalid_callback_signature");
  await refused({ ...good, nonce: "../../etc" }, 401, "invalid_callback_signature");
  // A valid signature for a nonce this job was never submitted with.
  await refused(w.callback(jobId, trainerEvent(1, "started"), { nonce: "othernonce01" }), 401, "invalid_callback_signature");
  // Stale and from the future: more than 300 seconds from this clock.
  for (const offset of [-301_000, 301_000]) {
    const at = new Date(w.clock.now.getTime() + offset);
    await refused(w.callback(jobId, trainerEvent(1, "started"), { at }), 401, "invalid_callback_signature");
  }
  // Oversize, before the signature is even computed.
  await refused({ ...good, rawBody: "x".repeat(65_537) }, 413, "callback_too_large");
  // Signed, but not a trainer event; or an event that names another job.
  await refused(w.callback(jobId, { v: 1, seq: 1, ts: "now", type: "started" }), 400, "invalid_trainer_event");
  await refused(w.callback(jobId, { ...trainerEvent(1, "completed"), status: "completed" }), 400, "invalid_trainer_event");
  const other = w.callback(jobId, trainerEvent(1, "started"));
  const swapped = other.rawBody.replace(jobId, "aaaaaaaa-0000-4000-8000-999999999999");
  const { signTrainingCallback, deriveTrainingCallbackSecret } = await import("../services/trainingWebhookAuth.js");
  const { SERVER_SECRET } = await import("./trainingFakes.js");
  await refused(
    {
      ...other,
      rawBody: swapped,
      signatureHeader: signTrainingCallback(
        deriveTrainingCallbackSecret(jobId, other.nonce, SERVER_SECRET),
        Math.floor(w.clock.now.getTime() / 1000),
        swapped,
      ),
    },
    400,
    "callback_job_mismatch",
  );

  // Within the window it is accepted.
  const at = new Date(w.clock.now.getTime() - 299_000);
  assert.deepEqual(await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(1, "started"), { at })), {
    ok: true,
    applied: true,
  });
});

test("callback: a job that does not exist is a 404 (after the signature held)", async () => {
  const w = makeWorld();
  const { deriveTrainingCallbackSecret, signTrainingCallback } = await import("../services/trainingWebhookAuth.js");
  const { SERVER_SECRET } = await import("./trainingFakes.js");
  const jobId = "aaaaaaaa-0000-4000-8000-999999999999";
  const rawBody = JSON.stringify({ ...trainerEvent(1, "started"), jobId });
  const signatureHeader = signTrainingCallback(
    deriveTrainingCallbackSecret(jobId, "somenonce001", SERVER_SECRET),
    Math.floor(w.clock.now.getTime() / 1000),
    rawBody,
  );
  const result = await recordTrainingEvent(w.deps, { jobId, nonce: "somenonce001", rawBody, signatureHeader });
  assert.deepEqual(!result.ok && result.status, 404);
});

test("callback: a terminal event is stored as a REPORT - it never writes a terminal state and never moves money", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(600);
  for (const event of [trainerEvent(1, "completed"), trainerEvent(2, "failed")]) {
    const result = await recordTrainingEvent(w.deps, w.callback(jobId, event));
    assert.deepEqual(result, { ok: true, applied: true });
    const job = w.db.job(jobId);
    assert.equal(job.status, "running");
    assert.equal(job.settledAt, null);
    assert.equal(job.completedAt, null);
    assert.equal(job.failureCode, null);
    assert.equal((job.reportedOutcome as any).type, event.type);
  }
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION]);
  assert.equal(w.db.fineTuned.length, 0);
  assert.deepEqual(w.events(), ["training.started"]);
  assert.equal(w.deferred.length, 2, "each asked for the same reconcile the poller runs");
});

test("callback: the first word from the container starts a queued job; the Nosana start replaces it when known", async () => {
  const w = makeWorld();
  const jobId = await toQueued(w);
  w.advance(200);
  const result = await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(1, "started")));
  assert.deepEqual(result, { ok: true, applied: true });
  assert.equal(w.db.job(jobId).status, "running");
  assert.deepEqual(w.db.job(jobId).startedAt, w.clock.now, "the fallback start");

  const deployment = w.nosana.only();
  const nosanaStart = new Date(w.clock.now.getTime() - 90_000);
  deployment.status = "running";
  deployment.jobs = [{ job: "j", status: "RUNNING" }];
  deployment.job = { state: "running", timeStart: nosanaStart, timeEnd: null, jobResult: null };
  await w.drain();
  assert.deepEqual(w.db.job(jobId).startedAt, nosanaStart);
});

test("callback: ignored for a job that is over, being cancelled, or not yet submitted", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  const nonce = w.db.job(jobId).submitNonce!;
  for (const status of ["completed", "failed", "cancelled", "cancelling", "finalizing", "submitting"]) {
    w.db.job(jobId).status = status;
    const before = structuredClone(w.db.job(jobId));
    const result = await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(5, "completed"), { nonce }));
    assert.deepEqual(result, { ok: true, applied: false }, status);
    assert.deepEqual(w.db.job(jobId), before, status);
  }
});

// ============================================
// Callbacks and the poller together
// ============================================

function assertSettledOnce(w: World, jobId: string) {
  assert.equal(w.db.job(jobId).status, "completed");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE, usage(15n)], "exactly one settlement");
  assert.equal(w.db.balance(), START_BALANCE - 15n);
  assert.equal(w.db.fineTuned.length, 1, "one model");
  assert.deepEqual(w.events(), ["training.started", "training.completed"], "one webhook");
}

async function completedByCallback(w: World) {
  const jobId = await toRunning(w);
  w.advance(600);
  const uploaded = w.storeAdapter(jobId);
  await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(1, "uploaded", uploaded)));
  await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(2, "completed")));
  return jobId;
}

test("race: the callback's reconcile and the poller's run at the same time - one settlement, one model, one webhook", async () => {
  const w = makeWorld();
  const jobId = await completedByCallback(w);
  const fromCallback = w.deferred.splice(0);
  assert.equal(fromCallback.length, 1);
  await Promise.all([
    reconcileTrainingJob(w.deps, jobId),
    ...fromCallback.map((task) => task()),
    reconcileTrainingJob(w.deps, jobId),
  ]);
  assertSettledOnce(w, jobId);
});

test("race: the poller first, then the callback's reconcile, then a late callback", async () => {
  const w = makeWorld();
  const jobId = await completedByCallback(w);
  await reconcileTrainingJob(w.deps, jobId);
  await w.drain();
  // The process exits and Nosana reports it; a retried callback arrives after.
  endRun(w, 0);
  await reconcileTrainingJob(w.deps, jobId);
  const late = await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(2, "completed")));
  assert.deepEqual(late, { ok: true, applied: false });
  assertSettledOnce(w, jobId);
});

test("race: the trainer reported success by callback while Nosana still shows it running - it completes at once", async () => {
  const w = makeWorld();
  const jobId = await completedByCallback(w);
  assert.equal(w.nosana.only().job!.state, "running");
  await w.drain();
  assertSettledOnce(w, jobId);
  assert.equal(w.nosana.only().status, "stopped");
});

test("race: a failed report by callback and the exit code seen by the poller - settled once, by the report", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(600);
  await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(1, "failed")));
  endRun(w, 11);
  await Promise.all([reconcileTrainingJob(w.deps, jobId), w.drain(), reconcileTrainingJob(w.deps, jobId)]);
  assert.equal(w.db.job(jobId).failureCode, "dataset_row_invalid");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE, usage(15n)]);
  assert.deepEqual(w.events(), ["training.started", "training.failed"]);
});

test("race: two callbacks landing together cannot overwrite each other", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  const uploaded = { adapterBytes: 5, adapterSha256: "c".repeat(64) };
  await Promise.all([
    recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(1, "started"))),
    recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(2, "uploaded", uploaded))),
  ]);
  const metrics = w.db.job(jobId).metrics as any;
  assert.equal(w.db.job(jobId).lastEventSeq, 2);
  assert.deepEqual(metrics.uploaded, uploaded);
});

// ============================================
// Cancel
// ============================================

test("cancel pending: cancelled at once, the whole hold returned, nothing ever submitted", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  const result = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.deepEqual(result, { ok: true, status: "cancelled" });
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
  assert.deepEqual(w.events(), ["training.started", "training.cancelled"]);
  // The deferred submit finds nothing to claim.
  await w.drain();
  assert.equal(w.nosana.deployments.size, 0);
  assert.equal(w.db.job(jobId).status, "cancelled");
});

test("cancel while submitting: ends cancelled, charged nothing, and the submitter stops what it created", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  let cancelAnswer: unknown;
  w.nosana.state.duringCreate = async () => {
    cancelAnswer = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  };
  await w.drain();

  assert.deepEqual(cancelAnswer, { ok: true, status: "cancelling" }, "there was no id to stop yet");
  const job = w.db.job(jobId);
  assert.equal(job.status, "cancelled");
  assert.equal(job.nosanaJobId, null);
  assert.equal(job.actualCostCents, 0n);
  assert.equal(w.nosana.only().status, "stopped", "the submitter retired its own deployment");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
  assert.deepEqual(w.events(), ["training.started", "training.cancelled"]);
});

test("cancel while submitting, and the submitter died: the poller finds the deployment by name, stops it, then cancels", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  w.nosana.state.createThenThrow = true;
  w.nosana.state.listError = new Error("list unavailable");
  await w.drain(); // left for recovery: submitting, a deployment exists, no id
  w.nosana.state.listError = null;

  assert.deepEqual(await cancelTrainingJob(w.deps, { orgId: ORG, jobId }), { ok: true, status: "cancelling" });
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "waiting", "the submitter may still be at work");
  w.advance(TRAINING_SUBMIT_TIMEOUT_SECONDS + 1);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "cancelled");
  assert.equal(w.nosana.only().status, "stopped");
  assert.equal(w.db.job(jobId).actualCostCents, 0n);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
});

test("cancel queued: stopped, cancelled, charged nothing (queue time is free)", async () => {
  const w = makeWorld();
  const jobId = await toQueued(w);
  w.advance(500);
  assert.deepEqual(await cancelTrainingJob(w.deps, { orgId: ORG, jobId }), { ok: true, status: "cancelled" });
  assert.equal(w.nosana.only().status, "stopped");
  assert.equal(w.db.job(jobId).actualCostCents, 0n);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
});

test("cancel running: charged for the time run up to the request, never for the time the stop then took", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(300);
  w.nosana.state.stopError = new Error("stop timed out");
  w.world.orphanRecordFails = true;

  const answer = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.deepEqual(answer, { ok: true, status: "cancelling" });
  const requestedAt = new Date(w.clock.now);
  assert.deepEqual(w.db.job(jobId).cancelRequestedAt, requestedAt);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION], "not settled until the stop is confirmed");

  // The poller keeps trying; the stop lands twenty minutes later.
  w.advance(600);
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "stop_retry");
  w.advance(600);
  w.nosana.state.stopError = null;
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).to, "cancelled");

  const job = w.db.job(jobId);
  assert.equal(job.billedSeconds, 300);
  assert.equal(job.actualCostCents, 8n, "300 s at 250 micro-dollars is 7.5 cents, rounded up");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE, usage(8n)]);
  assert.deepEqual(w.events(), ["training.started", "training.cancelled"]);
  assert.equal(w.db.fineTuned.length, 0);
});

test("cancel running: the run had completed before the request - finalised and charged as a completion (R2)", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(200);
  const uploaded = w.storeAdapter(jobId);
  endRun(w, 0, [eventLine(trainerEvent(1, "uploaded", uploaded))], "running");
  w.advance(100);
  const answer = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.deepEqual(answer, { ok: true, status: "cancelling" }, "the cancel was accepted; the run's own end decides");

  const job = w.db.job(jobId);
  assert.equal(job.status, "completed", "cancelling -> finalizing -> completed");
  assert.equal(job.billedSeconds, 200, "billed to its own end, before the request");
  assert.equal(job.actualCostCents, 5n);
  assert.equal(w.db.fineTuned.length, 1, "the user gets the model the run made");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE, usage(5n)]);
  assert.deepEqual(w.events(), ["training.started", "training.completed"]);
});

test("cancel running: a free failure the poller had not settled yet stays free, and keeps its reason (R2)", async () => {
  // Found by review: the run went out of memory, the row was still `running`
  // (inside the grace for the exit code), the user pressed Cancel, and the
  // cancel turned a free failure into a charged cancel.
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(240);
  endRun(w, null, [], "running");
  assert.equal((await reconcileTrainingJob(w.deps, jobId)).action, "waiting", "ended, exit code not there yet");
  assert.ok(w.db.job(jobId).gpuStoppedAt, "the end was seen while running");

  w.advance(30);
  const answer = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.deepEqual(answer, { ok: true, status: "cancelling" });
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION], "nothing settled while the outcome is unknown");

  // The result appears: out of memory.
  endRun(w, 13, [eventLine(trainerEvent(4, "failed", { exitCode: 13, code: "gpu_out_of_memory", message: "CUDA out of memory", phase: "train" }))], "running");
  const result = await reconcileTrainingJob(w.deps, jobId);
  assert.equal(result.to, "cancelled", "cancelling -> failed is not a transition");
  const job = w.db.job(jobId);
  assert.equal(job.failureCode, "gpu_out_of_memory");
  assert.equal(job.lastError, "CUDA out of memory");
  assert.equal(job.actualCostCents, 0n);
  assert.equal(job.billedSeconds, 0);
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE]);
  assert.deepEqual(w.events(), ["training.started", "training.cancelled"]);
  assert.equal(w.emitted[1]!.data.failureCode, "gpu_out_of_memory");
  assert.equal(w.emitted[1]!.data.chargedCents, 0);
  const detail = (await getTrainingJobDetail(w.deps, { orgId: ORG, jobId }))!;
  assert.deepEqual(detail.failure, { code: "gpu_out_of_memory", message: "CUDA out of memory", charged: false });
});

test("cancel running: a data failure before the request is charged as that failure, to its own end (R2)", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(200);
  endRun(w, 11, [], "running");
  w.advance(100);
  await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  const job = w.db.job(jobId);
  assert.equal(job.status, "cancelled");
  assert.equal(job.failureCode, "dataset_error");
  assert.equal(job.billedSeconds, 200);
  assert.equal(job.actualCostCents, 5n);
});

test("cancel running: what our own stop causes is never taken as an earlier end on Nosana's clock (R2)", async () => {
  // Nosana's clock a little behind ours: the end of the job OUR stop caused
  // is stamped before the request. An interruption, SIGTERM or SIGKILL is
  // what the stop does, so it stays a cancel, charged to the request.
  for (const exitCode of [30, 137, 143]) {
    const w = makeWorld();
    const jobId = await toRunning(w);
    w.advance(300);
    const requestedAt = new Date(w.clock.now);
    w.nosana.state.stopError = new Error("stop timed out");
    w.world.orphanRecordFails = true;
    await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
    w.advance(60);
    w.nosana.state.stopError = null;
    w.world.orphanRecordFails = false;
    endRun(w, exitCode, [], "stopped");
    w.nosana.only().job!.timeEnd = new Date(requestedAt.getTime() - 2_000);
    await reconcileTrainingJob(w.deps, jobId);
    const job = w.db.job(jobId);
    assert.equal(job.status, "cancelled", String(exitCode));
    assert.equal(job.failureCode, null, String(exitCode));
    assert.equal(job.actualCostCents, 8n, `${exitCode}: charged to the request`);
  }
});

test("cancel running: a stop that fails is handed to the sweep with its credential, and the job is settled", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(300);
  w.nosana.state.stopError = new Error("stop refused");
  assert.deepEqual(await cancelTrainingJob(w.deps, { orgId: ORG, jobId }), { ok: true, status: "cancelled" });
  assert.deepEqual(w.orphans, [
    { nosanaDeploymentId: w.nosana.only().id, sourceKind: "training", sourceId: jobId, reason: "training_cancelled", accessMode: "api_key" },
  ]);
  assert.equal(w.db.job(jobId).actualCostCents, 8n);
});

test("cancel: refused once the trainer has reported how the run ended, success or failure (R2)", async () => {
  const w = makeWorld();
  const jobId = await completedByCallback(w);
  w.deferred.length = 0;
  const refused = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.deepEqual(!refused.ok && [refused.status, refused.code], [409, "training_already_finished"]);
  assert.equal(w.db.job(jobId).status, "running", "nothing changed");
  assert.equal(w.db.job(jobId).cancelRequestedAt, null);
  await reconcileTrainingJob(w.deps, jobId);
  assert.equal(w.db.job(jobId).status, "completed");
  assert.equal(w.db.fineTuned.length, 1);

  const w2 = makeWorld();
  const failedJob = await toRunning(w2);
  w2.advance(120);
  await recordTrainingEvent(w2.deps, w2.callback(failedJob, trainerEvent(1, "failed", { exitCode: 13, code: "gpu_out_of_memory", message: "CUDA out of memory", phase: "train" })));
  w2.deferred.length = 0;
  const alsoRefused = await cancelTrainingJob(w2.deps, { orgId: ORG, jobId: failedJob });
  assert.equal(!alsoRefused.ok && alsoRefused.code, "training_already_finished");
});

test("cancel: a terminal event that lands between the cancel's read and its write makes the write miss (R2)", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(120);
  const prisma = w.deps.prisma;
  let injected = false;
  w.deps.prisma = {
    ...prisma,
    trainingJob: {
      ...prisma.trainingJob,
      findFirst: async (args) => {
        const row = await prisma.trainingJob.findFirst(args);
        if (!injected && row && row.status === "running") {
          injected = true;
          // The trainer's report arrives right after the cancel read the row.
          await recordTrainingEvent(w.deps, w.callback(jobId, trainerEvent(1, "failed", { exitCode: 13, code: "gpu_out_of_memory", message: "CUDA out of memory", phase: "train" })));
        }
        return row;
      },
    },
  };
  const result = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.equal(!result.ok && result.code, "training_already_finished");
  assert.equal(w.db.job(jobId).status, "running");
});

test("cancel: 409 for a job that is finalizing, already cancelling or over; 404 for another organization's", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  const other = await cancelTrainingJob(w.deps, { orgId: OTHER_ORG, jobId });
  assert.deepEqual(!other.ok && [other.status, other.code], [404, "training_job_not_found"]);

  for (const status of ["finalizing", "cancelling", "completed", "failed", "cancelled"]) {
    w.db.job(jobId).status = status;
    const result = await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
    assert.deepEqual(!result.ok && [result.status, result.code, result.extra], [409, "training_job_not_cancellable", { status }], status);
    assert.equal(w.db.job(jobId).status, status);
  }
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION]);
});

test("cancel racing the end of the run: settled exactly once, whoever wins", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(600);
  endRun(w, 11);
  await Promise.all([reconcileTrainingJob(w.deps, jobId), cancelTrainingJob(w.deps, { orgId: ORG, jobId })]);
  const job = w.db.job(jobId);
  assert.ok(job.status === "failed" || job.status === "cancelled");
  assert.deepEqual(w.db.ledgerOf(jobId), [RESERVATION, RELEASE, usage(15n)]);
  assert.equal(w.events().length, 2);
});

// ============================================
// Every transition, and reading jobs
// ============================================

test("every transition of the state machine is one the service makes", () => {
  // The tests above drive each of these; this pins the list they cover so a
  // new transition cannot be added without one.
  const covered = new Set([
    "pending>submitting", "pending>cancelled", "submitting>queued", "submitting>failed",
    "submitting>cancelling", "queued>running", "queued>failed", "queued>cancelling",
    "running>finalizing", "running>failed", "running>cancelling", "finalizing>completed",
    "finalizing>failed", "cancelling>cancelled", "cancelling>finalizing",
  ]);
  assert.deepEqual(
    TRAINING_TRANSITIONS.map((t) => `${t.from}>${t.to}`).filter((t) => !covered.has(t)),
    [],
  );
});

test("retry: a new job with the same configuration and its own hold; refused while the first is in progress", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  const early = await retryTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.deepEqual(!early.ok && [early.status, early.code], [409, "training_job_not_finished"]);

  await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  const retried = await retryTrainingJob(w.deps, { orgId: ORG, jobId });
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  assert.notEqual(retried.job.id, jobId);
  const next = w.db.job(retried.job.id);
  assert.deepEqual(
    [next.name, next.baseModelId, next.method, next.gpuTier, next.maxRuntimeSeconds, next.hyperparams],
    ["Support bot v1", "phi-3-mini", "lora", "4090", 3_600, { epochs: 2 }],
  );
  assert.deepEqual(w.db.ledgerOf(next.id), [RESERVATION]);
  assert.equal(w.db.job(jobId).status, "cancelled", "the first job is untouched");

  w.db.insertJob({ id: "bbbbbbbb-0000-4000-8000-000000000009", status: "failed" });
  const legacy = await retryTrainingJob(w.deps, { orgId: ORG, jobId: "bbbbbbbb-0000-4000-8000-000000000009" });
  assert.deepEqual(!legacy.ok && legacy.code, "training_job_not_retryable");
  const missing = await retryTrainingJob(w.deps, { orgId: OTHER_ORG, jobId });
  assert.deepEqual(!missing.ok && missing.status, 404);
});

test("detail: the hold and the cost so far while running; the charge and its ledger rows once settled", async () => {
  const w = makeWorld();
  const jobId = await toRunning(w);
  w.advance(400);
  const live = (await getTrainingJobDetail(w.deps, { orgId: ORG, jobId }))!;
  assert.equal(live.status, "running");
  assert.equal(live.reservationCents, 90);
  assert.equal(live.costSoFarCents, 10);
  assert.equal(live.actualCostCents, null);
  assert.equal(live.charged, null);
  assert.deepEqual(live.ledger.map((row) => [row.type, row.amountCents]), [["training_reservation", -90]]);
  assert.equal(live.dataset!.name, "support tickets");
  assert.equal((live as Record<string, unknown>).nosanaJobId, undefined, "which platform account pays is not the user's business");

  w.advance(200);
  endRun(w, 11, [eventLine(trainerEvent(1, "failed"))]);
  await reconcileTrainingJob(w.deps, jobId);
  const done = (await getTrainingJobDetail(w.deps, { orgId: ORG, jobId }))!;
  assert.equal(done.costSoFarCents, null);
  assert.equal(done.actualCostCents, 15);
  assert.equal(done.billedSeconds, 600);
  assert.equal(done.charged, true);
  assert.deepEqual(done.failure, { code: "dataset_row_invalid", message: "Row 3 has no completion", charged: true });
  assert.deepEqual(
    done.ledger.map((row) => [row.type, row.amountCents, row.balanceAfterCents]),
    [
      ["training_reservation", -90, 9_910],
      ["training_reservation_release", 90, 10_000],
      ["training_usage", -15, 9_985],
    ],
  );
  assert.equal(await getTrainingJobDetail(w.deps, { orgId: OTHER_ORG, jobId }), null);
  assert.equal(await getTrainingJobLogs(w.deps, { orgId: OTHER_ORG, jobId, tail: 10 }), null);
});

test("capabilities: can start when everything is configured; each blocker is named with a sentence", async () => {
  const w = makeWorld();
  const ready = await describeTrainingCapabilities(w.deps);
  assert.equal(ready.canStart, true);
  assert.deepEqual(ready.blockers, []);
  assert.deepEqual(ready.runLimit, { minSeconds: 300, maxSeconds: 20_700, setupAllowanceSeconds: 900, queueTimeoutSeconds: 1_800 });
  assert.equal(ready.nosana.tiers.find((tier) => tier.tier === "4090")!.deployable, true);

  w.world.store = null;
  w.world.runtime = {
    ...w.world.runtime,
    image: { configured: false, reason: "TRAINING_IMAGE not set" },
    nosanaConfigured: false,
    publicApiUrl: null,
    pollIntervalMs: 0,
    orphanSweepEnabled: false,
    batchJobTimeoutSeconds: 1_000,
  };
  const blocked = await describeTrainingCapabilities(w.deps);
  assert.equal(blocked.canStart, false);
  assert.deepEqual(
    blocked.blockers.map((blocker) => blocker.code),
    [
      "dataset_storage_not_configured",
      "training_image_not_configured",
      "nosana_not_configured",
      "training_callbacks_not_configured",
      "training_poller_disabled",
      "training_orphan_sweep_disabled",
      "training_run_limit_unavailable",
    ],
  );
  for (const blocker of blocked.blockers) {
    assert.equal(blocker.message, TRAINING_UNAVAILABLE_MESSAGE);
    assert.ok(!/TRAINING_|NOSANA_|PUBLIC_API_URL|server|configured/.test(blocker.message), "no configuration in a user's sentence");
  }
  // The operator reads which setting is missing, under the same codes.
  const operator = trainingOperatorBlockers(w.world.runtime, w.world.store);
  assert.deepEqual(
    operator.map((blocker) => blocker.code),
    blocked.blockers.map((blocker) => blocker.code),
  );
  const operatorByCode = Object.fromEntries(operator.map((blocker) => [blocker.code, blocker.message]));
  assert.match(operatorByCode.dataset_storage_not_configured!, /DATASETS_BUCKET/);
  assert.match(operatorByCode.training_image_not_configured!, /TRAINING_IMAGE not set/);
  assert.match(operatorByCode.nosana_not_configured!, /NOSANA_API_KEY/);
  assert.match(operatorByCode.training_callbacks_not_configured!, /PUBLIC_API_URL/);
  assert.match(operatorByCode.training_poller_disabled!, /TRAINING_POLL_INTERVAL_MS/);
  assert.match(operatorByCode.training_orphan_sweep_disabled!, /DEPLOYMENT_STATUS_INTERVAL_MS/);
  assert.match(operatorByCode.training_run_limit_unavailable!, /NOSANA_BATCH_JOB_TIMEOUT_SECONDS/);

  w.world.runtime = { ...w.world.runtime, nosanaMock: true, nosanaConfigured: true };
  const mock = await describeTrainingCapabilities(w.deps);
  assert.ok(mock.blockers.some((blocker) => blocker.code === "training_requires_real_nosana"));
  assert.equal(mock.nosana.tiers.every((tier) => !tier.deployable), true);

  w.world.runtime = { ...w.world.runtime, nosanaMock: false, tiers: {} };
  const noTier = await describeTrainingCapabilities(w.deps);
  assert.ok(noTier.blockers.some((blocker) => blocker.code === "gpu_market_not_configured"));
});

test("models: every trainable model, with the reason one is unavailable", async () => {
  const w = makeWorld();
  const models = await listTrainingModels(w.deps);
  const byId = Object.fromEntries(models.map((model) => [model.id, model]));
  assert.equal(byId["phi-3-mini"]!.available, true);
  assert.deepEqual(byId["phi-3-mini"]!.supportedMethods, ["lora", "qlora"]);
  assert.equal(byId["phi-3-mini"]!.recommendedGpuTier, "4090");
  assert.equal(byId["llama-3.1-8b"]!.available, false);
  assert.equal(byId["llama-3.1-8b"]!.unavailableReason, "hf_token_required");
  assert.equal(byId["llama-3.1-8b"]!.unavailableMessage, "This model is not available for fine-tuning right now.");
  // In the trainable catalog but not in this server's model table.
  assert.equal(byId["qwen2-7b"]!.unavailableReason, "model_not_in_catalog");
  assert.ok(models.every((model) => model.methods.every((entry) => (entry.method as string) !== "full")));

  w.world.runtime.hfToken = "hf_abcdefghijklmnop";
  const withToken = await listTrainingModels(w.deps);
  assert.equal(withToken.find((model) => model.id === "llama-3.1-8b")!.available, true);
});

test("the dataset of a job can be deleted afterwards and the detail still names it", async () => {
  const w = makeWorld();
  const jobId = await admit(w);
  await cancelTrainingJob(w.deps, { orgId: ORG, jobId });
  w.db.datasets[0]!.deletedAt = new Date();
  const detail = (await getTrainingJobDetail(w.deps, { orgId: ORG, jobId }))!;
  assert.deepEqual(detail.dataset, { id: DATASET, name: "support tickets", rowCount: 50, deleted: true });
});
