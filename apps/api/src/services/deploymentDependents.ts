/**
 * What answers from one model deployment, or runs on it: what its owner is
 * told before they stop it.
 *
 * An agent set to `wheelsai/<model id>` is answered from its organization's
 * own running deployment of that model (services/hostedModel.ts). Stop the
 * last one and the agent cannot answer; if the agent is on sale for use its
 * listing is paused (services/listingPause.ts).
 *
 * A workflow on sale needs this deployment when a model step runs on it, or
 * when a step's agent is one of those agents: stopped, the workflow cannot
 * run, and a plan on it is not renewed until it can again (services/
 * workflowListing.ts, workflowCanRunNow). What a workflow needs is told by
 * the read behind that question (workflowNeedsOf), and whether it is on sale
 * by the test that keeps a workflow on sale runnable (saleHold).
 *
 * This is the list the Stop button reads first. Read-only: nothing is
 * stopped, paused or written here.
 */

import { prisma } from "@wheelsai/db";

import { resolveAgentModelId } from "./agentModelResolution.js";
import { workflowNeedsOf, type WorkflowStepRow } from "./buildWorkflowListingDeps.js";
import { HOSTED_MODEL_PREFIX } from "./hostedModel.js";
import { HOSTED_CHOICE_LIVE_STATUSES } from "./hostedModelChoices.js";
import { ADAPTER_NAME_PREFIX, FINE_TUNED_SLUG_PATTERN } from "./nosana.js";
import { isGpuBilledDeployment } from "./nosanaIds.js";
import { saleHold, type SaleHoldDb } from "./orchestration.js";
import { PAST_DUE_GRACE_DAYS } from "./subscriptionAccess.js";

export interface DeploymentDependents {
  /** Agents that will stop answering if this deployment is stopped now. */
  agents: Array<{
    id: string;
    name: string;
    /** The agent has a published listing that sells use. */
    onSale: boolean;
    listing: { id: string; title: string; pricingModel: string; subscribers: number } | null;
  }>;
  /**
   * Workflows of this organization that are on sale (their listing is
   * published, or somebody's plan on it still runs) and could not run if
   * this deployment were stopped now. By the workflow's own name: this answer
   * is its owner's.
   *
   * What a stop does to the plans on one, as the renewal does it
   * (services/buildSubscriptionRenewalTickDeps.ts, with workflowCanRunNow):
   * while the workflow cannot run, a plan that comes due is not charged and
   * is tried again; it is charged once if the workflow runs again within
   * `renewalGraceDays` days after the plan's period ended, and it ends
   * uncharged after that. The days already paid for keep counting. That
   * holds while the listing is published (`onSale`): once it is not, every
   * plan on it ends at its period's end whatever the workflow can do.
   */
  workflows: Array<{
    id: string;
    name: string;
    /** Its listing is published. False: it was taken off sale and somebody's plan on it still runs. */
    onSale: boolean;
    listing: { id: string; title: string; subscribers: number };
    /** How many days after a plan's period ends its renewal waits for the workflow to run again. */
    renewalGraceDays: number;
  }>;
}

/** A deployment as the identity rule reads it. */
interface DependentsDeploymentRow {
  id: string;
  status: string;
  modelId: string;
  nosanaJobIds: string[];
  fineTunedModelId: string | null;
  fineTunedModel: { orgId: string; liveSlug: string | null; status: string } | null;
}

const DEPLOYMENT_COLUMNS = {
  id: true,
  status: true,
  modelId: true,
  nosanaJobIds: true,
  fineTunedModelId: true,
  fineTunedModel: { select: { orgId: true, liveSlug: true, status: true } },
} as const;

/** The part of the database the list reads. The Prisma client is one. */
export interface DeploymentDependentsDb {
  deployment: {
    findFirst(args: {
      where: { id: string; orgId: string };
      select: typeof DEPLOYMENT_COLUMNS;
    }): Promise<DependentsDeploymentRow | null>;
    findMany(args: {
      where: { orgId: string; id: { not: string }; status: "running" };
      select: typeof DEPLOYMENT_COLUMNS;
    }): Promise<DependentsDeploymentRow[]>;
  };
  agent: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: { name: "asc" };
      select: { id: true; name: true; modelConfig: true };
    }): Promise<Array<{ id: string; name: string; modelConfig: unknown }>>;
  };
  agentListing: {
    findMany(args: {
      where: { agentId: { in: string[] }; status: "published"; sells: "use" };
      select: { id: true; agentId: true; title: true; pricingModel: true };
    }): Promise<Array<{ id: string; agentId: string; title: string; pricingModel: string }>>;
    findMany(args: {
      where: { orchestrationId: { in: string[] }; publisherId: string };
      select: { id: true; orchestrationId: true; title: true };
    }): Promise<Array<{ id: string; orchestrationId: string; title: string }>>;
  } & SaleHoldDb["agentListing"];
  agentSubscription: {
    findMany(args: {
      where: { listingId: { in: string[] }; status: { in: string[] } };
      select: { listingId: true; subscriberId: true };
    }): Promise<Array<{ listingId: string; subscriberId: string }>>;
  } & SaleHoldDb["agentSubscription"];
  agentInstall: {
    findMany(args: {
      where: { listingId: { in: string[] }; kind: "use" };
      select: { listingId: true; buyerId: true };
    }): Promise<Array<{ listingId: string; buyerId: string }>>;
  };
  orchestration: {
    findMany(args: {
      where: {
        orgId: string;
        steps: { some: { OR: Array<{ stepType: "model"; deploymentId: string } | { agentId: { in: string[] } }> } };
      };
      orderBy: { name: "asc" };
      select: { id: true; name: true; steps: { select: typeof STEP_COLUMNS } };
    }): Promise<Array<{ id: string; name: string; steps: WorkflowStepRow[] }>>;
  };
}

/** What workflowNeedsOf reads of a step. */
const STEP_COLUMNS = { stepType: true, agentId: true, fallbackAgentId: true, deploymentId: true } as const;

export interface DeploymentDependentsDeps {
  db?: DeploymentDependentsDb;
  /** Whether somebody's plan still runs is asked at this moment. Default: now. */
  now?: () => Date;
}

/**
 * The model id an agent is set to in order to be answered from this
 * deployment, or null when no agent can be. The rule is choiceIdentity's in
 * services/hostedModelChoices.ts, which does not export it: a deployment that
 * serves a fine-tuned model goes by that model's name and never by its base
 * model's id, and only while the model is the organization's, ready and not
 * deleted. Keep the two in step.
 */
function answeredModelId(row: DependentsDeploymentRow, orgId: string): string | null {
  if (row.fineTunedModelId !== null || row.fineTunedModel) {
    const model = row.fineTunedModel;
    if (!model || model.orgId !== orgId || model.status !== "ready") return null;
    if (!model.liveSlug || !FINE_TUNED_SLUG_PATTERN.test(model.liveSlug)) return null;
    return `${HOSTED_MODEL_PREFIX}${ADAPTER_NAME_PREFIX}${model.liveSlug}`;
  }
  return `${HOSTED_MODEL_PREFIX}${row.modelId}`;
}

/** Nothing depends on it. A new object each time: a caller may keep what it is given. */
const none = (): DeploymentDependents => ({ agents: [], workflows: [] });

/**
 * The agents that would stop answering if this deployment were stopped now:
 * they are set to the model it answers, and no other running deployment of
 * the organization answers that model.
 */
async function agentsAnsweredFrom(
  db: DeploymentDependentsDb,
  deployment: DependentsDeploymentRow,
  orgId: string,
): Promise<Array<{ id: string; name: string; modelConfig: unknown }>> {
  // No agent chat is answered from the development stand-in (billed per
  // request), so stopping it takes nothing away from any agent.
  if (!isGpuBilledDeployment(deployment)) return [];
  const modelId = answeredModelId(deployment, orgId);
  if (!modelId) return [];

  // Another deployment that answers the same id keeps every agent answering.
  const others = await db.deployment.findMany({
    where: { orgId, id: { not: deployment.id }, status: "running" },
    select: DEPLOYMENT_COLUMNS,
  });
  if (others.some((other) => isGpuBilledDeployment(other) && answeredModelId(other, orgId) === modelId)) {
    return [];
  }

  // Matched in the database on what is stored, then by the rule the chat
  // itself picks a model with: `externalModel` comes before `model`. The
  // stored text is matched on containing the id, not on being it: the chat
  // trims what is stored (agentModelResolution.ts), so an agent saved as
  // " wheelsai/x" answers from this deployment like any other. An agent
  // that was deleted has no row, and there is no archived state.
  const stored = await db.agent.findMany({
    where: {
      orgId,
      OR: [
        { modelConfig: { path: ["externalModel"], string_contains: modelId } },
        { modelConfig: { path: ["model"], string_contains: modelId } },
      ],
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, modelConfig: true },
  });
  return stored.filter(
    (agent) => resolveAgentModelId({ modelConfig: agent.modelConfig, availableFreeModelIds: [] }) === modelId,
  );
}

/**
 * How many buyers pay for use of each listing. A subscription does not say
 * what it is for; the buyer's licence for the same listing does. Only a
 * licence for use is counted: a copy runs in the buyer's own organization
 * and does not stop with this deployment.
 */
async function subscribersOfListings(
  db: DeploymentDependentsDb,
  listingIds: string[],
): Promise<(listingId: string) => number> {
  const [subscriptions, useLicences] =
    listingIds.length > 0
      ? await Promise.all([
          db.agentSubscription.findMany({
            where: { listingId: { in: listingIds }, status: { in: ["active", "past_due"] } },
            select: { listingId: true, subscriberId: true },
          }),
          db.agentInstall.findMany({
            where: { listingId: { in: listingIds }, kind: "use" },
            select: { listingId: true, buyerId: true },
          }),
        ])
      : [[], []];
  const forUse = new Set(useLicences.map((licence) => `${licence.listingId} ${licence.buyerId}`));
  return (listingId: string) =>
    subscriptions.filter((sub) => sub.listingId === listingId && forUse.has(`${sub.listingId} ${sub.subscriberId}`))
      .length;
}

/**
 * The workflows on sale that could not run if this deployment were stopped
 * now: a model step runs on it (a model step is served by its own
 * deployment, by id, and by no other), or a step's agent is one of the
 * agents that would stop answering (and so the rule that another running
 * deployment of the same model keeps them answering holds for it too).
 */
async function workflowsNeeding(
  db: DeploymentDependentsDb,
  args: { orgId: string; deploymentId: string; agentIds: string[]; now: Date },
): Promise<DeploymentDependents["workflows"]> {
  const { orgId, deploymentId, agentIds } = args;
  const candidates = await db.orchestration.findMany({
    where: {
      orgId,
      steps: {
        some: {
          OR: [
            { stepType: "model", deploymentId },
            ...(agentIds.length > 0 ? [{ agentId: { in: agentIds } }] : []),
          ],
        },
      },
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, steps: { select: STEP_COLUMNS } },
  });
  const answering = new Set(agentIds);
  const needing = candidates.filter((workflow) => {
    const needs = workflowNeedsOf(workflow.steps);
    return needs.modelStepDeploymentIds.includes(deploymentId) || needs.stepAgentIds.some((id) => answering.has(id));
  });
  if (needing.length === 0) return [];

  const holds = await Promise.all(needing.map((workflow) => saleHold(workflow.id, orgId, args.now, db)));
  const onSale = needing.flatMap((workflow, index) => {
    const hold = holds[index];
    return hold ? [{ ...workflow, published: hold === "on_sale" }] : [];
  });
  if (onSale.length === 0) return [];

  const listings = await db.agentListing.findMany({
    where: { orchestrationId: { in: onSale.map((workflow) => workflow.id) }, publisherId: orgId },
    select: { id: true, orchestrationId: true, title: true },
  });
  const subscribersOf = await subscribersOfListings(
    db,
    listings.map((listing) => listing.id),
  );
  return onSale.flatMap((workflow) => {
    const listing = listings.find((candidate) => candidate.orchestrationId === workflow.id);
    return listing
      ? [
          {
            id: workflow.id,
            name: workflow.name,
            onSale: workflow.published,
            listing: { id: listing.id, title: listing.title, subscribers: subscribersOf(listing.id) },
            renewalGraceDays: PAST_DUE_GRACE_DAYS,
          },
        ]
      : [];
  });
}

/**
 * The agents and the workflows on sale that depend on this deployment, by
 * name; null when the organization has no such deployment.
 */
export async function listDeploymentDependents(
  args: { orgId: string; deploymentId: string },
  deps: DeploymentDependentsDeps = {},
): Promise<DeploymentDependents | null> {
  const db = deps.db ?? (prisma as unknown as DeploymentDependentsDb);
  const { orgId } = args;

  const deployment = await db.deployment.findFirst({
    where: { id: args.deploymentId, orgId },
    select: DEPLOYMENT_COLUMNS,
  });
  if (!deployment) return null;

  // Nothing answers from, or runs on, a deployment that is stopped or failed.
  if (!HOSTED_CHOICE_LIVE_STATUSES.includes(deployment.status)) return none();

  const agents = await agentsAnsweredFrom(db, deployment, orgId);
  const listings =
    agents.length > 0
      ? await db.agentListing.findMany({
          where: { agentId: { in: agents.map((agent) => agent.id) }, status: "published", sells: "use" },
          select: { id: true, agentId: true, title: true, pricingModel: true },
        })
      : [];
  const subscribersOf = await subscribersOfListings(
    db,
    listings.map((listing) => listing.id),
  );
  const workflows = await workflowsNeeding(db, {
    orgId,
    deploymentId: deployment.id,
    agentIds: agents.map((agent) => agent.id),
    now: (deps.now ?? (() => new Date()))(),
  });

  return {
    agents: agents.map((agent) => {
      const listing = listings.find((candidate) => candidate.agentId === agent.id) ?? null;
      return {
        id: agent.id,
        name: agent.name,
        onSale: listing !== null,
        listing: listing && {
          id: listing.id,
          title: listing.title,
          pricingModel: listing.pricingModel,
          subscribers: subscribersOf(listing.id),
        },
      };
    }),
    workflows,
  };
}
