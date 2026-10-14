/**
 * The production read of one workflow for sale (services/workflowListing.ts
 * holds the rules it is read for).
 *
 * The workflow is ALWAYS read by its id and an organization, never by its id
 * alone: the caller's organization for its creator, the listing's publisher
 * for a buyer's start and for a paid run. A workflow that is no longer in
 * that organization is not found, and so not sellable.
 *
 * Two reads:
 *
 *   loadWorkflowForListing     what the sellable question needs.
 *   loadWorkflowRunReadiness   that, and whether what the steps run on is
 *                              serving at this moment.
 *
 * and the two questions asked of them by a caller that must fail closed
 * (workflowSellableNow, readWorkflowCanRunNow): a read that throws is "no".
 */

import { prisma } from "@wheelsai/db";

import { createLogger } from "../utils/logger.js";
import { resolveAgentModelId } from "./agentModelResolution.js";
import { anyMarketplaceCopy } from "./buildOfferingServiceDeps.js";
import { HOSTED_MODEL_PREFIX, resolveHostedModel } from "./hostedModel.js";
import {
  workflowCanRunNow,
  workflowSellableProblem,
  type WorkflowForListing,
  type WorkflowRunReadiness,
} from "./workflowListing.js";

const defaultLogger = createLogger("workflow-listing");

/** A step as these reads take it. */
export interface WorkflowStepRow {
  stepType: string;
  agentId: string | null;
  fallbackAgentId: string | null;
  deploymentId: string | null;
}

interface WorkflowRow {
  id: string;
  orgId: string;
  isEnabled: boolean;
  timeout: number;
  inputSchema: unknown;
  steps: WorkflowStepRow[];
}

/** The part of the database these reads use. The Prisma client and a transaction are each one. */
export interface WorkflowListingDb {
  orchestration: {
    findFirst(args: {
      where: { id: string; orgId: string };
      select: Record<string, unknown>;
    }): Promise<WorkflowRow | null>;
  };
  agent: {
    findMany(args: {
      where: { id: { in: string[] }; orgId: string };
      select: { id: true; modelConfig: true };
    }): Promise<Array<{ id: string; modelConfig: unknown }>>;
  };
  deployment: {
    findMany(args: {
      where: { id: { in: string[] }; orgId: string; status: "running" };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
}

export interface WorkflowListingDeps {
  db?: WorkflowListingDb;
  /** Whether any of these agents is a buyer's copy of a marketplace listing. */
  anyMarketplaceCopy?: (agentIds: string[]) => Promise<boolean>;
  /** Answers `ok` when the organization's own deployment of the model can serve now. */
  resolveHostedModel?: (args: { orgId: string; modelId: string }) => Promise<{ ok: boolean }>;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

/** Which workflow, and in which organization it must be. */
export interface WorkflowListingRef {
  workflowId: string;
  /** The creator's own organization, or the publisher of the listing. Never left out. */
  orgId: string;
}

const WORKFLOW_COLUMNS = {
  id: true,
  orgId: true,
  isEnabled: true,
  timeout: true,
  inputSchema: true,
  steps: { select: { stepType: true, agentId: true, fallbackAgentId: true, deploymentId: true } },
} as const;

const unique = (ids: Array<string | null>): string[] => [...new Set(ids.filter((id): id is string => !!id))];

/**
 * What a workflow's steps need to be serving for it to run now, the one
 * answer to it (the Stop warning of a deployment asks it too,
 * services/deploymentDependents.ts):
 *
 *   modelStepDeploymentIds  the deployment of each model step, by its id;
 *                           null for a model step that names none, which
 *                           has nothing to run on
 *   stepAgentIds            the agent of each step. A fallback agent is not
 *                           among them: the step it stands behind decides.
 */
export function workflowNeedsOf(steps: ReadonlyArray<WorkflowStepRow>): {
  modelStepDeploymentIds: Array<string | null>;
  stepAgentIds: string[];
} {
  return {
    modelStepDeploymentIds: steps.filter((step) => step.stepType === "model").map((step) => step.deploymentId),
    stepAgentIds: unique(steps.map((step) => step.agentId)),
  };
}

interface Loaded {
  workflow: WorkflowForListing;
  steps: WorkflowStepRow[];
  /** The agents of the organization that a step or a fallback names. */
  agents: Array<{ id: string; modelConfig: unknown }>;
}

async function load(ref: WorkflowListingRef, deps: WorkflowListingDeps): Promise<Loaded | null> {
  const db = deps.db ?? (prisma as unknown as WorkflowListingDb);
  const row = await db.orchestration.findFirst({
    where: { id: ref.workflowId, orgId: ref.orgId },
    select: WORKFLOW_COLUMNS,
  });
  if (!row) return null;
  const agentIds = unique(row.steps.flatMap((step) => [step.agentId, step.fallbackAgentId]));
  // Scoped to the workflow's organization: an agent that was deleted, or one
  // of another organization, is not among them.
  const agents =
    agentIds.length === 0
      ? []
      : await db.agent.findMany({
          where: { id: { in: agentIds }, orgId: row.orgId },
          select: { id: true, modelConfig: true },
        });
  const found = new Set(agents.map((agent) => agent.id));
  return {
    workflow: {
      id: row.id,
      orgId: row.orgId,
      isEnabled: row.isEnabled,
      stepCount: row.steps.length,
      usesMarketplaceCopy: await (deps.anyMarketplaceCopy ?? anyMarketplaceCopy)(agentIds),
      everyAgentExists: agentIds.every((id) => found.has(id)),
      timeoutMs: row.timeout,
      inputSchema: row.inputSchema,
    },
    steps: row.steps,
    agents,
  };
}

/** The workflow as the sellable question reads it, or null when it is not in that organization. */
export async function loadWorkflowForListing(
  ref: WorkflowListingRef,
  deps: WorkflowListingDeps = {},
): Promise<WorkflowForListing | null> {
  return (await load(ref, deps))?.workflow ?? null;
}

/**
 * The workflow, and whether what its steps run on is serving now: every
 * model step's deployment is in the workflow's organization and running,
 * and every step agent set to a model its organization runs
 * (`wheelsai/<model id>`) has a deployment that can serve, the question
 * listingPausedNow (services/listingPause.ts) asks of an agent. A fallback
 * agent is not asked about: the step it stands behind decides.
 */
export async function loadWorkflowRunReadiness(
  ref: WorkflowListingRef,
  deps: WorkflowListingDeps = {},
): Promise<WorkflowRunReadiness> {
  const loaded = await load(ref, deps);
  if (!loaded) return { workflow: null, modelStepsServe: false, agentModelsServe: false };
  const db = deps.db ?? (prisma as unknown as WorkflowListingDb);
  const orgId = loaded.workflow.orgId;

  const needs = workflowNeedsOf(loaded.steps);
  const deploymentIds = unique(needs.modelStepDeploymentIds);
  const running =
    deploymentIds.length === 0
      ? []
      : await db.deployment.findMany({
          where: { id: { in: deploymentIds }, orgId, status: "running" },
          select: { id: true },
        });
  const serving = new Set(running.map((deployment) => deployment.id));
  // A model step with no deployment at all has nothing to run on.
  const modelStepsServe = needs.modelStepDeploymentIds.every((id) => id !== null && serving.has(id));

  const stepAgentIds = new Set(needs.stepAgentIds);
  // No free models offered: an agent with no model of its own is not on a
  // model its organization runs, whatever it would fall back to.
  const hostedModelIds = unique(
    loaded.agents
      .filter((agent) => stepAgentIds.has(agent.id))
      .map((agent) => resolveAgentModelId({ modelConfig: agent.modelConfig, availableFreeModelIds: [] }) ?? null)
      .map((modelId) => (modelId && modelId.startsWith(HOSTED_MODEL_PREFIX) ? modelId : null)),
  );
  const resolve = deps.resolveHostedModel ?? resolveHostedModel;
  let agentModelsServe = true;
  for (const modelId of hostedModelIds) {
    if (!(await resolve({ orgId, modelId })).ok) {
      agentModelsServe = false;
      break;
    }
  }
  return { workflow: loaded.workflow, modelStepsServe, agentModelsServe };
}

/** A change to a workflow that has not been saved yet. */
export interface WorkflowChange {
  /** The enabled flag as it would be. Left out: as it is. */
  isEnabled?: boolean;
  /** The whole definition as it would be: its time limit and its steps. Left out: as it is. */
  definition?: {
    timeoutMs: number;
    steps: ReadonlyArray<{ agentId?: string | null; fallbackAgentId?: string | null }>;
  };
}

/**
 * The workflow AS IT WOULD BE once a change is saved, for the sellable
 * question to be asked before anything is written (a workflow on sale must
 * stay sellable, services/orchestration.ts). null when the workflow is not
 * in that organization.
 */
export async function loadWorkflowAsItWouldBe(
  ref: WorkflowListingRef,
  change: WorkflowChange,
  deps: WorkflowListingDeps = {},
): Promise<WorkflowForListing | null> {
  const loaded = await load(ref, deps);
  if (!loaded) return null;
  const workflow: WorkflowForListing = {
    ...loaded.workflow,
    ...(change.isEnabled !== undefined && { isEnabled: change.isEnabled }),
  };
  if (!change.definition) return workflow;
  const db = deps.db ?? (prisma as unknown as WorkflowListingDb);
  const agentIds = unique(
    change.definition.steps.flatMap((step) => [step.agentId ?? null, step.fallbackAgentId ?? null]),
  );
  const agents =
    agentIds.length === 0
      ? []
      : await db.agent.findMany({
          where: { id: { in: agentIds }, orgId: workflow.orgId },
          select: { id: true, modelConfig: true },
        });
  const found = new Set(agents.map((agent) => agent.id));
  return {
    ...workflow,
    stepCount: change.definition.steps.length,
    usesMarketplaceCopy: await (deps.anyMarketplaceCopy ?? anyMarketplaceCopy)(agentIds),
    everyAgentExists: agentIds.every((id) => found.has(id)),
    timeoutMs: change.definition.timeoutMs,
  };
}

/** Whether the workflow may be on sale, asked by a caller that must fail closed: a read that throws is "no". */
export async function workflowSellableNow(ref: WorkflowListingRef, deps: WorkflowListingDeps = {}): Promise<boolean> {
  try {
    return workflowSellableProblem(await loadWorkflowForListing(ref, deps), ref.orgId) === null;
  } catch (error) {
    (deps.logger ?? defaultLogger).warn(
      { error, workflowId: ref.workflowId },
      "Could not read a workflow on sale; it counts as not sellable",
    );
    return false;
  }
}

/** Whether the workflow can run at this moment. A read that throws is "cannot run". */
export async function readWorkflowCanRunNow(ref: WorkflowListingRef, deps: WorkflowListingDeps = {}): Promise<boolean> {
  try {
    return workflowCanRunNow(await loadWorkflowRunReadiness(ref, deps), ref.orgId);
  } catch (error) {
    (deps.logger ?? defaultLogger).warn(
      { error, workflowId: ref.workflowId },
      "Could not ask whether a workflow can run now; it counts as cannot run",
    );
    return false;
  }
}
