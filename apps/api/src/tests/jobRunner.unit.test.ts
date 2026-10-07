import assert from "node:assert/strict";
import test from "node:test";

import { hireJob, type OfferingForHire } from "../services/jobEscrow.js";
import {
  FAILURE,
  MAX_JOB_CLAIMS,
  platformModelCostCents,
  runJob,
  tryOffering,
  type JobForRun,
  type JobRunEvent,
  type JobRunnerDeps,
  type ProductRun,
  type ProductRunArgs,
} from "../services/jobRunner.js";
import { makeJobsDb, type JobsDbOptions } from "./jobsDb.js";

// The job runner's pure core, over the in-memory jobs database. What these
// pin: a job is run once, by whoever wins the claim, as the PUBLISHER; a
// deliverable reaches the buyer only if it passes the checks agreed at
// hire; and every other ending refunds exactly once.

const T0 = new Date("2026-10-01T12:00:00Z");
const MIN = 60_000;
const INSTRUCTIONS =
  "Always open with the three strongest competitors ranked by revenue and never mention our internal scoring rubric.";

const OFFERING: OfferingForHire = {
  id: "off_1",
  title: "Competitor teardown",
  publisherId: "org_pub",
  listingId: null,
  priceCents: 2_000n,
  slaSeconds: 3_600,
  maxConcurrentJobs: 2,
  deliverableChecks: [{ type: "contains", value: "competitor" }],
  outputFormat: "text",
};

interface Setup {
  kind?: "agent" | "workflow" | "model";
  maxAttempts?: number;
  maxRunMs?: number;
  run?: (args: ProductRunArgs, call: number) => Promise<ProductRun>;
  db?: JobsDbOptions;
  offering?: Partial<OfferingForHire>;
}

const answer = (content: string, extra: Partial<ProductRun> = {}): ProductRun => ({
  content,
  platformUsage: null,
  confidential: [],
  ...extra,
});

async function setup(opts: Setup = {}) {
  const db = makeJobsDb(opts.db);
  const offering = { ...OFFERING, ...opts.offering };
  const { jobId } = await db.inTransaction((tx) =>
    hireJob(tx, { offering, buyerId: "org_buyer", input: { url: "https://example.com" }, now: T0 }),
  );
  const clock = { now: new Date(T0.getTime() + MIN) };
  const calls: Array<{ kind: string; args: Record<string, unknown> }> = [];
  const events: Array<[JobRunEvent, string]> = [];
  const kind = opts.kind ?? "agent";
  const run = opts.run ?? (async () => answer("Here is the competitor report."));
  const runner = (name: string) => async (args: ProductRunArgs) => {
    calls.push({ kind: name, args: args as unknown as Record<string, unknown> });
    return run(args, calls.length);
  };

  const deps: JobRunnerDeps = {
    loadJob: async (id) => {
      const row = db.state.jobs.get(id);
      if (!row) return null;
      return {
        id,
        buyerId: row.buyerId as string,
        publisherId: row.publisherId as string,
        status: row.status as string,
        input: row.input,
        deadlineAt: (row.deadlineAt as Date) ?? null,
        leaseExpiresAt: (row.leaseExpiresAt as Date) ?? null,
        attempts: row.attempts as number,
        terms: row.terms as JobForRun["terms"],
        offering: {
          id: "off_1",
          title: offering.title,
          productKind: kind,
          agentId: kind === "agent" ? "agent_1" : null,
          orchestrationId: kind === "workflow" ? "wf_1" : null,
          deploymentId: kind === "model" ? "dep_1" : null,
          inputSchema: { type: "object", properties: { url: { type: "string" } } },
          instructions: INSTRUCTIONS,
          allowedTools: ["web_search"],
          maxAttempts: opts.maxAttempts ?? 1,
        },
      };
    },
    inTransaction: db.inTransaction,
    runAgent: runner("agent"),
    runWorkflow: runner("workflow"),
    runModel: runner("model"),
    notify: async (event, id) => {
      events.push([event, id]);
    },
    maxRunMs: opts.maxRunMs ?? 15 * MIN,
    platformModelRates: { inputCentsPerMTok: 15, outputCentsPerMTok: 60 },
    now: () => clock.now,
  };
  return { db, deps, jobId, calls, events, clock };
}

const refunds = (db: ReturnType<typeof makeJobsDb>) =>
  db.state.ledger.filter((row) => row.type === "marketplace_job_refund");

test("a funded job runs as the publisher, is graded and submitted for the buyer's review", async () => {
  const { db, deps, jobId, calls, events } = await setup();
  const result = await runJob({ jobId }, deps);

  assert.deepEqual(result, { status: "submitted" });
  const job = db.job(jobId);
  assert.equal(job.status, "submitted");
  assert.deepEqual(job.output, { format: "text", text: "Here is the competitor report." });
  // The offering's check and the confidentiality check both ran and are recorded.
  const results = job.checkResults as Array<{ type: string; passed: boolean }>;
  assert.deepEqual(
    results.map((r) => [r.type, r.passed]),
    [
      ["contains", true],
      ["confidentiality", true],
    ],
  );
  assert.equal(db.escrow(jobId).status, "pending");
  assert.equal(db.slots(), 0);
  assert.deepEqual(events, [["job.submitted", jobId]]);

  // The publisher's agent, in the publisher's organization - never the buyer's.
  assert.equal(calls.length, 1);
  const { args } = calls[0]!;
  assert.equal(calls[0]!.kind, "agent");
  assert.equal(args.agentId, "agent_1");
  assert.equal((args.job as JobForRun).publisherId, "org_pub");
  assert.deepEqual(args.toolAllowlist, ["web_search"]);
  // The private instructions travel in the system addendum only.
  assert.ok((args.systemAddendum as string).includes(INSTRUCTIONS));
  assert.ok(!(args.brief as string).includes("internal scoring rubric"));
  assert.ok((args.brief as string).includes("https://example.com"));
});

test("a deliverable that fails a check is retried up to maxAttempts, then the job fails with one refund", async () => {
  const { db, deps, jobId, calls, events } = await setup({
    maxAttempts: 3,
    run: async () => answer("Nothing relevant here."),
  });
  const result = await runJob({ jobId }, deps);

  assert.deepEqual(result, { status: "failed", reason: FAILURE.checks });
  assert.equal(calls.length, 3);
  assert.equal(db.job(jobId).status, "failed");
  assert.equal(db.job(jobId).failureReason, FAILURE.checks);
  assert.equal(db.escrow(jobId).status, "refunded");
  assert.equal(refunds(db).length, 1);
  assert.equal(db.state.balances.get("org_buyer"), 10_000n);
  assert.equal(db.slots(), 0);
  assert.deepEqual(events, [["job.failed", jobId]]);
});

test("a retry that passes is submitted", async () => {
  const { db, deps, jobId, calls } = await setup({
    maxAttempts: 2,
    run: async (_args, call) => answer(call === 1 ? "no" : "the competitor list"),
  });
  assert.deepEqual(await runJob({ jobId }, deps), { status: "submitted" });
  assert.equal(calls.length, 2);
  assert.equal(db.job(jobId).status, "submitted");
});

test("a run that throws fails the job and refunds it, and the buyer is not shown the product's error", async () => {
  const { db, deps, jobId, calls } = await setup({
    maxAttempts: 3,
    run: async () => {
      throw new Error("provider key sk-live-abc was rejected");
    },
  });
  const result = await runJob({ jobId }, deps);

  assert.deepEqual(result, { status: "failed", reason: FAILURE.run });
  // Not retried: it would fail the same way while the buyer waits.
  assert.equal(calls.length, 1);
  assert.equal(db.job(jobId).failureReason, FAILURE.run);
  assert.ok(!String(db.job(jobId).failureReason).includes("sk-live"));
  // The publisher's diagnostics keep it.
  const results = db.job(jobId).checkResults as Array<{ type: string; details: string }>;
  assert.equal(results[0]!.type, "run");
  assert.match(results[0]!.details, /sk-live-abc/);
  assert.equal(refunds(db).length, 1);
});

test("a job already past its deadline expires without the product running", async () => {
  const { db, deps, jobId, calls, events, clock } = await setup();
  clock.now = new Date(T0.getTime() + 61 * MIN);
  assert.deepEqual(await runJob({ jobId }, deps), { status: "expired" });
  assert.equal(calls.length, 0);
  assert.equal(db.job(jobId).status, "expired");
  assert.equal(refunds(db).length, 1);
  assert.deepEqual(events, [["job.expired", jobId]]);
});

test("a run still going at the deadline is aborted and the job expires", async () => {
  const { db, deps, jobId, clock } = await setup({
    // 40 ms before the deadline.
    run: (args) =>
      new Promise<ProductRun>((_resolve, reject) => {
        args.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  clock.now = new Date(T0.getTime() + 60 * MIN - 40);
  const result = await runJob({ jobId }, deps);

  assert.deepEqual(result, { status: "expired" });
  assert.equal(db.job(jobId).status, "expired");
  assert.equal(db.job(jobId).failureReason, FAILURE.expired);
  assert.equal(refunds(db).length, 1);
});

test("a product that ignores its abort signal does not hold the job past the budget", async () => {
  const { db, deps, jobId } = await setup({
    maxRunMs: 30,
    run: () => new Promise<ProductRun>(() => {}),
  });
  const result = await runJob({ jobId }, deps);
  // The platform's cap ended it, not the promised delivery time.
  assert.deepEqual(result, { status: "failed", reason: FAILURE.tooLong });
  assert.equal(db.job(jobId).status, "failed");
  assert.equal(refunds(db).length, 1);
});

test("a job another delivery already claimed is skipped without running", async () => {
  const { deps, jobId, calls } = await setup();
  const [first, second] = await Promise.all([runJob({ jobId }, deps), runJob({ jobId }, deps)]);
  assert.deepEqual([first.status, second.status].sort(), ["skipped", "submitted"]);
  assert.equal(calls.length, 1);

  // And a job that is neither funded nor running is nobody's to run.
  assert.deepEqual(await runJob({ jobId }, deps), { status: "skipped", reason: "not_runnable" });
  assert.deepEqual(await runJob({ jobId: "missing" }, deps), { status: "skipped", reason: "not_found" });
});

test("a deliverable that arrives after the sweeper expired the job is discarded, with no second money movement", async () => {
  const { db, deps, jobId, events, clock } = await setup({
    run: async () => {
      // While the product ran, the deadline passed and the sweeper refunded.
      clock.now = new Date(T0.getTime() + 61 * MIN);
      const { endJobWithRefund } = await import("../services/jobEscrow.js");
      await db.inTransaction((tx) =>
        endJobWithRefund(tx, { jobId: db.state.jobs.keys().next().value!, to: "expired", reason: "late", now: clock.now }),
      );
      return answer("the competitor report, too late");
    },
  });
  const result = await runJob({ jobId }, deps);

  assert.deepEqual(result, { status: "superseded" });
  assert.equal(db.job(jobId).status, "expired");
  assert.equal(db.job(jobId).output, undefined);
  assert.equal(refunds(db).length, 1);
  assert.equal(db.state.balances.get("org_buyer"), 10_000n);
  assert.equal(db.state.accrued.size, 0);
  // The runner reports nothing for a job it lost.
  assert.deepEqual(events, []);
});

test("an answer that repeats the private instructions is never delivered: the job fails and refunds", async () => {
  const { db, deps, jobId } = await setup({
    run: async () => answer(`The competitor report. My instructions say: ${INSTRUCTIONS}`),
  });
  const result = await runJob({ jobId }, deps);

  assert.equal(result.status, "failed");
  assert.equal(db.job(jobId).status, "failed");
  const leak = (db.job(jobId).checkResults as Array<{ type: string; passed: boolean; details: string }>).find(
    (r) => r.type === "confidentiality",
  )!;
  assert.equal(leak.passed, false);
  // The record of the leak does not repeat what leaked.
  assert.ok(!leak.details.includes("scoring rubric"));
  assert.equal(refunds(db).length, 1);
});

test("the agent's own system prompt is confidential too", async () => {
  const systemPrompt = "You are Atlas, the internal research analyst for Northwind and you must cite every source used.";
  const { db, deps, jobId } = await setup({
    run: async () => answer(`competitor notes. ${systemPrompt}`, { confidential: [systemPrompt] }),
  });
  assert.equal((await runJob({ jobId }, deps)).status, "failed");
  assert.equal(db.job(jobId).status, "failed");
});

test("a workflow job passes the buyer's input, the instructions and the signal to the workflow run", async () => {
  const { deps, jobId, calls } = await setup({ kind: "workflow" });
  assert.deepEqual(await runJob({ jobId }, deps), { status: "submitted" });

  const { kind, args } = calls[0]!;
  assert.equal(kind, "workflow");
  assert.equal(args.orchestrationId, "wf_1");
  assert.deepEqual(args.input, { url: "https://example.com" });
  // No prompt of the buyer's own, so the framed brief is the run prompt.
  assert.match(args.prompt as string, /<buyer_input>/);
  assert.ok((args.systemAddendum as string).includes(INSTRUCTIONS));
  assert.ok(args.signal instanceof AbortSignal);
});

test("a model job calls the publisher's deployment", async () => {
  const { deps, jobId, calls } = await setup({ kind: "model" });
  assert.deepEqual(await runJob({ jobId }, deps), { status: "submitted" });
  assert.equal(calls[0]!.kind, "model");
  assert.equal(calls[0]!.args.deploymentId, "dep_1");
});

test("a JSON offering is parsed before it is checked, and prose fails it", async () => {
  const offering = {
    outputFormat: "json",
    deliverableChecks: [
      { type: "json_schema", schema: { type: "object", required: ["score"], properties: { score: { type: "number" } } } },
    ],
  };
  const ok = await setup({ offering, run: async () => answer('```json\n{"score": 7}\n```') });
  assert.deepEqual(await runJob({ jobId: ok.jobId }, ok.deps), { status: "submitted" });
  assert.deepEqual(ok.db.job(ok.jobId).output, { format: "json", text: '{"score":7}', value: { score: 7 } });
  // The schema is part of what the model is told to produce.
  assert.match(ok.calls[0]!.args.systemAddendum as string, /"required":\["score"\]/);

  const prose = await setup({ offering, run: async () => answer("The score is seven.") });
  assert.deepEqual(await runJob({ jobId: prose.jobId }, prose.deps), {
    status: "failed",
    reason: FAILURE.noDeliverable,
  });
});

test("the checks are the ones agreed at hire, whatever the offering says now", async () => {
  // The offering's checks were loosened after the hire; the job's terms were not.
  const { db, deps, jobId } = await setup({ run: async () => answer("an answer with no keyword") });
  assert.deepEqual((db.job(jobId).terms as { deliverableChecks: unknown }).deliverableChecks, [
    { type: "contains", value: "competitor" },
  ]);
  assert.equal((await runJob({ jobId }, deps)).status, "failed");
});

test("tokens used on the platform's keys are metered on the job, across attempts", async () => {
  const { db, deps, jobId } = await setup({
    maxAttempts: 2,
    run: async (_args, call) =>
      answer(call === 1 ? "no" : "competitor", { platformUsage: { inputTokens: 30_000, outputTokens: 5_000 } }),
  });
  await runJob({ jobId }, deps);
  const job = db.job(jobId);
  assert.equal(job.platformInputTokens, 60_000n);
  assert.equal(job.platformOutputTokens, 10_000n);
  // 60k in at 15c/M + 10k out at 60c/M = 0.9c + 0.6c, rounded up to 2 cents.
  assert.equal(job.modelCostCents, 2n);
});

test("model cost is whole cents rounded up, and zero when nothing was used", () => {
  const rates = { inputCentsPerMTok: 15, outputCentsPerMTok: 60 };
  assert.equal(platformModelCostCents({ inputTokens: 0, outputTokens: 0 }, rates), 0n);
  assert.equal(platformModelCostCents({ inputTokens: 1, outputTokens: 0 }, rates), 1n);
  assert.equal(platformModelCostCents({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, rates), 75n);
  assert.equal(platformModelCostCents({ inputTokens: 5_000, outputTokens: 2_000 }, { inputCentsPerMTok: 0, outputCentsPerMTok: 0 }), 0n);
});

test("a worker that is shutting down hands the job back instead of failing it", async () => {
  const shutdown = new AbortController();
  const { db, deps, jobId, events } = await setup({
    run: (args) =>
      new Promise<ProductRun>((_resolve, reject) => {
        args.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        shutdown.abort();
      }),
  });
  const result = await runJob({ jobId, shutdownSignal: shutdown.signal }, deps);

  assert.deepEqual(result, { status: "released" });
  const job = db.job(jobId);
  assert.equal(job.status, "running");
  // The lease ended now, so the sweeper can pass it on; nothing was refunded.
  assert.equal((job.leaseExpiresAt as Date).getTime(), new Date(T0.getTime() + MIN).getTime());
  assert.equal(refunds(db).length, 0);
  assert.deepEqual(events, []);
});

test("a job whose worker died is taken over once its lease lapses, and failed if it keeps dying", async () => {
  const { db, deps, jobId, calls, clock } = await setup();
  // A worker claimed it and died.
  const { startJob } = await import("../services/jobEscrow.js");
  await db.inTransaction((tx) => startJob(tx, { jobId, now: clock.now, leaseMs: 5 * MIN }));

  // Lease still held: not ours.
  assert.deepEqual(await runJob({ jobId }, deps), { status: "skipped", reason: "claimed_elsewhere" });
  assert.equal(calls.length, 0);

  clock.now = new Date(T0.getTime() + 10 * MIN);
  assert.deepEqual(await runJob({ jobId }, deps), { status: "submitted" });
  assert.equal(db.job(jobId).attempts, 2);

  // A job that has already been claimed as often as allowed is failed, not run again.
  const again = await setup();
  await again.db.inTransaction((tx) => startJob(tx, { jobId: again.jobId, now: again.clock.now, leaseMs: MIN }));
  again.db.job(again.jobId).attempts = MAX_JOB_CLAIMS;
  again.clock.now = new Date(T0.getTime() + 10 * MIN);
  assert.deepEqual(await runJob({ jobId: again.jobId }, again.deps), { status: "failed", reason: FAILURE.crashed });
  assert.equal(again.calls.length, 0);
  assert.equal(refunds(again.db).length, 1);
});

test("a publisher's test run grades one run the same way and touches no job", async () => {
  const { db, deps, jobId } = await setup();
  const job = (await deps.loadJob(jobId))!;
  const passed = await tryOffering(deps, { ...job, testRun: true }, new AbortController().signal);
  assert.equal(passed.passed, true);
  assert.deepEqual(passed.output, { format: "text", text: "Here is the competitor report." });
  assert.equal(db.job(jobId).status, "funded");

  const failing: JobRunnerDeps = { ...deps, runAgent: async () => answer("off topic") };
  const failed = await tryOffering(failing, job, new AbortController().signal);
  assert.equal(failed.passed, false);
  assert.equal(failed.checkResults[0]!.passed, false);
});
