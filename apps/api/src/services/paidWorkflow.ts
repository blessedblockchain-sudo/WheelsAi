/**
 * A paid run of a workflow on sale: a buyer runs a creator's own workflow,
 * per run or from a plan, and never sees inside it.
 *
 *   POST /api/w/:slug/run          runPaidWorkflow, with a body
 *   model "w/<slug>" on /v1        runPaidWorkflow, with messages
 *   GET  /api/w/:slug/access       getWorkflowAccess
 *
 * The buyer's name for the workflow is the LISTING's slug. The workflow's
 * own slug and name are its creator's and are never read from a buyer's
 * address or told to a buyer.
 *
 * It is the order of one paid use (services/paidUse.ts) with a workflow in
 * place of the agent, and it shares that file's refusals, sentences and
 * billing object. Nothing is taken until step 8:
 *
 *    1. who      a session's membership is read again, failing closed.
 *    2. limits   a slug that cannot exist is 404 with nothing counted. Then
 *                the buyer's undelivered answers of the day and the buyer's
 *                minute, under keys of their own (`pw:`): a handle and a
 *                listing slug can hold the same text.
 *    3. body     `{ input: { ... } }` and nothing else, or messages.
 *    4. listing  by slug, which must sell a workflow; then the workflow by
 *                the listing's workflow AND its publisher as the
 *                organization. The caller's own is 409 own_workflow before
 *                the licence is read. Not sellable, or not able to run
 *                now (a step's deployment stopped), is 503.
 *    5. licence  resolveUseBilling with unit "run". A month with no count
 *                and a free use cannot exist for a workflow: either is 503.
 *    6. input    against the workflow's input form and the two sizes. Then
 *                the day limit, only off a plan.
 *    7. room     the early refusal when every paid run it can hold is
 *                going. A caller who already left is charged nothing. The
 *                run is registered so a restart waits for it.
 *    8. charge   the price, or one use of the plan, taken ONCE and wrapped
 *                in settleOnce. The moment is kept.
 *    9. run      started in the creator's organization and run to its end.
 *                A start that finds no room refunds: the bound itself is
 *                held there, under the lock, not by the read of step 7. A
 *                buyer who leaves cancels the run.
 *   10. settle   the run completed, it has a text, the text repeats no step
 *                agent's instructions, the caller is still there, and the
 *                answer is not later than the longest run plus its grace.
 *   11. refund   in every other ending, in full.
 *
 * What a buyer is never told: a step's name, type, output or error, the
 * engine's error text, the run's id, the workflow's own name or slug, an
 * agent or a model inside it, tokens, durations, the creator's
 * organization. Every answer here is built field by field from the
 * listing's own public words and the buyer's own rows.
 *
 * Pure core: every effect is a dependency (services/buildPaidWorkflowDeps.ts
 * binds the real ones). Nothing here reads the environment or the database,
 * and no error text of the engine is read here: a run past its time arrives
 * as a typed `timedOut`.
 */

import { z } from "zod";

import { settleOnce } from "./agentChat.js";
import { TASK_MESSAGES, type TaskInputIssue } from "./agentTask.js";
import type { SpendPeek } from "./apiKeySpend.js";
import { detectInstructionLeak } from "./assertions.js";
import { CLIENT_GONE, type SettleableMeter } from "./chatStreamSettlement.js";
import type { LimitRule } from "./failClosedLimiter.js";
import type { TokenUsage } from "./jobRunner.js";
import { onTrialPlan } from "./listingPlans.js";
import type { NormalizedMessage } from "./openaiCompat.js";
import {
  accessPlanOf,
  canAccept,
  chargeRefusal,
  CLIENT_GONE_REFUSAL,
  failureRefusal,
  limitRefusal,
  PAID_USE_MESSAGES,
  planBillingOf,
  plansOnOffer,
  planUsedUpRefusal,
  planWillRenew,
  refused,
  type BuyerRule,
  type PaidCaller,
  type PaidUseBilling,
  type PaidUseDeps,
  type PaidUseErrorCode,
  type PaidUseLimits,
  type PaidUseRefusal,
  type PaidUseTerms,
  type Refused,
  type UseAccessView,
} from "./paidUse.js";
import { consumePublicLimit, secondsLeftInUtcDay, utcDay } from "./publicChat.js";
import { PAST_DUE_GRACE_DAYS } from "./subscriptionAccess.js";
import { onPlan, useAccess, type UseAccess } from "./useAccess.js";
import { resolveUseBilling, type UseBilling, type UsePlanCount } from "./useMetering.js";
import { MAX_WORKFLOW_INPUT_BYTES, MAX_WORKFLOW_PROMPT_CHARS, workflowRunInput } from "./workflowChat.js";
import {
  listingProductKind,
  PAID_WORKFLOW_DELIVER_GRACE_MS,
  PAID_WORKFLOW_MAX_ACTIVE_RUNS,
  PAID_WORKFLOW_MAX_RUN_MS,
  WORKFLOW_LISTING_SLUG,
  workflowCanRunNow,
  type WorkflowForListing,
  type WorkflowRunReadiness,
} from "./workflowListing.js";
import { checkAgainstSchema } from "./workflowSchemaCheck.js";

// ============================================
// Limits and keys
// ============================================

/** The numbers of a buyer's own limits: the ones a paid use of an agent has, and no second set. */
export type PaidWorkflowLimits = Pick<
  PaidUseLimits,
  "perBuyerPerMinute" | "perBuyerPerDay" | "undeliveredRefundsPerDay"
>;

/**
 * The limiter keys of a paid run, in one place. `slug` is the listing's
 * slug in lower case. Never the keys of a paid use of an agent: a handle
 * and a listing slug are different names that can hold the same text.
 */
export const paidWorkflowKeys = {
  buyerMinute: (orgId: string, slug: string) => `pw:b:m:${orgId}:${slug}`,
  buyerDay: (orgId: string, slug: string, day: string) => `pw:b:d:${day}:${orgId}:${slug}`,
  undeliveredDay: (orgId: string, slug: string, day: string) => `pw:r:d:${day}:${orgId}:${slug}`,
} as const;

const MINUTE = 60;
/** The refund counter only counts: its limit is never what refuses. */
const COUNT_ONLY = 1_000_000;
/** How long a caller of a busy workflow is asked to wait: the sentence says a minute. */
const BUSY_RETRY_SECONDS = 60;

// ============================================
// Input
// ============================================

export interface PaidWorkflowInput {
  caller: PaidCaller;
  /** The listing's slug in the address or the model name, as sent. */
  slug: string;
  /** POST /api/w/:slug/run: the parsed JSON body, not yet validated. Never with `messages`. */
  body?: unknown;
  /** Model "w/<slug>": the conversation, as the owner's own workflow call takes it. Never with `body`. */
  messages?: NormalizedMessage[];
  /** With `messages` only: the caller asked for a stream. A body is always answered whole. */
  stream?: boolean;
  /** Fires when the client goes away; the run is cancelled and refunded. */
  signal: AbortSignal;
}

export interface PaidWorkflowReadInput {
  caller: PaidCaller;
  slug: string;
}

/** A listing as a paid run reads it. One that sells an agent has no workflow. */
export interface PaidWorkflowListing {
  id: string;
  slug: string;
  title: string;
  /** The creator's organization. Never sent to a buyer. */
  publisherId: string;
  status: string;
  sells: string;
  pricingModel: string;
  pricePerRequestCents: bigint | null;
  monthlyPriceCents: bigint | null;
  agentId: string | null;
  orchestrationId: string | null;
}

/** A run that was started. Nothing of it is ever sent to a buyer. */
export interface PaidWorkflowRun {
  id: string;
  workflowId: string;
  /** The creator's organization, read from the workflow's own row. */
  orgId: string;
}

/**
 * How a run ended. A run past its time is said here and nowhere read from a
 * text. What a completed run's steps left rides on its ending, so nothing of
 * a run is kept anywhere once the run is over, whether or not it is read.
 */
export type PaidWorkflowEnding =
  | {
      status: "completed";
      /** The system prompts of the step agents that took part: the answer must not repeat them. */
      confidential: Array<string | null>;
      /** What the steps used on the platform's own model keys; null when none ran on them. */
      platformUsage: TokenUsage | null;
    }
  /** Failed, cancelled, skipped or taken over: nothing to deliver. */
  | { status: "failed"; timedOut: boolean };

/** What a completed run answered. */
export interface PaidWorkflowAnswer {
  /** The answer text; null when the run produced nothing to say. */
  text: string | null;
}

// ============================================
// Dependencies
// ============================================

export interface PaidWorkflowDeps {
  limiter: PaidUseDeps["limiter"];
  limits: PaidWorkflowLimits;
  /** The listing that holds this slug, in ANY state and whatever it sells. */
  loadListingBySlug(slug: string): Promise<PaidWorkflowListing | null>;
  /**
   * The workflow for sale, by its id AND the organization it must be in
   * (the listing's publisher), and whether what its steps run on is serving
   * now; `workflow` is null when it is not there. Throws when it cannot be
   * read, which counts as cannot run.
   */
  loadWorkflowReadiness(ref: { workflowId: string; orgId: string }): Promise<WorkflowRunReadiness>;
  loadLicence: PaidUseDeps["loadLicence"];
  loadPlans?: PaidUseDeps["loadPlans"];
  readBalance: PaidUseDeps["readBalance"];
  peekKeySpend: PaidUseDeps["peekKeySpend"];
  /** How many paid runs of this workflow are queued or running. A read: the bound is held by `startRun`. */
  activePaidRuns(workflowId: string): Promise<number>;
  /** The metering of one run: beginUseMetering, with the workflow's id where an agent's is. */
  beginUse: PaidUseDeps["beginUse"];
  /**
   * Registers the run so a shutdown of this process waits for it. null =
   * the process is shutting down and takes no new run. When omitted nothing
   * is registered.
   */
  beginRun?(): { signal: AbortSignal; done(): void } | null;
  /**
   * Starts the run in the workflow's own organization. `no_room` = every
   * paid run the workflow can hold is going: no row was created.
   */
  startRun(args: {
    workflowId: string;
    orgId: string;
    input: Record<string, unknown>;
    prompt?: string;
  }): Promise<{ ok: true; run: PaidWorkflowRun } | { ok: false; reason: "no_room" }>;
  /** Runs it to its end, in this process. `shutdown` fires when the process is stopping. */
  runToEnd(run: PaidWorkflowRun, options: { shutdown?: AbortSignal }): Promise<PaidWorkflowEnding>;
  /** Cancels the run. A run that already ended is not an error. */
  cancelRun(run: PaidWorkflowRun): Promise<void>;
  readAnswer(run: PaidWorkflowRun): Promise<PaidWorkflowAnswer>;
  memberRole: PaidUseDeps["memberRole"];
  warnPlan?: PaidUseDeps["warnPlan"];
  now?: () => Date;
  logger?: PaidUseDeps["logger"];
}

// ============================================
// Results
// ============================================

/**
 * A checked answer for a caller who asked for a stream. Nothing is settled:
 * only the code that writes the bytes knows whether they arrived.
 */
export interface PaidWorkflowStream {
  kind: "stream";
  /** The whole answer, checked. */
  text: string;
  /** The charge. The caller MUST forward the answer with streamToReply and this meter. */
  meter: SettleableMeter;
  billing: PaidUseBilling;
  /** Call once the bytes were sent or were not. Never throws. */
  finished(outcome: { ok: boolean }): Promise<void>;
}

export type PaidWorkflowResult =
  | Refused
  | { kind: "result"; output: { format: "text"; text: string }; billing: PaidUseBilling }
  | PaidWorkflowStream;

/** The access view of an agent's paid use, with the workflow's word for its owner. */
export type WorkflowAccessView = Omit<UseAccessView, "access"> & { access: UseAccess | "own_workflow" };

export type WorkflowAccessResult = Refused | { kind: "access"; view: WorkflowAccessView };

// ============================================
// Refusals
// ============================================

const WORDS = PAID_USE_MESSAGES.workflow;

const NOT_FOUND: PaidUseRefusal = { status: 404, code: "workflow_not_found", message: WORDS.notFound };
const NOT_A_MEMBER: PaidUseRefusal = { status: 403, code: "not_a_member", message: WORDS.notAMember };
const OWN_WORKFLOW: PaidUseRefusal = { status: 409, code: "own_workflow", message: WORDS.ownWorkflow };
const UNAVAILABLE: PaidUseRefusal = { status: 503, code: "workflow_unavailable", message: WORDS.unavailable };
const BUSY: PaidUseRefusal = {
  status: 429,
  code: "workflow_busy",
  message: WORDS.busy,
  retryAfterSeconds: BUSY_RETRY_SECONDS,
};

/** What a key that cannot be named is told: it has no caps to pay within. */
const KEY_WITHOUT_CAPS =
  "This API key has no spend caps, so it cannot pay for a run of a workflow. Create a key with agents:use and both caps.";

const back = (refunded: bigint | null) => (refunded === null ? {} : { refundedCents: Number(refunded) });

/** The start found no room, after the charge: it was refunded, and a client must not send it again by itself. */
function busyAfterCharge(refunded: bigint | null): PaidUseRefusal {
  return {
    status: 429,
    code: "workflow_busy",
    message: WORDS.busyAfterCharge(refunded),
    retryAfterSeconds: BUSY_RETRY_SECONDS,
    noAutomaticRetry: true,
    ...back(refunded),
  };
}

function timedOut(refunded: bigint | null): PaidUseRefusal {
  return { status: 504, code: "run_timed_out", message: WORDS.runTimedOut(refunded), ...back(refunded) };
}

const runFailed = (refunded: bigint | null): PaidUseRefusal =>
  failureRefusal({ code: "upstream_error", message: "", retryAfterSeconds: null }, refunded, "workflow");

/** The listing's slug as a buyer may send it, in lower case, or null when no listing can have it. */
function slugOf(raw: string): string | null {
  const slug = typeof raw === "string" ? raw.toLowerCase() : "";
  return WORKFLOW_LISTING_SLUG.test(slug) ? slug : null;
}

/** What the listing asks now. A workflow is sold by the run, and its owner always keeps a copy. */
function workflowTermsOf(listing: PaidWorkflowListing): PaidUseTerms {
  return {
    pricingModel: listing.pricingModel,
    pricePerRequestCents: listing.pricePerRequestCents == null ? null : Number(listing.pricePerRequestCents),
    monthlyPriceCents: listing.monthlyPriceCents == null ? null : Number(listing.monthlyPriceCents),
    unit: "run",
    keepsCopy: true,
  };
}

/** The listing by slug when it sells a workflow, with that workflow's id; null for anything else. */
async function loadWorkflowListing(
  deps: Pick<PaidWorkflowDeps, "loadListingBySlug">,
  slug: string,
): Promise<(PaidWorkflowListing & { orchestrationId: string }) | null> {
  const listing = await deps.loadListingBySlug(slug);
  // An agent's listing has a slug too: it is not a workflow, and is not found here.
  if (!listing || listing.orchestrationId === null || listingProductKind(listing) !== "workflow") return null;
  return { ...listing, orchestrationId: listing.orchestrationId };
}

// ============================================
// The input
// ============================================

/** POST /api/w/:slug/run: the answers, and nothing else. */
const runBodySchema = z.object({ input: z.record(z.unknown()) }).strict();

type RunInput =
  | { ok: true; input: Record<string, unknown>; prompt: string | undefined }
  | { ok: false; refusal: PaidUseRefusal };

const TOO_LARGE = (message: string): RunInput => ({
  ok: false,
  refusal: { status: 413, code: "input_too_large", message },
});

/** Step 6: what the run is given, checked against the workflow's own input form. */
function runInputOf(
  sent: { input: Record<string, unknown> } | { messages: NormalizedMessage[] },
  inputSchema: unknown,
): RunInput {
  let input: Record<string, unknown>;
  let prompt: string | undefined;
  if ("messages" in sent) {
    const run = workflowRunInput(sent.messages, inputSchema);
    if (!run.ok) {
      // Its two refusals name only the caller's own messages and the sizes.
      return run.code === "messages_too_large"
        ? TOO_LARGE(run.detail.message ?? TASK_MESSAGES.inputTooLarge)
        : {
            ok: false,
            refusal: {
              status: 400,
              code: "invalid_request",
              message: run.detail.message ?? PAID_USE_MESSAGES.invalidChatBody,
            },
          };
    }
    ({ input, prompt } = run);
  } else {
    input = sent.input;
    prompt = undefined;
    if (typeof input.prompt === "string" && input.prompt.length > MAX_WORKFLOW_PROMPT_CHARS) {
      return TOO_LARGE(TASK_MESSAGES.inputTooLarge);
    }
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_WORKFLOW_INPUT_BYTES) {
      return TOO_LARGE(TASK_MESSAGES.inputTooLarge);
    }
  }
  // As the start itself reads it: the prompt is the key `prompt` of the input.
  const problems = checkAgainstSchema(inputSchema, {
    ...input,
    ...(prompt !== undefined && prompt !== "" ? { prompt } : {}),
  });
  if (problems.length > 0) {
    return {
      ok: false,
      refusal: {
        status: 400,
        code: "input_invalid",
        message: TASK_MESSAGES.inputInvalid,
        // The form's own list. The form is public: it is what the page draws.
        details: problems.map((message): TaskInputIssue => ({ path: "", field: null, label: null, message })),
      },
    };
  }
  return { ok: true, input, prompt };
}

// ============================================
// One paid run
// ============================================

/** One paid run of a creator's workflow. Never throws for a refusal. */
export async function runPaidWorkflow(input: PaidWorkflowInput, deps: PaidWorkflowDeps): Promise<PaidWorkflowResult> {
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const day = utcDay(now);
  const dayLeft = secondsLeftInUtcDay(now);
  const { caller } = input;
  const { limits } = deps;

  const consume = async (rules: LimitRule[], rule: BuyerRule = "minute"): Promise<PaidUseRefusal | null> => {
    const told = await consumePublicLimit(deps.limiter, rules, "paid", deps.logger);
    return told ? limitRefusal(told, limits, rule, "workflow") : null;
  };

  // 1. Still a member, read as it is now. A read that fails refuses.
  if (caller.type === "jwt") {
    if (!caller.userId) return refused(NOT_A_MEMBER);
    let role: string | null;
    try {
      role = await deps.memberRole(caller.orgId, caller.userId);
    } catch (err) {
      deps.logger?.error({ err }, "paid run refused: the caller's membership could not be read");
      return refused(UNAVAILABLE);
    }
    if (role === null) return refused(NOT_A_MEMBER);
  }

  // 2. A slug that cannot exist is not counted and not looked up.
  const slug = slugOf(input.slug);
  if (!slug) return refused(NOT_FOUND);

  const undeliveredKey = paidWorkflowKeys.undeliveredDay(caller.orgId, slug, day);
  const undelivered = await deps.limiter.peek(undeliveredKey);
  if (undelivered === null) {
    deps.logger?.error({ surface: "paid" }, "paid run refused: the rate limiter is unavailable");
    return refused(limitRefusal({ status: 503, code: "rate_limiter_unavailable" }, limits, "minute", "workflow"));
  }
  if (undelivered >= limits.undeliveredRefundsPerDay) {
    return refused({
      status: 429,
      code: "too_many_refunds",
      message: PAID_USE_MESSAGES.tooManyRefunds,
      retryAfterSeconds: dayLeft,
    });
  }
  const buyerLimit = await consume([
    {
      scope: "org",
      key: paidWorkflowKeys.buyerMinute(caller.orgId, slug),
      limit: limits.perBuyerPerMinute,
      windowSeconds: MINUTE,
    },
  ]);
  if (buyerLimit) return refused(buyerLimit);

  // 3. The body is read here, not trusted: no lookup depends on it yet.
  let sent: { input: Record<string, unknown> } | { messages: NormalizedMessage[] };
  if (input.messages !== undefined && input.body === undefined) {
    sent = { messages: input.messages };
  } else {
    const parsed = input.messages === undefined ? runBodySchema.safeParse(input.body) : null;
    if (!parsed?.success) {
      return refused({ status: 400, code: "invalid_request", message: PAID_USE_MESSAGES.invalidTaskBody });
    }
    sent = { input: parsed.data.input };
  }
  const wantsStream = "messages" in sent && input.stream === true;

  // 4. The listing, which must sell a workflow, and the workflow in the
  // publisher's organization: never by its id alone.
  const listing = await loadWorkflowListing(deps, slug);
  if (!listing) return refused(NOT_FOUND);
  let readiness: WorkflowRunReadiness;
  try {
    readiness = await deps.loadWorkflowReadiness({ workflowId: listing.orchestrationId, orgId: listing.publisherId });
  } catch (err) {
    deps.logger?.error({ err, listingId: listing.id }, "paid run refused: the workflow on sale could not be read");
    readiness = { workflow: null, modelStepsServe: false, agentModelsServe: false };
  }
  const workflow: WorkflowForListing | null = readiness.workflow;
  // The creator never pays to run their own workflow, whatever rows exist.
  if (listing.publisherId === caller.orgId || workflow?.orgId === caller.orgId) return refused(OWN_WORKFLOW);
  // Asked at every run, never remembered from the listing's status: it is
  // sellable, AND every step can be served now. A model step whose
  // deployment was stopped would fail the run after the charge; it is
  // refused here, before anything is taken.
  if (!workflow || !workflowCanRunNow(readiness, listing.publisherId)) return refused(UNAVAILABLE);
  const onSaleForUse = listing.status === "published" && listing.sells === "use";

  // 5. The licence and its access.
  const { licence, sub } = await deps.loadLicence({ listingId: listing.id, buyerId: caller.orgId });
  const billing: UseBilling = resolveUseBilling(
    { callerOrgId: caller.orgId, listing, licence, sub, unit: "run", thing: "workflow" },
    now,
  );
  if (billing.kind === "refused") {
    // Decided above already; this is the backstop.
    if (billing.code === "own_agent") return refused(OWN_WORKFLOW);
    const plans = billing.code === "plan_ended" ? await plansOnOffer(deps, listing) : undefined;
    return refused({
      status: billing.status,
      code: billing.code,
      message: billing.message,
      ...(billing.access !== undefined && { access: billing.access }),
      ...((billing.code === "use_not_started" || billing.code === "pricing_changed" || billing.code === "plan_ended") &&
        onSaleForUse && { terms: workflowTermsOf(listing) }),
      ...(plans !== undefined && { plans }),
    });
  }
  // A workflow is sold per run, with plans on top. A free use, a month with
  // no count and a free trial cannot exist for one: a row that says so is
  // not run, so nothing runs free and uncounted.
  if (billing.kind === "free" || billing.kind === "subscribed" || onTrialPlan(sub)) {
    deps.logger?.error({ listingId: listing.id, kind: billing.kind }, "paid run refused: a workflow listing met as free, as a month or as a trial");
    return refused(UNAVAILABLE);
  }

  const apiKeyId = caller.type === "api_key" ? (caller.apiKeyId ?? null) : null;
  const planRenews = planWillRenew(listing, sub);
  const extraInstall = billing.kind === "plan" ? billing.extraInstall : null;
  /** A plan that is used up and stops: told with the plans on offer, a bigger one among them. */
  const usedUp = async (refusal: PaidUseRefusal): Promise<PaidUseRefusal> => {
    if (refusal.code !== "plan_used_up") return refusal;
    const plans = await plansOnOffer(deps, listing);
    return plans === undefined ? refusal : { ...refusal, plans };
  };
  let payable: bigint | null = billing.kind === "billable" ? billing.priceCents : null;
  if (billing.kind === "plan") {
    const { plan } = billing;
    if (plan.usedInPeriod >= plan.includedUses + plan.carriedUses) {
      if (!extraInstall) return refused(await usedUp(planUsedUpRefusal(plan, now, planRenews, false)));
      payable = extraInstall.pricePerRequestCents;
    }
  }
  if (payable !== null) {
    // Read, not taken: the charge itself is step 8 and still decides.
    let balance: bigint;
    try {
      balance = await deps.readBalance(caller.orgId);
    } catch (err) {
      deps.logger?.error({ err }, "paid run refused: the buyer's balance could not be read");
      return refused(UNAVAILABLE);
    }
    if (balance < payable) {
      return refused({
        status: 402,
        code: "insufficient_credits",
        message: PAID_USE_MESSAGES.notEnoughCredits("run", payable),
        priceCents: Number(payable),
        balanceCents: Number(balance),
      });
    }
    if (caller.type === "api_key") {
      const peek: SpendPeek = apiKeyId
        ? await deps.peekKeySpend({ apiKeyId, orgId: caller.orgId, priceCents: payable })
        : { ok: false, code: "api_key_spend_caps_missing", message: KEY_WITHOUT_CAPS, extra: {} };
      if (!peek.ok) {
        return refused({ status: 403, code: peek.code as PaidUseErrorCode, message: peek.message, caps: peek.extra });
      }
    }
  }

  // 6. The input against the workflow's own form. Nothing has been spent.
  let run: Extract<RunInput, { ok: true }>;
  try {
    const checked = runInputOf(sent, workflow.inputSchema);
    if (!checked.ok) return refused(checked.refusal);
    run = checked;
  } catch (err) {
    // The workflow's own form cannot be read: its owner's to fix.
    deps.logger?.error({ err, listingId: listing.id }, "paid run refused: the workflow's input form cannot be read");
    return refused(UNAVAILABLE);
  }

  // The buyer's limit for the day, for a buyer who pays per run. A buyer on
  // a plan is held by the plan's count. Taken after every refusal that only
  // reads, so none of them spent one of the day's runs.
  if (billing.kind !== "plan") {
    const dayLimit = await consume(
      [
        {
          scope: "org",
          key: paidWorkflowKeys.buyerDay(caller.orgId, slug, day),
          limit: limits.perBuyerPerDay,
          windowSeconds: dayLeft,
        },
      ],
      "day",
    );
    if (dayLimit) return refused(dayLimit);
  }

  // 7. Room. The early refusal only: two buyers can read the same count, so
  // the bound itself is held where the run's row is created (step 9).
  let active: number;
  try {
    active = await deps.activePaidRuns(workflow.id);
  } catch (err) {
    deps.logger?.error({ err, listingId: listing.id }, "paid run refused: the workflow's runs could not be counted");
    return refused(UNAVAILABLE);
  }
  if (active >= PAID_WORKFLOW_MAX_ACTIVE_RUNS) return refused(BUSY);

  // Nobody is waiting for this answer any more: stop before charging.
  if (input.signal.aborted) return refused(CLIENT_GONE_REFUSAL);

  // Registered BEFORE the charge: from here until the charge is settled or
  // refunded, a shutdown waits for this run instead of stranding its money.
  const slot = deps.beginRun ? deps.beginRun() : undefined;
  if (slot === null) {
    return refused(failureRefusal({ code: "service_unavailable", message: "", retryAfterSeconds: null }, null, "workflow"));
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    slot?.done();
  };

  // 8. The charge, or one use of the plan. Once.
  const metering = deps.beginUse({
    agentId: workflow.id,
    install: billing.kind === "billable" ? billing.install : null,
    ...(billing.kind === "plan" && {
      plan: {
        read: billing.plan,
        // A key that cannot be named cannot reserve against its caps, so it
        // pays for no extra use: past the count its plan stops.
        extraInstall: caller.type === "api_key" && !apiKeyId ? null : extraInstall,
      },
    }),
    apiKeyId,
    unit: "run",
  });
  let meter: SettleableMeter;
  try {
    const taken = await metering.beginMetering({ agentId: workflow.id, orgId: workflow.orgId });
    if (!taken || !taken.ok) {
      release();
      const why = taken ? metering.refusal() : null;
      if (!why) return refused(UNAVAILABLE);
      const planId = billing.kind === "plan" ? billing.plan.planId : null;
      return refused(await usedUp(chargeRefusal(why, now, planRenews, planId, false, "workflow")));
    }
    // The one reference to the handle: whichever of settle and refund is
    // asked first is the only one that reaches it.
    meter = settleOnce(taken.handle);
  } catch (err) {
    release();
    throw err;
  }
  /** When the charge was taken: an answer later than the longest run plus its grace is not delivered. */
  const chargedAt = clock().getTime();
  const charge = metering.charge();
  const charged = charge ? charge.grossCents : null;
  const planUse = billing.kind === "plan" ? metering.planUse() : null;

  /** One more answer that was paid for and not delivered. Best effort. */
  const countUndelivered = async (): Promise<void> => {
    if (!charge && !planUse) return;
    await deps.limiter
      .consume([{ scope: "org", key: undeliveredKey, limit: COUNT_ONLY, windowSeconds: dayLeft }])
      .catch((err) => deps.logger?.warn({ err }, "failed to count an undelivered paid run"));
  };

  // The plan's count as the reply told it: read once, and the warning is asked with the same numbers.
  let planCount: UsePlanCount | null = null;
  const billingNow = async (): Promise<PaidUseBilling> => {
    const balanceCents = await deps
      .readBalance(caller.orgId)
      .then((cents) => Number(cents))
      .catch(() => null);
    if (planUse) planCount = await planUse.count();
    return {
      chargedCents: Number(charged ?? 0n),
      balanceCents,
      access: billing.access,
      ...(planUse && planCount && { plan: planBillingOf(planUse, planCount, planRenews, false) }),
    };
  };

  /** The email at 85% and at 100% of a plan: asked once an included use was delivered, never waited for. */
  const warnOfPlan = (told: PaidUseBilling): void => {
    if (!deps.warnPlan || billing.kind !== "plan" || !planUse || planUse.use !== "included") return;
    const count = planCount;
    if (!count || !told.plan || told.plan.warning === null) return;
    try {
      void Promise.resolve(
        deps.warnPlan({
          orgId: caller.orgId,
          subscriptionId: planUse.subscriptionId,
          periodStart: planUse.periodStart,
          planName: count.planId === billing.plan.planId ? (sub?.planName ?? null) : null,
          // The listing's title: what the buyer knows the workflow by.
          agentTitle: listing.title,
          includedUses: count.includedUses,
          carriedUses: count.carriedUses,
          usedUses: count.usedInPeriod,
          extraUsePriceCents: extraInstall ? count.extraUsePriceCents : null,
          periodEnd: count.periodEnd,
          renews: planRenews,
        }),
      ).catch((err) => deps.logger?.warn({ err }, "a plan's warning failed; the answer went out as it was"));
    } catch (err) {
      deps.logger?.warn({ err }, "a plan's warning failed; the answer went out as it was");
    }
  };

  let started: PaidWorkflowRun | null = null;
  let cancelAsked = false;
  /** Asked once. Never throws: a run that cannot be cancelled ends by its own time limit. */
  const cancel = async (): Promise<void> => {
    if (!started || cancelAsked) return;
    cancelAsked = true;
    await deps
      .cancelRun(started)
      .catch((err) => deps.logger?.warn({ err }, "a paid run could not be cancelled; it ends by its own time limit"));
  };
  const onGone = () => void cancel();
  let handedOver = false;
  let settled = false;

  try {
    // Fail closed: a run that must be paid for and carries no charge, or a
    // run on a plan that took no use from its count, does not start.
    const unpaid = billing.kind === "billable" && !charge;
    const uncounted = billing.kind === "plan" && (!planUse || (planUse.use === "extra" && !charge));
    if (unpaid || uncounted) {
      await meter.refund("the run could not be started");
      deps.logger?.error({ listingId: listing.id }, "paid run refused: a run reached its start without its charge or its use of a plan");
      return refused(charge ? runFailed(charge.grossCents) : UNAVAILABLE);
    }

    // 9. The run, in the creator's organization.
    const start = await deps.startRun({
      workflowId: workflow.id,
      orgId: workflow.orgId,
      input: run.input,
      ...(run.prompt !== undefined && { prompt: run.prompt }),
    });
    if (!start.ok) {
      // No row was created. The charge goes back, or the use.
      await meter.refund("the workflow had no room for another paid run");
      return refused(busyAfterCharge(charged));
    }
    started = start.run;
    // A buyer who leaves cancels the run. Their signal is never handed to
    // the engine as its shutdown signal: that would record a failure.
    input.signal.addEventListener("abort", onGone, { once: true });
    if (input.signal.aborted) await cancel();

    const ended = await deps.runToEnd(started, { ...(slot && { shutdown: slot.signal }) });

    // 11. The buyer left: whatever the run did, nobody is there to read it.
    if (input.signal.aborted) {
      await cancel();
      await meter.refund(CLIENT_GONE);
      await countUndelivered();
      return refused({ ...CLIENT_GONE_REFUSAL, ...back(charged) });
    }
    if (ended.status !== "completed") {
      await meter.refund(ended.timedOut ? "the workflow run timed out" : "the workflow run did not complete");
      if (ended.timedOut) return refused(timedOut(charged));
      // The process is stopping: the run was ended by us, not by the workflow.
      if (slot?.signal.aborted) {
        return refused(
          failureRefusal({ code: "service_unavailable", message: "", retryAfterSeconds: null }, charged, "workflow"),
        );
      }
      return refused(runFailed(charged));
    }

    const answer = await deps.readAnswer(started);
    // Completed with nothing to say is nothing delivered.
    if (answer.text === null || answer.text.length === 0) {
      await meter.refund("the workflow run produced no answer");
      return refused(runFailed(charged));
    }
    if (detectInstructionLeak(answer.text, ended.confidential).leaked) {
      await meter.refund("the answer was withheld");
      await countUndelivered();
      return refused({
        status: 502,
        code: "answer_withheld",
        message: PAID_USE_MESSAGES.withheld(charged),
        ...back(charged),
      });
    }
    // Produced and checked, but the caller left while it was: not delivered.
    if (input.signal.aborted) {
      await meter.refund(CLIENT_GONE);
      await countUndelivered();
      return refused({ ...CLIENT_GONE_REFUSAL, ...back(charged) });
    }
    // Too late to deliver. The sweeper gives a pending charge back once it
    // is older than this, and a settle after that only logs: an answer sent
    // now could be an answer for nothing. Refused here, by the clock.
    if (clock().getTime() - chargedAt > PAID_WORKFLOW_MAX_RUN_MS + PAID_WORKFLOW_DELIVER_GRACE_MS) {
      await cancel();
      await meter.refund("the answer came too late to deliver");
      return refused(timedOut(charged));
    }

    // What the steps used on the platform's own model keys comes out of the
    // creator's amount at the settle.
    metering.notePlatformUsage(ended.platformUsage);

    if (!wantsStream) {
      // 10. Delivered.
      await meter.settle();
      settled = true;
      const told = await billingNow();
      warnOfPlan(told);
      return { kind: "result", output: { format: "text", text: answer.text }, billing: told };
    }

    const told = await billingNow();
    handedOver = true;
    return {
      kind: "stream",
      text: answer.text,
      // 10-11. Only the socket knows whether the answer arrived.
      meter,
      billing: told,
      finished: async (outcome) => {
        try {
          if (outcome.ok) warnOfPlan(told);
          else await countUndelivered();
        } finally {
          release();
        }
      },
    };
  } catch (err) {
    // Settled already: the answer was paid for, and no refund may be claimed.
    if (settled) throw err;
    // Anything that throws between the charge and the end refunds. The
    // error is ours to read; the buyer is told only that the run failed.
    deps.logger?.error({ err, listingId: listing.id }, "a paid run failed after its charge; the charge was refunded");
    await cancel();
    await meter.refund("the paid run failed");
    return refused(runFailed(charged));
  } finally {
    input.signal.removeEventListener("abort", onGone);
    // A stream's charge is still open: its `finished` lets the process go.
    if (!handedOver) release();
  }
}

// ============================================
// What the caller may do
// ============================================

/** The caller's access to a workflow that is, or was, on sale. Reads only. */
export async function getWorkflowAccess(
  input: PaidWorkflowReadInput,
  deps: PaidWorkflowDeps,
): Promise<WorkflowAccessResult> {
  const now = (deps.now ?? (() => new Date()))();
  const { caller } = input;
  const slug = slugOf(input.slug);
  if (!slug) return refused(NOT_FOUND);

  const listing = await loadWorkflowListing(deps, slug);
  if (!listing) return refused(NOT_FOUND);

  const own = listing.publisherId === caller.orgId;
  const onSaleForUse = listing.status === "published" && listing.sells === "use";
  const { licence, sub } = own
    ? { licence: null, sub: null }
    : await deps.loadLicence({ listingId: listing.id, buyerId: caller.orgId });
  const mine = licence && licence.buyerId === caller.orgId ? licence : null;
  const access: WorkflowAccessView["access"] = own
    ? "own_workflow"
    : useAccess(
        {
          licence: mine && {
            kind: mine.kind,
            status: mine.status,
            accepted: {
              pricingModel: mine.acceptedPricingModel,
              pricePerRequestCents: mine.acceptedPricePerRequestCents,
            },
          },
          listing,
          sub: mine ? sub : null,
        },
        now,
      );
  const balance = await deps.readBalance(caller.orgId);
  // On a plan, while it gives uses.
  const held = mine && sub && onPlan(sub) && access === "subscribed" ? sub : null;

  return {
    kind: "access",
    view: {
      access,
      listingId: listing.id,
      terms: onSaleForUse ? workflowTermsOf(listing) : null,
      plans: (await plansOnOffer(deps, listing)) ?? [],
      plan: held && accessPlanOf(held, planWillRenew(listing, held)),
      // A workflow's listing offers no free trial.
      trial: null,
      trialAvailable: false,
      trialNeedsCredits: false,
      trialEnded: false,
      accepted:
        mine && mine.kind === "use"
          ? {
              pricingModel: mine.acceptedPricingModel ?? null,
              pricePerRequestCents:
                mine.acceptedPricePerRequestCents == null ? null : Number(mine.acceptedPricePerRequestCents),
              monthlyPriceCents: sub?.priceCents == null ? null : Number(sub.priceCents),
            }
          : null,
      subscription:
        mine && sub
          ? {
              status: sub.status,
              currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
              graceEndsAt:
                sub.status === "past_due" && sub.cancelAtPeriodEnd !== true
                  ? new Date(sub.currentPeriodEnd.getTime() + PAST_DUE_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString()
                  : null,
            }
          : null,
      balanceCents: Number(balance),
      canAccept: await canAccept(deps, caller),
      // No copy of a workflow is sold, so no copy's month can hold a start back.
      startBlocked: null,
      // A workflow's listing has no pause.
      paused: false,
    },
  };
}
