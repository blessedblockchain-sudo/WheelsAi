/**
 * What an agent's public page shows someone who pays to use it, and the page
 * of a workflow on sale (/w/<slug>), which is drawn by the same gate. Pure:
 * the page passes what the API said (the terms, the caller's access, a
 * refusal, what a use cost) and draws the sentence and the one action that
 * come back.
 *
 * The sentences that name what is sold say "agent" on an agent's page and
 * "workflow" on a workflow's: the functions that word them take the subject,
 * and an agent's are what they always were. A workflow's page never names a
 * step, an agent or a model inside it, tokens or who sells it.
 *
 * Every amount here was sent by the API, in cents. Nothing is charged, read
 * or kept by this file.
 */
import { describeSchedule } from "@wheelsai/shared/schedule-choice";

import { formatCents } from "./agent-page";
import type {
  MarketplacePricingTerms,
  PaidUseAccessState,
  PaidUseBilling,
  PaidUseRefusal,
  PaidUseTerms,
  PaidWorkflowAccessState,
  PublicAgentPaidTerms,
  PublicWorkflowRead,
} from "./api";
import { AGENT_PAUSED_MESSAGE, LISTING_PAUSED_START_MESSAGE } from "./listing-pause";
import { PUBLIC_USE_MESSAGES } from "./public-use";
import type { FormValues } from "./schema-form";

// ============================================
// The price
// ============================================

export type PaidUnit = "message" | "run" | "month";

/** How the agent on the page is used. */
export type PaidAgentKind = "chat" | "task" | "scheduled";

/** One price as a person reads it: so much per message or run, or so much a month. */
export interface PaidPrice {
  model: "per_request" | "monthly";
  cents: number;
  unit: PaidUnit;
}

export const PAID_USE_MESSAGES = {
  paidFromCredits: "Paid from your WheelsAI credits.",
  signIn: "Sign in to use this agent.",
  signInButton: "Sign in",
  createAccount: "Create an account",
  tryFree: "Try it free first",
  draftKept: "Your answers are kept on this device while you sign in.",
  startButton: "Start using",
  askAdmin: "Ask an owner or admin of your organization to start this.",
  waiting: "Working on your answer…",
  addCredits: "Add credits",
  ownAgent: "This is your agent. This is the page people who pay see.",
  ended: "Your subscription has ended. Subscribe again to keep using it.",
  subscribeAgain: "Subscribe again",
  notOffered: "This agent is no longer offered. You will not be charged again.",
  notOfferedNeverStarted: "This agent is no longer offered.",
  noCopy: "WheelsAI does not give the owner of this agent a copy of what you send.",
  keepsCopy: "The owner of this agent gets a copy of what you send and what it answers.",
  sendsRequests: "This agent can send requests to other websites as part of its answers.",
  runsOnItsOwn: "This agent runs on its own. Subscribers read its results here.",
  notStarted: "You have not started using this agent.",
  includedInSubscription: "Included in your subscription.",
  includedInPlan: "Included in your plan.",
  planEnded: "Your plan ended. Choose a plan or pay per use to keep using it.",
  // A listing's free trial: some uses for some days, started once by a buyer's organization. Not the
  // free messages of a listing's own page ("Try it free first"), which are anyone's.
  includedInTrial: "Included in your free trial.",
  trialEnded: "Your free trial ended. Choose a plan or pay per use to keep using it.",
  offline: "The agent could not be reached. Check your connection and try again.",
  unknown: "Something went wrong. Please try again.",
} as const;

// ============================================
// What is sold: an agent or a workflow
// ============================================

/** What the page sells. Its sentences are worded for it. */
export type PaidSubject = "agent" | "workflow";

/** The sentences of the page that name what is sold. */
export interface PaidSubjectWords {
  signIn: string;
  /** Said to the owner on their own page. */
  own: string;
  notOffered: string;
  notOfferedNeverStarted: string;
  notStarted: string;
  /** The two privacy sentences. */
  keepsCopy: string;
  noCopy: string;
  offline: string;
  /** Said when the API answered 404 with no sentence of its own. */
  notFound: string;
}

const AGENT_WORDS: PaidSubjectWords = {
  signIn: PAID_USE_MESSAGES.signIn,
  own: PAID_USE_MESSAGES.ownAgent,
  notOffered: PAID_USE_MESSAGES.notOffered,
  notOfferedNeverStarted: PAID_USE_MESSAGES.notOfferedNeverStarted,
  notStarted: PAID_USE_MESSAGES.notStarted,
  keepsCopy: PAID_USE_MESSAGES.keepsCopy,
  noCopy: PAID_USE_MESSAGES.noCopy,
  offline: PAID_USE_MESSAGES.offline,
  notFound: "This agent was not found.",
};

/**
 * A workflow's page, in its own words. The owner's sentence and "not found"
 * are the API's own (PAID_USE_MESSAGES.workflow in
 * apps/api/src/services/paidUse.ts); the copy sentence is the design's.
 */
export const PAID_WORKFLOW_MESSAGES = {
  signIn: "Sign in to use this workflow.",
  own: "This is your workflow. This is the page people who pay see.",
  notOffered: "This workflow is no longer offered. You will not be charged again.",
  notOfferedNeverStarted: "This workflow is no longer offered.",
  notStarted: "You have not started using this workflow.",
  keepsCopy: "The owner of this workflow gets a copy of what you send and what it answers.",
  noCopy: "WheelsAI does not give the owner of this workflow a copy of what you send.",
  offline: "The workflow could not be reached. Check your connection and try again.",
  notFound: "This workflow was not found.",
  /** The heading of the form on the page. */
  panelTitle: "Run it",
  notFoundTitle: "Workflow not found",
  notFoundPage: "This workflow doesn't exist or isn't on sale.",
  loadFailed: "Couldn't load this workflow",
  /**
   * Said under the form after the person pressed Stop (or the run was cancelled some other way while the
   * page was open). The run was cancelled with its request, so no answer of the API is read here: the API
   * gives back what it took for a run that was not delivered, and the credits on the page are read again.
   */
  stopped: "You stopped the run. What was charged is refunded, or the use is given back to your plan.",
} as const;

/** The sentences that name what is sold, for that subject. An agent's are PAID_USE_MESSAGES' own. */
export function paidWordsOf(subject: PaidSubject = "agent"): PaidSubjectWords {
  return subject === "workflow" ? PAID_WORKFLOW_MESSAGES : AGENT_WORDS;
}

/**
 * "A run can take up to 10 minutes." From the API's number, on the page and on
 * its API page alike; null when the API sent no number above zero, so no
 * time is ever said that the API did not give.
 */
export function runTimeLimit(maxRunMinutes: unknown): string | null {
  if (typeof maxRunMinutes !== "number" || !Number.isFinite(maxRunMinutes) || maxRunMinutes <= 0) return null;
  const minutes = Math.ceil(maxRunMinutes);
  return `A run can take up to ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** "A run can take up to 10 minutes. Keep this page open: closing it cancels the run." The second part alone with no time. */
export function runTimeNote(maxRunMinutes: number): string {
  const keepOpen = "Keep this page open: closing it cancels the run.";
  const limit = runTimeLimit(maxRunMinutes);
  return limit ? `${limit} ${keepOpen}` : keepOpen;
}

/**
 * When the page reads the access again after a run was stopped. The API gives
 * the charge or the use back only once the cancelled run has ended, which
 * comes after the read made at the moment of Stop; these later reads bring the
 * credits and the count on the page level with the refund.
 */
export const STOPPED_REREADS_MS: readonly number[] = [5_000, 30_000];

/**
 * The terms a workflow's page shows before anyone signs in, in the shape the
 * gate reads an agent's in. A workflow is sold per run only, so the two
 * numbers a month's sentence would say are never said; the owner always keeps
 * a copy; the line an agent's page says about sending requests to other
 * websites is not said; and there is no free trial.
 */
export function workflowPageTerms(read: PublicWorkflowRead): PublicAgentPaidTerms {
  return {
    listingId: read.listingId,
    listingSlug: read.slug,
    pricingModel: "per_request",
    priceCents: read.priceCents,
    unit: "run",
    // Said only in the dialog of a month, which a workflow never has.
    perMinute: 0,
    perDay: 0,
    transcriptsStored: true,
    sendsRequests: false,
    plans: Array.isArray(read.plans) ? read.plans : [],
    trial: null,
  };
}

/**
 * The access of a workflow, in the shape the gate draws an agent's: its owner
 * is the agent's owner case, worded for a workflow by the page's subject.
 * Nothing else changes: a workflow has no free trial, no copy and no pause.
 */
export function workflowAccessAsAgent(state: PaidWorkflowAccessState): PaidUseAccessState {
  return { ...state, access: state.access === "own_workflow" ? "own_agent" : state.access };
}

/** Whether a body read from the API is a workflow's public page. Anything else is a failed read, never drawn in part. */
export function isPublicWorkflowRead(body: unknown): body is PublicWorkflowRead {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const read = body as Partial<PublicWorkflowRead>;
  const text = (value: unknown) => typeof value === "string" && value.trim() !== "";
  if (read.kind !== "workflow" || !text(read.listingId) || !text(read.slug) || !text(read.title)) return false;
  if (typeof read.priceCents !== "number" || typeof read.maxRunMinutes !== "number") return false;
  const input = read.input as Partial<PublicWorkflowRead["input"]> | undefined;
  return (
    typeof input === "object" &&
    input !== null &&
    typeof input.schema === "object" &&
    input.schema !== null &&
    typeof input.maxInputBytes === "number"
  );
}

/** "$0.05", "$9.00": cents as dollars with two decimals. */
export function dollars(cents: number): string {
  return formatCents(Number.isFinite(cents) ? cents : 0);
}

/** The price on the page before anyone has signed in. */
export function priceOfPage(terms: PublicAgentPaidTerms): PaidPrice {
  const monthly = terms.pricingModel === "monthly";
  return { model: monthly ? "monthly" : "per_request", cents: terms.priceCents, unit: monthly ? "month" : terms.unit };
}

/** The price in the terms the API gave a signed-in caller; null when they name no price. */
export function priceOfTerms(terms: PaidUseTerms | null | undefined): PaidPrice | null {
  if (!terms) return null;
  if (terms.pricingModel === "monthly") {
    return typeof terms.monthlyPriceCents === "number" ? { model: "monthly", cents: terms.monthlyPriceCents, unit: "month" } : null;
  }
  if (terms.pricingModel === "per_request") {
    return typeof terms.pricePerRequestCents === "number"
      ? { model: "per_request", cents: terms.pricePerRequestCents, unit: terms.unit === "run" ? "run" : "message" }
      : null;
  }
  return null;
}

/** "$0.05 per message", "$0.10 per run", "$9.00 a month". */
export function priceLine(price: PaidPrice): string {
  return price.model === "monthly" ? `${dollars(price.cents)} a month` : `${dollars(price.cents)} per ${price.unit}`;
}

/** "Subscribe for $9.00 a month". */
export function subscribeLabel(price: PaidPrice): string {
  return `Subscribe for ${priceLine(price)}`;
}

/** "Accept $0.08 per message". */
export function acceptLabel(price: PaidPrice): string {
  return `Accept ${priceLine(price)}`;
}

/**
 * The terms a person was shown, in the shape a start sends back as
 * `expected`. Built from the terms on screen and nothing else, so a click
 * agrees to that price and no other.
 */
export function expectedTerms(terms: PaidUseTerms): MarketplacePricingTerms {
  return {
    pricingModel: terms.pricingModel as MarketplacePricingTerms["pricingModel"],
    pricePerRequestCents: terms.pricePerRequestCents,
    monthlyPriceCents: terms.monthlyPriceCents,
  };
}

/** Which of the two privacy sentences the page says. */
export function privacyLine(keepsCopy: boolean, subject: PaidSubject = "agent"): string {
  const words = paidWordsOf(subject);
  return keepsCopy ? words.keepsCopy : words.noCopy;
}

// ============================================
// Dates
// ============================================

export interface DateWords {
  locale?: string;
  timeZone?: string;
  /** Said after a time that is not in the viewer's own zone: "UTC". */
  mark?: string;
}

/** "12 Nov". "" when it is not a date. */
export function shortDay(iso: string | null | undefined, words: DateWords = {}): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(words.locale ?? "en-GB", {
    day: "numeric",
    month: "short",
    ...(words.timeZone ? { timeZone: words.timeZone } : {}),
  });
}

/** "Last result: 12 Oct, 09:00." null when there is none yet. */
export function lastResultLine(iso: string | null | undefined, words: DateWords = {}): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = shortDay(iso, words);
  const time = date.toLocaleTimeString(words.locale ?? "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(words.timeZone ? { timeZone: words.timeZone } : {}),
  });
  return `Last result: ${day}, ${time}${words.mark ? ` ${words.mark}` : ""}.`;
}

/** "Runs every day at 09:00." and the time zone its times are in. Empty when no schedule is set. */
export function scheduleLines(schedule: { cronExpression: string; timezone: string } | null | undefined): string[] {
  const cron = schedule?.cronExpression?.trim();
  if (!schedule || !cron) return [];
  const zone = schedule.timezone?.trim();
  return [describeSchedule(cron), ...(zone ? [`Times are in ${zone}.`] : [])];
}

// ============================================
// The one view of the page
// ============================================

export type PaidActionKind = "signin" | "start" | "accept" | "subscribe" | "add_credits" | "wait" | "none";

export interface PaidAction {
  kind: PaidActionKind;
  /** The words on the button or link; null when there is nothing to press. */
  label: string | null;
}

const NO_ACTION: PaidAction = { kind: "none", label: null };

/** What a person reads and agrees to before a start or a subscription. */
export interface PaidDialog {
  title: string;
  body: string;
  /** The button that agrees. It names the price. */
  confirmLabel: string;
}

export type PaidViewKind =
  | "signed_out"
  | "own_agent"
  | "not_started"
  | "ask_admin"
  | "start_blocked"
  | "price_changed"
  | "lapsed"
  | "plan_ended"
  | "not_offered"
  | "in_use";

export interface PaidView {
  kind: PaidViewKind;
  /** The sentence that says where the person stands. */
  sentence: string;
  action: PaidAction;
  /** Whether the agent answers this person now (or, for a self-running agent, shows them its results). */
  usable: boolean;
  /** The price the person is shown, and would agree to by the action; null when none is offered. */
  price: PaidPrice | null;
  /** What `start` or `subscribe` asks before it charges; null for any other action. */
  dialog: PaidDialog | null;
  /** True when the action agrees to a price that replaces one agreed to earlier. */
  acceptNewPricing: boolean;
  /** "You have credits for about 3 more messages." Set only when credits cover three uses or fewer. */
  lowCredits: string | null;
}

/**
 * The terms on the public page, and what the page sells. An agent's page
 * says nothing of `subject`: its sentences are an agent's.
 */
export type PaidPageTerms = PublicAgentPaidTerms & { subject?: PaidSubject };

/** The page's terms with what it sells, for the view: the gate words its sentences by it. */
export function pageTermsFor(terms: PublicAgentPaidTerms, subject: PaidSubject): PaidPageTerms {
  return subject === "agent" ? terms : { ...terms, subject };
}

export interface PaidViewInput {
  /** Whether someone is signed in. */
  authed: boolean;
  /** The access the API answered for them; null while signed out. */
  access: PaidUseAccessState | null;
  /** The terms on the public page, for someone who has not signed in, and what the page sells. */
  page: PaidPageTerms;
  kind: PaidAgentKind;
  /** How dates are written; the viewer's own by default. */
  dates?: DateWords;
}

const plural = (count: number, unit: PaidUnit) => `${count} more ${unit}${count === 1 ? "" : "s"}`;

/**
 * The dialog that starts per-use: "Each message costs $0.05, paid from your credits. ..."
 *
 * `opening` takes the place of that first sentence for someone whose uses are
 * not charged from the first one on: on a free trial, where the free uses
 * come first (lib/use-plans.ts). The rest is said to everyone.
 */
export function startDialog(price: PaidPrice, opening?: string, subject: PaidSubject = "agent"): PaidDialog {
  const first = opening ?? `Each ${price.unit} costs ${dollars(price.cents)}, paid from your credits.`;
  return {
    title: `Start using this ${subject}?`,
    body: `${first} It is charged when you send it and refunded if the ${subject} does not answer. You can stop at any time.`,
    confirmLabel: `Start at ${priceLine(price)}`,
  };
}

/** The dialog that subscribes: "Charges $9.00 from your credits now and every 30 days. ..." */
export function subscribeDialog(price: PaidPrice, kind: PaidAgentKind, perDay: number, subject: PaidSubject = "agent"): PaidDialog {
  const what =
    kind === "scheduled" ? "You can read its results on this page." : `You can use it up to ${perDay} times a day.`;
  return {
    title: `Subscribe to this ${subject}?`,
    body: `Charges ${dollars(price.cents)} from your credits now and every 30 days. ${what} Cancel at any time and keep access until the month you paid for ends.`,
    confirmLabel: subscribeLabel(price),
  };
}

/** How many more uses the credits cover; null when the price is not a per-use price above zero. */
export function usesLeft(balanceCents: number, price: PaidPrice | null): number | null {
  if (!price || price.model !== "per_request" || !(price.cents > 0)) return null;
  return Math.max(0, Math.floor(balanceCents / price.cents));
}

/** The low-credits line, only when credits cover three uses or fewer. */
export function lowCreditsLine(balanceCents: number, price: PaidPrice | null): string | null {
  const left = usesLeft(balanceCents, price);
  if (left === null || !price || left > 3) return null;
  if (left === 0) return `You do not have credits for another ${price.unit}.`;
  return `You have credits for about ${plural(left, price.unit)}.`;
}

function view(kind: PaidViewKind, sentence: string, extra: Partial<PaidView> = {}): PaidView {
  return {
    kind,
    sentence,
    action: NO_ACTION,
    usable: false,
    price: null,
    dialog: null,
    acceptNewPricing: false,
    lowCredits: null,
    ...extra,
  };
}

/** What a person who may start is offered: per use, or by the month. */
function offer(
  price: PaidPrice,
  kind: PaidAgentKind,
  perDay: number,
  subject: PaidSubject,
): Pick<PaidView, "action" | "dialog" | "price"> {
  return price.model === "monthly"
    ? { action: { kind: "subscribe", label: subscribeLabel(price) }, dialog: subscribeDialog(price, kind, perDay, subject), price }
    : { action: { kind: "start", label: PAID_USE_MESSAGES.startButton }, dialog: startDialog(price, undefined, subject), price };
}

function notStartedSentence(price: PaidPrice, kind: PaidAgentKind, subject: PaidSubject): string {
  if (subject === "workflow") {
    return price.model === "monthly" ? "Subscribe to use this workflow." : "Start using this workflow to run it.";
  }
  if (price.model === "monthly") {
    return kind === "scheduled" ? "Subscribe to read this agent's results." : "Subscribe to use this agent.";
  }
  return kind === "task" ? "Start using this agent to give it a task." : "Start using this agent to send it a message.";
}

/** The sentence for a price that is not the one the person agreed to. */
export function priceChangedSentence(
  now: PaidPrice,
  accepted: PaidUseAccessState["accepted"],
  subject: PaidSubject = "agent",
): string {
  if (now.model === "monthly") {
    // The same amount as before is not a changed price: the subscription ended and the agent is on sale again.
    if (accepted?.pricingModel === "monthly" && accepted.monthlyPriceCents !== now.cents) {
      const agreed = typeof accepted.monthlyPriceCents === "number" ? ` You agreed to ${dollars(accepted.monthlyPriceCents)}.` : "";
      return `The owner changed the price to ${priceLine(now)}.${agreed} Nothing is charged until you subscribe.`;
    }
    return `This ${subject} is now sold by the month (${dollars(now.cents)}). Nothing is charged until you subscribe.`;
  }
  if (accepted?.pricingModel === "per_request" && typeof accepted.pricePerRequestCents === "number") {
    return `The owner changed the price to ${priceLine(now)}. You agreed to ${dollars(accepted.pricePerRequestCents)}. Nothing is charged until you accept the new price.`;
  }
  return `This ${subject} is now sold per ${now.unit} (${dollars(now.cents)}). Nothing is charged until you accept the new price.`;
}

function subscribedSentence(state: PaidUseAccessState, dates: DateWords, subject: PaidSubject): string {
  const sub = state.subscription;
  const until = shortDay(sub?.currentPeriodEnd, dates);
  const agreed = typeof state.accepted?.monthlyPriceCents === "number" ? state.accepted.monthlyPriceCents : null;
  if (!sub || !until) return "You are subscribed.";
  if (state.terms === null) return `This ${subject} is no longer offered. You keep access until ${until}.`;
  if (sub.status === "past_due") {
    // The day the grace ends, when the API says it; the page never works one out.
    const grace = shortDay(sub.graceEndsAt, dates);
    const amount = agreed !== null ? ` of ${dollars(agreed)}` : "";
    return `Your renewal${amount} did not go through. Add credits${grace ? ` before ${grace}` : ""} to keep access.`;
  }
  if (sub.cancelAtPeriodEnd) return `Cancelled. You keep access until ${until}.`;
  return agreed !== null
    ? `You are subscribed. Renews ${until} at ${dollars(agreed)} a month.`
    : `You are subscribed. Renews ${until}.`;
}

/**
 * Where a person stands with a paid agent, from whether they are signed in
 * and what the API answered about their access: one sentence, one action.
 */
export function paidView(input: PaidViewInput): PaidView {
  const { access: state, page, kind } = input;
  const dates = input.dates ?? {};
  const pagePrice = priceOfPage(page);
  const subject: PaidSubject = page.subject ?? "agent";
  const words = paidWordsOf(subject);

  if (!input.authed || !state) {
    return view("signed_out", words.signIn, {
      action: { kind: "signin", label: PAID_USE_MESSAGES.signInButton },
      price: pagePrice,
    });
  }

  const price = priceOfTerms(state.terms);

  switch (state.access) {
    case "own_agent":
      return view("own_agent", words.own, { price: price ?? pagePrice });

    case "subscribed": {
      const pastDue = state.subscription?.status === "past_due";
      return view("in_use", subscribedSentence(state, dates, subject), {
        usable: true,
        price,
        action: pastDue ? { kind: "add_credits", label: PAID_USE_MESSAGES.addCredits } : NO_ACTION,
      });
    }

    case "listing_pricing": {
      if (!price) return view("in_use", `Your credits: ${dollars(state.balanceCents)}.`, { usable: true });
      const low = lowCreditsLine(state.balanceCents, price);
      return view("in_use", `${priceLine(price)}. Your credits: ${dollars(state.balanceCents)}.`, {
        usable: true,
        price,
        lowCredits: low,
        action: low ? { kind: "add_credits", label: PAID_USE_MESSAGES.addCredits } : NO_ACTION,
      });
    }

    case "pricing_changed": {
      if (!price) return view("not_offered", words.notOffered);
      const sentence = priceChangedSentence(price, state.accepted, subject);
      if (!state.canAccept) return view("price_changed", `${sentence} ${PAID_USE_MESSAGES.askAdmin}`, { price });
      return price.model === "monthly"
        ? view("price_changed", sentence, { ...offer(price, kind, page.perDay, subject), acceptNewPricing: true })
        : view("price_changed", sentence, {
            price,
            action: { kind: "accept", label: acceptLabel(price) },
            acceptNewPricing: true,
          });
    }

    case "subscription_lapsed": {
      if (!price) return view("not_offered", words.notOffered);
      if (!state.canAccept) return view("lapsed", `${PAID_USE_MESSAGES.ended} ${PAID_USE_MESSAGES.askAdmin}`, { price });
      return view("lapsed", PAID_USE_MESSAGES.ended, offer(price, kind, page.perDay, subject));
    }

    // A plan that is over, with no price per use agreed to: nothing is charged until the person chooses.
    // The plans to choose from are drawn by the page (lib/use-plans.ts); the action here is pay per use.
    case "plan_ended": {
      if (state.startBlocked) return view("start_blocked", state.startBlocked.message, { price: price ?? pagePrice });
      if (!price) return view("not_offered", words.notOffered);
      // What ended was their free trial: said as that, not as a plan.
      const ended = state.trialEnded === true ? PAID_USE_MESSAGES.trialEnded : PAID_USE_MESSAGES.planEnded;
      if (!state.canAccept) return view("plan_ended", `${ended} ${PAID_USE_MESSAGES.askAdmin}`, { price });
      return view("plan_ended", ended, offer(price, kind, page.perDay, subject));
    }

    case "not_offered":
    case "unlisted":
      return view("not_offered", words.notOffered);

    case "none":
    case "uninstalled":
    default: {
      if (state.startBlocked) return view("start_blocked", state.startBlocked.message, { price: price ?? pagePrice });
      if (!price) return view("not_offered", words.notOfferedNeverStarted);
      if (!state.canAccept) return view("ask_admin", PAID_USE_MESSAGES.askAdmin, { price });
      return view("not_started", notStartedSentence(price, kind, subject), offer(price, kind, page.perDay, subject));
    }
  }
}

// ============================================
// What a use cost
// ============================================

/**
 * Under an answer: "This message cost $0.05. Your credits: $4.90." On a plan:
 * "Included in your plan.", or "Charged $0.04." for a use past its count. On
 * a free trial: "Included in your free trial.", and past its uses, for
 * someone who agreed to the price per use, "Charged $0.05."
 */
export function chargeLine(billing: PaidUseBilling, unit: PaidUnit): string {
  const planUse = billing.plan?.use;
  if (planUse === "included") {
    return billing.plan?.trial === true ? PAID_USE_MESSAGES.includedInTrial : PAID_USE_MESSAGES.includedInPlan;
  }
  if (planUse === "extra" && billing.chargedCents > 0) return `Charged ${dollars(billing.chargedCents)}.`;
  if (billing.access === "subscribed") return PAID_USE_MESSAGES.includedInSubscription;
  const word = unit === "run" ? "run" : "message";
  const credits = typeof billing.balanceCents === "number" ? ` Your credits: ${dollars(billing.balanceCents)}.` : "";
  if (!(billing.chargedCents > 0)) return `This ${word} was not charged.${credits}`;
  return `This ${word} cost ${dollars(billing.chargedCents)}.${credits}`;
}

// ============================================
// Refusals
// ============================================

/** What was refused: the wording of a few sentences depends on it. */
export type PaidRefusedAct = "chat" | "task" | "results" | "start";

export interface PaidNotice {
  /** The refusal's code; "" when the request never got an answer. */
  code: string;
  /** One sentence for the person. */
  message: string;
  action: PaidAction;
  /** A task's answers that need another look: the question's key to its sentence. */
  fields: Record<string, string>;
  /** How long to wait before trying again, when the server said. */
  retryAfterSeconds: number | null;
  /** What was charged for this use and given back; null when nothing was. */
  refundedCents: number | null;
  /** The price the action would agree to, when the refusal carried one. */
  price: PaidPrice | null;
}

interface CodeRule {
  action: PaidActionKind;
  /** What is said when the API sent no sentence of its own. */
  fallback: string;
}

/**
 * Every code a paid chat, run, read of results or start can be refused
 * with, the action that goes with it, and what is said when the API sent no
 * sentence of its own.
 */
export const PAID_REFUSAL_RULES: Record<string, CodeRule> = {
  // A chat or a run.
  invalid_request: { action: "none", fallback: PUBLIC_USE_MESSAGES.chatUnreadable },
  unauthorized: { action: "signin", fallback: PAID_USE_MESSAGES.signIn },
  missing_scope: { action: "none", fallback: "This API key is not allowed to pay for agents." },
  use_not_started: { action: "start", fallback: PAID_USE_MESSAGES.notStarted },
  api_key_use_price_cap_exceeded: { action: "none", fallback: "This costs more than this API key may pay for one use." },
  api_key_daily_cap_exceeded: { action: "none", fallback: "This API key has reached what it may spend in a day." },
  api_key_spend_caps_missing: { action: "none", fallback: "This API key has no spend caps for paid agents." },
  not_a_member: {
    action: "none",
    fallback: "You are no longer a member of this organization, so you cannot use this agent on its behalf.",
  },
  insufficient_credits: { action: "add_credits", fallback: "You do not have enough credits for this. Nothing was charged. Add credits to continue." },
  subscription_lapsed: { action: "subscribe", fallback: PAID_USE_MESSAGES.ended },
  // On a plan. Used up: every included use is gone and the plan has no price for an extra one.
  // Ended: the page goes back to choosing, so the sentence has no button of its own.
  plan_used_up: { action: "wait", fallback: "You have used all the uses in your plan. Nothing was charged." },
  plan_ended: { action: "none", fallback: PAID_USE_MESSAGES.planEnded },
  agent_not_found: { action: "none", fallback: "This agent was not found." },
  own_agent: { action: "none", fallback: PAID_USE_MESSAGES.ownAgent },
  not_for_sale: { action: "none", fallback: "Use of this agent is not for sale." },
  not_offered: { action: "none", fallback: PAID_USE_MESSAGES.notOffered },
  results_only: { action: "none", fallback: "This agent runs on its own. Subscribers read its results on its page." },
  pricing_changed: { action: "accept", fallback: "The owner changed the price. Nothing is charged until you accept the new price." },
  not_a_task_agent: { action: "none", fallback: "This agent does not take a task. Reload the page and try again." },
  not_a_scheduled_agent: { action: "none", fallback: "This agent does not run on its own, so it has no results to read." },
  input_too_large: { action: "none", fallback: PUBLIC_USE_MESSAGES.answersTooLong },
  input_invalid: { action: "none", fallback: PUBLIC_USE_MESSAGES.answersInvalid },
  rate_limited: { action: "wait", fallback: "This agent has reached its limit for now. Nothing was charged. Try again later." },
  too_many_refunds: { action: "wait", fallback: "Several of your answers could not be delivered today. Try again tomorrow." },
  client_closed_request: { action: "none", fallback: "The request was cancelled." },
  model_error: { action: "none", fallback: "The agent could not answer just now. Please try again." },
  answer_withheld: { action: "none", fallback: "This answer could not be shown." },
  agent_unavailable: { action: "wait", fallback: "This agent cannot be used right now. Try again later." },
  // The model the agent runs on is not running. Nothing was sent to it, so nothing was charged.
  agent_paused: { action: "wait", fallback: AGENT_PAUSED_MESSAGE },
  rate_limiter_unavailable: { action: "wait", fallback: "This agent is temporarily unavailable. Try again shortly." },
  // A start, a subscription or accepting a price.
  expected_terms_required: { action: "none", fallback: "The price could not be confirmed. Reload the page and try again." },
  listing_not_found: { action: "none", fallback: PAID_USE_MESSAGES.notOfferedNeverStarted },
  listing_paused: { action: "wait", fallback: LISTING_PAUSED_START_MESSAGE },
  sells_copies: { action: "none", fallback: "This agent is now sold as a copy. Get it from its listing." },
  subscription_claim_lost: { action: "none", fallback: "Another request for your organization got there first. Reload the page." },
  copy_subscription_active: { action: "none", fallback: "You hold a copy of this agent that is paid for. Remove your copy first." },
  // Starting a plan while a plan or a paid month still runs.
  already_on_plan: {
    action: "none",
    fallback: "You already have a plan or a subscription for this agent that is still running. Nothing was charged.",
  },
  // Starting a listing's free trial, which an organization does once. The API's own sentences
  // (TRIAL_START_MESSAGES in apps/api/src/services/trialStart.ts, PLAN_MOVE_MESSAGES in planMove.ts).
  trial_already_used: {
    action: "none",
    fallback: "You have already used the free trial of this agent. Choose a plan or pay per use to keep using it.",
  },
  trial_needs_credits: {
    action: "add_credits",
    fallback: "Add credits to your account once to start a free trial. The trial itself costs nothing.",
  },
  // Moving up from a free trial: a plan is started over it in the usual way.
  trial_cannot_move: {
    action: "none",
    fallback: "You are on a free trial. Start the plan you want: nothing of the trial is carried over.",
  },
};

/**
 * The codes whose sentence names nothing that is sold (credits, a key's caps,
 * a plan's count, a price, an answer that could not be delivered): a
 * workflow's page says them as an agent's does, from PAID_REFUSAL_RULES, so a
 * sentence is written once.
 */
const SHARED_REFUSAL_CODES = [
  "api_key_use_price_cap_exceeded",
  "api_key_daily_cap_exceeded",
  "insufficient_credits",
  "subscription_lapsed",
  "plan_used_up",
  "plan_ended",
  "pricing_changed",
  "input_too_large",
  "input_invalid",
  "too_many_refunds",
  "client_closed_request",
  "answer_withheld",
  "expected_terms_required",
  "subscription_claim_lost",
] as const;

/**
 * The same for a workflow's page, which meets the codes of a paid run of a
 * workflow, of a start and of a plan. Where the API words a sentence for a
 * workflow it is that sentence (PAID_USE_MESSAGES.workflow and the API page's
 * refusals in apps/api/src/services/paidUse.ts and workflowPublicPage.ts); the
 * API sends one with every refusal, so these are said only when it did not.
 * No fallback here names an agent, and the codes of an agent alone (its kinds,
 * its pause, its copies, its free trial) are not here: an unknown code says
 * the API's sentence, or that something went wrong.
 */
export const PAID_WORKFLOW_REFUSAL_RULES: Record<string, CodeRule> = {
  ...Object.fromEntries(SHARED_REFUSAL_CODES.map((code) => [code, PAID_REFUSAL_RULES[code]])),
  // The codes whose agent's sentence names the agent: the workflow's own words.
  invalid_request: { action: "none", fallback: PUBLIC_USE_MESSAGES.answersUnreadable },
  unauthorized: { action: "signin", fallback: PAID_WORKFLOW_MESSAGES.signIn },
  missing_scope: { action: "none", fallback: "This API key is not allowed to pay for a run." },
  use_not_started: { action: "start", fallback: PAID_WORKFLOW_MESSAGES.notStarted },
  api_key_spend_caps_missing: {
    action: "none",
    fallback: "This API key has no spend caps, so it cannot pay for a run. Nothing was charged.",
  },
  not_a_member: {
    action: "none",
    fallback: "You are no longer a member of this organization, so you cannot use this workflow on its behalf.",
  },
  workflow_not_found: { action: "none", fallback: PAID_WORKFLOW_MESSAGES.notFound },
  // The owner on their own page: a run answers own_workflow, a start own_agent with the workflow's words.
  own_workflow: { action: "none", fallback: PAID_WORKFLOW_MESSAGES.own },
  own_agent: { action: "none", fallback: PAID_WORKFLOW_MESSAGES.own },
  not_for_sale: { action: "none", fallback: "Use of this workflow is not for sale." },
  not_offered: { action: "none", fallback: PAID_WORKFLOW_MESSAGES.notOffered },
  rate_limited: { action: "wait", fallback: "This workflow has reached its limit for now. Nothing was charged. Try again later." },
  rate_limiter_unavailable: {
    action: "wait",
    fallback: "This workflow is temporarily unavailable. Nothing was charged. Try again shortly.",
  },
  // A paid run's own codes. Waiting is what a busy or unavailable workflow asks: the form stays, and it is
  // run again with its own button.
  workflow_unavailable: { action: "wait", fallback: "This workflow cannot be run right now. Nothing was charged. Try again later." },
  workflow_busy: {
    action: "wait",
    fallback: "This workflow is running as many times as it can right now. Nothing was charged. Try again in a minute.",
  },
  run_failed: { action: "none", fallback: "The workflow could not finish this run. Please try again." },
  run_timed_out: { action: "none", fallback: "The workflow took too long and was stopped. Please try again." },
  // A start, a subscription or accepting a price.
  listing_not_found: { action: "none", fallback: PAID_WORKFLOW_MESSAGES.notOfferedNeverStarted },
  already_on_plan: {
    action: "none",
    fallback: "You already have a plan for this workflow that is still running. Nothing was charged.",
  },
};

/** The rules of the page's subject. An agent's are PAID_REFUSAL_RULES. */
export function refusalRulesOf(subject: PaidSubject = "agent"): Record<string, CodeRule> {
  return subject === "workflow" ? PAID_WORKFLOW_REFUSAL_RULES : PAID_REFUSAL_RULES;
}

/** The sentences for a charge that was taken and given back. They never say nothing was charged. */
function refundedSentence(code: string, amount: string, apiMessage: string, subject: PaidSubject): string {
  // An agent's model and its restart are an agent's to speak of: a workflow's refund is the API's sentence.
  const own = subject === "workflow" && (code === "model_error" || code === "agent_unavailable") ? "" : code;
  switch (own) {
    case "model_error":
      return `The agent could not answer just now. Your ${amount} was refunded.`;
    case "answer_withheld":
      return `This answer could not be shown. Your ${amount} was refunded.`;
    case "agent_unavailable":
      return `This agent is restarting. Your ${amount} was refunded. Try again in a moment.`;
    case "client_closed_request":
      return `The request was cancelled. Your ${amount} was refunded.`;
    default: {
      // Any other code that comes with a refund: the API's sentence, with the refund said.
      const kept = apiMessage.replace(/\s*Nothing (was|is) charged\.?/gi, "").trim();
      if (/refunded/i.test(kept)) return kept;
      return `${kept ? `${kept} ` : ""}Your ${amount} was refunded.`;
    }
  }
}

/**
 * What a workflow's run says is wrong with the input, as one list for the
 * whole form: its checks are of the input as a whole and name no question
 * the page could stand them beside. "" when there is nothing to say.
 */
function inputIssuesOf(details: unknown): string {
  if (!Array.isArray(details)) return "";
  const said: string[] = [];
  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) continue;
    const { message } = detail as { message?: unknown };
    if (typeof message !== "string") continue;
    const text = message.trim().replace(/[.\s]+$/, "");
    if (text !== "" && !said.includes(text)) said.push(text);
  }
  return said.join("; ");
}

function fieldsOf(details: unknown): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!Array.isArray(details)) return fields;
  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) continue;
    const { field, message } = detail as { field?: unknown; message?: unknown };
    if (typeof message !== "string" || message.trim() === "") continue;
    const key = typeof field === "string" ? field : "";
    fields[key] = fields[key] ? `${fields[key]} ${message}` : message;
  }
  return fields;
}

export interface PaidRefusalInput {
  /** The HTTP status; 0 when the request never got an answer. */
  status: number;
  /** The refusal body, as `paidUseRefusalOf` read it; null when there was none. */
  refusal: PaidUseRefusal | null;
  act: PaidRefusedAct;
  /** What one use is on this page, for the sentences that name it. */
  unit: PaidUnit;
  /** What the page sells; an agent unless it says. */
  subject?: PaidSubject;
}

/** The label of an action, with the price where the action agrees to one. */
function actionOf(kind: PaidActionKind, price: PaidPrice | null): PaidAction {
  switch (kind) {
    case "signin":
      return { kind, label: PAID_USE_MESSAGES.signInButton };
    case "start":
      return price?.model === "monthly"
        ? { kind: "subscribe", label: subscribeLabel(price) }
        : { kind, label: PAID_USE_MESSAGES.startButton };
    case "accept":
      if (!price) return { kind, label: "Accept new price" };
      return price.model === "monthly" ? { kind: "subscribe", label: subscribeLabel(price) } : { kind, label: acceptLabel(price) };
    case "subscribe":
      return { kind, label: price?.model === "monthly" ? subscribeLabel(price) : PAID_USE_MESSAGES.subscribeAgain };
    case "add_credits":
      return { kind, label: PAID_USE_MESSAGES.addCredits };
    case "wait":
    case "none":
      return { kind, label: null };
  }
}

/**
 * The sentence and the one action for a refused chat, run, read of results
 * or start. The API's own sentence is shown as it came unless this page has
 * the numbers to say it exactly, or a charge was refunded.
 */
export function paidRefusalNotice(input: PaidRefusalInput): PaidNotice {
  const { status, refusal, act, unit } = input;
  const subject: PaidSubject = input.subject ?? "agent";
  const words = paidWordsOf(subject);
  const base = { fields: {}, retryAfterSeconds: null, refundedCents: null, price: null };
  if (!refusal) {
    if (status === 401) return { ...base, code: "unauthorized", message: words.signIn, action: actionOf("signin", null) };
    // A workflow's 404 carries no sentence: the workflow is no longer on sale at this address.
    if (status === 404 && subject === "workflow") {
      return { ...base, code: "workflow_not_found", message: words.notFound, action: NO_ACTION };
    }
    return {
      ...base,
      code: "",
      message: status === 0 ? words.offline : PAID_USE_MESSAGES.unknown,
      action: NO_ACTION,
    };
  }

  // A 401 is a 401 whatever its body calls itself.
  const code = status === 401 ? "unauthorized" : refusal.error;
  const rule = refusalRulesOf(subject)[code];
  const apiMessage = typeof refusal.message === "string" ? refusal.message.trim() : "";
  const retry =
    typeof refusal.retryAfterSeconds === "number" && refusal.retryAfterSeconds > 0 ? Math.ceil(refusal.retryAfterSeconds) : null;
  const refunded = typeof refusal.refundedCents === "number" && refusal.refundedCents > 0 ? refusal.refundedCents : null;
  // The price the refusal named: the terms of a use, or the pricing of a start.
  const pricing = refusal.pricing;
  const price =
    priceOfTerms(refusal.terms) ??
    (pricing
      ? priceOfTerms({
          pricingModel: pricing.pricingModel ?? "",
          pricePerRequestCents: pricing.pricePerRequestCents ?? null,
          monthlyPriceCents: pricing.monthlyPriceCents ?? null,
          unit: unit === "run" ? "run" : "message",
          keepsCopy: false,
        })
      : null);

  let message = apiMessage || rule?.fallback || PAID_USE_MESSAGES.unknown;
  let fields: Record<string, string> = {};

  if (refunded !== null) {
    message = refundedSentence(code, dollars(refunded), apiMessage, subject);
  } else if (code === "unauthorized") {
    message = words.signIn;
  } else if (code === "own_agent" || (subject === "workflow" && code === "own_workflow")) {
    message = words.own;
  } else if (code === "use_not_started") {
    message = words.notStarted;
  } else if (code === "insufficient_credits" && act !== "start" && typeof refusal.priceCents === "number") {
    const word = unit === "run" ? "run" : "message";
    message = `You do not have enough credits for this ${word} (${dollars(refusal.priceCents)}). Nothing was charged. Add credits to continue.`;
  } else if (code === "pricing_changed" && act === "start" && price) {
    // The API's sentence here speaks of a price "you agreed to", which someone starting for the first time never did.
    message = `The price is now ${priceLine(price)}. Nothing was charged.`;
  } else if (code === "invalid_request") {
    // The API's sentence here is written for code, not for a person on a page.
    message = act === "task" ? PUBLIC_USE_MESSAGES.answersUnreadable : PUBLIC_USE_MESSAGES.chatUnreadable;
  } else if (code === "input_too_large") {
    message = act === "task" ? PUBLIC_USE_MESSAGES.answersTooLong : PUBLIC_USE_MESSAGES.messageTooLong;
  } else if (code === "input_invalid" && subject === "workflow") {
    // A workflow's checks are of the input as a whole: one list for the form, never beside a question.
    const issues = inputIssuesOf(refusal.details);
    message = issues ? `${PUBLIC_USE_MESSAGES.answersInvalid.replace(/\.$/, ":")} ${issues}.` : PUBLIC_USE_MESSAGES.answersInvalid;
  } else if (code === "input_invalid") {
    message = PUBLIC_USE_MESSAGES.answersInvalid;
    fields = fieldsOf(refusal.details);
  }

  return {
    code,
    message,
    action: rule ? actionOf(rule.action, price) : NO_ACTION,
    fields,
    retryAfterSeconds: retry,
    refundedCents: refunded,
    price,
  };
}

/** The notice a panel shows in place when the page already knows the person cannot use the agent yet. */
export function noticeOfView(current: PaidView): PaidNotice {
  return {
    code: current.kind,
    message: current.sentence,
    action: current.action,
    fields: {},
    retryAfterSeconds: null,
    refundedCents: null,
    price: current.price,
  };
}

// ============================================
// A task's answers, kept while the person signs in
// ============================================

/**
 * Where one agent's unsent answers are kept in sessionStorage. A workflow's
 * are kept under its page's path (`workflowDraftKey`), never under a bare
 * slug, which could be the same text as an agent's handle.
 */
export function taskDraftKey(handle: string): string {
  return `wheelsai:paid-task-draft:${handle}`;
}

/** Where a workflow's unsent answers are kept: under "/w/<slug>". */
export function workflowDraftKey(slug: string): string {
  return taskDraftKey(workflowPagePath(slug));
}

/** The answers as they are stored, with the form they belong to. */
export function packTaskDraft(schemaKey: string, values: FormValues): string {
  return JSON.stringify({ schema: schemaKey, values });
}

/**
 * The stored answers, when they belong to the form on the page now: only
 * questions the form still has, only text and yes-or-no values. null when
 * there is nothing to restore.
 */
export function unpackTaskDraft(raw: string | null | undefined, schemaKey: string, current: FormValues): FormValues | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { schema, values } = parsed as { schema?: unknown; values?: unknown };
  if (schema !== schemaKey || typeof values !== "object" || values === null || Array.isArray(values)) return null;
  const restored: FormValues = { ...current };
  let any = false;
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!(key in current)) continue;
    if (typeof value !== "string" && typeof value !== "boolean") continue;
    if (typeof value !== typeof current[key]) continue;
    if (restored[key] !== value) any = true;
    restored[key] = value;
  }
  return any ? restored : null;
}

// ============================================
// Where the page sends people
// ============================================

/** The agent's own page, as the path sign-in comes back to. */
export function agentPagePath(handle: string): string {
  return `/a/${encodeURIComponent(handle)}`;
}

/** A workflow's own page, by its listing's slug: the path sign-in comes back to. */
export function workflowPagePath(slug: string): string {
  return `/w/${encodeURIComponent(slug)}`;
}

/** Where sign-in comes back to: an agent's page by its handle, or a page's own path. */
export type ReturnTo = string | { path: string };

function returnPath(to: ReturnTo): string {
  return typeof to === "string" ? agentPagePath(to) : to.path;
}

/** The sign-in page, returning to this agent's page, or to the page at `{ path }`. */
export function signInHref(to: ReturnTo): string {
  return `/login?next=${encodeURIComponent(returnPath(to))}`;
}

/** The sign-up page, returning to this agent's page, or to the page at `{ path }`. */
export function registerHref(to: ReturnTo): string {
  return `/register?next=${encodeURIComponent(returnPath(to))}`;
}

/** The listing's page, where the agent can be tried free. */
export function tryFreeHref(listingSlug: string): string {
  return `/marketplace/${encodeURIComponent(listingSlug)}`;
}

/** Where credits are added. */
export const ADD_CREDITS_HREF = "/dashboard/billing";
