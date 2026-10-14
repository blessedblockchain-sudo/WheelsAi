/**
 * Composition root for a paid run of a workflow on sale
 * (services/paidWorkflow.ts): the one set of deps of this process.
 *
 * The run follows the one path that already runs a workflow on a stranger's
 * input, a hired job (services/buildJobRunnerDeps.ts, runWorkflow), line for
 * line:
 *
 *   start    startWorkflowRun in the workflow's OWN organization, read from
 *            the workflow's row and never from the request, triggered by
 *            "paid" with no one named (`triggeredById` null: the creator is
 *            never told who the buyer is), handed to no queue. Its row is
 *            made by createPaidQueuedRun (services/buildWorkflowRunDeps.ts)
 *            under the lock that orders the organization's starts, and only
 *            while fewer than PAID_WORKFLOW_MAX_ACTIVE_RUNS paid runs of this
 *            workflow are queued or running.
 *   run      runWorkflowExecutionJob in this process, every step in tool
 *            mode "hired" with CONFIDENTIAL_CHAT_RULES and no outbound tool
 *            allowed, through the watched executor (the step agents' system
 *            prompts, and what ran on the platform's keys). The queue's
 *            worker would run it as the owner's own run, with every tool.
 *   cancel   cancelExecution in the creator's organization; a run that
 *            already ended, or is gone, is nothing to stop.
 *   answer   workflowAnswerText over the stored row.
 *
 * The engine says that a run passed its time only by the error text
 * "workflow timed out after <n>ms" (services/runOrchestrationExecution.ts).
 * paidRunEnding, in this file, is the one place that reads it, and turns
 * it into a typed `timedOut`.
 *
 * The buyer's licence, plans, balance, key caps, membership and plan
 * warnings are the paid use's own (services/buildPaidUseDeps.ts), on the
 * same limiter: one set of rows and counters for both.
 *
 * Building it connects to nothing.
 */

import { prisma as defaultPrisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import { chatWithDeployment as defaultChatWithDeployment } from "./buildDeploymentChatDeps.js";
import { buildOrchestrationExecutorDeps, modelStepCapability } from "./buildOrchestrationExecutorDeps.js";
import { productionPaidUseDeps } from "./buildPaidUseDeps.js";
import {
  ACTIVE_RUN_STATUSES,
  buildStartWorkflowRunDeps,
  buildWorkflowExecutionJobDeps,
  createPaidQueuedRun,
  type WorkflowRunPrismaSurface,
} from "./buildWorkflowRunDeps.js";
import { loadWorkflowRunReadiness } from "./buildWorkflowListingDeps.js";
import { createInFlightRuns } from "./inFlightRuns.js";
import { CONFIDENTIAL_CHAT_RULES } from "./jobPrompt.js";
import { PAID_USE_LIMITS } from "./paidUse.js";
import type { PaidWorkflowDeps, PaidWorkflowEnding, PaidWorkflowListing, PaidWorkflowRun } from "./paidWorkflow.js";
import { runWorkflowExecutionJob, type WorkflowJobResult } from "./runWorkflowExecutionJob.js";
import { buildProductionExecutorDeps } from "./scheduledTaskExecutorProduction.js";
import { startWorkflowRun } from "./startWorkflowRun.js";
import { watchWorkflowExecutor, type WorkflowStepExecutor } from "./watchedWorkflowExecutor.js";
import { triggerWebhook } from "./webhooks.js";
import { workflowAnswerText } from "./workflowChat.js";
import { WorkflowError } from "./workflowErrors.js";
import { PAID_WORKFLOW_MAX_ACTIVE_RUNS, PAID_WORKFLOW_TRIGGER } from "./workflowListing.js";
import type { WorkflowCapabilities } from "./workflowDefinition.js";

const logger = createLogger("paid-workflow");

// ============================================
// How a run ended
// ============================================

/** The engine's one way of saying a run passed its time (runOrchestrationExecution.ts). */
const TIMED_OUT = /^workflow timed out after \d+ms$/;

/**
 * How a paid run ended, as the paid service reads it. The one reader of the
 * engine's error text: nothing else turns a text into "timed out". A run
 * that was skipped, taken over, cancelled or failed is not delivered.
 */
export function paidRunEnding(
  result: WorkflowJobResult,
): { status: "completed" } | Extract<PaidWorkflowEnding, { status: "failed" }> {
  if (result.status === "completed") return { status: "completed" };
  const error = "error" in result ? result.error : null;
  return { status: "failed", timedOut: result.status === "failed" && typeof error === "string" && TIMED_OUT.test(error) };
}

// ============================================
// The run
// ============================================

/** What these reads and writes use of the database, beyond what the run's lifecycle binds. */
export interface PaidWorkflowRunPrisma {
  orchestration: {
    findUnique(args: { where: { id: string }; select: { orgId: true } }): Promise<{ orgId: string } | null>;
  };
  orchestrationExecution: {
    count(args: {
      where: { orchestrationId: string; triggeredBy: string; status: { in: string[] } };
    }): Promise<number>;
    findUnique(args: {
      where: { id: string };
      select: {
        output: true;
        context: true;
        orchestration: { select: { steps: { orderBy: { stepOrder: "asc" }; select: { name: true } } } };
      };
    }): Promise<{ output: unknown; context: unknown; orchestration: { steps: Array<{ name: string }> } } | null>;
  };
}

export interface PaidWorkflowRunOverrides {
  prisma?: PaidWorkflowRunPrisma & WorkflowRunPrismaSurface;
  executor?: WorkflowStepExecutor;
  chatWithDeployment?: typeof defaultChatWithDeployment;
  /** buildOrchestrationExecutorDeps: what each step of a run is bound to. */
  engineBindingsOf?: typeof buildOrchestrationExecutorDeps;
  /** runWorkflowExecutionJob: the run itself. */
  runJob?: typeof runWorkflowExecutionJob;
  /** services/orchestration.ts cancelExecution. */
  cancelExecution?: (executionId: string, orchestrationId: string, orgId: string) => Promise<unknown>;
  emitEvent?: (orgId: string, type: string, data: Record<string, unknown>) => Promise<void>;
  capabilities?: WorkflowCapabilities;
}

/** The four calls of a paid run, and the count of paid runs in flight. */
export function buildPaidWorkflowRunDeps(
  overrides: PaidWorkflowRunOverrides = {},
): Pick<PaidWorkflowDeps, "activePaidRuns" | "startRun" | "runToEnd" | "cancelRun" | "readAnswer"> {
  const prisma = overrides.prisma ?? (defaultPrisma as unknown as PaidWorkflowRunPrisma & WorkflowRunPrismaSurface);
  const surface = prisma as WorkflowRunPrismaSurface;
  const chatWithDeployment = overrides.chatWithDeployment ?? defaultChatWithDeployment;
  const engineBindingsOf = overrides.engineBindingsOf ?? buildOrchestrationExecutorDeps;
  const runJob = overrides.runJob ?? runWorkflowExecutionJob;
  let executor = overrides.executor ?? null;

  const startDeps = {
    ...buildStartWorkflowRunDeps({
      prisma: surface,
      // Run below, in this process, not by the workflow queue: its worker
      // would run every step as the owner's own, with every tool.
      enqueue: async () => {},
      runnerEnabled: true,
      maxActiveRunsPerOrg: Number.MAX_SAFE_INTEGER,
    }),
    // In place of the organization's cap: the workflow's own number of paid runs.
    createQueuedRun: createPaidQueuedRun(surface, PAID_WORKFLOW_MAX_ACTIVE_RUNS),
  };

  return {
    activePaidRuns: (workflowId) =>
      prisma.orchestrationExecution.count({
        where: { orchestrationId: workflowId, triggeredBy: PAID_WORKFLOW_TRIGGER, status: { in: [...ACTIVE_RUN_STATUSES] } },
      }),

    startRun: async (args) => {
      // The organization the run belongs to is the workflow's own row's.
      const row = await prisma.orchestration.findUnique({ where: { id: args.workflowId }, select: { orgId: true } });
      if (!row) throw new Error("the workflow on sale is gone");
      let queued;
      try {
        queued = await startWorkflowRun(
          {
            orchestrationId: args.workflowId,
            orgId: row.orgId,
            input: args.input,
            ...(args.prompt !== undefined && { prompt: args.prompt }),
            triggeredBy: PAID_WORKFLOW_TRIGGER,
            // The creator is never told who paid for a run.
            triggeredById: null,
          },
          startDeps,
        );
      } catch (err) {
        // The one refusal that is "no room". Its words name the
        // organization's runs: they stay here, and the buyer hears the
        // workflow's own sentence.
        if (err instanceof WorkflowError && err.code === "workflow_run_limit") return { ok: false, reason: "no_room" };
        throw err;
      }
      return { ok: true, run: { id: queued.id, workflowId: args.workflowId, orgId: row.orgId } };
    },

    runToEnd: async (run: PaidWorkflowRun, { shutdown }): Promise<PaidWorkflowEnding> => {
      executor ??= buildProductionExecutorDeps();
      // This run's own watcher. What it saw rides on the ending and is
      // kept nowhere else: a run that is never read leaves nothing behind.
      const watched = watchWorkflowExecutor(executor);
      const result = await runJob(
        // The process's own shutdown signal. A buyer who leaves cancels the
        // run instead: their signal here would record it as a failure.
        { executionId: run.id, ...(shutdown && { shutdownSignal: shutdown }) },
        buildWorkflowExecutionJobDeps({
          prisma: surface,
          engineBindings: (claimed) =>
            engineBindingsOf(
              claimed.id,
              { executor: watched.executor, chatWithDeployment },
              // Nothing that moves money or writes the creator's files, no
              // outbound request: an empty list allows none.
              { mode: "hired", instructions: CONFIDENTIAL_CHAT_RULES, toolAllowlist: [] },
            ),
          emitEvent:
            overrides.emitEvent ??
            (async (eventOrgId, type, data) => {
              await triggerWebhook(eventOrgId, type, data, "orchestration", String(data.orchestrationId));
            }),
          capabilities: overrides.capabilities ?? { modelSteps: modelStepCapability() },
          onSideEffectError: (what, err) => logger.error({ err, what }, "Paid workflow run bookkeeping failed"),
        }),
      );
      const ending = paidRunEnding(result);
      if (ending.status !== "completed") return ending;
      return {
        status: "completed",
        // The step agents' system prompts, as a hired job collects them. A
        // step's prompt template is not one: it often holds the very words
        // the answer is meant to repeat.
        confidential: watched.confidential(),
        platformUsage: watched.platformUsage(),
      };
    },

    cancelRun: async (run) => {
      const cancel =
        overrides.cancelExecution ?? (await import("./orchestration.js")).cancelExecution;
      try {
        await cancel(run.id, run.workflowId, run.orgId);
      } catch (err) {
        // Already finished, or deleted with its workflow: nothing left to stop.
        if (err instanceof WorkflowError && (err.code === "execution_finished" || err.code === "not_found")) return;
        throw err;
      }
    },

    readAnswer: async (run) => {
      const row = await prisma.orchestrationExecution.findUnique({
        where: { id: run.id },
        select: {
          output: true,
          context: true,
          orchestration: { select: { steps: { orderBy: { stepOrder: "asc" }, select: { name: true } } } },
        },
      });
      return {
        text: row
          ? workflowAnswerText({
              output: row.output,
              context: row.context,
              stepOrder: row.orchestration.steps.map((step) => step.name),
            })
          : null,
      };
    },
  };
}

// ============================================
// The whole set
// ============================================

/** What a paid run reads of a listing: the use listing's columns and what it sells. */
export const PAID_WORKFLOW_LISTING_COLUMNS = {
  id: true,
  slug: true,
  title: true,
  publisherId: true,
  status: true,
  sells: true,
  pricingModel: true,
  pricePerRequestCents: true,
  monthlyPriceCents: true,
  agentId: true,
  orchestrationId: true,
} as const;

/** Every paid run of a workflow in this process, so a shutdown can end each and give its charge back. */
const inFlightPaidRuns = createInFlightRuns();

/**
 * Called on SIGTERM with the agent chats: stops every paid run that is going,
 * so each refunds its charge, and refuses new ones.
 */
export function cancelInFlightPaidWorkflowRuns(timeoutMs: number) {
  return inFlightPaidRuns.cancelAll(timeoutMs);
}

export function buildPaidWorkflowDeps(): PaidWorkflowDeps {
  const paid = productionPaidUseDeps();
  return {
    limiter: paid.limiter,
    limits: PAID_USE_LIMITS,
    // A listing's slug is unique across the marketplace, whatever it sells.
    loadListingBySlug: (slug): Promise<PaidWorkflowListing | null> =>
      defaultPrisma.agentListing.findUnique({ where: { slug }, select: PAID_WORKFLOW_LISTING_COLUMNS }),
    // By its id AND the publisher's organization, with whether its steps
    // can be served now. A throw is "cannot run" in the core.
    loadWorkflowReadiness: (ref) => loadWorkflowRunReadiness(ref),
    loadLicence: paid.loadLicence,
    ...(paid.loadPlans && { loadPlans: paid.loadPlans }),
    readBalance: paid.readBalance,
    peekKeySpend: paid.peekKeySpend,
    beginUse: paid.beginUse,
    beginRun: () => inFlightPaidRuns.begin(),
    ...buildPaidWorkflowRunDeps(),
    memberRole: paid.memberRole,
    ...(paid.warnPlan && { warnPlan: paid.warnPlan }),
    logger,
  };
}

let production: PaidWorkflowDeps | null = null;

/** The one set of paid-run deps of this process: /api/w and /v1 share its limits and counters. */
export function productionPaidWorkflowDeps(): PaidWorkflowDeps {
  return (production ??= buildPaidWorkflowDeps());
}
