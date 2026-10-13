/**
 * The rules of a plan on a listing.
 *
 * A plan is prepaid uses on top of a listing that sells use per request: a
 * name, a price for 30 days, a number of included uses, and one ending when
 * they run out (the plan stops until it renews, or each extra use has a
 * price). A creator sends the whole set for a listing and it is checked
 * here, before anything is written. A buyer agrees to the exact terms they
 * were shown, and those are compared here with the plan as it is now, before
 * anything is charged.
 *
 * A listing can also offer one free trial: a plan of its own kind that costs
 * nothing, includes a few uses, lasts 7 days and is started once by a buyer's
 * organization (services/trialStart.ts). It is set and ended in the same set
 * as the paid plans and is not one of the four. It is not "Try it", the few
 * free messages a day anyone gets on a listing's page.
 *
 * No plan is unlimited.
 *
 * Pure: no IO.
 */
import { validationFailureFromFields, type ValidationFailureBody } from "../lib/validationFailure.js";
import { MIN_PRICE_PER_USE_CENTS } from "./useListing.js";

// ============================================
// The numbers
// ============================================

/** How many paid plans one listing can offer at a time. */
export const MAX_PAID_PLANS = 4;

/** The longest name of a plan, counted after trimming. */
export const MAX_PLAN_NAME_CHARS = 40;

/** The smallest price of a paid plan for its 30 days, in cents. */
export const MIN_PLAN_PRICE_CENTS = 100n;

/**
 * A paid plan costs at least this much for each use it includes, so $9.00
 * includes at most 900 uses. Included uses that run on the platform's own
 * model keys cost the platform, and nothing repays that yet.
 */
export const MIN_PLAN_CENTS_PER_INCLUDED_USE = 1n;

/** The fewest uses a plan can include. */
export const MIN_INCLUDED_USES = 1;

/**
 * The most uses a plan can include. A buyer on a plan is held to the plan's
 * count and to the uses a minute, not to a number of uses a day
 * (services/paidUse.ts), so the count is what a plan sells. This is also the
 * most the database's check allows. At a cent for each included use such a
 * plan costs at least $1,000.00.
 */
export const MAX_INCLUDED_USES = 100_000;

/**
 * The smallest price of one use past the included ones. It is the floor of
 * any use sold by itself, for the same reason: below it the platform's share
 * rounds to nothing.
 */
export const MIN_EXTRA_USE_PRICE_CENTS = MIN_PRICE_PER_USE_CENTS;

/** The most uses a free trial can include. They run at the creator's cost. */
export const MAX_TRIAL_USES = 50;

/** How many days a free trial lasts from its start. It is never renewed. */
export const TRIAL_DAYS = 7;

/** What a free trial is called. A creator does not name it, and a name that is sent is not kept. */
export const TRIAL_PLAN_NAME = "Free trial";

/** The place of the free trial among a listing's plans. The paid ones hold 1 to 4. */
export const TRIAL_PLAN_POSITION = 0;

/**
 * Whether a buyer's subscription row is a free trial: a row with a count of
 * uses whose agreed price is nothing. A paid plan costs at least
 * MIN_PLAN_PRICE_CENTS, so no paid row reads as one, and a row a paid plan
 * took over stops reading as one with the price it was given.
 */
export function onTrialPlan(
  row: { includedUses?: number | null; priceCents?: bigint | null } | null | undefined,
): boolean {
  return row != null && row.includedUses != null && row.priceCents === 0n;
}

// ============================================
// The set a creator sends
// ============================================

/** One plan as a creator sends it. Cents are whole cents. */
export interface PlanInput {
  /** Set to change a plan in place. Absent for a new plan. */
  id?: string;
  /** "paid", or "trial" for the listing's one free trial. */
  kind: string;
  /** A free trial has no name of its own: whatever is sent for one is not kept. */
  name: string;
  /** What the 30 days cost. 0 for a free trial. */
  priceCents: bigint;
  includedUses: number;
  /** What each use past the included ones costs. Null = the plan stops until it renews. Always null for a free trial. */
  extraUsePriceCents: bigint | null;
}

/** A plan that passed the check: its name trimmed, and its place among the listing's plans. */
export interface CheckedPlan {
  id: string | null;
  kind: "paid" | "trial";
  /** A free trial's is always TRIAL_PLAN_NAME. */
  name: string;
  priceCents: bigint;
  includedUses: number;
  extraUsePriceCents: bigint | null;
  /** A paid plan: 1 to 4, in the order sent, the order a buyer sees them in. The free trial: 0. */
  position: number;
}

/** What of the listing and its agent decides whether it can have plans. */
export interface PlanListing {
  /** AgentListing.sells: "use" or "copies". */
  sells: string;
  pricingModel: string;
  /** Agent.agentKind of the listing's agent. */
  agentKind?: string | null;
}

export const PLAN_MESSAGES = {
  sellsCopies: "Plans are for a listing that sells use of the agent. This listing sells copies.",
  notPerUse: "Plans are added to a listing that is sold per use. Change this listing to Pay per use first.",
  scheduled: "An agent that runs on its own is sold by the month, so it cannot have plans.",
  tooMany: `A listing can have at most ${MAX_PAID_PLANS} plans.`,
  kind: "A plan is either paid or a free trial.",
  kindChanged: "A plan cannot be turned into a free trial, or a free trial into a plan. End it and add a new one.",
  trialTwice: "A listing can have one free trial.",
  trialPrice: "A free trial has no price.",
  trialExtra: "A free trial has no price for an extra use. It stops when its uses are gone.",
  trialUses: `A free trial includes between ${MIN_INCLUDED_USES} and ${MAX_TRIAL_USES} uses.`,
  sameTwice: "This plan is in the list twice.",
  gone: "This plan is no longer on the listing. Reload the page and try again.",
  nameMissing: "Give the plan a name.",
  nameTooLong: `The name of a plan can be at most ${MAX_PLAN_NAME_CHARS} characters.`,
  priceFloor: `The price for 30 days must be at least ${dollars(MIN_PLAN_PRICE_CENTS)}.`,
  usesRange: `A plan includes between ${MIN_INCLUDED_USES} and ${MAX_INCLUDED_USES.toLocaleString("en-US")} uses.`,
  priceForUses: (priceCents: bigint) =>
    `At ${dollars(priceCents)} a plan can include at most ${Number(priceCents / MIN_PLAN_CENTS_PER_INCLUDED_USE).toLocaleString("en-US")} uses.`,
  extraFloor: `The price for each extra use must be at least ${dollars(MIN_EXTRA_USE_PRICE_CENTS)}.`,
} as const;

function dollars(cents: bigint): string {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export type PlanSetCheck =
  | { ok: true; plans: CheckedPlan[] }
  | {
      /** One or more fields are wrong. Nothing was saved. */
      ok: false;
      status: 400;
      code: "validation_failed";
      /** The first problem, as a sentence. */
      message: string;
      /** Each field that is wrong, as "plans[0].priceCents", with its sentence. */
      fields: Record<string, string>;
      /** The whole answer, in the shape every refused field of a listing has. */
      body: ValidationFailureBody;
    }
  | {
      /** This listing cannot have plans, whatever is sent. */
      ok: false;
      status: 409;
      code: "plans_not_available";
      message: string;
    };

/**
 * Checks the whole set of plans a creator sends for a listing. The set
 * replaces what the listing has: a plan with an id is changed in place, and
 * the plans that end are named beside it (services/listingPlanStore.ts), so
 * an empty set is allowed.
 *
 * `activePlanIds` are the ids of the listing's plans that are on offer now.
 * When it is given, an id that is not among them is refused: a plan of
 * another listing, or one retired since the page was loaded.
 *
 * `activeKinds` says, for those ids, whether each is a paid plan or the free
 * trial. When it is given, an id sent as the other kind is refused: a row is
 * changed in place, and its kind is not something that changes.
 */
export function checkPlanSet(
  listing: PlanListing,
  plans: PlanInput[],
  activePlanIds?: ReadonlySet<string>,
  activeKinds?: ReadonlyMap<string, string>,
): PlanSetCheck {
  const cannot = (message: string): PlanSetCheck => ({ ok: false, status: 409, code: "plans_not_available", message });
  if (listing.sells !== "use") return cannot(PLAN_MESSAGES.sellsCopies);
  if (listing.agentKind === "scheduled") return cannot(PLAN_MESSAGES.scheduled);
  if (listing.pricingModel !== "per_request") return cannot(PLAN_MESSAGES.notPerUse);

  // The first problem of each field is the one told.
  const fields: Record<string, string> = {};
  const wrong = (field: string, sentence: string) => {
    if (!(field in fields)) fields[field] = sentence;
  };

  // The free trial is not one of the four.
  if (plans.filter((plan) => plan.kind !== "trial").length > MAX_PAID_PLANS) wrong("plans", PLAN_MESSAGES.tooMany);

  const seen = new Set<string>();
  const checked: CheckedPlan[] = [];
  let trials = 0;
  let paid = 0;
  plans.forEach((plan, index) => {
    const at = (field: string) => `plans[${index}].${field}`;
    const trial = plan.kind === "trial";

    if (trial) {
      if (++trials > 1) wrong(at("kind"), PLAN_MESSAGES.trialTwice);
    } else if (plan.kind !== "paid") wrong(at("kind"), PLAN_MESSAGES.kind);

    if (plan.id !== undefined) {
      if (seen.has(plan.id)) wrong(at("id"), PLAN_MESSAGES.sameTwice);
      else if (activePlanIds && !activePlanIds.has(plan.id)) wrong(at("id"), PLAN_MESSAGES.gone);
      else if (activeKinds && activeKinds.has(plan.id) && activeKinds.get(plan.id) !== plan.kind) {
        wrong(at("kind"), PLAN_MESSAGES.kindChanged);
      }
      seen.add(plan.id);
    }

    if (trial) {
      // Its own rules: no price, no extra price, a few uses. Its name is not
      // the creator's to choose, so none is asked for and none is kept.
      if (plan.priceCents !== 0n) wrong(at("priceCents"), PLAN_MESSAGES.trialPrice);
      if ((plan.extraUsePriceCents ?? null) !== null) wrong(at("extraUsePriceCents"), PLAN_MESSAGES.trialExtra);
      const trialUsesInRange =
        Number.isInteger(plan.includedUses) &&
        plan.includedUses >= MIN_INCLUDED_USES &&
        plan.includedUses <= MAX_TRIAL_USES;
      if (!trialUsesInRange) wrong(at("includedUses"), PLAN_MESSAGES.trialUses);
      checked.push({
        id: plan.id ?? null,
        kind: "trial",
        name: TRIAL_PLAN_NAME,
        priceCents: 0n,
        includedUses: plan.includedUses,
        extraUsePriceCents: null,
        position: TRIAL_PLAN_POSITION,
      });
      return;
    }

    const name = typeof plan.name === "string" ? plan.name.trim() : "";
    // Counted as a person counts: one for each character, whatever it takes to store.
    const nameChars = [...name].length;
    if (nameChars < 1) wrong(at("name"), PLAN_MESSAGES.nameMissing);
    else if (nameChars > MAX_PLAN_NAME_CHARS) wrong(at("name"), PLAN_MESSAGES.nameTooLong);

    const usesInRange =
      Number.isInteger(plan.includedUses) &&
      plan.includedUses >= MIN_INCLUDED_USES &&
      plan.includedUses <= MAX_INCLUDED_USES;
    if (!usesInRange) wrong(at("includedUses"), PLAN_MESSAGES.usesRange);

    if (plan.priceCents < MIN_PLAN_PRICE_CENTS) {
      wrong(at("priceCents"), PLAN_MESSAGES.priceFloor);
    } else if (usesInRange && plan.priceCents < BigInt(plan.includedUses) * MIN_PLAN_CENTS_PER_INCLUDED_USE) {
      // Told on the count: the price is allowed, it is the uses that are too many for it.
      wrong(at("includedUses"), PLAN_MESSAGES.priceForUses(plan.priceCents));
    }

    const extra = plan.extraUsePriceCents ?? null;
    if (extra !== null && extra < MIN_EXTRA_USE_PRICE_CENTS) wrong(at("extraUsePriceCents"), PLAN_MESSAGES.extraFloor);

    checked.push({
      id: plan.id ?? null,
      kind: "paid",
      name,
      priceCents: plan.priceCents,
      includedUses: plan.includedUses,
      extraUsePriceCents: extra,
      // Its place among the paid plans: a free trial sent before it does not move it.
      position: ++paid,
    });
  });

  const first = Object.values(fields)[0];
  if (first !== undefined) {
    return {
      ok: false,
      status: 400,
      code: "validation_failed",
      message: first,
      fields,
      body: validationFailureFromFields(fields),
    };
  }
  return { ok: true, plans: checked };
}

// ============================================
// The terms a buyer agreed to
// ============================================

/** The terms of a plan a buyer is shown and agrees to. A free trial's are its id, a price of 0, its uses and no extra price. */
export interface PlanTerms {
  id: string;
  priceCents: bigint;
  includedUses: number;
  /** Null = the plan stops until it renews. */
  extraUsePriceCents: bigint | null;
}

/** A plan as it is now. */
export interface CurrentPlan extends PlanTerms {
  /** ListingPlan.status: "active" or "retired". */
  status: string;
}

/**
 * Whether the terms a buyer was shown are the plan as it is now. A creator
 * can change or end a plan between a buyer reading it and confirming, and
 * what they confirmed must be what is charged and written: any difference,
 * a cheaper price included, is a refusal that shows the terms again. A plan
 * that is gone or was ended matches nothing.
 */
export function samePlanTerms(shown: PlanTerms, plan: CurrentPlan | null | undefined): boolean {
  if (!plan || plan.status !== "active") return false;
  return (
    shown.id === plan.id &&
    shown.priceCents === plan.priceCents &&
    shown.includedUses === plan.includedUses &&
    (shown.extraUsePriceCents ?? null) === (plan.extraUsePriceCents ?? null)
  );
}
