/**
 * Marketplace per-request metering (W2 money keystone) — the money-IN
 * half of the marketplace loop whose money-OUT half (payout executor) is
 * already proven on devnet.
 *
 * Before this existed, `recordMarketplaceUsage` had ZERO callers and, had
 * anything called it, it would have FABRICATED money: it created a
 * `settled` revenue row and incremented the publisher's pendingPayoutCents
 * without ever debiting the buyer. The platform would then owe creators
 * real payouts against revenue it never collected. That function is gone;
 * this module replaces it.
 *
 * The shape is the reservation pattern the rest of this codebase already
 * uses (deployment credit gate, payout executor):
 *
 *   charge  — conditional debit of the buyer's credit balance
 *             (`WHERE balanceCents >= gross`, so concurrent requests
 *             against a balance that covers one of them cannot both
 *             pass) + a `pending` MarketplaceRevenue row + a ledger row
 *             referencing it. Runs BEFORE the agent executes: a buyer
 *             with no balance is refused, not served for free.
 *   settle  — CAS pending → settled, then accrue the creator's share and
 *             bump the delivered-request counters. Only delivered
 *             requests count, and the publisher's pending payout only
 *             ever grows by money actually taken from a buyer.
 *   refund  — CAS pending → refunded, then credit the buyer back. Runs
 *             when execution throws, so a failed inference is not billed.
 *
 * Exactly-once comes from the status CAS: two concurrent completions of
 * the same charge settle (or refund) once, never twice.
 *
 * Recovery: if `settle` fails after `charge` committed, the row stays
 * `pending` — the buyer is debited and the creator is not yet credited.
 * That is a visible, queryable state (`status = 'pending'` with a
 * settled_at of null), not a silent loss, and it is the reason settle is
 * never allowed to fail the buyer's HTTP response: they got their answer
 * and paid for it.
 *
 * The prisma surfaces are structural stubs (the deploymentCreditGate
 * precedent) so every path here is unit-testable without a database.
 */
import { subscriptionGrantsAccess } from "./subscriptionAccess.js";
import { orgHoldsToken, tokenRequiredMessage, type TokenAccessDb } from "./tokenAccess.js";

/** Platform's cut in basis points. Mirrors PLATFORM_FEE_SHARE = 0.1. */
export const PLATFORM_FEE_BPS = 1000n;

/**
 * Uninstalling ends the licence, and the clone stops working.
 *
 * Without this, per-request billing had a one-click bypass: `uninstall`
 * flipped the install row to `uninstalled` but left the cloned agent —
 * the publisher's system prompt, tools and source — fully runnable in the
 * buyer's org. Metering keys on an ACTIVE install, so the cheapest way to
 * use a paid agent forever would have been to stop paying for it.
 */
export type RevocationReason = "uninstalled" | "subscription_lapsed" | "token_required";

export interface GateToken {
  symbol: string;
  mintAddress: string;
}

/** What the buyer is told when a marketplace clone refuses to run. */
export function licenceRevokedMessage(
  listingTitle: string,
  reason: RevocationReason = "uninstalled",
  token?: GateToken,
): string {
  if (reason === "subscription_lapsed") {
    return `"${listingTitle}" is a monthly subscription that is not paid up. Resubscribe from Installed Agents to use it again.`;
  }
  if (reason === "token_required" && token) {
    return tokenRequiredMessage(listingTitle, token);
  }
  return `This agent came from the marketplace listing "${listingTitle}" and stopped working when you uninstalled it. Reinstall it to use it again.`;
}

export class MarketplaceLicenceRevokedError extends Error {
  readonly listingTitle: string;
  readonly reason: RevocationReason;
  readonly token?: GateToken;

  constructor(listingTitle: string, reason: RevocationReason = "uninstalled", token?: GateToken) {
    super(licenceRevokedMessage(listingTitle, reason, token));
    this.name = "MarketplaceLicenceRevokedError";
    this.listingTitle = listingTitle;
    this.reason = reason;
    this.token = token;
  }
}

export class MarketplacePaymentRequiredError extends Error {
  readonly requiredCents: bigint;
  readonly balanceCents: bigint;
  readonly listingTitle: string;

  constructor(args: {
    requiredCents: bigint;
    balanceCents: bigint;
    listingTitle: string;
  }) {
    super(
      `This agent is billed per request by its publisher (${(
        Number(args.requiredCents) / 100
      ).toFixed(4)} USD per request). Your credit balance is ${(
        Number(args.balanceCents) / 100
      ).toFixed(2)} USD — top up to keep using it.`,
    );
    this.name = "MarketplacePaymentRequiredError";
    this.requiredCents = args.requiredCents;
    this.balanceCents = args.balanceCents;
    this.listingTitle = args.listingTitle;
  }
}

// ============================================
// Resolution
// ============================================

export interface MeteredInstall {
  installId: string;
  listingId: string;
  listingTitle: string;
  publisherId: string;
  buyerId: string;
  pricePerRequestCents: bigint;
}

export interface MeteringLookupPrisma {
  agentInstall: {
    findFirst(args: {
      where: { clonedAgentId: string; buyerId: string };
      select: {
        id: true;
        listingId: true;
        buyerId: true;
        status: true;
        listing: {
          select: {
            title: true;
            status: true;
            publisherId: true;
            pricingModel: true;
            pricePerRequestCents: true;
            agentToken: { select: { id: true; symbol: true; mintAddress: true } };
          };
        };
      };
    }): Promise<{
      id: string;
      listingId: string;
      buyerId: string;
      status: string;
      listing: {
        title: string;
        status: string;
        publisherId: string;
        pricingModel: string;
        pricePerRequestCents: bigint | null;
        agentToken?: { id: string; symbol: string; mintAddress: string } | null;
      };
    } | null>;
  };
  /** Token-gated listings; absent = fail closed once a token exists. */
  orgMember?: TokenAccessDb["orgMember"];
  agentTokenHolder?: TokenAccessDb["agentTokenHolder"];
  agentSubscription?: {
    findUnique(args: {
      where: { listingId_subscriberId: { listingId: string; subscriberId: string } };
      select: { status: true; currentPeriodEnd: true; cancelAtPeriodEnd: true };
    }): Promise<{ status: string; currentPeriodEnd: Date; cancelAtPeriodEnd: boolean } | null>;
  };
}

export type InstallBilling =
  /** Not a marketplace clone, or licensed and free to run. */
  | { kind: "free" }
  /** Licence ended — the clone must refuse to run. */
  | { kind: "revoked"; listingTitle: string; reason: RevocationReason; token?: GateToken }
  | { kind: "billable"; install: MeteredInstall };

/**
 * What does running this agent cost, and is it allowed to run at all?
 *
 * The lookup is keyed on `clonedAgentId` — the copy that lives in the
 * BUYER's org. The publisher's own original agent has no install row
 * pointing at it, so publishers are never billed for running their own
 * work.
 *
 * `free` covers: not an install at all, a free listing, a paid-up
 * monthly subscription, a token-gated listing the buyer org holds the
 * token for (or whose token has not launched yet), a zero price, and a
 * listing that is no longer published (a publisher who archives a
 * listing stops charging for it — existing buyers keep what they
 * installed).
 */
export async function resolveInstallBilling(
  db: MeteringLookupPrisma,
  args: { agentId: string; orgId: string },
): Promise<InstallBilling> {
  const install = await db.agentInstall.findFirst({
    where: {
      clonedAgentId: args.agentId,
      buyerId: args.orgId,
    },
    select: {
      id: true,
      listingId: true,
      buyerId: true,
      status: true,
      listing: {
        select: {
          title: true,
          status: true,
          publisherId: true,
          pricingModel: true,
          pricePerRequestCents: true,
          agentToken: { select: { id: true, symbol: true, mintAddress: true } },
        },
      },
    },
  });

  if (!install) return { kind: "free" };
  if (install.status !== "active") {
    return {
      kind: "revoked",
      listingTitle: install.listing.title,
      // A suspended install is a lapsed monthly subscription.
      reason: install.status === "suspended" ? "subscription_lapsed" : "uninstalled",
    };
  }
  if (install.listing.status !== "published") return { kind: "free" };
  // Monthly: runs only while its subscription is paid up (or in grace).
  if (install.listing.pricingModel === "monthly") {
    const sub = db.agentSubscription
      ? await db.agentSubscription.findUnique({
          where: { listingId_subscriberId: { listingId: install.listingId, subscriberId: install.buyerId } },
          select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
        })
      : null;
    return subscriptionGrantsAccess(sub)
      ? { kind: "free" }
      : { kind: "revoked", listingTitle: install.listing.title, reason: "subscription_lapsed" };
  }
  // Tokenized: free until the token launches, then only for orgs whose
  // members hold it.
  if (install.listing.pricingModel === "tokenized") {
    const token = install.listing.agentToken;
    if (!token) return { kind: "free" };
    const holds =
      db.orgMember && db.agentTokenHolder
        ? await orgHoldsToken(
            { orgMember: db.orgMember, agentTokenHolder: db.agentTokenHolder },
            { orgId: install.buyerId, tokenId: token.id },
          )
        : false;
    return holds
      ? { kind: "free" }
      : {
          kind: "revoked",
          listingTitle: install.listing.title,
          reason: "token_required",
          token: { symbol: token.symbol, mintAddress: token.mintAddress },
        };
  }
  if (install.listing.pricingModel !== "per_request") return { kind: "free" };

  const price = install.listing.pricePerRequestCents ?? 0n;
  if (price <= 0n) return { kind: "free" };

  return {
    kind: "billable",
    install: {
      installId: install.id,
      listingId: install.listingId,
      listingTitle: install.listing.title,
      publisherId: install.listing.publisherId,
      buyerId: install.buyerId,
      pricePerRequestCents: price,
    },
  };
}

// ============================================
// Split
// ============================================

export interface RevenueSplit {
  grossCents: bigint;
  platformFeeCents: bigint;
  creatorCents: bigint;
}

/**
 * Integer split, round-half-up on the platform fee with the creator
 * taking the remainder — so platformFee + creator === gross exactly, at
 * every price, with no float drift.
 */
export function splitRevenue(
  pricePerRequestCents: bigint,
  requestCount: number,
): RevenueSplit {
  const count = BigInt(Math.max(1, Math.trunc(requestCount)));
  const grossCents = pricePerRequestCents * count;
  const platformFeeCents =
    (grossCents * PLATFORM_FEE_BPS + 5000n) / 10000n;
  return {
    grossCents,
    platformFeeCents,
    creatorCents: grossCents - platformFeeCents,
  };
}

// ============================================
// Charge
// ============================================

export interface MeteringChargePrisma {
  creditBalance: {
    updateMany(args: {
      where: { orgId: string; balanceCents: { gte: bigint } };
      data: { balanceCents: { decrement: bigint } };
    }): Promise<{ count: number }>;
    findUnique(args: {
      where: { orgId: string };
    }): Promise<{ balanceCents: bigint } | null>;
  };
  creditTransaction: {
    create(args: {
      data: {
        orgId: string;
        amountCents: bigint;
        type: string;
        description: string;
        referenceId: string;
        balanceAfter: bigint;
      };
    }): Promise<unknown>;
  };
  marketplaceRevenue: {
    create(args: {
      data: {
        listingId: string;
        installId: string;
        buyerId: string;
        publisherId: string;
        type: string;
        grossAmountCents: bigint;
        platformFeeCents: bigint;
        creatorAmountCents: bigint;
        requestCount: number;
        status: string;
      };
    }): Promise<{ id: string }>;
  };
}

export interface MarketplaceCharge extends RevenueSplit {
  revenueId: string;
  install: MeteredInstall;
  requestCount: number;
}

export type ChargeResult =
  | { ok: true; charge: MarketplaceCharge }
  | { ok: false; reason: "insufficient_credits"; requiredCents: bigint; balanceCents: bigint };

/**
 * Take the buyer's money and open a pending revenue row. Run INSIDE a
 * prisma.$transaction: the debit, the ledger entry, and the revenue row
 * must commit together or a crash leaves money debited with nothing
 * explaining it.
 */
export async function chargeMarketplaceRequest(
  tx: MeteringChargePrisma,
  args: { install: MeteredInstall; requestCount?: number },
): Promise<ChargeResult> {
  const requestCount = Math.max(1, Math.trunc(args.requestCount ?? 1));
  const split = splitRevenue(args.install.pricePerRequestCents, requestCount);

  const claimed = await tx.creditBalance.updateMany({
    where: {
      orgId: args.install.buyerId,
      balanceCents: { gte: split.grossCents },
    },
    data: { balanceCents: { decrement: split.grossCents } },
  });

  if (claimed.count === 0) {
    const current = await tx.creditBalance.findUnique({
      where: { orgId: args.install.buyerId },
    });
    return {
      ok: false,
      reason: "insufficient_credits",
      requiredCents: split.grossCents,
      balanceCents: current?.balanceCents ?? 0n,
    };
  }

  const revenue = await tx.marketplaceRevenue.create({
    data: {
      listingId: args.install.listingId,
      installId: args.install.installId,
      buyerId: args.install.buyerId,
      publisherId: args.install.publisherId,
      type: "per_request",
      grossAmountCents: split.grossCents,
      platformFeeCents: split.platformFeeCents,
      creatorAmountCents: split.creatorCents,
      requestCount,
      // NOT settled: the buyer has paid, the creator has not been
      // credited, and the agent has not run yet.
      status: "pending",
    },
  });

  const after = await tx.creditBalance.findUnique({
    where: { orgId: args.install.buyerId },
  });

  await tx.creditTransaction.create({
    data: {
      orgId: args.install.buyerId,
      amountCents: -split.grossCents,
      type: "marketplace_usage",
      description: `Marketplace request — ${args.install.listingTitle}`,
      // The revenue row, so a buyer's debit and the creator's credit are
      // correlatable from either side.
      referenceId: revenue.id,
      balanceAfter: after?.balanceCents ?? 0n,
    },
  });

  return {
    ok: true,
    charge: {
      ...split,
      revenueId: revenue.id,
      install: args.install,
      requestCount,
    },
  };
}

// ============================================
// Settle / refund
// ============================================

export interface MeteringSettlePrisma {
  marketplaceRevenue: {
    updateMany(args: {
      where: { id: string; status: string };
      data: { status: string; settledAt?: Date };
    }): Promise<{ count: number }>;
  };
  publisherProfile: {
    update(args: {
      where: { orgId: string };
      data: {
        totalRevenueCents: { increment: bigint };
        pendingPayoutCents: { increment: bigint };
      };
    }): Promise<unknown>;
  };
  agentInstall: {
    update(args: {
      where: { id: string };
      data: {
        totalRequests: { increment: bigint };
        totalSpentCents: { increment: bigint };
      };
    }): Promise<unknown>;
  };
  agentListing: {
    update(args: {
      where: { id: string };
      data: { totalRequests: { increment: bigint } };
    }): Promise<unknown>;
  };
}

export type SettleResult =
  | { settled: true; creatorCents: bigint }
  | { settled: false; reason: "not_pending" };

/**
 * Turn a paid-for, delivered request into creator earnings. Run INSIDE a
 * prisma.$transaction.
 *
 * The CAS (`updateMany where {id, status:"pending"}`) is the exactly-once
 * barrier — a settle that races a refund, or two settles of the same
 * charge, credit the publisher once. Counters move here rather than at
 * charge time so `totalRequests` counts delivered requests only.
 */
export async function settleMarketplaceRequest(
  tx: MeteringSettlePrisma,
  args: { charge: MarketplaceCharge; now?: () => Date },
): Promise<SettleResult> {
  const now = (args.now ?? (() => new Date()))();

  const claimed = await tx.marketplaceRevenue.updateMany({
    where: { id: args.charge.revenueId, status: "pending" },
    data: { status: "settled", settledAt: now },
  });
  if (claimed.count === 0) {
    return { settled: false, reason: "not_pending" };
  }

  await tx.publisherProfile.update({
    where: { orgId: args.charge.install.publisherId },
    data: {
      totalRevenueCents: { increment: args.charge.creatorCents },
      pendingPayoutCents: { increment: args.charge.creatorCents },
    },
  });

  await tx.agentInstall.update({
    where: { id: args.charge.install.installId },
    data: {
      totalRequests: { increment: BigInt(args.charge.requestCount) },
      totalSpentCents: { increment: args.charge.grossCents },
    },
  });

  await tx.agentListing.update({
    where: { id: args.charge.install.listingId },
    data: { totalRequests: { increment: BigInt(args.charge.requestCount) } },
  });

  return { settled: true, creatorCents: args.charge.creatorCents };
}

export interface MeteringRefundPrisma {
  marketplaceRevenue: MeteringSettlePrisma["marketplaceRevenue"];
  creditBalance: {
    update(args: {
      where: { orgId: string };
      data: { balanceCents: { increment: bigint } };
    }): Promise<{ balanceCents: bigint }>;
  };
  creditTransaction: MeteringChargePrisma["creditTransaction"];
}

export type RefundResult =
  | { refunded: true; amountCents: bigint }
  | { refunded: false; reason: "not_pending" };

/**
 * Give the money back when the agent did not deliver. Run INSIDE a
 * prisma.$transaction.
 *
 * The publisher was never credited (that happens in settle), so there is
 * nothing to claw back from them — a failed request simply never becomes
 * anyone's revenue.
 */
export async function refundMarketplaceRequest(
  tx: MeteringRefundPrisma,
  args: { charge: MarketplaceCharge; reason: string },
): Promise<RefundResult> {
  const claimed = await tx.marketplaceRevenue.updateMany({
    where: { id: args.charge.revenueId, status: "pending" },
    data: { status: "refunded" },
  });
  if (claimed.count === 0) {
    return { refunded: false, reason: "not_pending" };
  }

  const after = await tx.creditBalance.update({
    where: { orgId: args.charge.install.buyerId },
    data: { balanceCents: { increment: args.charge.grossCents } },
  });

  await tx.creditTransaction.create({
    data: {
      orgId: args.charge.install.buyerId,
      amountCents: args.charge.grossCents,
      type: "marketplace_refund",
      description: `Marketplace request refunded — ${args.charge.install.listingTitle} (${args.reason})`,
      referenceId: args.charge.revenueId,
      balanceAfter: after.balanceCents,
    },
  });

  return { refunded: true, amountCents: args.charge.grossCents };
}
