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
 * A listing can also offer one free trial beside its plans: some uses for
 * some days at no price, started once by a buyer's organization. It is said
 * here in its own words and is never a card. It is not the free messages of
 * a listing's own page ("Try it free first"), which are anyone's.
 *
 * Never said here: how many people are on a plan, anything of the
 * organization that sells it, or a count that has no end.
 */
import type {
  PaidUseAccessState,
  PaidUseBilling,
  PaidUsePlan,
  PaidUseRefusal,
  PlanOffer,
  PlanTerms,
  TrialOffer,
} from "./api";
import {
  PAID_USE_MESSAGES,
  acceptLabel,
  dollars,
  paidRefusalNotice,
  paidView,
  priceChangedSentence,
  shortDay,
  startDialog,
  type DateWords,
  type PaidDialog,
  type PaidNotice,
  type PaidPrice,
  type PaidSubject,
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
// The free trial: its offer, its start, its count
// ============================================

export const TRIAL_WORDS = {
  /** What a free trial is called wherever a plan's name would be. The API's own name for it. */
  name: "Free trial",
  startButton: "Start the free trial",
  dialogTitle: "Start the free trial?",
  /** Under the offer, to an organization that never added credits. With the way to add them. */
  needsCredits: "Add credits to your account once to start it. The trial itself costs nothing.",
} as const;

const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * The free trial in an answer, as it is offered. Only one whose every term is
 * there is kept: what is shown is what starting it agrees to. Anything else
 * reads as no trial.
 */
export function trialOfferOf(raw: unknown): TrialOffer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, includedUses, days } = raw as Partial<TrialOffer>;
  if (typeof id !== "string" || id === "" || !isWhole(includedUses) || !isWhole(days)) return null;
  return { id, includedUses, days };
}

/** "7 days", "1 day". */
function daysWord(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** "20 uses free for 7 days": the size of a trial, as every sentence that offers one says it. */
export function trialSizeWords(trial: TrialOffer): string {
  return `${usesWord(trial.includedUses)} free for ${daysWord(trial.days)}`;
}

/**
 * "Try 20 uses free for 7 days. Nothing is charged and it does not renew."
 * For someone who already pays per use (`after`, the price they agreed to and
 * keep), the second sentence is what a use costs after the free ones: they
 * are charged it without being asked again, so "nothing is charged" would be
 * false for them.
 */
export function trialOfferLine(trial: TrialOffer, after: PaidPrice | null = null): string {
  return `Try ${trialSizeWords(trial)}. ${after ? trialAfterLine(after) : "Nothing is charged and it does not renew."}`;
}

/**
 * The terms of a free trial, in the shape a start sends back: its id and its
 * uses as they were shown, at no price and with no price for an extra use.
 * Built from the trial the person was shown and nothing else.
 */
export function trialTermsOf(trial: TrialOffer): PlanTerms {
  return { id: trial.id, priceCents: 0, includedUses: trial.includedUses, extraUsePriceCents: null };
}

/**
 * The dialog that starts a free trial: "Starts a free trial of 20 uses for 7
 * days. Nothing is charged, now or later. ...". Someone who already pays per
 * use keeps that agreement through the trial (`after`): their dialog says
 * the free uses cost nothing and what each use costs after them.
 */
export function trialStartDialog(trial: TrialOffer, after: PaidPrice | null = null): PaidDialog {
  const starts = `Starts a free trial of ${usesWord(trial.includedUses)} for ${daysWord(trial.days)}.`;
  return {
    title: TRIAL_WORDS.dialogTitle,
    body: after
      ? `${starts} The free uses cost nothing. ${trialAfterLine(after)}`
      : `${starts} Nothing is charged, now or later. When it ends you choose a plan or pay per use.`,
    confirmLabel: TRIAL_WORDS.startButton,
  };
}

/** "You have used all 20 uses of your free trial.", and for a trial of one use a sentence that reads right. As the API says it. */
function usedAllTrial(uses: number): string {
  return uses === 1 ? "You have used the 1 use of your free trial." : `You have used all ${uses} uses of your free trial.`;
}

/** "After your free uses, each message is $0.05 from your credits." For someone on a trial who agreed to the price per use. */
export function trialAfterLine(price: PaidPrice): string {
  return `After your free uses, each ${price.unit} is ${dollars(price.cents)} from your credits.`;
}

export interface TrialCountLineInput {
  plan: PlanCount;
  /** The end of the trial's days (the subscription's `currentPeriodEnd`). */
  endsAt?: string | null;
  /**
   * What a use past the trial's uses costs this person: the price per use
   * they agreed to, as the listing asks it now. Null when they agreed to
   * none, or to one the listing's price is now above: the trial then stops
   * and they choose. Left out by a page that was not told what they agreed
   * to: its line then says only that the uses are gone.
   */
  perUse?: PaidPrice | null;
  dates?: DateWords;
}

/**
 * The one line of a free trial, in place of a plan's:
 * "12 of 20 trial uses left. Your free trial ends on 20 Oct.", and when they
 * are gone "You have used all 20 uses of your free trial. Choose a plan or
 * pay per use to keep using it.", or, for someone who agreed to the price
 * per use, "... Each message is now $0.05 from your credits."
 *
 * A trial never renews and never starts again, so the line names no day on
 * which a count comes back and never speaks of moving up.
 */
export function trialCountLine(input: TrialCountLineInput): string {
  const { plan } = input;
  const total = Math.max(plan.includedUses, plan.usedUses + plan.remainingUses);
  const left = plan.remainingUses;
  if (left <= 0) {
    const used = usedAllTrial(total);
    if (input.perUse === undefined) return used;
    return input.perUse
      ? `${used} Each ${input.perUse.unit} is now ${dollars(input.perUse.cents)} from your credits.`
      : `${used} Choose a plan or pay per use to keep using it.`;
  }
  const endsOn = shortDay(input.endsAt, input.dates ?? {});
  return `${left} of ${total} trial ${total === 1 ? "use" : "uses"} left.${endsOn ? ` Your free trial ends on ${endsOn}.` : ""}`;
}

/** How a free trial is offered to the person on the page. */
export type TrialOfferKind =
  /** They may start it now: the button, then the dialog. */
  | "start"
  /** Adding credits once is the one thing missing: the way to add them, and no button. */
  | "needs_credits"
  /** Nobody is signed in: the page's own sign-in action is what to press. */
  | "signin"
  /** Their organization could start it, and they may not: an owner or admin does. */
  | "ask_admin";

/** A free trial as it is said above the plan cards. */
export interface TrialOfferView {
  /** The trial as it is shown. Its terms are what a start sends, held from the moment its dialog opens. */
  trial: TrialOffer;
  /** "Try 20 uses free for 7 days. Nothing is charged and it does not renew." */
  line: string;
  kind: TrialOfferKind;
  /**
   * What a use after the free ones costs this person without being asked
   * again: the listing's price per use, for someone who pays it now and whose
   * agreement covers it. Null for everyone else. The line and the start
   * dialog are written with it.
   */
  after: PaidPrice | null;
  /** The sentence after the line: what is missing, or who to ask. Null when there is none, or the page already says it. */
  note: string | null;
}

/** What the page draws of the listing's free trial. */
export interface TrialGate {
  /**
   * The trial on offer to this person. Null when the listing offers none,
   * when their organization used it or is on a plan, a month or the trial
   * itself, and for the agent's own maker: nothing about a trial is then
   * shown.
   */
  offer: TrialOfferView | null;
  /** Whether the person is on the free trial now. The page's sentence is then its count line. */
  held: boolean;
  /**
   * Under the count line while on the trial, for someone who agreed to a
   * price per use: "After your free uses, each message is $0.05 from your
   * credits.", or, when the listing's price is now above what they agreed
   * to, the sentence of a price that changed. Null otherwise.
   */
  afterLine: string | null;
}

const NO_TRIAL: TrialGate = { offer: null, held: false, afterLine: null };

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
  /** `paidView` of the same input, with the count line as its sentence for someone on a plan or on the free trial. */
  view: PaidView;
  plans: PlanGate;
  /** The listing's free trial: its offer above the cards, or what is said while on it. */
  trial: TrialGate;
}

/** A free trial can be offered to these and to someone who pays per use. Never where the page says the agent is not sold, is the person's own, or cannot be started. */
const TRIAL_OFFERED: ReadonlyArray<PaidView["kind"]> = ["signed_out", "not_started", "ask_admin", "plan_ended", "price_changed"];

/**
 * The free trial as it is offered to the person on the page; null when
 * nothing about a trial is shown. Whether their organization can start it is
 * the API's to say (`trialAvailable`, `trialNeedsCredits`): it is never
 * worked out here.
 */
function trialOffered(input: PaidViewInput, base: PaidView): TrialOfferView | null {
  // A trial is some uses of an agent sold per use. A month has none.
  if (base.price?.model !== "per_request") return null;
  const state = input.authed ? input.access : null;
  if (!state) {
    const trial = base.kind === "signed_out" ? trialOfferOf(input.page.trial) : null;
    return trial && { trial, line: trialOfferLine(trial), kind: "signin", after: null, note: null };
  }
  const paysPerUse = base.kind === "in_use" && state.access === "listing_pricing";
  if (!TRIAL_OFFERED.includes(base.kind) && !paysPerUse) return null;
  const trial = trialOfferOf(state.trial);
  if (!trial) return null;
  // A start keeps the agreement of someone who pays per use: past the free uses they are charged the price
  // they agreed to, so the offer names it. The same rule as on the trial itself: only while the listing's
  // price is not above what was agreed.
  const agreed = agreedPerUse(state);
  const after = paysPerUse && agreed !== null && base.price.cents <= agreed ? base.price : null;
  const line = trialOfferLine(trial, after);
  if (state.trialNeedsCredits === true) return { trial, line, kind: "needs_credits", after, note: TRIAL_WORDS.needsCredits };
  if (state.trialAvailable !== true) return null;
  if (state.canAccept === true && !state.startBlocked) return { trial, line, kind: "start", after, note: null };
  // Said once: the page's own sentence may already ask for an owner or admin.
  const said = base.sentence.includes(PAID_USE_MESSAGES.askAdmin);
  return { trial, line, kind: "ask_admin", after, note: said ? null : PAID_USE_MESSAGES.askAdmin };
}

/** The price per use the person agreed to themselves, in cents; null when they agreed to none. */
function agreedPerUse(state: PaidUseAccessState): number | null {
  const agreed = state.accepted;
  return agreed?.pricingModel === "per_request" && isCents(agreed.pricePerRequestCents) ? agreed.pricePerRequestCents : null;
}

/**
 * The page of someone on the free trial. Its sentence is the trial's count
 * line. The plans are shown and can be started over the trial at any time,
 * and nothing speaks of moving up. Pay as you go is offered until they have
 * agreed to it; from then on the page says what a use costs after the free
 * ones. When the listing's price is above what they agreed to, the page asks
 * them to accept the new one, as it does for anyone who pays per use.
 */
function trialHeldView(
  base: PaidView,
  state: PaidUseAccessState,
  held: PlanCountLineInput,
  cards: PlanOffer[],
): PlanGateView {
  const price = base.price?.model === "per_request" ? base.price : null;
  const agreed = agreedPerUse(state);
  // The listing's price is what a use past the trial is charged, and only while it is not above what was agreed.
  const covered = price !== null && agreed !== null && price.cents <= agreed;
  const left = held.plan.remainingUses > 0;
  const sentence = trialCountLine({
    plan: held.plan,
    endsAt: held.endsAt,
    // An agent that is no longer sold for use has nothing to choose: the line then only counts.
    ...(price && { perUse: covered ? price : null }),
    dates: held.dates,
  });
  const mayAgree = state.canAccept === true && !state.startBlocked;

  let view: PaidView = { ...base, sentence };
  let afterLine: string | null = null;
  if (price && agreed === null) {
    // Agreed to nothing yet: today's start per use, which takes effect during the trial.
    if (mayAgree) {
      view = {
        ...view,
        action: { kind: "start", label: PAID_USE_MESSAGES.startButton },
        // While free uses are left the dialog says they come first, not that each message is charged.
        dialog: left ? startDialog(price, trialAfterLine(price)) : startDialog(price),
      };
    }
  } else if (price && !covered) {
    // The price went up since they agreed: nothing past the free uses is charged until they accept it.
    afterLine = priceChangedSentence(price, state.accepted);
    if (mayAgree) view = { ...view, action: { kind: "accept", label: acceptLabel(price) }, acceptNewPricing: true };
  } else if (covered && left) {
    afterLine = trialAfterLine(price);
  }

  // Someone who has something left to agree to and may not is told who can.
  const toChoose = price !== null && !covered;
  return {
    view,
    plans: {
      cards: price ? cards : [],
      // The cards and pay as you go are a choice the whole trial long, with no plan on offer too.
      place: price ? "first" : "none",
      canStart: price !== null && mayAgree,
      askAdmin: price !== null && !mayAgree && (cards.length > 0 || toChoose) ? PAID_USE_MESSAGES.askAdmin : null,
      payAsYouGo: agreed === null ? payAsYouGoLine(price) : null,
      countLine: null,
    },
    trial: { offer: null, held: true, afterLine },
  };
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
  if (state && held && state.plan?.trial === true) return trialHeldView(base, state, held, cards);
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
  const offer = trialOffered(input, base);
  // The trial is said above the cards. When it has already said who to ask, the cards do not say it again,
  // behind "See plans" either.
  const askedAbove = offer?.note === PAID_USE_MESSAGES.askAdmin;
  const askAdmin =
    place !== "none" &&
    !canStart &&
    !askedAbove &&
    !NEVER_START.includes(base.kind) &&
    !base.sentence.includes(PAID_USE_MESSAGES.askAdmin)
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
    trial: offer ? { ...NO_TRIAL, offer } : NO_TRIAL,
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
 * everyone else it is `planGateView` and `moveUp: null`. Nobody moves up
 * from a free trial: a plan is started over it in the usual way.
 */
export function planPageView(input: PaidViewInput): PlanPageView {
  const gate = planGateView(input);
  const state = input.authed ? input.access : null;
  const held = heldPlanLine(input, gate.view.kind);
  if (!state || !held || gate.trial.held) return { ...gate, moveUp: null };

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
    ? { ...gate, plans: { ...gate.plans, countLine: line }, moveUp }
    : { ...gate, view: { ...gate.view, sentence: line }, moveUp };
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
  // Whether the count is a free trial's is the answer's to say: a paid plan started over the trial in
  // between is told as what it is. An answer that does not say leaves what the page held.
  const said = billing?.plan?.trial;
  const trial = typeof said === "boolean" ? said : held?.trial;
  const plan: PaidUsePlan = {
    id: billing?.plan?.id ?? held?.id ?? null,
    name: held?.name ?? "",
    ...(typeof trial === "boolean" && { trial }),
    ...count,
  };
  return { ...access, plan };
}

/**
 * The access after a refusal that says where the person now stands, so the
 * page is true before it is read again:
 *
 *   plan_ended        back to choosing, with the plans and the price per use
 *                     the refusal named; said as a free trial that ended
 *                     when that is what the page held
 *   plan_used_up      the count at none left, and when it starts again as
 *                     the refusal says it (a free trial never does)
 *   pricing_changed   on starting a plan or the free trial: the plans, and
 *                     the trial, as they are now
 *   trial_already_used, trial_needs_credits
 *                     on starting the free trial: it is no longer offered
 *                     as one that can be started
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
    return {
      ...access,
      ...named,
      access: "plan_ended",
      plan: null,
      terms: refusal.terms ?? access.terms,
      // What ended is what the page held. The read that follows says it again.
      ...(access.plan?.trial === true && { trialEnded: true }),
    };
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
      ...(typeof access.plan.trial === "boolean" && { trial: access.plan.trial }),
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
  if (refusal.error === "pricing_changed" && (Array.isArray(refusal.plans) || refusal.trial !== undefined)) {
    // A refused start of the free trial also names the trial as it is offered now, or that there is none.
    return { ...access, ...named, ...(refusal.trial !== undefined && { trial: trialOfferOf(refusal.trial) }) };
  }
  if (refusal.error === "trial_already_used") return { ...access, trialAvailable: false, trialNeedsCredits: false };
  if (refusal.error === "trial_needs_credits") return { ...access, trialAvailable: false, trialNeedsCredits: true };
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
  /** What the page sells, for the sentences that name it; an agent unless it says. */
  subject?: PaidSubject;
}

/**
 * The sentence and the one action for a plan, or the free trial, that could
 * not be started. Nothing was charged on any of them. A trial that was used
 * before, and one that waits for credits to be added once (with the way to
 * add them), say the API's sentence. Plans that changed: the API's sentence,
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
