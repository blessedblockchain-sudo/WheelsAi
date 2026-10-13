/**
 * Composition root for paid use (services/paidUse.ts): binds the pure core
 * to Prisma, the fail-closed limiter the public page uses, the metering of
 * one use (services/useMeteringProduction.ts) and agent chat itself.
 *
 * The chat core gets its production deps with ONE of them replaced:
 * `beginMetering` is the use's own, bound to the buyer's licence, in place
 * of the copy path's lookup. Nothing else about the chat differs.
 *
 * Building it connects to nothing; the limiter's Redis opens on the first
 * request.
 */

import { prisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import { prepareAgentChat, type AgentChatDeps } from "./agentChat.js";
import { latestOwnResults } from "./agentOwnSchedule.js";
import { peekApiKeySpend, type ApiKeySpendReadDb } from "./apiKeySpend.js";
import { buildAgentChatDeps } from "./buildAgentChatDeps.js";
import { productionPublicChatDeps, publicChatLimiter } from "./buildPublicChatDeps.js";
import { PAID_USE_LIMITS, type PaidAgent, type PaidUseDeps } from "./paidUse.js";
import { getDefaultRegistry } from "./skills/production.js";
import { USE_LISTING_COLUMNS } from "./useListing.js";
import { beginUseMetering } from "./useMeteringProduction.js";

const logger = createLogger("paid-use");

/** What a paid use reads of the creator's agent. None of it is sent to a buyer but the kind. */
export const PAID_AGENT_COLUMNS = {
  id: true,
  orgId: true,
  name: true,
  agentKind: true,
  kindConfig: true,
  entrypoint: true,
  isPublic: true,
  publicResults: true,
  systemPrompt: true,
  tools: true,
  pageKey: { select: { id: true, storeTranscripts: true } },
} as const;

/**
 * What a paid use reads of the buyer's subscription row. The count of a plan
 * is part of it: a row read without `includedUses` would read as a month
 * with no count (every answer free), and one read without its plan's status
 * would give a plan its creator ended days of grace. A test holds the list.
 */
export const USE_SUBSCRIPTION_COLUMNS = {
  status: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  endReason: true,
  priceCents: true,
  id: true,
  planId: true,
  currentPeriodStart: true,
  includedUses: true,
  usedInPeriod: true,
  carriedUses: true,
  extraUsePriceCents: true,
  plan: { select: { status: true } },
} as const;

/** The row as the paid service reads it: the plan's status becomes `planRetired`. */
export function useSubscriptionOf<Row extends { plan: { status: string } | null }>(
  sub: Row,
): Omit<Row, "plan"> & { planRetired: boolean } {
  const { plan, ...row } = sub;
  // A plan its creator ended is not renewed: no days of grace after the period.
  return { ...row, planRetired: plan?.status === "retired" };
}

let chatDeps: AgentChatDeps | null = null;

export function buildPaidUseDeps(): PaidUseDeps {
  return {
    limiter: publicChatLimiter,
    limits: PAID_USE_LIMITS,

    // The handle IS the lookup: there is no caller organization to scope
    // by. The agent is then run scoped to its own organization.
    loadAgentByHandle: (handle): Promise<PaidAgent | null> =>
      prisma.agent.findUnique({ where: { publicHandle: handle }, select: PAID_AGENT_COLUMNS }),

    // An agent has at most one listing. Read in any state: a paid month
    // outlives a listing that stopped selling.
    loadListing: (agentId) => prisma.agentListing.findUnique({ where: { agentId }, select: USE_LISTING_COLUMNS }),

    loadLicence: async ({ listingId, buyerId }) => {
      const [licence, sub] = await Promise.all([
        prisma.agentInstall.findUnique({
          where: { listingId_buyerId: { listingId, buyerId } },
          select: {
            id: true,
            buyerId: true,
            kind: true,
            status: true,
            acceptedPricingModel: true,
            acceptedPricePerRequestCents: true,
          },
        }),
        prisma.agentSubscription.findUnique({
          where: { listingId_subscriberId: { listingId, subscriberId: buyerId } },
          select: USE_SUBSCRIPTION_COLUMNS,
        }),
      ]);
      return { licence, sub: sub && useSubscriptionOf(sub) };
    },

    readBalance: async (orgId) =>
      (await prisma.creditBalance.findUnique({ where: { orgId }, select: { balanceCents: true } }))?.balanceCents ?? 0n,

    peekKeySpend: (args) => peekApiKeySpend(prisma as unknown as ApiKeySpendReadDb, { ...args, cap: "use" }),

    outboundToolNames: () =>
      getDefaultRegistry()
        .list()
        .filter((skill) => skill.sendsOutbound === true)
        .map((skill) => skill.key),

    beginUse: (args) => beginUseMetering(args),

    prepareChat: (input, beginMetering) =>
      prepareAgentChat(input, {
        // A public caller brings no functions of its own, so there is no
        // hand-back to resume and no continuation store to open.
        ...(chatDeps ??= buildAgentChatDeps({ continuations: false })),
        beginMetering,
      }),

    // The public page's own writer: a kept copy of a paid use is filed as
    // a kept copy of a free one is, in the creator's organization.
    writeTranscript: (transcript) =>
      productionPublicChatDeps().writeTranscript?.(transcript) ?? Promise.resolve(),

    latestResults: (args) => latestOwnResults(prisma as never, args),

    memberRole: async (orgId, userId) =>
      (await prisma.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { role: true } }))?.role ??
      null,

    logger,
  };
}

let production: PaidUseDeps | null = null;

/** The one set of paid-use deps of this process: the /api/a routes and /v1 share its limits and counters. */
export function productionPaidUseDeps(): PaidUseDeps {
  return (production ??= buildPaidUseDeps());
}
