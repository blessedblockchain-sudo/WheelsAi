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
 * No plan is unlimited, and free trials are not offered yet.
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

// ============================================
// The set a creator sends
// ============================================

/** One plan as a creator sends it. Cents are whole cents. */
export interface PlanInput {
  /** Set to change a plan in place. Absent for a new plan. */
  id?: string;
  /** "paid". A "trial" is refused for now. */
  kind: string;
  name: string;
  /** What the 30 days cost. */
  priceCents: bigint;
  includedUses: number;
  /** What each use past the included ones costs. Null = the plan stops until it renews. */
  extraUsePriceCents: bigint | null;
}

/** A plan that passed the check: its name trimmed, and its place among the listing's paid plans. */
export interface CheckedPlan {
  id: string | null;
  kind: "paid";
  name: string;
  priceCents: bigint;
  includedUses: number;
  extraUsePriceCents: bigint | null;
  /** 1 to 4, in the order sent: the order a buyer sees them in. */
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
  trial: "Free trials are not available yet.",
  kind: "A plan is either paid or a free trial.",
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
 */
export function checkPlanSet(
  listing: PlanListing,
  plans: PlanInput[],
  activePlanIds?: ReadonlySet<string>,
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

  if (plans.length > MAX_PAID_PLANS) wrong("plans", PLAN_MESSAGES.tooMany);

  const seen = new Set<string>();
  const checked: CheckedPlan[] = [];
  plans.forEach((plan, index) => {
    const at = (field: string) => `plans[${index}].${field}`;

    if (plan.kind === "trial") wrong(at("kind"), PLAN_MESSAGES.trial);
    else if (plan.kind !== "paid") wrong(at("kind"), PLAN_MESSAGES.kind);

    if (plan.id !== undefined) {
      if (seen.has(plan.id)) wrong(at("id"), PLAN_MESSAGES.sameTwice);
      else if (activePlanIds && !activePlanIds.has(plan.id)) wrong(at("id"), PLAN_MESSAGES.gone);
      seen.add(plan.id);
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
      position: index + 1,
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

/** The terms of a plan a buyer is shown and agrees to. */
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
