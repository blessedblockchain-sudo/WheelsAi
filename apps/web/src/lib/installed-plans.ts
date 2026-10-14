/**
 * A row of Installed whose buyer is on a plan: 30 days of use for one price,
 * with a number of uses included.
 *
 * What the row says (its badge, the count of what is left), what can be done
 * from it (move up, cancel or resume the renewal, stop), and the words of
 * each dialog. Pure: no IO, no React. Every number here was sent by the API
 * (`subscription.plan` and `listing.plans` of `GET /api/marketplace/my-installs`)
 * and no date is worked out in this file.
 *
 * The count is said by `planCountLine` of lib/use-plans.ts, the function the
 * agent's own page uses, so the two pages never count differently.
 *
 * A row on the listing's free trial is worded here too, as a trial: its badge
 * is "Free trial", its line is the trial's count, and it can only be
 * stopped. It never renews, so nothing about a renewal or a move is offered.
 *
 * Never said here: how many people are on a plan, anything of the
 * organization that sells it, or a count that has no end.
 */
import type { PaidUsePlan, PlanOffer, PlanTerms } from "./api";
import { formatCents } from "./agent-page";
import type { InstalledConfirm, InstalledFormat, InstalledLicence, InstalledLine, InstalledViewer } from "./installed-rows";
import { shortDay, type PaidPrice } from "./paid-use";
import {
  TRIAL_WORDS,
  carriedOnMove,
  planAfterLine,
  planCountLine,
  planCountOf,
  planMoveDialog,
  planPriceLine,
  planTermsOf,
  planUsesLine,
  plansOf,
  trialCountLine,
} from "./use-plans";

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const INSTALLED_PLAN_WORDS = {
  moveUp: "Move up",
  /** The dialog that lists the bigger plans. Its title names the agent. */
  chooseIntro: "Choose a bigger plan. You are asked once more before anything is charged.",
  /** Said in that dialog when the plans were read again and none is bigger any more. */
  noneBigger: "There is no bigger plan to move to now.",
  /** A move that got no sentence from the API (the request never got an answer). */
  moveFailed: "The move did not go through. Look at this row before you try again.",
  /** What "Stop using" asks of a row on the free trial: a trial is started once, so stopping gives it up. */
  stopTrial: "This ends your free trial and your access now. You cannot start the free trial again.",
} as const;

/** "You are now on the Pro plan." */
export function movedLine(card: Pick<PlanOffer, "name">): string {
  return `You are now on ${theNamedPlan(card.name)}.`;
}

/** "the Pro plan". A plan its creator called "Pro plan" is not "the Pro plan plan". */
function theNamedPlan(raw: string): string {
  const name = raw.trim();
  if (!name) return "this plan";
  return /\bplan$/i.test(name) ? `the ${name}` : `the ${name} plan`;
}

/**
 * The zone a plan's days are written in when the page names none: the one
 * the agent's own page writes them in, so "Renews 12 Nov." is the same day
 * on both.
 */
const PLAN_DAY_ZONE = "UTC";

const datesOf = (fmt: InstalledFormat) => ({ timeZone: fmt.timeZone ?? PLAN_DAY_ZONE });

// ---------------------------------------------------------------------------
// Whether a row is on a plan
// ---------------------------------------------------------------------------

/**
 * The plan this row's buyer is on, while it gives them uses. Null for every
 * other row: a copy, a month with no count, a buyer who pays per use, a plan
 * that is over. Those rows are not this file's.
 */
export function planOfInstall(install: InstalledLicence): PaidUsePlan | null {
  const plan = install.subscription?.plan;
  if (install.kind !== "use" || install.access !== "subscribed" || !plan) return null;
  // A plan whose count cannot be read is not drawn as one.
  return planCountOf(plan) ? plan : null;
}

/** Whether the row is on the listing's free trial: a plan the API marks as one. */
export function onTrial(install: InstalledLicence): boolean {
  return planOfInstall(install)?.trial === true;
}

/** The listing sells use of this agent today. */
function sellsUseNow(install: InstalledLicence): boolean {
  return install.listing.status === "published" && install.listing.sells === "use";
}

/**
 * What a use past the trial's uses costs this buyer: the listing's price per
 * use, when they agreed to a price per use themselves and the listing does
 * not ask more than that. Null otherwise: the trial then stops and they
 * choose. The rule the API charges by.
 */
function perUseAfterTrial(install: InstalledLicence): PaidPrice | null {
  const { listing } = install;
  const agreed = install.acceptedPricing;
  if (!sellsUseNow(install) || listing.pricingModel !== "per_request" || !listing.pricePerRequestCents) return null;
  if (agreed?.pricingModel !== "per_request" || agreed.pricePerRequestCents == null) return null;
  if (listing.pricePerRequestCents > agreed.pricePerRequestCents) return null;
  return { model: "per_request", cents: listing.pricePerRequestCents, unit: listing.unit === "run" ? "run" : "message" };
}

/** The plans the listing offers now, as the API sent them with the install. */
function plansOnOffer(install: InstalledLicence): PlanOffer[] {
  return sellsUseNow(install) ? plansOf(install.listing.plans) : [];
}

// ---------------------------------------------------------------------------
// The badge and the line
// ---------------------------------------------------------------------------

/**
 * "Starter, $9.00 for 30 days". The price is the one this buyer agreed to
 * (the subscription's own), which is what a renewal charges; the plan's
 * price today can differ. A free trial has no price: its badge is
 * "Free trial". Null when the row is not on a plan.
 */
export function planBadge(install: InstalledLicence): string | null {
  const plan = planOfInstall(install);
  if (!plan) return null;
  if (plan.trial === true) return TRIAL_WORDS.name;
  const name = plan.name.trim();
  const agreed = install.subscription?.priceCents ?? null;
  if (agreed === null) return name || "Plan";
  const price = `${formatCents(agreed)} for 30 days`;
  return name ? `${name}, ${price}` : price;
}

/**
 * A renewal that was not paid and is being retried. `before` is the day
 * access ends unless credits are added, already written as a day.
 */
export function renewalNotThroughLine(priceCents: number | null, before: string): string {
  return priceCents !== null
    ? `Your renewal of ${formatCents(priceCents)} did not go through. Add credits before ${before} to keep access.`
    : `Your renewal did not go through. Add credits before ${before} to keep access.`;
}

/**
 * The line under the row: what is left of the plan, in the words of the
 * agent's page. While a renewal is being retried the row says that first,
 * then the count with no day in it (the period's end is behind the buyer).
 * Someone who may not spend is not told to move up: the row does not offer
 * it to them. A free trial's line is its own count, as the agent's page
 * says it. Null when the row is not on a plan.
 */
export function planLine(
  install: InstalledLicence,
  fmt: InstalledFormat = {},
  viewer: InstalledViewer = {},
): InstalledLine | null {
  const plan = planOfInstall(install);
  const sub = install.subscription;
  const read = planCountOf(plan);
  if (!plan || !sub || !read) return null;
  if (plan.trial === true) {
    const text = trialCountLine({
      plan: read,
      endsAt: sub.currentPeriodEnd,
      // An agent that is no longer sold for use has nothing to choose: the line then only counts.
      ...(sellsUseNow(install) && { perUse: perUseAfterTrial(install) }),
      dates: datesOf(fmt),
    });
    // The words never change before the uses are gone; from 85% used the line takes the tone of a plan's warning.
    return { text, tone: read.remainingUses > 0 && read.warning === null ? "ok" : "warn" };
  }
  // An agent that is no longer sold for use sells no extra use either, whatever the plan agreed:
  // past its count the plan stops, and the line must not name a charge.
  const count = sellsUseNow(install) ? read : { ...read, extraUsePriceCents: null };
  const dates = datesOf(fmt);
  const pastDue = sub.status === "past_due";
  // The row offers Move up whenever a bigger plan is on offer, so the line may point at it. Not to a
  // member who may not spend, whose row does not offer it.
  const moveUp = viewer.canSpend !== false && biggerPlans(install).length > 0;
  const text = planCountLine({ plan: count, endsAt: sub.currentPeriodEnd, pastDue, moveUp, dates });
  if (pastDue) {
    const before = shortDay(sub.graceEndsAt ?? sub.currentPeriodEnd, dates);
    return { text: `${renewalNotThroughLine(sub.priceCents, before)} ${text}`, tone: "warn" };
  }
  // Quiet only while there are uses left, no warning, and the plan will renew.
  const quiet = count.warning === null && count.remainingUses > 0 && Boolean(count.resetsAt);
  return { text, tone: quiet ? "ok" : "warn" };
}

// ---------------------------------------------------------------------------
// The renewal
// ---------------------------------------------------------------------------

/**
 * What the row offers about the renewal:
 *
 *   cancel   the plan will be charged again when its 30 days end (the API
 *            says when the count starts again)
 *   resume   the buyer cancelled the renewal, and the plan is still on
 *            offer, so turning it back on means something
 *   null     nothing to offer: not on a plan, or the plan will not renew
 *            whatever the buyer chooses (its creator ended it, the agent is
 *            no longer sold this way, or it is a free trial)
 */
export function planRenewal(install: InstalledLicence): "cancel" | "resume" | null {
  const plan = planOfInstall(install);
  const sub = install.subscription;
  if (!plan || !sub || plan.trial === true) return null;
  if (sub.cancelAtPeriodEnd) {
    return plansOnOffer(install).some((offer) => offer.id === plan.id) ? "resume" : null;
  }
  return plan.resetsAt ? "cancel" : null;
}

// ---------------------------------------------------------------------------
// Moving up
// ---------------------------------------------------------------------------

/**
 * The plans this buyer can move up to: the ones the listing offers now that
 * cost more for their 30 days than the price the buyer agreed to, the rule
 * the API holds a move to. Empty when there is none, for a row that is not
 * on a plan, and for a free trial: nobody moves up from one (a plan is
 * started over it on the agent's page).
 */
export function biggerPlans(install: InstalledLicence): PlanOffer[] {
  const plan = planOfInstall(install);
  const agreed = install.subscription?.priceCents ?? null;
  if (!plan || agreed === null || plan.trial === true) return [];
  return plansOnOffer(install).filter((offer) => offer.id !== plan.id && offer.priceCents > agreed);
}

/**
 * How many uses a move carries into the new 30 days, as the API will count
 * it: the uses that are left, and at most the number the plan being left
 * included (uses carried in by an earlier move are not carried again). The
 * rule is written once, for the agent's page (lib/use-plans.ts).
 */
export function carriedIntoMove(plan: Pick<PaidUsePlan, "includedUses" | "remainingUses">): number {
  return carriedOnMove(plan);
}

/** One of the bigger plans, as the dialog that lists them draws it. */
export interface MoveUpCard {
  id: string;
  name: string;
  /** "$29.00 for 30 days". */
  price: string;
  /** "2000 uses". */
  uses: string;
  /** "then $0.04 a use", or "then it stops until it renews". */
  after: string;
  /** What the card's button is called for someone who does not see the card: "Move up to the Pro plan". */
  moveLabel: string;
  /** The plan as it was offered: what the confirm names and what its terms are taken from. */
  offer: PlanOffer;
}

export interface MoveUpChoice {
  title: string;
  intro: string;
  cards: MoveUpCard[];
}

/** The dialog that lists the bigger plans. Null when the row is not on a plan, and for a free trial. */
export function moveUpChoice(install: InstalledLicence): MoveUpChoice | null {
  if (!planOfInstall(install) || onTrial(install)) return null;
  return {
    title: `Move up on ${install.listing.title}`,
    intro: INSTALLED_PLAN_WORDS.chooseIntro,
    cards: biggerPlans(install).map((offer) => ({
      id: offer.id,
      name: offer.name.trim(),
      price: planPriceLine(offer),
      uses: planUsesLine(offer),
      after: planAfterLine(offer),
      moveLabel: `${INSTALLED_PLAN_WORDS.moveUp} to ${theNamedPlan(offer.name)}`,
      offer,
    })),
  };
}

/** What agreeing to a move sends, and what it was shown. */
export interface MoveUpConfirm extends InstalledConfirm {
  /** The terms of the plan that was chosen: the buyer's consent, sent as they are. */
  terms: PlanTerms;
}

/**
 * The confirm of a move: "Starts a new 30 days today and charges $29.00 from
 * your credits. The 188 uses you have left are added to it." With nothing
 * left, the second sentence is left out. Its `terms` are the chosen plan's,
 * taken here, once, so what is sent is what this dialog named. Null when the
 * row is not on a plan, and for a free trial.
 */
export function moveUpConfirm(install: InstalledLicence, offer: PlanOffer): MoveUpConfirm | null {
  const plan = planOfInstall(install);
  if (!plan || plan.trial === true) return null;
  // The agent's page asks the same thing in the same words: one dialog for both. When a move carries
  // fewer uses than are left (some were carried in before), it says both numbers.
  const left = Number.isFinite(plan.remainingUses) ? Math.max(0, Math.floor(plan.remainingUses)) : 0;
  const dialog = planMoveDialog(offer, carriedIntoMove(plan), left);
  return {
    title: dialog.title,
    description: dialog.body,
    confirmLabel: dialog.confirmLabel,
    terms: planTermsOf(offer),
  };
}

/**
 * A move that was refused. Nothing was charged on any refusal the API
 * answers. Its own sentence is shown as it comes: the plan changed, too few
 * credits, not a bigger plan, a change that got there first, a member who
 * may not spend. `addCredits`: the one refusal with something to do about
 * it. The page reads its rows again after every one of them, so the choices
 * and the count are the API's again.
 */
export function moveUpRefusal(status: number, sentence: string | null | undefined): { message: string; addCredits: boolean } {
  const said = (sentence ?? "").trim();
  return { message: said || INSTALLED_PLAN_WORDS.moveFailed, addCredits: status === 402 };
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/**
 * What "Stop using" asks before it ends a plan: it ends now, and the 30 days
 * paid for are not refunded. A free trial was not paid for: stopping it
 * gives up the trial, which cannot be started a second time. Null when the
 * row is not on a plan.
 */
export function planStopSentence(install: InstalledLicence, fmt: InstalledFormat = {}): string | null {
  const sub = install.subscription;
  if (!planOfInstall(install) || !sub) return null;
  if (onTrial(install)) return INSTALLED_PLAN_WORDS.stopTrial;
  // A renewal that did not go through: the 30 days paid for are already over, so there is no day to
  // keep access until and nothing to refund.
  if (sub.status === "past_due") return "This ends your plan and your access now. You are not charged again.";
  const until = shortDay(sub.currentPeriodEnd, datesOf(fmt));
  return planRenewal(install) === "cancel"
    ? `This ends your plan now. The 30 days you paid for (until ${until}) are not refunded. To keep access until then, cancel renewal instead.`
    : `This ends your access now. The 30 days you paid for (until ${until}) are not refunded.`;
}
