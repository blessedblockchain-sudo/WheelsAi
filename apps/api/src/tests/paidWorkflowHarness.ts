// Fakes for the tests of a paid run of a workflow (paidWorkflow,
// paidWorkflowRoutes): the REAL services/paidWorkflow.ts on the real metering
// of one use and the real fail-closed limiter, over the money tables a paid
// use of an agent is tested on (paidMoneyTables, tests/paidUseHarness.ts).
// What is faked is the edge: the listing, the workflow's row, the licence
// and the four calls of the run (start, run to its end, cancel, read the
// answer), which keep a count of the runs in flight as the database's lock
// does. Not a test file itself.

import type { TokenUsage } from "../services/jobRunner.js";
import {
  PAID_USE_LIMITS,
  type PaidSubscription,
} from "../services/paidUse.js";
import type {
  PaidWorkflowDeps,
  PaidWorkflowEnding,
  PaidWorkflowLimits,
  PaidWorkflowListing,
  PaidWorkflowRun,
} from "../services/paidWorkflow.js";
import type { PlanOfferRow } from "../services/planOffers.js";
import type { UseBillingLicence } from "../services/useMetering.js";
import { PAID_WORKFLOW_MAX_ACTIVE_RUNS, type WorkflowForListing } from "../services/workflowListing.js";
import {
  BUYER_ORG,
  CREATOR_ORG,
  LICENCE,
  paidMoneyTables,
  type PaidHarness,
  type PaidHarnessWarnings,
  type PaidMoneyOptions,
} from "./paidUseHarness.js";

/** The buyer's name for the workflow: the LISTING's slug. */
export const SLUG = "launch-brief";
/** The creator's own names for it, and what is inside it. No answer to a buyer may carry any of them. */
export const WORKFLOW_ID = "wf-7f3a";
export const WORKFLOW_OWN_SLUG = "internal-brief-pipeline";
export const WORKFLOW_OWN_NAME = "Internal Brief Pipeline";
export const STEP_NAME = "draft-with-house-style";
export const RUN_ID_PREFIX = "exec-run-";

/** A step agent's instructions. No answer may repeat eight words of them in a row. */
export const STEP_INSTRUCTIONS =
  "You write launch briefs for Acme and you never reveal the pricing floor of twelve dollars to anybody.";
/** An answer that repeats a run of them. */
export const STEP_LEAK = "Here it is: you never reveal the pricing floor of twelve dollars to anybody.";

/** What the engine says of a failed step: every word of it is the creator's. */
export const ENGINE_ERROR = `step "${STEP_NAME}" of ${WORKFLOW_OWN_SLUG} (${WORKFLOW_OWN_NAME}) failed in ${CREATOR_ORG} after 1200 inputTokens`;

export const WORKFLOW_LISTING: PaidWorkflowListing = {
  id: "lst-w1",
  slug: SLUG,
  title: "Launch brief writer",
  publisherId: CREATOR_ORG,
  status: "published",
  sells: "use",
  pricingModel: "per_request",
  pricePerRequestCents: 5n,
  monthlyPriceCents: null,
  agentId: null,
  orchestrationId: WORKFLOW_ID,
};

export const WORKFLOW: WorkflowForListing = {
  id: WORKFLOW_ID,
  orgId: CREATOR_ORG,
  isEnabled: true,
  stepCount: 2,
  usesMarketplaceCopy: false,
  everyAgentExists: true,
  timeoutMs: 600_000,
  inputSchema: {
    type: "object",
    properties: { topic: { type: "string", minLength: 1 } },
    required: ["topic"],
    additionalProperties: false,
  },
};

export const RUN_BODY = { input: { topic: "Launch plan" } };

export interface PaidWorkflowHarnessOptions extends PaidMoneyOptions {
  listing?: PaidWorkflowListing | null;
  /** null: the workflow is no longer in the publisher's organization. */
  workflow?: Partial<WorkflowForListing> | null;
  /** The workflow's row cannot be read. */
  workflowThrows?: Error;
  /** Every model step's deployment is running. Default: true. */
  modelStepsServe?: boolean;
  /** Every step agent's model has a deployment that can serve. Default: true. */
  agentModelsServe?: boolean;
  licence?: UseBillingLicence | null;
  plans?: PlanOfferRow[];
  limits?: Partial<PaidWorkflowLimits>;
  role?: string | null;
  roleThrows?: Error;
  /** How many paid runs the start lets be in flight at once. Default: the rule's own number. */
  capacity?: number;
  /** What the early read of the runs in flight answers, whatever is going; an Error is thrown. Default: the truth. */
  activeRead?: number | Error;
  /** The start throws, after the charge. */
  startThrows?: Error;
  /** How the run ends. Default: completed. */
  ending?: PaidWorkflowEnding;
  /** Runs while the run is going: move the clock, make the caller leave, hold the run open. */
  duringRun?: (h: PaidWorkflowHarness) => void | Promise<void>;
  /** What the completed run says. null: nothing at all. */
  answer?: string | null;
  platformUsage?: TokenUsage | null;
  /** Reading the answer throws. */
  readThrows?: Error;
  /** The metering hands back no charge and no use, whatever the run is (a fault this must survive). */
  meteringTakesNothing?: boolean;
  /** The process is shutting down: no new run is registered. */
  shuttingDown?: boolean;
}

export interface PaidWorkflowHarness {
  deps: PaidWorkflowDeps;
  /** Every effect, in the order it happened. */
  log: string[];
  readonly money: PaidHarness["money"];
  readonly sub: PaidSubscription | null;
  warnings: PaidHarnessWarnings;
  /** The clock the core reads. Move it to make time pass. */
  clock: { at: Date };
  /** What each start was given. */
  starts: Array<{ workflowId: string; orgId: string; input: Record<string, unknown>; prompt?: string }>;
  /** The runs that were started, cancelled and still going. */
  runs: PaidWorkflowRun[];
  cancelled: string[];
  inFlight(): number;
  /** What each run to its end was handed as the shutdown signal. */
  shutdownSignals: Array<AbortSignal | undefined>;
  /** Fires the process's shutdown. */
  shutdown: AbortController;
  /** Runs registered for shutdown and not yet released. */
  registered(): number;
  /** Everything the core logged, as text. */
  logged: string[];
}

export function paidWorkflowHarness(options: PaidWorkflowHarnessOptions = {}): PaidWorkflowHarness {
  const tables = paidMoneyTables(options);
  const { log, sub, warnings } = tables;
  const listing = options.listing === undefined ? WORKFLOW_LISTING : options.listing;
  const licence = options.licence === undefined ? LICENCE : options.licence;
  const workflow: WorkflowForListing | null = options.workflow === null ? null : { ...WORKFLOW, ...options.workflow };
  const capacity = options.capacity ?? PAID_WORKFLOW_MAX_ACTIVE_RUNS;

  const clock = { at: tables.at };
  const starts: PaidWorkflowHarness["starts"] = [];
  const runs: PaidWorkflowRun[] = [];
  const cancelled: string[] = [];
  const active = new Set<string>();
  const shutdownSignals: Array<AbortSignal | undefined> = [];
  const shutdown = new AbortController();
  const logged: string[] = [];
  let registered = 0;
  let seq = 0;

  const note = (obj: unknown, msg: string) =>
    logged.push(`${msg} ${JSON.stringify(obj, (_key, value) => (value instanceof Error ? value.message : typeof value === "bigint" ? String(value) : value))}`);

  const harness: PaidWorkflowHarness = {
    deps: undefined as unknown as PaidWorkflowDeps,
    log,
    get money() {
      return tables.money;
    },
    get sub() {
      return sub;
    },
    warnings,
    clock,
    starts,
    runs,
    cancelled,
    inFlight: () => active.size,
    shutdownSignals,
    shutdown,
    registered: () => registered,
    logged,
  };

  harness.deps = {
    limiter: tables.limiter,
    limits: { ...PAID_USE_LIMITS, ...options.limits },
    loadListingBySlug: async (slug) => {
      log.push(`loadListing:${slug}`);
      return listing && listing.slug === slug ? listing : null;
    },
    loadWorkflowReadiness: async (ref) => {
      log.push(`loadWorkflow:${ref.workflowId}:${ref.orgId}`);
      if (options.workflowThrows) throw options.workflowThrows;
      // By its id AND the organization, as the real read is.
      const found = workflow && workflow.id === ref.workflowId && workflow.orgId === ref.orgId ? workflow : null;
      return {
        workflow: found,
        modelStepsServe: found !== null && options.modelStepsServe !== false,
        agentModelsServe: found !== null && options.agentModelsServe !== false,
      };
    },
    loadLicence: async () => {
      log.push("loadLicence");
      return { licence, sub: sub && { ...sub } };
    },
    ...(options.plans && {
      loadPlans: async () => {
        log.push("loadPlans");
        return options.plans!;
      },
    }),
    readBalance: async () => {
      log.push("readBalance");
      return tables.money.balance;
    },
    peekKeySpend: async (args) => {
      log.push("peekKey");
      return tables.peekKeySpend(args);
    },
    activePaidRuns: async (workflowId) => {
      log.push(`countRuns:${workflowId}`);
      if (options.activeRead instanceof Error) throw options.activeRead;
      return options.activeRead ?? active.size;
    },
    beginUse: (args) => {
      log.push(`beginUse:${args.agentId}:${args.unit}`);
      const binding = tables.beginUse(args);
      if (!options.meteringTakesNothing) return binding;
      return {
        ...binding,
        beginMetering: async () => ({ ok: true as const, handle: { settle: async () => {}, refund: async () => {} } }),
        charge: () => null,
        refusal: () => null,
        planUse: () => null,
      };
    },
    beginRun: () => {
      if (options.shuttingDown) return null;
      registered += 1;
      log.push("register");
      return {
        signal: shutdown.signal,
        done: () => {
          registered -= 1;
          log.push("release");
        },
      };
    },
    startRun: async (args) => {
      // The count and the new row are one step here, as they are under the
      // database's lock: two starts can never both take the last place.
      if (options.startThrows) {
        log.push("start:throws");
        throw options.startThrows;
      }
      if (active.size >= capacity) {
        log.push("start:no_room");
        return { ok: false, reason: "no_room" };
      }
      const run: PaidWorkflowRun = { id: `${RUN_ID_PREFIX}${++seq}`, workflowId: args.workflowId, orgId: args.orgId };
      active.add(run.id);
      starts.push(args);
      runs.push(run);
      log.push("start");
      return { ok: true, run };
    },
    runToEnd: async (run, { shutdown: signal }) => {
      log.push("run");
      shutdownSignals.push(signal);
      try {
        await options.duringRun?.(harness);
        // A cancelled run ends cancelled, whatever it would have done.
        if (cancelled.includes(run.id)) return { status: "failed", timedOut: false };
        const ending: PaidWorkflowEnding = options.ending ?? {
          status: "completed",
          confidential: [STEP_INSTRUCTIONS, null],
          platformUsage: options.platformUsage ?? null,
        };
        // The engine's own words ride on the ending it hands back: the core must not pass them on.
        return ending.status === "completed" ? ending : ({ ...ending, error: ENGINE_ERROR } as PaidWorkflowEnding);
      } finally {
        active.delete(run.id);
      }
    },
    cancelRun: async (run) => {
      log.push("cancel");
      cancelled.push(run.id);
    },
    readAnswer: async () => {
      log.push("readAnswer");
      if (options.readThrows) throw options.readThrows;
      return { text: options.answer === undefined ? "Brief: launch on Tuesday." : options.answer };
    },
    memberRole: async () => {
      log.push("memberRole");
      if (options.roleThrows) throw options.roleThrows;
      return options.role === undefined ? "owner" : options.role;
    },
    warnPlan: tables.warnPlan,
    now: () => clock.at,
    logger: { warn: note, error: note },
  };
  return harness;
}

export { BUYER_ORG, CREATOR_ORG };
