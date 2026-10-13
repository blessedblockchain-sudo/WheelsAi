/**
 * What one paid use of a creator's agent costs, and the charge for it.
 *
 * A buyer who pays to use an agent holds a licence (AgentInstall, kind
 * "use") and no copy. This module decides, from the licence, its access
 * (services/useAccess.ts) and the listing, what one use is:
 *
 *   free        a free use listing. Anyone may use it; no licence is needed
 *   subscribed  inside a paid month: it runs and nothing is charged
 *   plan        inside a paid plan: the terms the buyer agreed to, as the
 *               subscription row holds them. Whether this use is one of the
 *               included ones is decided where one is taken
 *               (services/planUse.ts), not here. A free trial is a plan
 *               too: its own uses cost nothing, and a use past them is
 *               charged only to a buyer who agreed to the price per use
 *               themselves, at the price and by the rule of `billable`
 *   refused     with the reason, the status and what the caller is told
 *   billable    per use, at the listing's price, which is never above the
 *               price the buyer accepted
 *
 * Only per use is billable, and the caller's own listing never is.
 *
 * The money itself moves through services/marketplaceMetering.ts, the same
 * functions a metered copy uses, so a paid use is a per_request revenue row
 * with one marketplace_usage ledger line, settled exactly once when the
 * answer is delivered or refunded exactly once in every other ending:
 *
 *   chargeUse  ONE transaction: the debit, the pending revenue row and its
 *              ledger line, then, when an API key pays, the key's spend
 *              reservation. A refused reservation rolls the debit back, so
 *              there is no debit, no row and no ledger line.
 *   settleUse  pending -> settled, with the model cost the run noted.
 *   refundUse  pending -> refunded.
 *
 * Pure over the injected transaction runner.
 */
import { ApiKeyUseCapError, reserveApiKeySpend, type ApiKeySpendTx } from "./apiKeySpend.js";
import {
  chargeMarketplaceRequest,
  refundMarketplaceRequest,
  settleMarketplaceRequest,
  type MarketplaceCharge,
  type MeteredInstall,
  type MeteringChargePrisma,
  type MeteringRefundPrisma,
  type MeteringSettlePrisma,
  type RefundResult,
  type SettleResult,
} from "./marketplaceMetering.js";
import { onTrialPlan } from "./listingPlans.js";
import { onPlan, useAccess, useDecision, type UseAccess, type UseSubscription } from "./useAccess.js";

/** What one use is called where the buyer reads it: a chat message, or a task run. */
export type UseUnit = "message" | "run";

const dollars = (cents: bigint) => `$${(Number(cents) / 100).toFixed(2)}`;

// ============================================
// Resolution
// ============================================

export interface UseBillingListing {
  id: string;
  title: string;
  /** The creator's organization. */
  publisherId: string;
  status: string;
  sells: string;
  pricingModel: string;
  pricePerRequestCents?: bigint | null;
  /** Only read to word a refusal. */
  monthlyPriceCents?: bigint | null;
}

export interface UseBillingLicence {
  id: string;
  buyerId: string;
  kind: string;
  status: string;
  acceptedPricingModel?: string | null;
  acceptedPricePerRequestCents?: bigint | null;
}

/**
 * The subscription as a use reads it. `priceCents` is what the row was
 * agreed at: with the count it tells a free trial from a paid plan
 * (services/listingPlans.ts, onTrialPlan). A row read without it is a paid
 * plan, which is charged nothing it did not agree to.
 */
export type UseBillingSubscription = UseSubscription & { priceCents?: bigint | null };

export interface UseBillingInput {
  /** The organization that is asking, and that would pay. */
  callerOrgId: string;
  listing: UseBillingListing;
  /** The caller's licence row for this listing, or null. */
  licence: UseBillingLicence | null;
  /** The caller's subscription to this listing, or null. */
  sub: UseBillingSubscription | null;
  /** Words the refusals: "per message" or "per run". Default "message". */
  unit?: UseUnit;
}

export type UseRefusalReason =
  | "own_agent"
  | "not_for_sale"
  | "use_not_started"
  | "pricing_changed"
  | "subscription_lapsed"
  | "plan_ended"
  | "not_offered";

/**
 * The plan a buyer is on, as their subscription row holds it: the terms they
 * agreed to and the count of this period. Never the plan as the creator has
 * it now.
 */
export interface UsePlan {
  /** The subscription row the count is on. */
  subscriptionId: string;
  /** The plan the row was started on. Null on a row that names none. */
  planId: string | null;
  includedUses: number;
  /** Uses taken since `periodStart`, as read. The take decides again. */
  usedInPeriod: number;
  /** Unused uses brought into this period by a move to a bigger plan. */
  carriedUses: number;
  /** What each use past the count costs, as agreed. Null = the plan stops until it renews. */
  extraUsePriceCents: bigint | null;
  /** The period a use is taken from: a use taken in one is never given back into another. */
  periodStart: Date;
  periodEnd: Date;
}

export type UseBilling =
  | { kind: "free" }
  | { kind: "subscribed"; access: "subscribed" }
  | {
      kind: "plan";
      access: "subscribed";
      plan: UsePlan;
      /**
       * The charge target of one use past the count, at the extra price the
       * buyer agreed to, with kind "use". Null when the plan stops, and when
       * the listing no longer sells use: nothing more is sold on it then.
       *
       * On a free trial it is never the row's extra price: it is the
       * listing's price per use, and only for a buyer whose licence agreed
       * to a price per use that covers it. Null for everybody else.
       */
      extraInstall: MeteredInstall | null;
    }
  | {
      kind: "refused";
      reason: UseRefusalReason;
      status: 402 | 403 | 409;
      /** The same word as `reason`: the error code the caller is sent. */
      code: UseRefusalReason;
      /** Plain words for the buyer. */
      message: string;
      /** Absent for own_agent, which is decided before the licence is read. */
      access?: UseAccess;
    }
  | {
      kind: "billable";
      access: "listing_pricing";
      /** What this use costs: the listing's price now, at or below the accepted one. */
      priceCents: bigint;
      /** The charge target, with kind "use". */
      install: MeteredInstall;
    };

function pricingChangedMessage(input: UseBillingInput): string {
  const { listing, licence } = input;
  const unit = input.unit ?? "message";
  if (listing.pricingModel === "per_request") {
    const price = dollars(listing.pricePerRequestCents ?? 0n);
    return licence?.acceptedPricingModel === "per_request" && licence.acceptedPricePerRequestCents != null
      ? `The owner changed the price to ${price} per ${unit}. You agreed to ${dollars(licence.acceptedPricePerRequestCents)}. Nothing is charged until you accept the new price.`
      : `This agent is now sold per ${unit} (${price}). Nothing is charged until you accept the new price.`;
  }
  if (listing.pricingModel === "monthly") {
    return listing.monthlyPriceCents != null
      ? `This agent is now sold by the month (${dollars(listing.monthlyPriceCents)}). Nothing is charged until you subscribe.`
      : "This agent is now sold by the month. Nothing is charged until you subscribe.";
  }
  return "The owner changed how this agent is sold. Nothing is charged until you accept the new terms.";
}

const REFUSAL_MESSAGE: Record<Exclude<UseRefusalReason, "pricing_changed">, string> = {
  own_agent: "This is your own agent, so there is nothing to pay for. Use it from your dashboard.",
  not_for_sale: "Use of this agent is not for sale.",
  use_not_started:
    "You have not started using this agent. Start on its page, or ask an owner or admin of your organization to start.",
  subscription_lapsed: "Your subscription has ended. Subscribe again to keep using it.",
  plan_ended: "Your plan ended. Choose a plan or pay per use to keep using it.",
  not_offered: "This agent is no longer offered. You will not be charged again.",
};

/**
 * What one use by `callerOrgId` is, from the rows as they are now. Decided
 * at each request, so a price the creator raised a second ago is never
 * charged to a buyer who agreed to less.
 */
export function resolveUseBilling(input: UseBillingInput, now: Date = new Date()): UseBilling {
  const { listing } = input;
  // The creator's own organization never pays itself, whatever rows exist.
  if (listing.publisherId === input.callerOrgId) {
    return {
      kind: "refused",
      reason: "own_agent",
      status: 409,
      code: "own_agent",
      message: REFUSAL_MESSAGE.own_agent,
    };
  }
  const onSaleForUse = listing.status === "published" && listing.sells === "use";
  // Free use is the agent's public page: no licence, no charge.
  if (onSaleForUse && listing.pricingModel === "free") return { kind: "free" };

  // A licence that is not this caller's is no licence.
  const licence = input.licence && input.licence.buyerId === input.callerOrgId ? input.licence : null;
  const access = useAccess(
    {
      licence: licence && {
        kind: licence.kind,
        status: licence.status,
        accepted: {
          pricingModel: licence.acceptedPricingModel,
          pricePerRequestCents: licence.acceptedPricePerRequestCents,
        },
      },
      listing,
      sub: licence ? input.sub : null,
    },
    now,
  );
  const decision = useDecision(access, listing);

  if (!decision.runs) {
    // Never started, on something that is not sold for use: there are no
    // terms to show, so it is not "start first".
    const reason: UseRefusalReason = access === "none" && !onSaleForUse ? "not_for_sale" : decision.code;
    return {
      kind: "refused",
      reason,
      status: reason === "not_for_sale" ? 409 : decision.status,
      code: reason,
      message: reason === "pricing_changed" ? pricingChangedMessage(input) : REFUSAL_MESSAGE[reason],
      access,
    };
  }
  if (access === "subscribed") {
    // A month with no count: exactly what it was before plans existed.
    if (!licence || !input.sub || !onPlan(input.sub)) return { kind: "subscribed", access };
    if (onTrialPlan(input.sub)) return trialBilling(input, licence, input.sub, now);
    return planBilling(input.sub, paidPlanExtraInstall(listing, licence, input.sub, onSaleForUse));
  }
  // listing_pricing from here, and so a licence.
  if (!decision.charged || !licence) return { kind: "free" };

  const priceCents = listing.pricePerRequestCents ?? 0n;
  const accepted = licence.acceptedPricePerRequestCents;
  // useAccess has already refused a price above the accepted one. Held
  // again here, where the amount is fixed: a charge above what the buyer
  // agreed to must be impossible, not merely unexpected.
  if (accepted == null || priceCents > accepted) {
    return {
      kind: "refused",
      reason: "pricing_changed",
      status: 409,
      code: "pricing_changed",
      message: pricingChangedMessage(input),
      access: "pricing_changed",
    };
  }
  return {
    kind: "billable",
    access: "listing_pricing",
    priceCents,
    install: {
      installId: licence.id,
      listingId: listing.id,
      listingTitle: listing.title,
      publisherId: listing.publisherId,
      buyerId: licence.buyerId,
      pricePerRequestCents: priceCents,
      kind: "use",
    },
  };
}

/**
 * A use inside a plan. Every term of the plan comes from the subscription
 * row, which copied them when the buyer agreed: a creator who has changed or
 * ended the plan since changes nothing for this buyer. `extraInstall` is
 * what a use past the count is charged on, decided by the caller.
 */
function planBilling(sub: UseSubscription, extraInstall: MeteredInstall | null): UseBilling {
  const { id, currentPeriodStart, includedUses, usedInPeriod, carriedUses } = sub;
  // A use can only be counted on a row that was read with its count. A row
  // read without it would run uncounted, so it does not run at all.
  if (
    id === undefined ||
    currentPeriodStart === undefined ||
    includedUses === null ||
    includedUses === undefined ||
    usedInPeriod === undefined ||
    carriedUses === undefined
  ) {
    throw new Error("resolveUseBilling was given a plan subscription without its id, period start or counts");
  }
  return {
    kind: "plan",
    access: "subscribed",
    plan: {
      subscriptionId: id,
      planId: sub.planId ?? null,
      includedUses,
      usedInPeriod,
      carriedUses,
      extraUsePriceCents: sub.extraUsePriceCents ?? null,
      periodStart: currentPeriodStart,
      periodEnd: sub.currentPeriodEnd,
    },
    extraInstall,
  };
}

/** A paid plan past its count: the extra price on the buyer's row, while the listing still sells use. */
function paidPlanExtraInstall(
  listing: UseBillingListing,
  licence: UseBillingLicence,
  sub: UseSubscription,
  onSaleForUse: boolean,
): MeteredInstall | null {
  const extraUsePriceCents = sub.extraUsePriceCents ?? null;
  return extraUsePriceCents !== null && extraUsePriceCents > 0n && onSaleForUse
    ? {
        installId: licence.id,
        listingId: listing.id,
        listingTitle: listing.title,
        publisherId: listing.publisherId,
        buyerId: licence.buyerId,
        pricePerRequestCents: extraUsePriceCents,
        kind: "use",
      }
    : null;
}

/**
 * A use inside a free trial. Its own uses cost nothing, and the row's extra
 * price, if a row ever carried one, is never read.
 *
 * Past them the trial stops, for everybody but a buyer who agreed to a price
 * per use themselves, on a licence that is active. That buyer goes on per
 * use, and what they are charged is not decided here a second time: it is
 * what this same licence and listing resolve to with no subscription at
 * all. Billable there is the charge target here, at the listing's price,
 * which is never above the price they accepted. A price that changed there
 * is the refusal here once the trial's uses are gone as read; while one is
 * left it only means the trial stops after it. Anything else (the listing
 * is no longer sold, a price of nothing) leaves the trial to stop, uncharged.
 */
function trialBilling(
  input: UseBillingInput,
  licence: UseBillingLicence,
  sub: UseSubscription,
  now: Date,
): UseBilling {
  const agreedPerUse = licence.status === "active" && licence.acceptedPricingModel === "per_request";
  if (!agreedPerUse) return planBilling(sub, null);
  const perUse = resolveUseBilling({ ...input, sub: null }, now);
  if (perUse.kind === "billable") return planBilling(sub, perUse.install);
  const trial = planBilling(sub, null);
  const usedUp = trial.kind === "plan" && trial.plan.usedInPeriod >= trial.plan.includedUses + trial.plan.carriedUses;
  return usedUp && perUse.kind === "refused" && perUse.reason === "pricing_changed" ? perUse : trial;
}

// ============================================
// A use on a plan
// ============================================

/** Why a use on a plan ran nothing: no use was taken and nothing was charged. */
export type UsePlanRefusal =
  | {
      ok: false;
      /** Every use of the period is gone, and the buyer agreed to no extra price. */
      reason: "plan_used_up";
      /** When the count starts again. */
      periodEnd: Date;
      includedUses: number;
      carriedUses: number;
    }
  /** The row changed while it was being decided and could not be decided again. */
  | { ok: false; reason: "plan_changed" };

/** The count of a plan, as the buyer is told it. */
export interface UsePlanCount {
  planId: string | null;
  includedUses: number;
  usedInPeriod: number;
  carriedUses: number;
  extraUsePriceCents: bigint | null;
  periodEnd: Date;
}

/** How one use on a plan was paid for. */
export interface UsePlanUse {
  /** `included`: one of the plan's uses, nothing charged. `extra`: past the count, at the agreed extra price (past a free trial, the price per use the buyer agreed to). */
  use: "included" | "extra";
  /** The subscription row the use was counted on, and the period it was counted in: what a warning is claimed for (services/planWarnings.ts). */
  subscriptionId: string;
  periodStart: Date;
  /** The count as it is now, for the reply. Reads; never throws. */
  count(): Promise<UsePlanCount>;
}

// ============================================
// Charge, settle, refund
// ============================================

/** Everything one charge, settle or refund of a use touches. A Prisma transaction has all of it. */
export type UseMeteringTx = MeteringChargePrisma & ApiKeySpendTx & MeteringSettlePrisma & MeteringRefundPrisma;

export interface UseMeteringDeps {
  /** Runs `fn` in one database transaction; a throw rolls all of it back. */
  transaction<T>(fn: (tx: UseMeteringTx) => Promise<T>): Promise<T>;
  now?: () => Date;
}

export type UseChargeResult =
  | { ok: true; charge: MarketplaceCharge }
  | {
      ok: false;
      reason: "insufficient_credits";
      status: 402;
      code: "insufficient_credits";
      message: string;
      requiredCents: bigint;
      balanceCents: bigint;
    }
  | {
      ok: false;
      reason: "api_key_cap";
      status: 403;
      code: ApiKeyUseCapError["code"];
      message: string;
      extra: Record<string, number>;
    }
  | { ok: false; reason: "own_agent"; status: 409; code: "own_agent"; message: string };

/**
 * Take the price of one use, before it runs. One transaction: the buyer's
 * debit with its pending revenue row and ledger line, and then, when an API
 * key is paying, the key's reservation against its per-use and daily caps.
 * A refused reservation throws inside the transaction, so the debit, the
 * row and the ledger line are rolled back with it.
 *
 * Every `ok: false` leaves nothing behind.
 */
export async function chargeUse(
  deps: UseMeteringDeps,
  args: {
    /** From resolveUseBilling's `billable`. */
    install: MeteredInstall;
    /** The API key that is paying, when one is. A session pays without a reservation. */
    apiKeyId?: string | null;
    unit?: UseUnit;
  },
): Promise<UseChargeResult> {
  const { install } = args;
  if (install.kind !== "use") {
    // A copy is charged by marketplaceMeteringProduction, not here.
    throw new Error("chargeUse was given a licence that is not for use");
  }
  if (install.publisherId === install.buyerId) {
    return { ok: false, reason: "own_agent", status: 409, code: "own_agent", message: REFUSAL_MESSAGE.own_agent };
  }
  try {
    return await deps.transaction(async (tx): Promise<UseChargeResult> => {
      const charged = await chargeMarketplaceRequest(tx, { install });
      if (!charged.ok) {
        return {
          ok: false,
          reason: "insufficient_credits",
          status: 402,
          code: "insufficient_credits",
          message: `You do not have enough credits for this ${args.unit ?? "message"} (${dollars(charged.requiredCents)}). Nothing was charged. Add credits to continue.`,
          requiredCents: charged.requiredCents,
          balanceCents: charged.balanceCents,
        };
      }
      if (args.apiKeyId) {
        await reserveApiKeySpend(tx, {
          apiKeyId: args.apiKeyId,
          orgId: install.buyerId,
          priceCents: charged.charge.grossCents,
          cap: "use",
          now: deps.now?.(),
        });
      }
      return charged;
    });
  } catch (err) {
    if (err instanceof ApiKeyUseCapError) {
      return { ok: false, reason: "api_key_cap", status: 403, code: err.code, message: err.message, extra: err.extra };
    }
    throw err;
  }
}

/**
 * The answer was delivered: the creator is credited, less the whole cents of
 * model cost this use has taken the listing's running total across. A
 * second settle, or a settle after a refund, does nothing.
 */
export function settleUse(
  deps: UseMeteringDeps,
  args: {
    charge: MarketplaceCharge;
    /** What the run cost on the platform's model keys, in millionths of a cent. 0 or absent on the creator's own key. */
    modelCostMicros?: bigint;
  },
): Promise<SettleResult> {
  return deps.transaction((tx) =>
    settleMarketplaceRequest(tx, { charge: args.charge, now: deps.now, modelCostMicros: args.modelCostMicros }),
  );
}

/** No answer was delivered: the buyer gets the price back. A second refund, or a refund after a settle, does nothing. */
export function refundUse(
  deps: UseMeteringDeps,
  args: { charge: MarketplaceCharge; reason: string },
): Promise<RefundResult> {
  return deps.transaction((tx) => refundMarketplaceRequest(tx, { charge: args.charge, reason: args.reason }));
}
