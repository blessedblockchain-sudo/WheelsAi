/**
 * The models an organization runs itself, as an agent's model choices.
 *
 * An agent set to `wheelsai/<model id>` is answered from the organization's
 * own deployment of that model (services/hostedModel.ts). This is the list a
 * model picker draws that choice from: one entry for each id an agent could
 * be set to, saying which deployment answers it and whether it answers now.
 *
 * Whether an id is answered is never decided here. Each entry asks
 * resolveHostedModel, the function the chat path itself calls, so the picker
 * cannot offer as working a model the chat would refuse.
 */

import { prisma } from "@wheelsai/db";

import { HOSTED_MODEL_PREFIX, resolveHostedModel, type HostedModelResolution } from "./hostedModel.js";
import { isGpuBilledDeployment } from "./nosanaIds.js";
import { ADAPTER_NAME_PREFIX, FINE_TUNED_SLUG_PATTERN } from "./nosana.js";

/** One model the organization runs itself, as an agent's model choice. */
export interface HostedModelChoice {
  /** What an agent's model is set to: "wheelsai/<catalog model id>", or "wheelsai/ft-<fine-tuned model slug>". */
  id: string;
  /** The model's name as the catalog (or the fine-tuned model) gives it. */
  displayName: string;
  /** True when an agent set to this id would be answered right now. */
  available: boolean;
  /** "running": answering. "starting": its deployment is not serving yet. "not_answering": it should be and is not. */
  state: "running" | "starting" | "not_answering";
  fineTuned: boolean;
  /** The deployment an agent set to this id is answered from. */
  deployment: { id: string; slug: string; name: string | null };
}

/**
 * The statuses of a model deployment that is serving or on its way to it.
 * A stopped or failed one is not a choice: nothing answers from it.
 */
export const HOSTED_CHOICE_LIVE_STATUSES = ["running", "degraded", "pending", "provisioning"];

const STARTING_STATUSES = ["pending", "provisioning"];

export interface HostedModelChoicesDeps {
  db?: Pick<typeof prisma, "deployment">;
  resolveHostedModel?: (args: { orgId: string; modelId: string }) => Promise<HostedModelResolution>;
}

interface ChoiceRow {
  id: string;
  slug: string;
  name: string | null;
  status: string;
  modelId: string;
  nosanaJobIds: string[];
  fineTunedModelId: string | null;
  createdAt: Date;
  model: { displayName: string } | null;
  fineTunedModel: { orgId: string; name: string; liveSlug: string | null; status: string } | null;
}

/**
 * The id an agent would be set to for this deployment, or null when no agent
 * can be answered from it. A deployment that serves a fine-tuned model goes
 * by that model's name and never by its base model's id, under the conditions
 * resolveHostedModel looks it up by: the model is the organization's, ready
 * and not deleted.
 */
function choiceIdentity(row: ChoiceRow, orgId: string): { id: string; displayName: string; fineTuned: boolean } | null {
  if (row.fineTunedModelId !== null || row.fineTunedModel) {
    const model = row.fineTunedModel;
    if (!model || model.orgId !== orgId || model.status !== "ready") return null;
    if (!model.liveSlug || !FINE_TUNED_SLUG_PATTERN.test(model.liveSlug)) return null;
    return {
      id: `${HOSTED_MODEL_PREFIX}${ADAPTER_NAME_PREFIX}${model.liveSlug}`,
      displayName: model.name,
      fineTuned: true,
    };
  }
  return {
    id: `${HOSTED_MODEL_PREFIX}${row.modelId}`,
    displayName: row.model?.displayName ?? row.modelId,
    fineTuned: false,
  };
}

/**
 * The organization's hosted model choices: available ones first, then by
 * name. Read-only: nothing is charged, reserved or written by listing.
 */
export async function listHostedModelChoices(
  args: { orgId: string },
  deps: HostedModelChoicesDeps = {},
): Promise<HostedModelChoice[]> {
  const db = deps.db ?? prisma;
  const resolve = deps.resolveHostedModel ?? ((a: { orgId: string; modelId: string }) => resolveHostedModel(a));

  const rows = (await db.deployment.findMany({
    where: { orgId: args.orgId, status: { in: HOSTED_CHOICE_LIVE_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      modelId: true,
      nosanaJobIds: true,
      fineTunedModelId: true,
      createdAt: true,
      model: { select: { displayName: true } },
      fineTunedModel: { select: { orgId: true, name: true, liveSlug: true, status: true } },
    },
  })) as ChoiceRow[];

  // Newest first, whatever order the rows came in: "newest" below is a rule
  // of the list, not a property of the query.
  const newestFirst = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const byId = new Map<string, { identity: NonNullable<ReturnType<typeof choiceIdentity>>; rows: ChoiceRow[] }>();
  for (const row of newestFirst) {
    // Billed per request (the development stand-in): an agent chat has
    // nothing to settle against it, so it is not a choice.
    if (!isGpuBilledDeployment(row)) continue;
    const identity = choiceIdentity(row, args.orgId);
    if (!identity) continue;
    const group = byId.get(identity.id);
    if (group) group.rows.push(row);
    else byId.set(identity.id, { identity, rows: [row] });
  }

  const choices = await Promise.all(
    [...byId.values()].map(async ({ identity, rows: candidates }): Promise<HostedModelChoice> => {
      // resolveHostedModel answers from the newest running deployment of the
      // id, so that is the one described; with none running, the newest one
      // that is on its way.
      const newest = candidates.find((row) => row.status === "running") ?? candidates[0]!;
      const resolution = await resolve({ orgId: args.orgId, modelId: identity.id });
      // A deployment that came up between the two reads: the one the answer
      // comes from is the one described.
      const picked =
        (resolution.ok ? candidates.find((row) => row.id === resolution.deploymentId) : undefined) ?? newest;
      // The entry names a deployment: it is available only when that is the
      // deployment the answer comes from.
      const available = resolution.ok && resolution.deploymentId === picked.id;
      return {
        id: identity.id,
        displayName: identity.displayName,
        available,
        state: available ? "running" : STARTING_STATUSES.includes(picked.status) ? "starting" : "not_answering",
        fineTuned: identity.fineTuned,
        deployment: { id: picked.id, slug: picked.slug, name: picked.name },
      };
    }),
  );

  return choices.sort(
    (a, b) =>
      Number(b.available) - Number(a.available) ||
      a.displayName.localeCompare(b.displayName) ||
      a.id.localeCompare(b.id),
  );
}
