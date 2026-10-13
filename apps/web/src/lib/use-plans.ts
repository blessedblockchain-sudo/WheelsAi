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

/**
 * The words of moving up to a bigger plan before the 30 days end. Kept apart
 * from the words of starting one: a card that starts a plan never speaks of
 * moving.
 */
export const MOVE_UP_WORDS = {
  /** Opens the bigger plans, under the count of what is left. */
  seeBigger: "See bigger plans",
  hideBigger: "Hide bigger plans",
  /** The button on a bigger plan's card. The card's name says which plan. */
  button: "Move up",
  /** What the list of bigger plans is called for someone who cannot see it. */
  cardsLabel: "Bigger plans",
  // What a refused move says when the API sent no sentence. The API's own words (PLAN_MOVE_MESSAGES in
  // apps/api/src/services/planMove.ts).
  notOnPlan: "You are not on a plan. Start one first.",
  samePlan: "You are already on this plan. Nothing was charged.",
  notBigger: "To move to a smaller plan, cancel the renewal and choose it when your plan ends.",
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
  /**
   * The person can move up to a bigger plan now. Said only where the line
   * tells them to wait: a plan that is used up and stops until it renews.
   */
  moveUp?: boolean;
  dates?: DateWords;
}

/**
 * The one line above the chat or the task form while on a plan:
 * "312 of 500 uses left. Renews 12 Nov.", the two warnings, and "Your plan
 * ends on 12 Nov." in place of the renewal when the plan will not renew.
 * With `moveUp`, a plan that is used up and stops ends "..., or move up now."
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
    const or = input.moveUp ? ", or move up now" : "";
    return renewsOn
      ? `${usedAll(total)} It starts again on ${renewsOn}${or}.`
      : `${usedAll(total)} It starts again when your plan renews${or}.`;
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

/** The plans on offer, as the page reads them. The ones the access names are fresher than the page's and win, an empty list included. */
function cardsOnOffer(input: PaidViewInput): PlanOffer[] {
  const state = input.authed ? input.access : null;
  return plansOf(state && Array.isArray(state.plans) ? state.plans : input.page.plans);
}

/**
 * What the count line of the plan the person is on is written from; null for
 * anyone who is not on a plan that gives them uses now.
 */
function heldPlanLine(input: PaidViewInput, kind: PaidView["kind"]): PlanCountLineInput | null {
  const state = input.authed ? input.access : null;
  const read = state?.access === "subscribed" && kind === "in_use" ? planCountOf(state.plan) : null;
  if (!read) return null;
  return {
    // The access names no price per use when the listing no longer sells use. No extra use is sold then,
    // whatever the plan agreed: past its count the plan stops, and the line must not name a charge.
    plan: state?.terms == null ? { ...read, extraUsePriceCents: null } : read,
    endsAt: state?.subscription?.currentPeriodEnd,
    pastDue: state?.subscription?.status === "past_due",
    // The API writes the day in its used-up sentence in UTC, and that sentence is shown on this page beside
    // the line. The line's days are written in UTC too, so the two never name different days.
    dates: { ...input.dates, timeZone: PLAN_DAY_ZONE },
  };
}

/**
 * An agent's page for someone who pays, plans included. With no plans in the
 * answer and none held it is `paidView` and nothing more: the page of a
 * listing with no plans is drawn exactly as before plans existed.
 */
export function planGateView(input: PaidViewInput): PlanGateView {
  const base = paidView(input);
  const state = input.authed ? input.access : null;
  const cards = cardsOnOffer(input);

  const held = heldPlanLine(input, base.kind);
  const pastDue = held?.pastDue === true;
  const line = held ? planCountLine(held) : null;
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
// Moving up to a bigger plan
// ============================================

/**
 * The plans a person on a plan can move up to: the ones on offer that cost
 * more for their 30 days than the price they agreed to for the plan they are
 * on, their own plan left out. The API moves to no other. Nobody whose agreed
 * price is not known is offered one.
 */
export function biggerPlans(
  cards: PlanOffer[],
  held: { id: string | null | undefined; agreedCents: number | null | undefined },
): PlanOffer[] {
  const agreed = held.agreedCents;
  if (typeof agreed !== "number" || !Number.isFinite(agreed)) return [];
  return cards.filter((card) => card.id !== held.id && card.priceCents > agreed);
}

/**
 * How many uses a move carries into the new 30 days: the uses that are left,
 * and at most as many as the plan being left included (uses carried by an
 * earlier move are not carried again). The API works out the same number
 * when it moves. The Installed page asks this function too.
 */
export function carriedOnMove(plan: Pick<PlanCount, "includedUses" | "remainingUses">): number {
  const left = Number.isFinite(plan.remainingUses) ? Math.floor(plan.remainingUses) : 0;
  const included = Number.isFinite(plan.includedUses) ? Math.floor(plan.includedUses) : 0;
  return Math.max(0, Math.min(left, included));
}

/** The uses left in the period, as a whole number that is never below 0. */
function usesLeft(plan: Pick<PlanCount, "remainingUses">): number {
  return Number.isFinite(plan.remainingUses) ? Math.max(0, Math.floor(plan.remainingUses)) : 0;
}

/**
 * The dialog that moves up: "Starts a new 30 days today and charges $29.00
 * from your credits. The 188 uses you have left are added to it." With no
 * use left the second sentence is left out.
 *
 * `leftUses` is what the count line shows as left. When a move carries fewer
 * (uses brought in by an earlier move stay behind) the sentence says both
 * numbers, "500 of the 590 uses you have left are added to it.", so nobody
 * pays for a move that drops uses without having read it.
 */
export function planMoveDialog(card: PlanOffer, carriedUses: number, leftUses: number = carriedUses): PaidDialog {
  const name = card.name.trim();
  const is = carriedUses === 1 ? "is" : "are";
  const carried =
    carriedUses <= 0
      ? ""
      : leftUses > carriedUses
        ? ` ${carriedUses} of the ${leftUses} uses you have left ${is} added to it.`
        : carriedUses === 1
          ? " The 1 use you have left is added to it."
          : ` The ${carriedUses} uses you have left are added to it.`;
  return {
    title: /\bplan$/i.test(name) ? `Move up to the ${name}?` : `Move up to the ${name} plan?`,
    body: `Starts a new 30 days today and charges ${dollars(card.priceCents)} from your credits.${carried}`,
    confirmLabel: `${MOVE_UP_WORDS.button} for ${dollars(card.priceCents)}`,
  };
}

/** What the page draws of moving up, for someone on a plan when the listing offers a bigger one. */
export interface PlanMoveUp {
  /** The bigger plans, in the order they are on offer. Never empty. */
  cards: PlanOffer[];
  /** Whether each card has its button: the same people who may start a plan. */
  canMove: boolean;
  /** Said once with the cards to someone who may not move up. */
  askAdmin: string | null;
  /** The uses a move would carry now, for the dialog's sentence. */
  carriedUses: number;
  /** The uses the count line shows as left. More than `carriedUses` after an earlier move. */
  leftUses: number;
}

export interface PlanPageView extends PlanGateView {
  /** Null for anyone who is not on a plan, and when no bigger plan is on offer. */
  moveUp: PlanMoveUp | null;
}

/**
 * `planGateView`, with moving up for someone on a plan. When they can move
 * up, the count line of a plan that is used up and stops says so. For
 * everyone else it is `planGateView` and `moveUp: null`.
 */
export function planPageView(input: PaidViewInput): PlanPageView {
  const gate = planGateView(input);
  const state = input.authed ? input.access : null;
  const held = heldPlanLine(input, gate.view.kind);
  if (!state || !held) return { ...gate, moveUp: null };

  const cards = biggerPlans(cardsOnOffer(input), { id: state.plan?.id, agreedCents: state.accepted?.monthlyPriceCents });
  if (cards.length === 0) return { ...gate, moveUp: null };

  const canMove = state.canAccept === true && !state.startBlocked;
  const moveUp: PlanMoveUp = {
    cards,
    canMove,
    askAdmin: canMove ? null : PAID_USE_MESSAGES.askAdmin,
    carriedUses: carriedOnMove(held.plan),
    leftUses: usesLeft(held.plan),
  };
  // Someone who cannot move up is not told to: their line is the one everybody reads.
  if (!canMove) return { ...gate, moveUp };
  const line = planCountLine({ ...held, moveUp: true });
  // The line is the page's sentence, or stands beside it while a renewal is retried, as in planGateView.
  return held.pastDue
    ? { view: gate.view, plans: { ...gate.plans, countLine: line }, moveUp }
    : { view: { ...gate.view, sentence: line }, plans: gate.plans, moveUp };
}

/** What a press on a bigger plan's card opens its dialog with. */
export interface PlanMoveNow {
  /** The card as the page has just read it: its terms are the ones sent. */
  card: PlanOffer;
  carriedUses: number;
  leftUses: number;
}

/**
 * A press on a bigger plan's card, measured against the page as it was read
 * again at that press. The count the dialog promises to carry is then the
 * count of that moment, not of when the page loaded: a subscription belongs
 * to an organization, and a teammate's uses are not seen until the next read.
 *
 * Null when the person can no longer move, or when the card they pressed is
 * no longer on offer with every term they were shown: no dialog opens for
 * terms that are not on the page, and the cards are drawn again from the read.
 */
export function planMoveNow(fresh: PlanMoveUp | null, pressed: PlanOffer): PlanMoveNow | null {
  if (!fresh?.canMove) return null;
  const card = fresh.cards.find(
    (offer) =>
      offer.id === pressed.id &&
      offer.priceCents === pressed.priceCents &&
      offer.includedUses === pressed.includedUses &&
      offer.extraUsePriceCents === pressed.extraUsePriceCents,
  );
  return card ? { card, carriedUses: fresh.carriedUses, leftUses: fresh.leftUses } : null;
}

/** What a refused move says when the API sent no sentence, by its code. */
const MOVE_REFUSALS: Record<string, string> = {
  not_on_plan: MOVE_UP_WORDS.notOnPlan,
  same_plan: MOVE_UP_WORDS.samePlan,
  not_a_bigger_plan: MOVE_UP_WORDS.notBigger,
};

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

/**
 * The sentence and the one action for a move up that was refused. Nothing
 * was charged and nothing changed on any of them. It reads as a refused
 * start does (plans that changed are drawn again, too few credits come with
 * the way to add them), and the refusals only a move has say the API's
 * sentence.
 */
export function planMoveNotice(input: PlanStartRefusalInput): PaidNotice {
  const notice = planStartNotice(input);
  const own = MOVE_REFUSALS[notice.code];
  if (!own) return notice;
  const said = typeof input.refusal?.message === "string" ? input.refusal.message.trim() : "";
  return { ...notice, message: said || own, action: { kind: "none", label: null } };
}
