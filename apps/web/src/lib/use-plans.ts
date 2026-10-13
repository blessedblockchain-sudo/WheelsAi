/**
 * The plans of an agent, as the person who pays reads them on its page: the
 * cards to choose from, what starting one says before it charges, the count
 * of uses left while on one, and what the page holds after a use or a
 * refusal. Pure: the page passes what the API said and draws what comes back.
 *
 * A plan is 30 days of use for one price with a number of uses included, on
 * top of the listing's price per use. Every number here was sent by the API.
 * Nothing is charged, read or kept by this file, and no date is worked out
 * in it.
 *
 * Never said here: how many people are on a plan, anything of the
 * organization that sells it, or a count that has no end.
 */
import type { PaidUseAccessState, PaidUseBilling, PaidUsePlan, PaidUseRefusal, PlanOffer, PlanTerms } from "./api";
import {
  PAID_USE_MESSAGES,
  dollars,
  paidRefusalNotice,
  paidView,
  shortDay,
  type DateWords,
  type PaidDialog,
  type PaidNotice,
  type PaidPrice,
  type PaidUnit,
  type PaidView,
  type PaidViewInput,
} from "./paid-use";

// ============================================
// Words
// ============================================

export const USE_PLAN_WORDS = {
  /** The button on a card. The card's name says which plan. */
  startButton: "Start this plan",
  /** Opens the cards for someone who already pays per use. */
  seePlans: "See plans",
  hidePlans: "Hide plans",
  /** What a start says when the API sent no sentence for plans that changed. */
  termsChanged: "The plans are not what you were shown. Nothing was charged. Look at them again and choose.",
} as const;

/** "500 uses", "1 use". */
function usesWord(count: number): string {
  return `${count} ${count === 1 ? "use" : "uses"}`;
}

/** "You have used all 500 uses.", and for a plan of one use a sentence that reads right. As the API says it. */
function usedAll(uses: number): string {
  return uses === 1 ? "You have used the 1 use in your plan." : `You have used all ${uses} uses.`;
}

// ============================================
// A card
// ============================================

function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The plans in an answer, as cards. Only a plan whose every term is there is
 * kept: a card is what the person agrees to, so one with a term missing is
 * not drawn. Anything that is not a list of plans reads as no plans.
 */
export function plansOf(raw: unknown): PlanOffer[] {
  if (!Array.isArray(raw)) return [];
  const cards: PlanOffer[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { id, name, priceCents, includedUses, extraUsePriceCents } = item as Partial<PlanOffer>;
    if (typeof id !== "string" || id === "" || typeof name !== "string" || name.trim() === "") continue;
    if (!isCents(priceCents)) continue;
    if (typeof includedUses !== "number" || !Number.isInteger(includedUses) || includedUses < 1) continue;
    if (extraUsePriceCents !== null && !isCents(extraUsePriceCents)) continue;
    cards.push({ id, name, priceCents, includedUses, extraUsePriceCents });
  }
  return cards;
}

/** "$9.00 for 30 days". */
export function planPriceLine(plan: PlanOffer): string {
  return `${dollars(plan.priceCents)} for 30 days`;
}

/** "500 uses". */
export function planUsesLine(plan: PlanOffer): string {
  return usesWord(plan.includedUses);
}

/** What happens past the count: "then $0.04 a use", or "then it stops until it renews". */
export function planAfterLine(plan: PlanOffer): string {
  return plan.extraUsePriceCents === null ? "then it stops until it renews" : `then ${dollars(plan.extraUsePriceCents)} a use`;
}

/** "Or pay as you go: $0.05 a message". null when the price is not a price per use. */
export function payAsYouGoLine(price: PaidPrice | null): string | null {
  if (!price || price.model !== "per_request") return null;
  return `Or pay as you go: ${dollars(price.cents)} a ${price.unit}`;
}

/**
 * The terms of a card, in the shape a start sends back. Built from the card
 * the person pressed and nothing else, so a click agrees to those terms and
 * no others.
 */
export function planTermsOf(card: PlanOffer): PlanTerms {
  return {
    id: card.id,
    priceCents: card.priceCents,
    includedUses: card.includedUses,
    extraUsePriceCents: card.extraUsePriceCents,
  };
}

/** The dialog that starts a plan: "Charges $9.00 from your credits now and every 30 days. ..." */
export function planStartDialog(card: PlanOffer): PaidDialog {
  const name = card.name.trim();
  const after =
    card.extraUsePriceCents === null
      ? "After that it stops until your plan renews."
      : `After that each use is ${dollars(card.extraUsePriceCents)}.`;
  return {
    // A plan its creator called "Pro plan" is not asked about as "the Pro plan plan".
    title: /\bplan$/i.test(name) ? `Start the ${name}?` : `Start the ${name} plan?`,
    body: `Charges ${dollars(card.priceCents)} from your credits now and every 30 days. Includes ${usesWord(card.includedUses)}. ${after}`,
    confirmLabel: `Start for ${dollars(card.priceCents)}`,
  };
}

// ============================================
// The count while on a plan
// ============================================

/** What the count line is written from. `PaidUsePlan` and the plan of a use's billing both carry it. */
export interface PlanCount {
  includedUses: number;
  usedUses: number;
  remainingUses: number;
  /** What each use past the count costs, as agreed. Null = the plan stops until it renews. */
  extraUsePriceCents: number | null;
  /** When the count starts again (an ISO time). Left out when the plan will not renew. */
  resetsAt?: string;
  warning: null | 85 | 100;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** The count in an answer; null when the answer carries no plan, or one this page cannot read. */
export function planCountOf(raw: unknown): PlanCount | null {
  if (typeof raw !== "object" || raw === null) return null;
  const plan = raw as Partial<PlanCount>;
  if (!isCount(plan.includedUses) || !isCount(plan.usedUses) || !isCount(plan.remainingUses)) return null;
  const extra = isCents(plan.extraUsePriceCents) ? plan.extraUsePriceCents : null;
  return {
    includedUses: plan.includedUses,
    usedUses: plan.usedUses,
    remainingUses: plan.remainingUses,
    extraUsePriceCents: extra,
    ...(typeof plan.resetsAt === "string" && plan.resetsAt !== "" && { resetsAt: plan.resetsAt }),
    warning: plan.warning === 85 || plan.warning === 100 ? plan.warning : null,
  };
}

export interface PlanCountLineInput {
  plan: PlanCount;
  /**
   * The end of the period paid for (the subscription's `currentPeriodEnd`):
   * said as the day the plan ends when it will not renew.
   */
  endsAt?: string | null;
  /**
   * A renewal that did not go through and is being retried. The period's end
   * is behind the person then, so the line names no day; the page's own
   * sentence says by when to add credits.
   */
  pastDue?: boolean;
  dates?: DateWords;
}

/**
 * The one line above the chat or the task form while on a plan:
 * "312 of 500 uses left. Renews 12 Nov.", the two warnings, and "Your plan
 * ends on 12 Nov." in place of the renewal when the plan will not renew.
 */
export function planCountLine(input: PlanCountLineInput): string {
  const { plan } = input;
  const dates = input.dates ?? {};
  // Every use of the period: the included ones and any brought into it.
  const total = Math.max(plan.includedUses, plan.usedUses + plan.remainingUses);
  const left = plan.remainingUses;
  const renews = Boolean(plan.resetsAt);
  const renewsOn = input.pastDue ? "" : shortDay(plan.resetsAt, dates);
  const endsOn = input.pastDue || renews ? "" : shortDay(input.endsAt, dates);
  const ends = endsOn ? ` Your plan ends on ${endsOn}.` : "";

  if (plan.warning === 100 || left === 0) {
    if (plan.extraUsePriceCents !== null) {
      return `${usedAll(total)} Each use is now ${dollars(plan.extraUsePriceCents)} from your credits.${ends}`;
    }
    if (!renews) return `${usedAll(total)}${ends}`;
    return renewsOn ? `${usedAll(total)} It starts again on ${renewsOn}.` : `${usedAll(total)} It starts again when your plan renews.`;
  }
  if (plan.warning === 85) {
    const until = renewsOn ? ` until ${renewsOn}` : "";
    return `You have used 85% of your plan. ${usesWord(left)} left${until}.${ends}`;
  }
  return `${left} of ${usesWord(total)} left.${renewsOn ? ` Renews ${renewsOn}.` : ""}${ends}`;
}

// ============================================
// The page with plans
// ============================================

/** Where the cards are drawn: before pay as you go, behind "See plans", or not at all. */
export type PlanCardsPlace = "first" | "behind" | "none";

export interface PlanGate {
  /** The plans on offer, in the order they are shown. Empty when the listing offers none. */
  cards: PlanOffer[];
  /**
   * `first`: someone who has agreed to nothing chooses between the plans and
   * pay as you go. `behind`: someone who already pays per use opens them with
   * "See plans". `none`: no plan can be chosen now (on a plan, subscribed, no
   * longer offered) or the listing has none.
   */
  place: PlanCardsPlace;
  /** Whether each card has its button: only an owner or admin who is signed in and may start. */
  canStart: boolean;
  /** Said with the cards when the person may not start one and the page's sentence has not said so. */
  askAdmin: string | null;
  /** "Or pay as you go: $0.05 a message", after cards that come first. */
  payAsYouGo: string | null;
  /**
   * The count of uses left, when it is said beside the page's sentence and
   * not in its place: while a renewal is being retried. Otherwise null, and
   * a plan holder's sentence is the count line itself.
   */
  countLine: string | null;
}

/** The zone a plan's days are written in on the page: the one the API writes them in. */
const PLAN_DAY_ZONE = "UTC";

export interface PlanGateView {
  /** `paidView` of the same input, with the count line as its sentence for someone on a plan. */
  view: PaidView;
  plans: PlanGate;
}

const FIRST: ReadonlyArray<PaidView["kind"]> = ["signed_out", "not_started", "ask_admin", "plan_ended", "own_agent", "start_blocked"];
/** These see the cards and can never start one: nobody is signed in, the agent is their own, or a start is held back. */
const NEVER_START: ReadonlyArray<PaidView["kind"]> = ["signed_out", "own_agent", "start_blocked"];

/**
 * An agent's page for someone who pays, plans included. With no plans in the
 * answer and none held it is `paidView` and nothing more: the page of a
 * listing with no plans is drawn exactly as before plans existed.
 */
export function planGateView(input: PaidViewInput): PlanGateView {
  const base = paidView(input);
  const state = input.authed ? input.access : null;
  // The plans the access names are fresher than the page's and win, an empty list included.
  const cards = plansOf(state && Array.isArray(state.plans) ? state.plans : input.page.plans);

  const read = state?.access === "subscribed" && base.kind === "in_use" ? planCountOf(state.plan) : null;
  // The access names no price per use when the listing no longer sells use. No extra use is sold then,
  // whatever the plan agreed: past its count the plan stops, and the line must not name a charge.
  const count = read && state?.terms == null ? { ...read, extraUsePriceCents: null } : read;
  const pastDue = state?.subscription?.status === "past_due";
  // The API writes the day in its used-up sentence in UTC, and that sentence is shown on this page beside
  // the line. The line's days are written in UTC too, so the two never name different days.
  const line = count
    ? planCountLine({
        plan: count,
        endsAt: state?.subscription?.currentPeriodEnd,
        pastDue,
        dates: { ...input.dates, timeZone: PLAN_DAY_ZONE },
      })
    : null;
  // The sentence of a monthly subscriber speaks of a month and of a renewal a plan may not have. A plan
  // holder reads the count. While a renewal is retried the page's sentence stays, with its add-credits action.
  const view = line !== null && !pastDue ? { ...base, sentence: line } : base;

  let place: PlanCardsPlace = "none";
  if (cards.length > 0) {
    if (FIRST.includes(base.kind)) place = "first";
    else if (base.kind === "price_changed" || (base.kind === "in_use" && state?.access === "listing_pricing")) place = "behind";
  }
  const canStart = place !== "none" && !NEVER_START.includes(base.kind) && state?.canAccept === true && !state.startBlocked;
  const askAdmin =
    place !== "none" && !canStart && !NEVER_START.includes(base.kind) && !base.sentence.includes(PAID_USE_MESSAGES.askAdmin)
      ? PAID_USE_MESSAGES.askAdmin
      : null;

  return {
    view,
    plans: {
      cards: place === "none" ? [] : cards,
      place,
      canStart,
      askAdmin,
      payAsYouGo: place === "first" ? payAsYouGoLine(base.price) : null,
      countLine: pastDue ? line : null,
    },
  };
}

// ============================================
// What the page holds after a use, and after a refusal
// ============================================

/**
 * The access after an answer, with the count from that answer's billing: the
 * line above the chat is drawn again with no request of its own. An answer
 * that names no plan changes nothing.
 */
export function accessAfterUse(
  access: PaidUseAccessState | null,
  billing: PaidUseBilling | null | undefined,
): PaidUseAccessState | null {
  const count = planCountOf(billing?.plan);
  if (!access || !count) return access;
  const held = access.plan ?? null;
  const plan: PaidUsePlan = {
    id: billing?.plan?.id ?? held?.id ?? null,
    name: held?.name ?? "",
    ...count,
  };
  return { ...access, plan };
}

/**
 * The access after a refusal that says where the person now stands, so the
 * page is true before it is read again:
 *
 *   plan_ended        back to choosing, with the plans and the price per use
 *                     the refusal named
 *   plan_used_up      the count at none left, and when it starts again as
 *                     the refusal says it
 *   pricing_changed   on starting a plan: the plans as they are now
 *
 * Any other refusal changes nothing here.
 */
export function accessAfterRefusal(
  access: PaidUseAccessState | null,
  refusal: PaidUseRefusal | null | undefined,
): PaidUseAccessState | null {
  if (!access || !refusal) return access;
  const named = Array.isArray(refusal.plans) ? { plans: plansOf(refusal.plans) } : {};

  if (refusal.error === "plan_ended") {
    return { ...access, ...named, access: "plan_ended", plan: null, terms: refusal.terms ?? access.terms };
  }
  if (refusal.error === "plan_used_up") {
    const count = planCountOf(access.plan);
    if (!count || !access.plan) return { ...access, ...named };
    const total = Math.max(count.includedUses, count.usedUses + count.remainingUses);
    // Built field by field: when the count starts again is the refusal's to say, and it says nothing
    // for a plan that will not renew.
    const plan: PaidUsePlan = {
      id: access.plan.id ?? null,
      name: access.plan.name ?? "",
      includedUses: count.includedUses,
      usedUses: total,
      remainingUses: 0,
      // A use past the count is refused this way only when no extra use is sold now, whatever was agreed.
      extraUsePriceCents: null,
      ...(typeof refusal.resetsAt === "string" && refusal.resetsAt !== "" && { resetsAt: refusal.resetsAt }),
      warning: 100,
    };
    return { ...access, ...named, plan };
  }
  if (refusal.error === "pricing_changed" && Array.isArray(refusal.plans)) return { ...access, ...named };
  return access;
}

// ============================================
// A start that was refused
// ============================================

export interface PlanStartRefusalInput {
  /** The HTTP status; 0 when the request never got an answer. */
  status: number;
  refusal: PaidUseRefusal | null;
  unit: PaidUnit;
}

/**
 * The sentence and the one action for a plan that could not be started.
 * Nothing was charged on any of them. Plans that changed: the API's sentence,
 * and the cards are drawn again from its answer. Not enough credits: the
 * API's sentence, which names the plan's price, and the way to add credits.
 * Every other refusal reads as it does for any start.
 */
export function planStartNotice(input: PlanStartRefusalInput): PaidNotice {
  const notice = paidRefusalNotice({ ...input, act: "start" });
  if (notice.code !== "pricing_changed") return notice;
  // A start per use names the new price per use here. A plan's terms are on its card, drawn again.
  const said = typeof input.refusal?.message === "string" ? input.refusal.message.trim() : "";
  return { ...notice, message: said || USE_PLAN_WORDS.termsChanged, action: { kind: "none", label: null }, price: null };
}
