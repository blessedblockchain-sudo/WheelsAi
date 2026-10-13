/**
 * A listing's free trial, as a buyer may take it.
 *
 * A creator can switch on one free trial for a listing that sells use per
 * request (services/listingPlans.ts): some uses, for 7 days, at no price. A
 * buyer's organization starts it once per listing, ever. It never renews,
 * never charges and has no days of grace; when it is over the buyer chooses
 * a plan or pay per use.
 *
 * This is NOT "Try it" (the few free messages a day anyone gets on a
 * listing's page: `trial` and `trialFundedDailyCap` on a listing,
 * services/trialSession.ts, services/trialFunding.ts). A free trial here is
 * a plan a buyer's organization starts, counted on their own row.
 *
 * Who may start one (judgeTrial): the listing offers a trial now, the
 * organization never started one on this listing, it has no plan or paid
 * month running on it, and it has added credits at least once. The last
 * rule is what keeps a trial from being free use for ever through new
 * accounts: signing up costs nothing, and a trial runs at the creator's
 * cost.
 *
 * The same judgement answers `trialAvailable` on a buyer's access
 * (services/paidUse.ts) and decides a start (startTrial), so the page never
 * offers a trial the start would refuse.
 *
 * A free trial moves no money: nothing is charged at its start, on a use or
 * at its end, and no revenue row, credit transaction or earnings row is
 * written for it anywhere.
 *
 * Pure: every read and the one write are handed in, and nothing imported
 * here reads the environment or the database. The production wiring is in
 * services/planStart.ts, which also shares what any start checks.
 */
import { samePlanTerms, type PlanTerms } from "./listingPlans.js";
import { copyMonthBlockingUse, useAccess, type UseSubscription } from "./useAccess.js";

// ============================================
// Credits added
// ============================================

/**
 * The types of a row of credit_transactions that say the organization added
 * credits it paid for. There is one: "purchase", written by grantCredits
 * (services/creditGrant.ts) for every way of paying:
 *
 *   a card            services/stripe/stripeWebhook.ts
 *   a wallet payment  services/walletTopup.ts
 *   a deposit         services/depositCredit.ts
 *
 * The only other writer of it is the stand-in for a card on a developer's
 * machine (routes/billing.ts, behind ALLOW_MOCK_CHECKOUT), which is off
 * wherever real money moves.
 *
 * Not among them, on purpose: "bonus" (the credits for verifying an address,
 * services/emailTokens.ts, a bonus on top of a purchase and a grant by an
 * operator, which cost the organization nothing) and "payout_credit"
 * (earnings a creator took as credits, which were not added from outside).
 */
export const CREDITS_ADDED_LEDGER_TYPES = ["purchase"] as const;

/** What the read of "has added credits" needs. Prisma's client satisfies it. */
export interface CreditsAddedDb {
  creditTransaction: {
    findFirst(args: {
      where: { orgId: string; type: { in: string[] }; amountCents: { gt: bigint } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/**
 * Whether the organization has added credits at least once. One row is
 * enough, however long ago and whatever is left of it. Throws when the
 * ledger cannot be read: the callers answer no then, each in its own way.
 */
export async function hasAddedCredits(db: CreditsAddedDb, orgId: string): Promise<boolean> {
  const row = await db.creditTransaction.findFirst({
    where: { orgId, type: { in: [...CREDITS_ADDED_LEDGER_TYPES] }, amountCents: { gt: 0n } },
    select: { id: true },
  });
  return row !== null && row !== undefined;
}

// ============================================
// Who may take the trial
// ============================================

/** Why a buyer's organization cannot start the trial now. */
export type TrialRefusalReason =
  /** The listing offers no trial now. */
  | "not_offered"
  /** The organization started one on this listing before. */
  | "trial_already_used"
  /** A plan, a paid month or the trial itself is running. */
  | "already_on_plan"
  /** The only thing missing: credits added at least once. */
  | "trial_needs_credits";

export type TrialStanding = { available: true } | { available: false; reason: TrialRefusalReason };

/**
 * Whether a buyer's organization may start a listing's trial, from four
 * facts. In this order, so that "add credits" is said only to an
 * organization for which it is the one thing missing.
 */
export function judgeTrial(facts: {
  /** The listing offers a trial now. */
  offered: boolean;
  /** The organization's row for the listing says a trial was started before. */
  used: boolean;
  /** Their row gives access now: a plan, a paid month, or a trial. */
  running: boolean;
  /** They added credits they paid for at least once. */
  addedCredits: boolean;
}): TrialStanding {
  if (!facts.offered) return { available: false, reason: "not_offered" };
  if (facts.used) return { available: false, reason: "trial_already_used" };
  if (facts.running) return { available: false, reason: "already_on_plan" };
  if (!facts.addedCredits) return { available: false, reason: "trial_needs_credits" };
  return { available: true };
}

/**
 * Whether a subscription row says its holder started the listing's trial
 * before. Only a row that says "never" (null) has not: a row read without
 * the column counts as used, so a reader that forgot it offers no trial.
 */
export function trialUsed(sub: { trialUsedAt?: Date | null } | null | undefined): boolean {
  return sub != null && sub.trialUsedAt !== null;
}

// ============================================
// Starting it
// ============================================

export const TRIAL_START_MESSAGES = {
  alreadyUsed: "You have already used the free trial of this agent. Choose a plan or pay per use to keep using it.",
  needsCredits: "Add credits to your account once to start a free trial. The trial itself costs nothing.",
} as const;

/**
 * This buyer's organization started the free trial of this listing before.
 * Nothing was written. Also thrown by the claim itself
 * (services/marketplaceSubscriptions.ts, startTrialSubscription) when the
 * row it reads says so.
 */
export class TrialAlreadyUsedError extends Error {
  readonly code = "trial_already_used";
  constructor() {
    super(TRIAL_START_MESSAGES.alreadyUsed);
    this.name = "TrialAlreadyUsedError";
  }
}

/** The organization never added credits. Nothing was written. */
export class TrialNeedsCreditsError extends Error {
  readonly code = "trial_needs_credits";
  constructor() {
    super(TRIAL_START_MESSAGES.needsCredits);
    this.name = "TrialNeedsCreditsError";
  }
}

/** The listing as a trial start reads it. */
export interface TrialListing {
  id: string;
  status: string;
  sells: string;
  pricingModel: string;
  pricePerRequestCents?: bigint | null;
}

/** A row of listing_plans as a start reads it by the id that was sent. */
export interface TrialPlanRow {
  id: string;
  listingId: string;
  kind: string;
  status: string;
  priceCents: bigint;
  includedUses: number;
  extraUsePriceCents: bigint | null;
}

/** The buyer's licence row for the listing. */
export interface TrialLicence {
  id: string;
  kind: string;
  status: string;
  clonedAgentId: string | null;
  acceptedPricingModel: string | null;
  acceptedPricePerRequestCents: bigint | null;
}

/** Their subscription row for it: what access reads, and whether a trial was started before. */
export type TrialSubscription = UseSubscription & { trialUsedAt?: Date | null };

/** A start that was refused by the buyer's own rows. Nothing was written. */
export type TrialStartRefusal =
  | { reason: "trial_already_used" }
  | { reason: "trial_needs_credits" }
  | { reason: "already_on_plan" }
  /** The organization holds a copy of this agent with a month paid for (services/useAccess.ts). */
  | { reason: "copy_subscription_active"; until: Date }
  /** A read failed: nobody is given a trial on a guess. */
  | { reason: "service_unavailable" };

export interface TrialStartDeps {
  /** The buyer's licence row for the listing and their subscription row, or null for each. */
  loadLicence(): Promise<{ licence: TrialLicence | null; sub: TrialSubscription | null }>;
  /** hasAddedCredits for the buyer's organization. */
  addedCredits(): Promise<boolean>;
  /** The error a start answers when the terms are not what was shown, carrying what the listing offers now. */
  termsChanged(): Promise<Error>;
  /** Throws the refusals of an agent that cannot answer right now (a pause, a graph). */
  refuseIfItCannotAnswer(): Promise<void>;
  /**
   * The one write, in one transaction: the trial compared again as it is
   * offered there, the licence claimed and written, the subscription row
   * claimed (startTrialSubscription), the listing's counters. Answers the
   * subscription's id. Throws when another request got there first.
   */
  claim(args: { licence: TrialLicence | null; now: Date }): Promise<string>;
  now?: () => Date;
  logger?: { warn(obj: unknown, msg: string): void };
}

/** Whether `plan` is this listing's free trial, on offer, on the terms that were shown. */
export function isTrialAsShown(listing: TrialListing, plan: TrialPlanRow | null, shown: PlanTerms): boolean {
  return (
    listing.status === "published" &&
    listing.sells === "use" &&
    listing.pricingModel === "per_request" &&
    plan !== null &&
    plan.listingId === listing.id &&
    plan.kind === "trial" &&
    samePlanTerms(shown, plan)
  );
}

/**
 * Start the listing's free trial for a buyer's organization. `shown` is the
 * trial's own terms as the person was shown them (its id, a price of 0, its
 * uses, no extra price), compared as a paid plan's are.
 *
 * The caller has already refused what any start refuses about the listing
 * (not on sale, the caller's own agent, a listing that sells copies). From
 * there, in this order, each with nothing written:
 *
 *   the terms are not the trial as it is now   throws deps.termsChanged()
 *   a copy with a month paid for               copy_subscription_active
 *   a trial was started before                 trial_already_used
 *   a plan, a month or the trial runs          already_on_plan
 *   credits were never added                   trial_needs_credits
 *   the agent cannot answer right now          throws from deps.refuseIfItCannotAnswer()
 *
 * A read that fails refuses (service_unavailable). Then deps.claim writes.
 * These checks only word the refusal: the claim reads the rows again and is
 * what holds a trial to one start under two requests at once.
 */
export async function startTrial(
  args: { listing: TrialListing; trial: TrialPlanRow | null; shown: PlanTerms },
  deps: TrialStartDeps,
): Promise<{ started: true; subscriptionId: string } | { started: false; refusal: TrialStartRefusal }> {
  const { listing } = args;
  const now = (deps.now ?? (() => new Date()))();
  const refuse = (refusal: TrialStartRefusal) => ({ started: false as const, refusal });

  if (!isTrialAsShown(listing, args.trial, args.shown)) throw await deps.termsChanged();

  let licence: TrialLicence | null;
  let sub: TrialSubscription | null;
  try {
    ({ licence, sub } = await deps.loadLicence());
  } catch (err) {
    deps.logger?.warn({ err, listingId: listing.id }, "Could not read a buyer's rows for a free trial; nothing was started");
    return refuse({ reason: "service_unavailable" });
  }

  const copyPaidUntil = copyMonthBlockingUse(licence, sub, now);
  if (copyPaidUntil) return refuse({ reason: "copy_subscription_active", until: copyPaidUntil });

  const running =
    useAccess(
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
        sub,
      },
      now,
    ) === "subscribed";

  let addedCredits = false;
  // Asked only when it decides: a buyer who is refused for another reason is told that reason.
  if (!trialUsed(sub) && !running) {
    try {
      addedCredits = await deps.addedCredits();
    } catch (err) {
      deps.logger?.warn({ err, listingId: listing.id }, "Could not read whether credits were added; no free trial was started");
      return refuse({ reason: "service_unavailable" });
    }
  }
  const standing = judgeTrial({ offered: true, used: trialUsed(sub), running, addedCredits });
  if (!standing.available) {
    // "not_offered" cannot be the answer here: the terms were compared above.
    return refuse({ reason: standing.reason === "not_offered" ? "service_unavailable" : standing.reason });
  }

  await deps.refuseIfItCannotAnswer();

  return { started: true, subscriptionId: await deps.claim({ licence, now }) };
}
