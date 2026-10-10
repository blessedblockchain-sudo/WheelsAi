/**
 * Runs one paid job (Offerings and Jobs). One call = one delivery from the
 * job-runner queue.
 *
 *   1. Load the job with its offering. Anything but `funded`, or `running`
 *      with a lapsed lease, is somebody else's or already over: return
 *      without running anything.
 *   2. Past its deadline: expire it (refund) without running the product.
 *   3. Claim it by compare-and-set: funded -> running (startJob), or take
 *      over a running job whose worker died (reclaimJob). Losing the claim
 *      means another delivery has it. The claim carries a lease as long as
 *      this run may take, so nothing has to renew it.
 *   4. Run the publisher's product IN THE PUBLISHER'S organization, under a
 *      time budget: the time left before the promised delivery, capped by
 *      the platform's longest run. When the budget ends the run is aborted,
 *      not left to finish and bill after the refund.
 *        agent     the shared chat core, tool mode `hired`
 *        workflow  the workflow run entry point, every step `hired`
 *        model     the publisher's deployment
 *   5. Turn the answer into a deliverable and grade it: the offering's
 *      checks as the buyer agreed to them at hire (the job's terms), plus
 *      the confidentiality check. A deliverable that fails is retried up to
 *      the offering's maxAttempts while time remains.
 *   6. Submit it (running -> submitted, before the deadline only), or end
 *      the job with a refund: `failed`, or `expired` when the deadline
 *      passed. Each is one transaction and one compare-and-set; losing it
 *      (the sweeper expired the job first) discards this run's result and
 *      moves no money.
 *
 * Tokens used on the platform's own model keys are counted and priced here
 * and written with the transition that ends the run (jobEscrow.ts takes the
 * cost out of the publisher's share at settlement).
 *
 * What the buyer is told about a failure is one of the fixed sentences
 * below. The product's own error text can quote the publisher's setup, so
 * it goes into the check results, which only the publisher reads.
 *
 * Pure: every IO surface is injected. Notification never throws.
 */

import { evaluateChecks, validateChecks, type Check, type CheckResult } from "./assertions.js";
import {
  endJobWithRefund,
  JobTransitionError,
  reclaimJob,
  releaseJobLease,
  startJob,
  submitJob,
  type EscrowTx,
  type JobModelUsage,
  type JobTerms,
} from "./jobEscrow.js";
import {
  composeSystemAddendum,
  extractDeliverable,
  renderJobBrief,
  workflowJobInput,
  type OutputFormat,
} from "./jobPrompt.js";

export type ProductKind = "agent" | "workflow" | "model";

export interface JobForRun {
  id: string;
  buyerId: string;
  publisherId: string;
  status: string;
  input: unknown;
  deadlineAt: Date | null;
  leaseExpiresAt: Date | null;
  /** Claims so far (a start and every takeover). */
  attempts: number;
  /** The publisher trying their own offering: no job row, no escrow. */
  testRun?: boolean;
  /** What the buyer agreed to at hire; the offering may have changed since. */
  terms: Partial<JobTerms>;
  offering: {
    id: string;
    title: string;
    productKind: string;
    agentId: string | null;
    orchestrationId: string | null;
    deploymentId: string | null;
    inputSchema: unknown;
    instructions: string | null;
    allowedTools: string[];
    maxAttempts: number;
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What one run of the product returned. */
export interface ProductRun {
  content: string;
  /**
   * Tokens that ran on the platform's own model keys in this run; null when
   * none did (the publisher's own keys or deployment).
   */
  platformUsage: TokenUsage | null;
  /** Text the deliverable must not repeat: the system prompts of the agents that ran. */
  confidential: Array<string | null | undefined>;
  orchestrationExecutionId?: string;
}

export interface ProductRunArgs {
  job: JobForRun;
  /** The buyer's input, framed as data. Safe to store and show. */
  brief: string;
  /** The offering's private instructions and the job's rules. Never stored. */
  systemAddendum: string;
  toolAllowlist: string[];
  signal: AbortSignal;
}

/** Cents per million tokens on the platform's own model keys. */
export interface PlatformModelRates {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
}

export type JobRunEvent = "job.submitted" | "job.failed" | "job.expired";

export interface JobRunnerDeps {
  loadJob(jobId: string): Promise<JobForRun | null>;
  inTransaction<T>(fn: (tx: EscrowTx) => Promise<T>): Promise<T>;
  runAgent(args: ProductRunArgs & { agentId: string }): Promise<ProductRun>;
  runWorkflow(
    args: ProductRunArgs & { orchestrationId: string; input: Record<string, unknown>; prompt?: string },
  ): Promise<ProductRun>;
  runModel(args: ProductRunArgs & { deploymentId: string }): Promise<ProductRun>;
  /** Must not throw. */
  notify(event: JobRunEvent, jobId: string): Promise<void>;
  /** The longest one job may run, whatever its delivery time (JOB_MAX_RUN_MS). */
  maxRunMs: number;
  platformModelRates: PlatformModelRates;
  now?: () => Date;
}

export type JobRunResult =
  | { status: "skipped"; reason: "not_found" | "not_runnable" | "claimed_elsewhere" }
  | { status: "submitted" }
  | { status: "failed"; reason: string }
  | { status: "expired" }
  /** The run finished but the job had already ended; its result was discarded. */
  | { status: "superseded" }
  /** The worker is shutting down; the job was handed back for another worker. */
  | { status: "released" };

/** A job that keeps killing its worker is failed instead of taken over forever. */
export const MAX_JOB_CLAIMS = 3;
/** The lease outlives the run's budget by this much, for the final transaction. */
const LEASE_MARGIN_MS = 60_000;

export const FAILURE = {
  checks: "The deliverable did not pass the offering's checks, so it was not delivered. You have been refunded.",
  noDeliverable: "The product did not produce a deliverable. You have been refunded.",
  run: "The product could not complete this job. You have been refunded.",
  tooLong: "The job ran longer than the platform allows and was stopped. You have been refunded.",
  crashed: "The job was interrupted more than once and was stopped. You have been refunded.",
  misconfigured: "This offering can no longer be run. You have been refunded.",
  expired: "The job was not delivered within the promised time. You have been refunded.",
} as const;

/**
 * What tokens on the platform's keys cost, in millionths of a cent: tokens
 * times cents per million tokens. Nothing is rounded up to a cent here; a
 * fraction of a millionth counts as one.
 */
export function platformModelCostMicros(usage: TokenUsage, rates: PlatformModelRates): bigint {
  const micro =
    Math.max(0, usage.inputTokens) * Math.max(0, rates.inputCentsPerMTok) +
    Math.max(0, usage.outputTokens) * Math.max(0, rates.outputCentsPerMTok);
  if (!Number.isFinite(micro) || micro <= 0) return 0n;
  return BigInt(Math.ceil(micro));
}

/**
 * What tokens on the platform's keys cost, in whole cents, rounded up: a
 * run that used any is never free.
 */
export function platformModelCostCents(usage: TokenUsage, rates: PlatformModelRates): bigint {
  return (platformModelCostMicros(usage, rates) + 999_999n) / 1_000_000n;
}

/** A result row for something that is not one of the offering's checks. */
function runResult(label: string, details: string): CheckResult {
  return { type: "run", label, passed: false, details: details.slice(0, 2000) };
}

function isKind(kind: string): kind is ProductKind {
  return kind === "agent" || kind === "workflow" || kind === "model";
}

type ProductRunners = Pick<JobRunnerDeps, "runAgent" | "runWorkflow" | "runModel">;

interface RunPlan {
  checks: Check[];
  outputFormat: OutputFormat;
  args: Omit<ProductRunArgs, "signal">;
}

/** What a run of this job is given and graded by. */
function planRun(job: JobForRun): { ok: true; plan: RunPlan } | { ok: false; results: CheckResult[] } {
  const { offering } = job;
  if (!isKind(offering.productKind)) {
    return { ok: false, results: [runResult("The offering's product", "unknown product kind")] };
  }
  const checks = validateChecks(job.terms.deliverableChecks ?? []);
  if (!checks.ok) {
    return {
      ok: false,
      results: [runResult("The offering's checks", checks.issues.map((i) => i.message).join("; "))],
    };
  }
  const outputFormat: OutputFormat = job.terms.outputFormat === "json" ? "json" : "text";
  const schemaCheck = checks.checks.find(
    (c): c is Extract<Check, { type: "json_schema" }> => c.type === "json_schema",
  );
  return {
    ok: true,
    plan: {
      checks: checks.checks,
      outputFormat,
      args: {
        job,
        brief: renderJobBrief(
          { title: job.terms.title ?? offering.title, inputSchema: offering.inputSchema },
          job.input,
        ),
        systemAddendum: composeSystemAddendum(offering.instructions, outputFormat, schemaCheck?.schema),
        toolAllowlist: offering.allowedTools,
      },
    },
  };
}

function dispatchProduct(
  deps: ProductRunners,
  job: JobForRun,
  plan: RunPlan,
  signal: AbortSignal,
): Promise<ProductRun> {
  const { offering } = job;
  const runArgs = { ...plan.args, signal };
  if (offering.productKind === "agent") {
    if (!offering.agentId) throw new Error("the offering's agent no longer exists");
    return deps.runAgent({ ...runArgs, agentId: offering.agentId });
  }
  if (offering.productKind === "workflow") {
    if (!offering.orchestrationId) throw new Error("the offering's workflow no longer exists");
    return deps.runWorkflow({
      ...runArgs,
      orchestrationId: offering.orchestrationId,
      ...workflowJobInput(
        { title: job.terms.title ?? offering.title, inputSchema: offering.inputSchema },
        job.input,
      ),
    });
  }
  if (!offering.deploymentId) throw new Error("the offering's model deployment no longer exists");
  return deps.runModel({ ...runArgs, deploymentId: offering.deploymentId });
}

type Graded =
  | { passed: true; output: Record<string, unknown>; results: CheckResult[] }
  | { passed: false; reason: string; results: CheckResult[]; output?: Record<string, unknown> };

/** The run's answer as a deliverable, graded by the checks and the confidentiality rule. */
function gradeRun(job: JobForRun, plan: RunPlan, run: ProductRun): Graded {
  const deliverable = extractDeliverable(run.content, plan.outputFormat);
  if (!deliverable.ok) {
    return {
      passed: false,
      reason: FAILURE.noDeliverable,
      results: [runResult("The product produced a deliverable", deliverable.reason)],
    };
  }
  const output =
    deliverable.format === "json"
      ? { format: "json", text: deliverable.text, value: deliverable.value }
      : { format: "text", text: deliverable.text };
  const graded = evaluateChecks(plan.checks, deliverable.text, {
    confidential: [job.offering.instructions, ...run.confidential],
  });
  return graded.passed
    ? { passed: true, output, results: graded.results }
    : { passed: false, reason: FAILURE.checks, results: graded.results, output };
}

/**
 * One run of an offering's product, graded, with no job behind it: the
 * publisher's test run. The same plan, dispatch and grading a paid job
 * gets; no claim, no escrow, no retry. Throws what the product threw.
 */
export async function tryOffering(
  deps: ProductRunners,
  job: JobForRun,
  signal: AbortSignal,
): Promise<{ passed: boolean; output: Record<string, unknown> | null; checkResults: CheckResult[] }> {
  const planned = planRun(job);
  if (!planned.ok) return { passed: false, output: null, checkResults: planned.results };
  const graded = gradeRun(job, planned.plan, await dispatchProduct(deps, job, planned.plan, signal));
  return { passed: graded.passed, output: graded.output ?? null, checkResults: graded.results };
}

export async function runJob(
  input: {
    jobId: string;
    /** Aborts the run when the worker process is shutting down. */
    shutdownSignal?: AbortSignal;
  },
  deps: JobRunnerDeps,
): Promise<JobRunResult> {
  const now = deps.now ?? (() => new Date());
  const job = await deps.loadJob(input.jobId);
  if (!job) return { status: "skipped", reason: "not_found" };
  if (!job.deadlineAt || (job.status !== "funded" && job.status !== "running")) {
    return { status: "skipped", reason: "not_runnable" };
  }
  const { id: jobId, offering } = job;
  const deadlineAt = job.deadlineAt;

  /** Ends the job with a refund. Null = it had already ended some other way. */
  const end = async (
    to: "failed" | "expired",
    reason: string,
    extra: { checkResults?: CheckResult[]; output?: unknown; modelUsage?: JobModelUsage } = {},
  ): Promise<JobRunResult> => {
    // A timer can fire a moment early; an expiry is never dated before the
    // deadline it is for.
    const at = now();
    const when = to === "expired" && at.getTime() < deadlineAt.getTime() ? deadlineAt : at;
    try {
      await deps.inTransaction((tx) => endJobWithRefund(tx, { jobId, to, reason, now: when, ...extra }));
    } catch (err) {
      if (err instanceof JobTransitionError) return { status: "superseded" };
      throw err;
    }
    await deps.notify(to === "failed" ? "job.failed" : "job.expired", jobId);
    return to === "failed" ? { status: "failed", reason } : { status: "expired" };
  };

  const claimedAt = now();
  if (deadlineAt.getTime() <= claimedAt.getTime()) return end("expired", FAILURE.expired);

  const untilDeadlineMs = deadlineAt.getTime() - claimedAt.getTime();
  const budgetMs = Math.min(untilDeadlineMs, deps.maxRunMs);
  const leaseMs = budgetMs + LEASE_MARGIN_MS;
  const takeover = job.status === "running";
  const claimed = await deps.inTransaction((tx) =>
    takeover
      ? reclaimJob(tx, { jobId, now: claimedAt, leaseMs })
      : startJob(tx, { jobId, now: claimedAt, leaseMs }),
  );
  if (!claimed) return { status: "skipped", reason: "claimed_elsewhere" };
  // Counted before this claim, so the third takeover is the one refused.
  if (takeover && job.attempts >= MAX_JOB_CLAIMS) return end("failed", FAILURE.crashed);

  const planned = planRun(job);
  if (!planned.ok) return end("failed", FAILURE.misconfigured, { checkResults: planned.results });
  const { plan } = planned;

  const controller = new AbortController();
  const budgetTimer = setTimeout(() => controller.abort("budget"), budgetMs);
  const onShutdown = () => controller.abort("shutdown");
  if (input.shutdownSignal?.aborted) onShutdown();
  input.shutdownSignal?.addEventListener("abort", onShutdown, { once: true });

  const used: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  const modelUsage = (): JobModelUsage => ({
    ...used,
    costCents: platformModelCostCents(used, deps.platformModelRates),
  });
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("the run was stopped")), { once: true });
  });
  stopped.catch(() => {});
  let failure: { reason: string; checkResults: CheckResult[]; output?: unknown } = {
    reason: FAILURE.run,
    checkResults: [],
  };
  try {
    const maxAttempts = Math.max(1, Math.min(3, offering.maxAttempts));
    for (let attempt = 1; attempt <= maxAttempts && !controller.signal.aborted; attempt++) {
      let run: ProductRun;
      try {
        // Raced against the abort: a product that ignores its signal must
        // not hold the job (and the buyer's refund) past the budget.
        const pending = dispatchProduct(deps, job, plan, controller.signal);
        pending.catch(() => {});
        run = await Promise.race([pending, stopped]);
      } catch (err) {
        if (controller.signal.aborted) break;
        // Not retried: an agent that is gone or a key that is refused fails
        // the same way again, and the buyer is waiting on the refund.
        const message = err instanceof Error ? err.message : String(err);
        failure = { reason: FAILURE.run, checkResults: [runResult("The product ran", message)] };
        break;
      }
      if (run.platformUsage) {
        used.inputTokens += run.platformUsage.inputTokens;
        used.outputTokens += run.platformUsage.outputTokens;
      }

      const graded = gradeRun(job, plan, run);
      if (!graded.passed) {
        failure = { reason: graded.reason, checkResults: graded.results, output: graded.output };
        continue;
      }
      const { output } = graded;

      const submitted = await deps.inTransaction((tx) =>
        submitJob(tx, {
          jobId,
          output,
          checkResults: graded.results,
          now: now(),
          modelUsage: modelUsage(),
          ...(typeof job.terms.reviewWindowMs === "number" && { reviewWindowMs: job.terms.reviewWindowMs }),
        }),
      );
      // Late, or ended by someone else while this ran: the result is dropped.
      if (!submitted) return { status: "superseded" };
      await deps.notify("job.submitted", jobId);
      return { status: "submitted" };
    }
  } finally {
    clearTimeout(budgetTimer);
    input.shutdownSignal?.removeEventListener("abort", onShutdown);
  }

  if (controller.signal.aborted && controller.signal.reason === "shutdown") {
    // Not this job's failure. The lease ends now so the sweeper passes the
    // job to another worker while there is still time.
    await deps
      .inTransaction((tx) => releaseJobLease(tx, { jobId, now: now(), modelUsage: modelUsage() }))
      .catch(() => false);
    return { status: "released" };
  }
  if (controller.signal.aborted) {
    // Which limit ended it: the promised delivery time, or the platform's cap.
    return budgetMs === untilDeadlineMs
      ? end("expired", FAILURE.expired, { modelUsage: modelUsage() })
      : end("failed", FAILURE.tooLong, { modelUsage: modelUsage() });
  }
  return end("failed", failure.reason, {
    checkResults: failure.checkResults,
    ...(failure.output !== undefined && { output: failure.output }),
    modelUsage: modelUsage(),
  });
}
