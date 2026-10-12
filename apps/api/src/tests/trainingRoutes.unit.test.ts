import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { globalErrorHandler } from "../lib/errorHandler.js";
import { acceptEmptyJsonBody } from "../routes/emptyJsonBody.js";
import { createTrainingRoutes } from "../routes/training.js";
import { IMAGE, JOB_INPUT, makeWorld, ORG, trainerEvent, type World } from "./trainingFakes.js";

// The /api/training job routes over HTTP (Fastify inject), with the fake
// world behind them: status codes and bodies of each answer, the session
// check, and the container callback route with its raw-body signature.

async function appFor(w: World, opts: { signedIn?: boolean } = {}) {
  const app = Fastify();
  // As index.ts does, so the callback scope has a parser to replace.
  acceptEmptyJsonBody(app);
  app.setErrorHandler(globalErrorHandler);
  await app.register(
    createTrainingRoutes({
      training: w.deps,
      datasets: {
        db: { list: async () => [] },
        getStore: () => w.world.store,
        getLimits: () => ({ maxBytes: 1, maxRows: 1 }),
      } as never,
      auth: async (request, reply) => {
        if (opts.signedIn === false) return reply.status(401).send({ error: "Unauthorized" });
        (request as unknown as { auth: unknown }).auth = { orgId: ORG, type: "jwt" };
      },
    }),
    { prefix: "/api/training" },
  );
  return app;
}

const post = (app: Awaited<ReturnType<typeof appFor>>, url: string, payload?: unknown) =>
  app.inject({ method: "POST", url, payload: payload as never });

test("every job route needs a session; the callback route does not use one", async () => {
  const w = makeWorld();
  const app = await appFor(w, { signedIn: false });
  const id = "aaaaaaaa-0000-4000-8000-000000000001";
  for (const [method, url] of [
    ["GET", "/api/training/capabilities"],
    ["GET", "/api/training/models"],
    ["GET", "/api/training/jobs"],
    ["GET", `/api/training/jobs/${id}`],
    ["GET", `/api/training/jobs/${id}/logs`],
    ["POST", "/api/training/jobs"],
    ["POST", "/api/training/estimate"],
    ["POST", `/api/training/jobs/${id}/cancel`],
    ["POST", `/api/training/jobs/${id}/retry`],
    ["GET", "/api/training/datasets"],
  ] as const) {
    const response = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
    assert.equal(response.statusCode, 401, `${method} ${url}`);
  }
  // No session there: an unsigned callback is refused for its signature.
  const callback = await post(app, `/api/training/jobs/${id}/events?n=abcdefgh1234`, trainerEvent(1, "started"));
  assert.equal(callback.statusCode, 401);
  assert.equal(callback.json().error, "invalid_callback_signature");
  // The old unauthenticated-by-token webhook path is gone.
  assert.equal((await post(app, `/api/training/jobs/${id}/webhook?token=x`, {})).statusCode, 404);
  await app.close();
});

test("POST /jobs: 201 with the hold; then list, detail, logs, cancel and retry", async () => {
  const w = makeWorld();
  const app = await appFor(w);

  const created = await post(app, "/api/training/jobs", {
    name: "Support bot v1",
    baseModelId: "phi-3-mini",
    datasetId: JOB_INPUT.datasetId,
    method: "lora",
    gpuTier: "4090",
    maxRuntimeMinutes: 60,
    config: { epochs: 2 },
  });
  assert.equal(created.statusCode, 201);
  const body = created.json();
  assert.equal(body.job.status, "pending");
  assert.deepEqual(body.reservation, { cents: 90, maxRuntimeSeconds: 3600, pricePerSecondUsd: 0.00025 });
  assert.equal(body.estimate.basis, "planning");
  const jobId = body.job.id;
  await w.drain();

  const list = (await app.inject({ url: "/api/training/jobs?status=queued" })).json();
  assert.equal(list.total, 1);
  assert.equal(list.jobs[0].id, jobId);
  assert.equal(list.jobs[0].reservationCents, 90);
  assert.equal(list.jobs[0].datasetName, "support tickets");
  assert.equal((await app.inject({ url: "/api/training/jobs?status=completed" })).json().total, 0);
  assert.equal((await app.inject({ url: "/api/training/jobs?status=nonsense" })).statusCode, 400);

  const detail = (await app.inject({ url: `/api/training/jobs/${jobId}` })).json();
  assert.equal(detail.job.status, "queued");
  assert.deepEqual(detail.job.ledger.map((row: { type: string }) => row.type), ["training_reservation"]);
  assert.equal(detail.job.dataset.name, "support tickets");
  assert.deepEqual(Object.keys(detail.job.nosana), ["deploymentId", "jobAddress", "jobUrl"]);
  assert.equal(detail.job.nosana.jobUrl, null);
  const logs = (await app.inject({ url: `/api/training/jobs/${jobId}/logs` })).json();
  assert.deepEqual([logs.logs, logs.totalLines, logs.source], ["", 0, "none"]);

  const missing = "aaaaaaaa-0000-4000-8000-999999999999";
  assert.equal((await app.inject({ url: `/api/training/jobs/${missing}` })).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/training/jobs/${missing}/logs` })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/training/jobs/not-a-uuid" })).statusCode, 400);

  // Retry of a job in progress is refused; cancel answers 200 once it is over.
  const early = await post(app, `/api/training/jobs/${jobId}/retry`);
  assert.deepEqual([early.statusCode, early.json().error], [409, "training_job_not_finished"]);
  const cancelled = await post(app, `/api/training/jobs/${jobId}/cancel`);
  assert.deepEqual([cancelled.statusCode, cancelled.json().status], [200, "cancelled"]);
  const again = await post(app, `/api/training/jobs/${jobId}/cancel`);
  assert.deepEqual([again.statusCode, again.json().error, again.json().status], [409, "training_job_not_cancellable", "cancelled"]);

  const retried = await post(app, `/api/training/jobs/${jobId}/retry`);
  assert.equal(retried.statusCode, 201);
  assert.equal(retried.json().retryOf, jobId);
  assert.notEqual(retried.json().job.id, jobId);
  await app.close();
});

test("POST /jobs/:id/cancel answers 202 while the stop is still to be confirmed", async () => {
  const w = makeWorld();
  const app = await appFor(w);
  const jobId = (await post(app, "/api/training/jobs", JOB_INPUT)).json().job.id;
  await w.drain();
  w.nosana.state.stopError = new Error("stop timed out");
  w.world.orphanRecordFails = true;
  const response = await post(app, `/api/training/jobs/${jobId}/cancel`);
  assert.deepEqual([response.statusCode, response.json().status], [202, "cancelling"]);
  await app.close();
});

test("POST /jobs: each refusal has its status and code, and creates nothing", async () => {
  const w = makeWorld();
  const app = await appFor(w);
  const send = async (patch: Record<string, unknown>) => {
    const response = await post(app, "/api/training/jobs", { ...JOB_INPUT, ...patch });
    return [response.statusCode, response.json().error];
  };

  // The schema.
  assert.equal((await post(app, "/api/training/jobs", { name: "x" })).statusCode, 400);
  assert.equal((await send({ name: "" }))[0], 400);
  assert.equal((await send({ datasetId: "nope" }))[0], 400);
  assert.deepEqual(await send({ maxRuntimeMinutes: 60 }), [400, "invalid_run_limit"]);
  assert.deepEqual(await send({ config: { epochs: 2 } }), [400, "invalid_hyperparameter"]);
  // Named refusals of the service.
  assert.deepEqual(await send({ gpuTier: "rtx-4090" }), [400, "unknown_gpu_tier"]);
  assert.deepEqual(await send({ method: "full" }), [400, "unsupported_method"]);
  assert.deepEqual(await send({ gpuCount: 2 }), [400, "unsupported_gpu_count"]);
  assert.deepEqual(await send({ gpuTier: "3060" }), [400, "tier_too_small"]);
  assert.deepEqual(await send({ hyperparams: { quantizationBits: 4 } }), [400, "unknown_hyperparameter"]);
  assert.deepEqual(await send({ hyperparams: { learningRate: 1 } }), [400, "invalid_hyperparameter"]);
  assert.deepEqual(await send({ maxRuntimeSeconds: 60 }), [400, "run_limit_out_of_range"]);
  assert.deepEqual(await send({ baseModelId: "nope" }), [404, "model_not_found"]);
  assert.deepEqual(await send({ datasetId: "aaaaaaaa-0000-4000-8000-999999999999" }), [404, "dataset_not_found"]);
  assert.deepEqual(await send({ baseModelId: "llama-3.1-8b", method: "qlora" }), [400, "hf_token_required"]);

  w.world.runtime.image = { configured: false, reason: "TRAINING_IMAGE not set" };
  assert.deepEqual(await send({}), [501, "training_image_not_configured"]);
  w.world.runtime.image = { configured: true, reference: `registry.example.com/t@sha256:${"a".repeat(64)}`, registry: null };
  w.world.runtime.nosanaMock = true;
  assert.deepEqual(await send({}), [501, "training_requires_real_nosana"]);
  w.world.runtime.nosanaMock = false;
  w.world.runtime.pollIntervalMs = 0;
  assert.deepEqual(await send({}), [503, "training_poller_disabled"]);
  w.world.runtime.pollIntervalMs = 15_000;
  w.db.balances[0]!.balanceCents = 1n;
  const poor = await post(app, "/api/training/jobs", JOB_INPUT);
  assert.equal(poor.statusCode, 402);
  assert.deepEqual(poor.json().error, "insufficient_credits");
  assert.deepEqual([poor.json().requiredCents, poor.json().balanceCents], [90, 1]);

  assert.equal(w.db.jobs.length, 0);
  assert.equal(w.db.ledger.length, 0);
  assert.deepEqual(w.events(), []);
  await app.close();
});

test("GET /capabilities and /models tell a page what can start and why not", async () => {
  const w = makeWorld();
  const app = await appFor(w);
  const ready = (await app.inject({ url: "/api/training/capabilities" })).json();
  assert.equal(ready.canStart, true);
  assert.deepEqual(ready.storage, { configured: true, driver: "local", maxDatasetBytes: 209715200, maxDatasetRows: 200000 });
  assert.deepEqual(ready.deploy, { available: true, blockers: [] });

  // A fine-tuned model cannot be deployed here: said beside it, and a job can still start.
  w.world.deployBlockers = [{ code: "adapter_storage_not_configured", message: "Set STORAGE_DRIVER." }];
  const noDeploy = (await app.inject({ url: "/api/training/capabilities" })).json();
  assert.equal(noDeploy.canStart, true);
  assert.deepEqual(noDeploy.deploy, {
    available: false,
    blockers: [
      {
        code: "adapter_storage_not_configured",
        message: "Deploying fine-tuned models is temporarily unavailable. Try again later.",
      },
    ],
  });
  w.world.deployBlockers = [];

  w.world.runtime.image = { configured: false, reason: "TRAINING_IMAGE not set" };
  const blocked = (await app.inject({ url: "/api/training/capabilities" })).json();
  assert.equal(blocked.canStart, false);
  assert.deepEqual(blocked.blockers, [
    {
      code: "training_image_not_configured",
      message: "Fine-tuning is temporarily unavailable. Try again later.",
    },
  ]);

  // The organization's own blocker: its free failures of the last day (R4).
  w.world.runtime.image = { configured: true, reference: IMAGE, registry: null };
  w.world.runtime.freeFailuresPerDay = 1;
  w.db.insertJob({
    id: "cccccccc-3333-4333-8333-000000000001",
    status: "failed",
    failureCode: "out_of_memory",
    reservationCents: 90n,
    actualCostCents: 0n,
    settledAt: new Date(w.clock.now),
  });
  const limited = (await app.inject({ url: "/api/training/capabilities" })).json();
  assert.equal(limited.canStart, false);
  assert.deepEqual(limited.blockers.map((blocker: { code: string }) => blocker.code), ["training_free_failure_limit"]);
  assert.match(limited.blockers[0].message, /^Fine-tuning cannot start for your organization until 2026-10-13 10:00 UTC/);

  const models = (await app.inject({ url: "/api/training/models" })).json().models;
  const llama = models.find((model: { id: string }) => model.id === "llama-3.1-8b");
  assert.deepEqual([llama.available, llama.unavailableReason, llama.gated], [false, "hf_token_required", true]);
  assert.equal(typeof models.find((model: { id: string }) => model.id === "phi-3-mini").parameters, "number");
  await app.close();
});

test("POST /estimate: the cheapest fitting tier when none is named; numbers, not bigints", async () => {
  const w = makeWorld();
  const app = await appFor(w);
  const response = await post(app, "/api/training/estimate", {
    baseModelId: "phi-3-mini",
    datasetId: JOB_INPUT.datasetId,
    method: "qlora",
    epochs: 1,
  });
  assert.equal(response.statusCode, 200);
  const { estimate, dataset } = response.json();
  assert.equal(estimate.gpuTier, "3060", "QLoRA on a 3.8B model fits 12 GB");
  assert.equal(estimate.recommendedGpuTier, "3060");
  assert.equal(estimate.basis, "planning");
  assert.equal(typeof estimate.maximumCents, "number");
  assert.ok(estimate.runLimit.suggestedSeconds >= 900);
  assert.deepEqual(dataset, { id: JOB_INPUT.datasetId, rowCount: 50, avgTokensPerRow: 200 });

  assert.deepEqual(response.json().hold, {
    cents: estimate.maximumCents,
    maxRuntimeSeconds: estimate.runLimit.appliedSeconds,
    pricePerSecondUsd: estimate.pricePerSecondUsd,
    gpuTier: "3060",
  });

  // A dataset with no tokens per row and a chosen run limit: no estimate, the hold.
  w.db.datasets[0]!.avgTokensPerRow = null;
  const parquet = await post(app, "/api/training/estimate", { ...JOB_INPUT, name: undefined });
  assert.equal(parquet.statusCode, 200);
  assert.deepEqual(parquet.json(), {
    estimate: null,
    hold: { cents: 90, maxRuntimeSeconds: 3_600, pricePerSecondUsd: 0.00025, gpuTier: "4090" },
    dataset: { id: JOB_INPUT.datasetId, rowCount: 50, avgTokensPerRow: null },
  });
  const noLimit = await post(app, "/api/training/estimate", { ...JOB_INPUT, name: undefined, maxRuntimeSeconds: undefined });
  assert.deepEqual([noLimit.statusCode, noLimit.json().error], [422, "training_estimate_unavailable"]);
  w.db.datasets[0]!.avgTokensPerRow = 200;

  const full = await post(app, "/api/training/estimate", { ...JOB_INPUT, name: undefined, method: "full" });
  assert.deepEqual([full.statusCode, full.json().error], [400, "unsupported_method"]);
  assert.equal(w.db.jobs.length, 0);
  await app.close();
});

test("POST /jobs/:id/events: signed over the raw bytes; replay, stale, oversize and malformed are refused", async () => {
  const w = makeWorld();
  const app = await appFor(w);
  const jobId = (await post(app, "/api/training/jobs", JOB_INPUT)).json().job.id;
  await w.drain();

  const send = (callback: ReturnType<World["callback"]>, body: string | Buffer = callback.rawBody) =>
    app.inject({
      method: "POST",
      url: `/api/training/jobs/${callback.jobId}/events?n=${callback.nonce}`,
      headers: { "content-type": "application/json", "x-wheelsai-signature": callback.signatureHeader },
      payload: body,
    });

  // The first event of a queued job starts it.
  const first = await send(w.callback(jobId, trainerEvent(1, "started")));
  assert.deepEqual([first.statusCode, first.json()], [200, { received: true, applied: true }]);
  assert.equal(w.db.job(jobId).status, "running");

  // Replayed byte for byte: acknowledged, not applied.
  const step = w.callback(jobId, trainerEvent(2, "step"));
  assert.deepEqual((await send(step)).json(), { received: true, applied: true });
  assert.deepEqual((await send(step)).json(), { received: true, applied: false });

  // The same JSON re-spaced is other bytes: the signature does not hold.
  const respaced = await send(step, JSON.stringify(JSON.parse(step.rawBody), null, 2));
  assert.deepEqual([respaced.statusCode, respaced.json().error], [401, "invalid_callback_signature"]);

  // Stale: signed more than five minutes ago.
  const stale = await send(w.callback(jobId, trainerEvent(3, "step"), { at: new Date(w.clock.now.getTime() - 301_000) }));
  assert.equal(stale.statusCode, 401);

  // Signed, but the old webhook's shape: it cannot set a status.
  const forgedShape = await send(w.callback(jobId, { status: "completed", outputPath: "s3://x" }));
  assert.deepEqual([forgedShape.statusCode, forgedShape.json().error], [400, "invalid_trainer_event"]);

  // Over 64 KB: refused by the parser of this route alone.
  const big = w.callback(jobId, trainerEvent(3, "failed", { message: "x".repeat(400), pad: "y".repeat(400) }));
  const oversize = await send(big, Buffer.alloc(65_537, 0x20));
  assert.equal(oversize.statusCode, 413);

  // A terminal event is a report: the job is still running, nothing is settled.
  const done = await send(w.callback(jobId, trainerEvent(3, "completed")));
  assert.deepEqual(done.json(), { received: true, applied: true });
  assert.equal(w.db.job(jobId).status, "running");
  assert.equal(w.db.job(jobId).lastEventSeq, 3);
  assert.equal(w.db.ledgerOf(jobId).length, 1);

  // The other routes of the plugin still parse JSON as objects.
  const estimate = await post(app, "/api/training/estimate", { ...JOB_INPUT, name: undefined });
  assert.equal(estimate.statusCode, 200);
  await app.close();
});
