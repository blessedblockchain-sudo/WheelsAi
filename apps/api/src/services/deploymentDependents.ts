/**
 * The agents that answer from one model deployment: what its owner is told
 * before they stop it.
 *
 * An agent set to `wheelsai/<model id>` is answered from its organization's
 * own running deployment of that model (services/hostedModel.ts). Stop the
 * last one and the agent cannot answer; if the agent is on sale for use its
 * listing is paused (services/listingPause.ts). This is the list the Stop
 * button reads first. Read-only: nothing is stopped, paused or written here.
 */

import { prisma } from "@wheelsai/db";

import { resolveAgentModelId } from "./agentModelResolution.js";
import { HOSTED_MODEL_PREFIX } from "./hostedModel.js";
import { HOSTED_CHOICE_LIVE_STATUSES } from "./hostedModelChoices.js";
import { ADAPTER_NAME_PREFIX, FINE_TUNED_SLUG_PATTERN } from "./nosana.js";
import { isGpuBilledDeployment } from "./nosanaIds.js";

export interface DeploymentDependents {
  /** Agents that will stop answering if this deployment is stopped now. */
  agents: Array<{
    id: string;
    name: string;
    /** The agent has a published listing that sells use. */
    onSale: boolean;
    listing: { id: string; title: string; pricingModel: string; subscribers: number } | null;
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
  };
  agentSubscription: {
    findMany(args: {
      where: { listingId: { in: string[] }; status: { in: string[] } };
      select: { listingId: true; subscriberId: true };
    }): Promise<Array<{ listingId: string; subscriberId: string }>>;
  };
  agentInstall: {
    findMany(args: {
      where: { listingId: { in: string[] }; kind: "use" };
      select: { listingId: true; buyerId: true };
    }): Promise<Array<{ listingId: string; buyerId: string }>>;
  };
}

export interface DeploymentDependentsDeps {
  db?: DeploymentDependentsDb;
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

const NONE: DeploymentDependents = { agents: [] };

/**
 * The agents that depend on this deployment, by name; null when the
 * organization has no such deployment.
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

  // Nothing answers from a deployment that is stopped or failed, and no
  // agent chat is answered from the development stand-in (billed per
  // request), so stopping either takes nothing away from any agent.
  if (!HOSTED_CHOICE_LIVE_STATUSES.includes(deployment.status)) return NONE;
  if (!isGpuBilledDeployment(deployment)) return NONE;
  const modelId = answeredModelId(deployment, orgId);
  if (!modelId) return NONE;

  // Another deployment that answers the same id keeps every agent answering.
  const others = await db.deployment.findMany({
    where: { orgId, id: { not: deployment.id }, status: "running" },
    select: DEPLOYMENT_COLUMNS,
  });
  if (others.some((other) => isGpuBilledDeployment(other) && answeredModelId(other, orgId) === modelId)) {
    return NONE;
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
  const agents = stored.filter(
    (agent) => resolveAgentModelId({ modelConfig: agent.modelConfig, availableFreeModelIds: [] }) === modelId,
  );
  if (agents.length === 0) return NONE;

  const listings = await db.agentListing.findMany({
    where: { agentId: { in: agents.map((agent) => agent.id) }, status: "published", sells: "use" },
    select: { id: true, agentId: true, title: true, pricingModel: true },
  });
  const listingIds = listings.map((listing) => listing.id);
  // A subscription does not say what it is for; the buyer's licence for the
  // same listing does. Only a licence for use is counted: a copy runs in the
  // buyer's own organization and does not stop with this deployment.
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
  const subscribersOf = (listingId: string) =>
    subscriptions.filter((sub) => sub.listingId === listingId && forUse.has(`${sub.listingId} ${sub.subscriberId}`))
      .length;

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
  };
}
