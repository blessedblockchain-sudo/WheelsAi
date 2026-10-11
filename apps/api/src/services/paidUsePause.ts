/**
 * Whether the listing a buyer's page describes is paused at this moment:
 * the production reading behind `paused` on the access view
 * (services/paidUse.ts, getUseAccess).
 *
 * The paid-use core is pure and does not read the agent's model, so the one
 * read it takes to ask is here. The question itself is listingPausedNow's
 * (services/listingPause.ts): it is never answered from the marker.
 */

import { prisma } from "@wheelsai/db";

import { listingPausedNow, type ListingPauseDeps } from "./listingPause.js";

export interface PaidListingPauseDeps extends ListingPauseDeps {
  loadModelConfig?: (agentId: string) => Promise<unknown>;
}

export async function paidListingPausedNow(
  args: { listing: { status: string; sells: string }; agent: { id: string; orgId: string } },
  deps: PaidListingPauseDeps = {},
): Promise<boolean> {
  // Only a published listing that sells use can be paused: no other costs a read.
  if (args.listing.status !== "published" || args.listing.sells !== "use") return false;
  const loadModelConfig =
    deps.loadModelConfig ??
    (async (agentId: string) =>
      (await prisma.agent.findUnique({ where: { id: agentId }, select: { modelConfig: true } }))?.modelConfig ?? null);
  const modelConfig = await loadModelConfig(args.agent.id);
  return listingPausedNow({ listing: args.listing, agent: { orgId: args.agent.orgId, modelConfig } }, deps);
}
