/**
 * Workflow (orchestration) service: definitions, runs and their history,
 * every query scoped to the caller's organization.
 *
 * Expected failures are WorkflowErrors, which carry the status and code
 * the API contract names. Anything else (a database outage, a bug) is
 * left to propagate so it is logged and answered as a 500, not dressed up
 * as a 400.
 */

import { randomBytes } from "node:crypto";

import { Prisma, prisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { modelStepCapability } from "./buildOrchestrationExecutorDeps.js";
import {
  ACTIVE_RUN_STATUSES,
  buildLoadOwnership,
  buildStartWorkflowRunDeps,
} from "./buildWorkflowRunDeps.js";
import { loadWorkflowAsItWouldBe, type WorkflowChange } from "./buildWorkflowListingDeps.js";
import { finishScheduledExecution } from "./finishScheduledExecution.js";
import { workflowApiEndpoints, type WorkflowApiEndpoints } from "./publicEndpoints.js";
import {
  startWorkflowRun,
  type QueuedRun,
  type StartWorkflowRunArgs,
  type WorkflowTrigger,
} from "./startWorkflowRun.js";
import {
  validateWorkflowDefinition,
  type PlanPreview,
  type WorkflowDefinition,
  type WorkflowPatch,
} from "./workflowDefinition.js";
import { isUniqueViolation, WorkflowError } from "./workflowErrors.js";
import { WORKFLOW_LISTING_MESSAGES, workflowSellableProblem } from "./workflowListing.js";
import { generatedWorkflowSlugRoot, pickWorkflowSlug, workflowSlugRoot } from "./workflowSlug.js";

const notFound = () => new WorkflowError("not_found", "Workflow not found");

// ============================================
// A workflow on sale
// ============================================

/**
 * What holds a workflow to staying runnable: its listing is published
 * ("on_sale"), or somebody is still on a plan for it ("on_plan": a
 * subscription to its listing that is active with its period's end in the
 * future, whatever the listing's status, because a buyer who paid for 30
 * days keeps a workflow that runs). null when nothing does.
 *
 * The listing is read by the workflow AND its publisher, which is the
 * workflow's own organization: nothing is said of another organization's.
 */
async function saleHold(orchestrationId: string, orgId: string, now: Date): Promise<"on_sale" | "on_plan" | null> {
  const listing = await prisma.agentListing.findFirst({
    where: { orchestrationId, publisherId: orgId },
    select: { id: true, status: true },
  });
  if (!listing) return null;
  if (listing.status === "published") return "on_sale";
  const onPlan = await prisma.agentSubscription.count({
    where: { listingId: listing.id, status: "active", currentPeriodEnd: { gt: now } },
  });
  return onPlan > 0 ? "on_plan" : null;
}

/**
 * Refuses a change after which a workflow that is on sale, or that people
 * are still on a plan for, could not be sold. The question is asked of the
 * workflow as it would be, before anything is written.
 */
async function assertStaysSellable(id: string, orgId: string, change: WorkflowChange, now: Date): Promise<void> {
  const hold = await saleHold(id, orgId, now);
  if (hold === null) return;
  const problem = workflowSellableProblem(await loadWorkflowAsItWouldBe({ workflowId: id, orgId }, change), orgId);
  if (problem === null) return;
  // A disable is asked to stop the sale first; any other change is told what
  // would be wrong. With the listing no longer published, the running plan
  // is what holds it, and that is what is said.
  const message =
    hold === "on_plan"
      ? WORKFLOW_LISTING_MESSAGES.onPlan
      : change.isEnabled === false
        ? WORKFLOW_LISTING_MESSAGES.onSale
        : WORKFLOW_LISTING_MESSAGES.onSaleChange(problem);
  throw new WorkflowError("workflow_on_sale", message);
}

// ============================================
// Definitions
// ============================================

/**
 * Validates a definition for this organization and returns its plan
 * preview. Throws invalid_workflow naming the step and field at fault.
 */
export async function planWorkflow(orgId: string, def: WorkflowDefinition): Promise<PlanPreview> {
  const validation = await validateWorkflowDefinition(def, {
    loadOwnership: buildLoadOwnership(prisma, orgId),
    capabilities: { modelSteps: modelStepCapability() },
  });
  if (!validation.ok) {
    throw new WorkflowError("invalid_workflow", validation.issue.message, {
      ...(validation.issue.step ? { step: validation.issue.step } : {}),
      ...(validation.issue.field ? { field: validation.issue.field } : {}),
    });
  }
  return validation.plan;
}

function stepRows(def: WorkflowDefinition) {
  return def.steps.map((step, index) => ({
    name: step.name,
    stepOrder: index,
    stepType: step.stepType ?? "agent",
    agentId: step.agentId ?? null,
    deploymentId: step.deploymentId ?? null,
    modelId: step.modelId ?? null,
    knowledgeBaseId: step.knowledgeBaseId ?? null,
    promptTemplate: step.promptTemplate ?? null,
    inputMapping: (step.inputMapping ?? {}) as Prisma.InputJsonValue,
    outputMapping: (step.outputMapping ?? {}) as Prisma.InputJsonValue,
    outputFormat: step.outputFormat ?? "text",
    condition: (step.condition ?? undefined) as Prisma.InputJsonValue | undefined,
    loop: (step.loop ?? undefined) as Prisma.InputJsonValue | undefined,
    onError: step.onError ?? "fail",
    fallbackAgentId: step.fallbackAgentId ?? null,
    maxRetries: step.maxRetries ?? 0,
    timeoutMs: step.timeoutMs ?? null,
    dependsOn: step.dependsOn ?? [],
  }));
}

function settings(def: WorkflowDefinition) {
  return {
    name: def.name,
    description: def.description ?? null,
    executionMode: def.executionMode,
    maxConcurrency: def.maxConcurrency ?? 5,
    timeout: def.timeout ?? 600_000,
    retryPolicy: (def.retryPolicy ?? {}) as Prisma.InputJsonValue,
    inputSchema: (def.inputSchema ?? {}) as Prisma.InputJsonValue,
    outputSchema: (def.outputSchema ?? {}) as Prisma.InputJsonValue,
  };
}

const withSteps = { steps: { orderBy: { stepOrder: "asc" as const } } };

/**
 * A workflow as the API returns it: with where it is served under /v1.
 * `apiEndpoint` and `openaiBaseUrl` are null when PUBLIC_API_URL is not set
 * (services/publicEndpoints.ts); `openaiModel` is always known.
 */
function withApi<T extends { slug: string }>(workflow: T): T & WorkflowApiEndpoints {
  return { ...workflow, ...workflowApiEndpoints(workflow.slug, env.PUBLIC_API_URL) };
}

const SLUG_ATTEMPTS = 5;

/** A unique violation on (org, slug), as opposed to the one on (org, name). */
function isSlugTaken(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const target = (err as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? "")];
  return fields.some((field) => field.includes("slug"));
}

export async function createOrchestration(orgId: string, def: WorkflowDefinition) {
  await planWorkflow(orgId, def);

  const root =
    workflowSlugRoot(def.name) || generatedWorkflowSlugRoot(randomBytes(3).toString("hex"));
  for (let attempt = 1; ; attempt++) {
    const taken = await prisma.orchestration.findMany({
      where: { orgId, slug: { startsWith: root } },
      select: { slug: true },
    });
    try {
      const created = await prisma.orchestration.create({
        data: {
          orgId,
          ...settings(def),
          slug: pickWorkflowSlug(root, taken.map((row) => row.slug)),
          ...(def.layout ? { layout: def.layout as Prisma.InputJsonValue } : {}),
          steps: { create: stepRows(def) },
        },
        include: withSteps,
      });
      return withApi(created);
    } catch (err) {
      // Two creates picked the same free slug; the loser reads again and
      // picks the next. A taken NAME is the caller's to fix: it propagates
      // and the route answers 409 name_taken.
      if (!isSlugTaken(err) || attempt >= SLUG_ATTEMPTS) throw err;
    }
  }
}

export async function getOrchestrations(orgId: string, options: {
  limit?: number;
  offset?: number;
  isEnabled?: boolean;
} = {}) {
  const { limit = 20, offset = 0, isEnabled } = options;
  const where: Prisma.OrchestrationWhereInput = { orgId };
  if (isEnabled !== undefined) where.isEnabled = isEnabled;

  const [rows, total] = await Promise.all([
    prisma.orchestration.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        _count: { select: { steps: true, executions: true, schedules: true } },
        executions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, completedAt: true },
        },
      },
    }),
    prisma.orchestration.count({ where }),
  ]);

  const orchestrations = rows.map(({ executions, _count, ...orchestration }) => ({
    ...withApi(orchestration),
    _count: { steps: _count.steps, executions: _count.executions },
    scheduleCount: _count.schedules,
    lastExecution: executions[0] ?? null,
  }));
  return { orchestrations, total };
}

/** Run columns safe for lists: no input, output or context payloads. */
const executionSummary = {
  id: true,
  orchestrationId: true,
  status: true,
  progress: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  triggeredBy: true,
  triggeredById: true,
  cancelRequestedAt: true,
  scheduledTaskId: true,
  taskExecutionId: true,
  error: true,
  failedStepId: true,
  createdAt: true,
} satisfies Prisma.OrchestrationExecutionSelect;

export async function getOrchestration(id: string, orgId: string) {
  const orch = await prisma.orchestration.findFirst({
    where: { id, orgId },
    include: {
      ...withSteps,
      executions: { orderBy: { createdAt: "desc" }, take: 10, select: executionSummary },
      schedules: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          scheduleType: true,
          cronExpression: true,
          intervalSeconds: true,
          scheduledAt: true,
          timezone: true,
          isEnabled: true,
          status: true,
          nextRunAt: true,
          lastRunAt: true,
          lastRunStatus: true,
        },
      },
    },
  });
  if (!orch) throw notFound();
  return withApi(orch);
}

/**
 * Replaces a workflow's whole definition: settings and steps together, in
 * one transaction, so a reader never sees new settings with old steps.
 *
 * The settings update is a compare-and-set on `updatedAt`. When the
 * caller sends `expectedUpdatedAt` it must be the version they loaded;
 * either way a concurrent replace between our read and our write matches
 * no row and is reported as stale rather than silently overwritten.
 */
export async function replaceOrchestration(
  id: string,
  orgId: string,
  def: WorkflowDefinition,
  expectedUpdatedAt?: string,
  now: Date = new Date(),
) {
  const current = await prisma.orchestration.findFirst({
    where: { id, orgId },
    select: { updatedAt: true },
  });
  if (!current) throw notFound();
  const stale = (currentUpdatedAt: Date) =>
    new WorkflowError(
      "stale_definition",
      "This workflow was changed after you loaded it; reload and apply your changes again",
      { currentUpdatedAt: currentUpdatedAt.toISOString() },
    );
  if (
    expectedUpdatedAt !== undefined &&
    new Date(expectedUpdatedAt).getTime() !== current.updatedAt.getTime()
  ) {
    throw stale(current.updatedAt);
  }

  await planWorkflow(orgId, def);

  // A workflow on sale stays sellable: asked of the definition that was
  // sent, before any of it is written.
  await assertStaysSellable(id, orgId, { definition: { timeoutMs: settings(def).timeout, steps: def.steps } }, now);

  const replaced = await prisma.$transaction(async (tx) => {
    const { count } = await tx.orchestration.updateMany({
      where: { id, orgId, updatedAt: current.updatedAt },
      data: {
        ...settings(def),
        // Omitted keeps the stored canvas; null clears it.
        ...(def.layout === undefined
          ? {}
          : { layout: def.layout === null ? Prisma.DbNull : (def.layout as Prisma.InputJsonValue) }),
      },
    });
    if (count === 0) return false;
    await tx.orchestrationStep.deleteMany({ where: { orchestrationId: id } });
    await tx.orchestrationStep.createMany({
      data: stepRows(def).map((row) => ({ ...row, orchestrationId: id })),
    });
    return true;
  });

  if (!replaced) {
    const latest = await prisma.orchestration.findFirst({
      where: { id, orgId },
      select: { updatedAt: true },
    });
    if (!latest) throw notFound();
    throw stale(latest.updatedAt);
  }
  return withApi(
    await prisma.orchestration.findFirstOrThrow({ where: { id, orgId }, include: withSteps }),
  );
}

/**
 * Metadata-only update. The fields are copied one by one from an already
 * validated patch: the request body is never handed to Prisma, which is
 * what once let a client rewrite orgId and the run counters.
 */
export async function updateOrchestration(
  id: string,
  orgId: string,
  patch: WorkflowPatch,
  now: Date = new Date(),
) {
  // A workflow on sale, or that people are still on a plan for, is not
  // disabled: nothing of the patch is saved.
  if (patch.isEnabled === false) await assertStaysSellable(id, orgId, { isEnabled: false }, now);

  const data: Prisma.OrchestrationUpdateManyMutationInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.isEnabled !== undefined) data.isEnabled = patch.isEnabled;

  const { count } = await prisma.orchestration.updateMany({ where: { id, orgId }, data });
  if (count === 0) throw notFound();
  return withApi(await prisma.orchestration.findFirstOrThrow({ where: { id, orgId } }));
}

/**
 * Deletes a workflow with its steps, runs and schedules. Runs still in
 * flight are stopped first: queued ones are cancelled (so no worker can
 * claim them) and running ones are asked to stop, and their worker also
 * treats the missing row as a cancel.
 *
 * Its listing is read FIRST, before any run is cancelled or asked to stop.
 * A workflow on sale is not deleted, and neither is one people have paid
 * for: its listing holds their licence and subscription rows. A listing
 * nobody ever started on is removed with the workflow, in one transaction.
 */
export async function deleteOrchestration(id: string, orgId: string) {
  const orch = await prisma.orchestration.findFirst({ where: { id, orgId }, select: { id: true } });
  if (!orch) throw notFound();

  const listing = await prisma.agentListing.findFirst({
    where: { orchestrationId: id },
    select: { id: true, status: true, _count: { select: { installs: true, subscriptions: true } } },
  });
  if (listing?.status === "published") {
    throw new WorkflowError("workflow_on_sale", WORKFLOW_LISTING_MESSAGES.onSale);
  }
  if (listing && listing._count.installs + listing._count.subscriptions > 0) {
    throw new WorkflowError("workflow_has_buyers", WORKFLOW_LISTING_MESSAGES.hasBuyers);
  }

  const now = new Date();
  const stopRunsAndDelete = async (db: Prisma.TransactionClient | typeof prisma) => {
    await db.orchestrationExecution.updateMany({
      where: { orchestrationId: id, status: "queued" },
      data: { status: "cancelled", completedAt: now },
    });
    await db.orchestrationExecution.updateMany({
      where: { orchestrationId: id, status: "running", cancelRequestedAt: null },
      data: { cancelRequestedAt: now },
    });
    await db.orchestration.deleteMany({ where: { id, orgId } });
  };

  if (!listing) {
    await stopRunsAndDelete(prisma);
    return { success: true };
  }

  await prisma.$transaction(async (tx) => {
    // The listing as it is now: published or started on since the read
    // above, it stays, and so does everything else. The plans go first: they
    // hold their listing.
    const buyers =
      (await tx.agentInstall.count({ where: { listingId: listing.id } })) +
      (await tx.agentSubscription.count({ where: { listingId: listing.id } }));
    if (buyers > 0) throw new WorkflowError("workflow_has_buyers", WORKFLOW_LISTING_MESSAGES.hasBuyers);
    await tx.listingPlan.deleteMany({ where: { listingId: listing.id } });
    const removed = await tx.agentListing.deleteMany({
      where: { id: listing.id, orchestrationId: id, status: { not: "published" } },
    });
    if (removed.count !== 1) throw new WorkflowError("workflow_on_sale", WORKFLOW_LISTING_MESSAGES.onSale);
    await stopRunsAndDelete(tx);
  });
  return { success: true };
}

// ============================================
// Runs
// ============================================

async function productionStartDeps() {
  // Imported lazily so loading this service never opens a Redis connection.
  const { enqueueWorkflowRun } = await import("../queues/workflow-run.queue.js");
  return buildStartWorkflowRunDeps({
    prisma,
    enqueue: (executionId) => enqueueWorkflowRun(executionId),
    runnerEnabled: env.WORKFLOW_RUN_CONCURRENCY > 0,
    maxActiveRunsPerOrg: env.WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG,
  });
}

/**
 * Queues a run of a workflow in `args.orgId`. This is the reusable entry
 * point: the dashboard and API call it through executeOrchestration, and
 * the scheduler and marketplace jobs call it directly with their own
 * `triggeredBy` and linking ids.
 */
export async function startOrchestrationRun(args: StartWorkflowRunArgs): Promise<QueuedRun> {
  return startWorkflowRun(args, await productionStartDeps());
}

export async function executeOrchestration(
  id: string,
  orgId: string,
  body: { prompt?: string; input?: Record<string, unknown> },
  // From authentication, never from the request body.
  trigger: { triggeredBy: WorkflowTrigger; triggeredById: string | null },
): Promise<QueuedRun> {
  return startOrchestrationRun({
    orchestrationId: id,
    orgId,
    prompt: body.prompt,
    input: body.input,
    triggeredBy: trigger.triggeredBy,
    triggeredById: trigger.triggeredById,
  });
}

async function assertWorkflow(orchestrationId: string, orgId: string): Promise<void> {
  const orch = await prisma.orchestration.findFirst({
    where: { id: orchestrationId, orgId },
    select: { id: true },
  });
  if (!orch) throw notFound();
}

export async function getExecution(executionId: string, orchestrationId: string, orgId: string) {
  await assertWorkflow(orchestrationId, orgId);

  const execution = await prisma.orchestrationExecution.findFirst({
    where: { id: executionId, orchestrationId },
    include: {
      stepResults: {
        orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          stepId: true,
          stepName: true,
          stepType: true,
          agentId: true,
          resourceId: true,
          status: true,
          iteration: true,
          input: true,
          output: true,
          error: true,
          attempt: true,
          durationMs: true,
          startedAt: true,
          completedAt: true,
        },
      },
    },
  });
  if (!execution) throw new WorkflowError("not_found", "Run not found");
  return execution;
}

export async function getExecutions(orchestrationId: string, orgId: string, options: {
  status?: string;
  limit?: number;
  offset?: number;
} = {}) {
  await assertWorkflow(orchestrationId, orgId);

  const { status, limit = 20, offset = 0 } = options;
  const where: Prisma.OrchestrationExecutionWhereInput = { orchestrationId };
  if (status) where.status = status;

  const [executions, total] = await Promise.all([
    prisma.orchestrationExecution.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: executionSummary,
    }),
    prisma.orchestrationExecution.count({ where }),
  ]);
  return { executions, total };
}

/**
 * Cancels a run. Both paths are compare-and-set, so a cancel can never
 * overwrite a run that already finished, and a finish can never overwrite
 * a cancel:
 *
 *   queued  → 'cancelled' at once; the worker's claim then matches no row.
 *   running → `cancelRequestedAt` is set and the status stays 'running'.
 *             The worker sees the request, aborts the in-flight call,
 *             and ends the run as 'cancelled' itself.
 *
 * `outcome` tells the route which happened (200 vs 202).
 */
export async function cancelExecution(executionId: string, orchestrationId: string, orgId: string) {
  await assertWorkflow(orchestrationId, orgId);
  const now = new Date();
  // Same child-scoping rule as the scheduler: the orchestration is
  // verified above, so the execution must be constrained to it.
  const scope = { id: executionId, orchestrationId };

  const cancelledQueued = await prisma.orchestrationExecution.updateMany({
    where: { ...scope, status: "queued" },
    data: { status: "cancelled", completedAt: now, error: "cancelled before it started" },
  });
  if (cancelledQueued.count === 0) {
    await prisma.orchestrationExecution.updateMany({
      where: { ...scope, status: "running", cancelRequestedAt: null },
      data: { cancelRequestedAt: now },
    });
  }

  const execution = await prisma.orchestrationExecution.findFirst({
    where: scope,
    select: executionSummary,
  });
  if (!execution) throw new WorkflowError("not_found", "Run not found");

  if (cancelledQueued.count > 0) {
    // The schedule that started it is told, and the job is dropped; both
    // are tidy-ups, the cancel itself already happened.
    if (execution.taskExecutionId) {
      await finishScheduledExecution(prisma, execution.taskExecutionId, {
        status: "cancelled",
        durationMs: 0,
        error: "workflow run cancelled before it started",
      }).catch(() => {});
    }
    await import("../queues/workflow-run.queue.js")
      .then(({ removeWorkflowRunJob }) => removeWorkflowRunJob(executionId))
      .catch(() => {});
    return { execution, outcome: "cancelled" as const };
  }
  if (execution.status === "running") {
    return { execution, outcome: "cancel_requested" as const };
  }
  throw new WorkflowError("execution_finished", `This run already ${execution.status}`, {
    status: execution.status,
  });
}

export async function getOrchestrationStats(orgId: string) {
  const [total, active, totalRuns, running] = await Promise.all([
    prisma.orchestration.count({ where: { orgId } }),
    prisma.orchestration.count({ where: { orgId, isEnabled: true } }),
    prisma.orchestrationExecution.count({ where: { orchestration: { orgId } } }),
    prisma.orchestrationExecution.count({
      where: { orchestration: { orgId }, status: { in: [...ACTIVE_RUN_STATUSES] } },
    }),
  ]);
  return {
    totalOrchestrations: total,
    activeOrchestrations: active,
    totalExecutions: totalRuns,
    runningExecutions: running,
  };
}
