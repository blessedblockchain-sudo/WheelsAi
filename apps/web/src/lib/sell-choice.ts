/**
 * "Who can use it?": the one question that puts use of an agent on sale.
 *
 * The choices and their words for each kind of agent, the earnings line,
 * what a save sends to the listing routes, what the listing an agent has now
 * means as a choice, and what a change does to the people who already pay.
 * Pure, so the Sell tab and the listing wizard only lay it out and cannot
 * drift apart. A workflow is asked the same question in its own words
 * (`SellSubject`): it has one answer, pay per run, with plans under it.
 *
 * Every amount is whole cents. What a creator earns comes from `splitCents`,
 * the API's own integer rule, never from a multiplication by 0.9.
 */
import type { AgentKind } from "@wheelsai/shared/agent-kind";
import { splitCents } from "@wheelsai/shared/revenue";

import { JOB_MAX_PRICE_CENTS, JOB_MIN_PRICE_CENTS, dollarsToCents, formatCents, formatDuration } from "./jobs";
import { OUTBOUND_TOOLS } from "./offering-draft";

// ============================================
// Words
// ============================================

export const SELL_WORDS = {
  question: "Who can use it?",
  lead: "People use your agent on its page or through the API. They never get its instructions, its settings or its code.",
  perUseHint: "Charged when they send it. Refunded if your agent does not answer.",
  modelCost: "When your agent runs on WheelsAI's models, the cost of the model comes out of your share.",
  signIn: "People sign in to pay. They pay from WheelsAI credits.",
  priceTurnsOffFree: "Setting a price turns off free use on its page.",
  forPayers:
    "Your agent cannot save files for people who pay, and cannot send requests to other websites unless you allow it here.",
  /** For an agent with no tool that sends requests out: there is nothing to allow. */
  forPayersNoOutbound: "Your agent cannot save files for people who pay.",
  allowOutbound: "Let it send requests to other websites",
  keepCopy: "Keep a copy of what people send and what it answers. Its page tells them.",
  moreOptions: "More options",
  guaranteed:
    "Sell with guaranteed delivery. A fixed price per task, held until the result is delivered and checked, and refunded if it is late.",
  deliveredWithin: "Delivered within",
  formDrift: "You changed this agent's form after putting it on sale. Buyers still see the earlier form.",
  showNewForm: "Show buyers the new form",
  paidTasksUnavailable:
    "Paid tasks are temporarily unavailable, so nobody can hire this agent right now. What you set here is kept.",
  copiesInstead: "Sell copies instead. Buyers get their own copy, including its instructions. You cannot take a copy back.",
  copiesDialogTitle: "Sell copies of this agent?",
  copiesDialogBody:
    "From now on buyers install their own copy and can read its instructions. People who pay to use it keep access until what they paid for ends.",
  copiesDialogScheduled:
    "Buyers get the agent and your suggested times. Your results, your schedule and where your results go are not shared.",
  copiesConfirm: "Sell copies",
  sellsCopies: "This agent sells copies. Buyers get its instructions.",
  sellUseInstead: "Sell use instead",
  putOnSale: "Put it on sale",
  saveChanges: "Save changes",
  stopSelling: "Stop selling",
  describe: "Add one line that tells people what this agent does.",
} as const;

/**
 * What "Who can use it?" is asked about: an agent, or a workflow. A workflow
 * is sold by use only, by the run, with plans on top: no Free, no Monthly, no
 * Token holders, no copies and no tools to allow.
 */
export type SellSubject = "agent" | "workflow";

/** The words of the question, by their keys in SELL_WORDS. */
export type SellWords = { readonly [K in keyof typeof SELL_WORDS]: string };

/** The API's sentences for what a workflow is not sold with (services/workflowListing.ts), each written once. */
const COPIES_NOT_SOLD = "A workflow is sold by use. Copies of a workflow are not sold.";
const SOLD_PER_RUN = "A workflow is sold per run. Add plans for buyers who want a number of uses for 30 days.";
/** What mode "hired" refuses in a paid run of a workflow; the Sell part reads it from here. */
const PAID_RUN_CANNOT =
  "In a paid run your steps cannot move money, change your saved files or call a web address with the HTTP request tool.";
/** Where a paid run is seen by the creator; the Sell part reads it from here. */
const PAID_RUNS_LISTED = "Paid runs appear in this workflow's runs, with what the buyer sent.";

/**
 * The same keys, said of a workflow. The words about what a workflow is not
 * sold with (copies, tools to allow, free use, a task with guaranteed
 * delivery) say why, in the API's own sentences, so no screen can draw an
 * offer the API refuses.
 */
const WORKFLOW_QUESTION_WORDS: SellWords = {
  question: SELL_WORDS.question,
  lead: "People run your workflow on its page or through the API. They never see its steps, its agents or its settings.",
  perUseHint: "Charged when a run starts. Refunded if the run does not finish.",
  modelCost: "When your steps run on WheelsAI's models, the cost of the model comes out of your share.",
  signIn: SELL_WORDS.signIn,
  priceTurnsOffFree: SOLD_PER_RUN,
  forPayers: PAID_RUN_CANNOT,
  forPayersNoOutbound: PAID_RUN_CANNOT,
  allowOutbound: "A workflow listing has no tools to allow.",
  keepCopy: PAID_RUNS_LISTED,
  moreOptions: SELL_WORDS.moreOptions,
  // A workflow's listing has no task to hire with guaranteed delivery: it is sold per run.
  guaranteed: SOLD_PER_RUN,
  deliveredWithin: SELL_WORDS.deliveredWithin,
  formDrift: "Buyers see this workflow's form as it is now.",
  showNewForm: SELL_WORDS.showNewForm,
  paidTasksUnavailable: SOLD_PER_RUN,
  copiesInstead: COPIES_NOT_SOLD,
  copiesDialogTitle: "Copies of a workflow are not sold.",
  copiesDialogBody: COPIES_NOT_SOLD,
  copiesDialogScheduled: COPIES_NOT_SOLD,
  copiesConfirm: SELL_WORDS.copiesConfirm,
  sellsCopies: COPIES_NOT_SOLD,
  sellUseInstead: SELL_WORDS.sellUseInstead,
  putOnSale: SELL_WORDS.putOnSale,
  saveChanges: SELL_WORDS.saveChanges,
  stopSelling: SELL_WORDS.stopSelling,
  describe: "Add one line that tells people what this workflow does.",
};

/** The words of the question for what is sold. An agent's are SELL_WORDS, exactly. */
export function sellWordsOf(subject: SellSubject = "agent"): SellWords {
  return subject === "workflow" ? WORKFLOW_QUESTION_WORDS : SELL_WORDS;
}

// ============================================
// Limits
// ============================================

/** The largest prices the listing routes take, in cents. */
export const MAX_PRICE_PER_USE_CENTS = 100_000;
export const MAX_MONTHLY_PRICE_CENTS = 10_000_000;
/** The smallest price of a copy's request: one cent. */
export const MIN_COPY_REQUEST_CENTS = 1;

export interface SellLimits {
  /** The smallest price of one use, in cents. */
  minPerUseCents: number;
  /** The smallest price of a month, in cents. */
  minMonthlyCents: number;
  /** How often one buyer may use an agent in a day; null when the server did not say. */
  perBuyerPerDay: number | null;
}

export const DEFAULT_SELL_LIMITS: SellLimits = { minPerUseCents: 5, minMonthlyCents: 100, perBuyerPerDay: null };

function wholePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The limits as `GET /api/capabilities` gives them; the floors of the listing routes when it could not be read. */
export function sellLimitsOf(
  capabilities: { paidUse?: { minPricePerUseCents?: unknown; perBuyerPerDay?: unknown } | null } | null | undefined,
): SellLimits {
  const paidUse = capabilities?.paidUse;
  return {
    minPerUseCents: wholePositive(paidUse?.minPricePerUseCents) ?? DEFAULT_SELL_LIMITS.minPerUseCents,
    minMonthlyCents: DEFAULT_SELL_LIMITS.minMonthlyCents,
    perBuyerPerDay: wholePositive(paidUse?.perBuyerPerDay),
  };
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * "On WheelsAI's models your agent can answer up to 200 times a day on your
 * plan. Add your own model key or upgrade to serve more." null when the
 * allowance could not be read: no number is better than a guessed one.
 */
export function capacityLine(freeModelDailyAllowance: number | null | undefined): string | null {
  const allowance = wholePositive(freeModelDailyAllowance);
  if (allowance === null) return null;
  return `On WheelsAI's models your agent can answer up to ${count(allowance)} times a day on your plan. Add your own model key or upgrade to serve more.`;
}

// ============================================
// The choices
// ============================================

export type SellChoiceId = "free" | "per_use" | "monthly" | "token_holders";
export type SellWhat = "use" | "copies";

export interface SellChoice {
  id: SellChoiceId;
  title: string;
  sentence: string;
  /** false: shown, and cannot be chosen. */
  selectable: boolean;
  /** The label of the price this choice asks for; null when it asks for none. */
  priceLabel: string | null;
  /** The line under the price field; null when there is none. */
  priceHint: string | null;
}

function kindOf(kind: AgentKind | null | undefined): AgentKind {
  return kind === "task" || kind === "scheduled" ? kind : "conversation";
}

/** What one payment per use buys, by kind: a message, or a run. */
export function unitWordOfUse(kind: AgentKind | null | undefined): "message" | "run" {
  return kindOf(kind) === "conversation" ? "message" : "run";
}

/**
 * The choices of "Who can use it?" for a kind of agent, in the order they
 * are shown. Talk to it: Free, Pay per use by the message, Monthly. Give it
 * a task: Free, Pay per use by the run, Monthly. Runs on its own: Free or
 * Monthly. Token holders is always last, always shown and never selectable.
 */
export function sellChoices(
  agentKind: AgentKind | null | undefined,
  limits: SellLimits = DEFAULT_SELL_LIMITS,
  subject: SellSubject = "agent",
): SellChoice[] {
  if (subject === "workflow") return workflowChoices(limits);
  const kind = kindOf(agentKind);
  const unit = unitWordOfUse(kind);
  const choices: SellChoice[] = [
    {
      id: "free",
      title: "Free",
      sentence: "Anyone with the link can use it. No sign-in. Their use counts toward your plan.",
      selectable: true,
      priceLabel: null,
      priceHint: null,
    },
  ];
  if (kind !== "scheduled") {
    choices.push({
      id: "per_use",
      title: "Pay per use",
      sentence: `People pay for each ${unit} from their WheelsAI credits.`,
      selectable: true,
      priceLabel: `Price per ${unit} (minimum ${formatCents(limits.minPerUseCents)})`,
      priceHint: SELL_WORDS.perUseHint,
    });
  }
  choices.push({
    id: "monthly",
    title: "Monthly",
    sentence:
      kind === "scheduled"
        ? "People pay every 30 days to read its results on its page and through the API."
        : limits.perBuyerPerDay !== null
          ? `People pay every 30 days and can use it up to ${count(limits.perBuyerPerDay)} times a day.`
          : "People pay every 30 days.",
    selectable: true,
    priceLabel: `Price per month (minimum ${formatCents(limits.minMonthlyCents)})`,
    priceHint: null,
  });
  choices.push({
    id: "token_holders",
    title: "Token holders",
    sentence: "People who hold your agent's token can use it. Available once your agent has a token.",
    selectable: false,
    priceLabel: null,
    priceHint: null,
  });
  return choices;
}

/**
 * The one choice of a workflow: pay per run, with plans under it. The API
 * sells a workflow per request (one run) at the smallest price per use or
 * more, and refuses every other way.
 */
function workflowChoices(limits: SellLimits): SellChoice[] {
  return [
    {
      id: "per_use",
      title: "Pay per run",
      sentence: "People pay for each run from their WheelsAI credits.",
      selectable: true,
      priceLabel: `Price per run (minimum ${formatCents(limits.minPerUseCents)})`,
      priceHint: WORKFLOW_QUESTION_WORDS.perUseHint,
    },
  ];
}

/** The prices a listing that sells copies can have. Every one of them is as it was before use could be sold. */
export function copyChoices(limits: SellLimits = DEFAULT_SELL_LIMITS): SellChoice[] {
  return [
    {
      id: "free",
      title: "Free",
      sentence: "Anyone can install a copy at no charge.",
      selectable: true,
      priceLabel: null,
      priceHint: null,
    },
    {
      id: "per_use",
      title: "Pay per request",
      sentence: "Buyers pay for each request their copy answers.",
      selectable: true,
      priceLabel: `Price per request (minimum ${formatCents(MIN_COPY_REQUEST_CENTS)})`,
      priceHint: null,
    },
    {
      id: "monthly",
      title: "Monthly",
      sentence: "Buyers pay a fixed price every 30 days.",
      selectable: true,
      priceLabel: `Price per month (minimum ${formatCents(limits.minMonthlyCents)})`,
      priceHint: null,
    },
    {
      id: "token_holders",
      title: "Token holders",
      sentence:
        "Buyers need at least 1 of your agent's token, held in a wallet linked to their organization. Until you launch the token, the listing is free to install and run.",
      selectable: true,
      priceLabel: null,
      priceHint: null,
    },
  ];
}

// ============================================
// The form
// ============================================

/** The question as it is answered on screen. Prices are typed, so an unfinished amount can sit in its input. */
export interface SellForm {
  sells: SellWhat;
  choice: SellChoiceId;
  /** Dollars, as typed: the price of one use (or of one request of a copy). */
  perUsePrice: string;
  /** Dollars, as typed: the price of a month. */
  monthlyPrice: string;
  /** Whether people who pay get the agent's tools that send requests to other websites. */
  allowOutbound: boolean;
}

export function emptySellForm(): SellForm {
  return { sells: "use", choice: "free", perUsePrice: "", monthlyPrice: "", allowOutbound: false };
}

/** The choices the form shows now: those of use for the agent's kind, or those of copies. */
export function choicesOf(
  form: Pick<SellForm, "sells">,
  agentKind: AgentKind | null | undefined,
  limits: SellLimits = DEFAULT_SELL_LIMITS,
  subject: SellSubject = "agent",
): SellChoice[] {
  // A workflow has no copies to sell: its one choice, whatever the form says.
  if (subject === "workflow") return workflowChoices(limits);
  return form.sells === "copies" ? copyChoices(limits) : sellChoices(agentKind, limits);
}

/** The form with a choice picked. A choice that is not offered, or cannot be chosen, changes nothing. */
export function withChoice(form: SellForm, id: SellChoiceId, choices: readonly SellChoice[]): SellForm {
  const choice = choices.find((candidate) => candidate.id === id);
  if (!choice || !choice.selectable) return form;
  return { ...form, choice: id };
}

/**
 * The form switched to selling copies. Only after the warning dialog was
 * confirmed: without that it comes back unchanged, so no screen can sell
 * copies by a slip.
 */
export function withCopies(form: SellForm, confirmed: boolean): SellForm {
  if (confirmed !== true || form.sells === "copies") return form;
  return { ...form, sells: "copies" };
}

/** The form switched back to selling use. A choice use does not have for this kind falls back to Free. */
export function withUse(form: SellForm, agentKind: AgentKind | null | undefined): SellForm {
  if (form.sells === "use") return form;
  const offered = sellChoices(agentKind).some((choice) => choice.id === form.choice && choice.selectable);
  return { ...form, sells: "use", choice: offered ? form.choice : "free" };
}

/** What the copies dialog says: the warning, and for a self-running agent what a copy carries. */
export function copiesDialog(agentKind: AgentKind | null | undefined): {
  title: string;
  description: string;
  confirmLabel: string;
} {
  return {
    title: SELL_WORDS.copiesDialogTitle,
    description:
      kindOf(agentKind) === "scheduled"
        ? `${SELL_WORDS.copiesDialogBody} ${SELL_WORDS.copiesDialogScheduled}`
        : SELL_WORDS.copiesDialogBody,
    confirmLabel: SELL_WORDS.copiesConfirm,
  };
}

// ============================================
// The listing an agent has, as a choice
// ============================================

export interface SellListing {
  sells?: string | null;
  pricingModel: string;
  pricePerRequestCents?: number | null;
  monthlyPriceCents?: number | null;
  allowedTools?: readonly string[] | null;
  status?: string;
  buyers?: { copies: number; using: number; subscribed: number } | null;
}

function priceText(cents: number | null | undefined): string {
  return typeof cents === "number" && Number.isFinite(cents) && cents > 0 ? (cents / 100).toFixed(2) : "";
}

const CHOICE_OF_MODEL: Record<string, SellChoiceId> = {
  free: "free",
  per_request: "per_use",
  monthly: "monthly",
  tokenized: "token_holders",
};

/**
 * What the current listing means as a choice. No listing is the question
 * unanswered: use, free. A listing that sells use on terms the question no
 * longer has for this kind (which the API does not allow) reads as Free, so
 * the form never shows a choice that is not on screen.
 */
export function formOfListing(
  listing: SellListing | null | undefined,
  agentKind?: AgentKind | null,
  subject: SellSubject = "agent",
): SellForm {
  // A workflow is sold per run and nothing else, so its question is always answered that way.
  if (subject === "workflow") {
    return {
      sells: "use",
      choice: "per_use",
      perUsePrice: priceText(listing?.pricePerRequestCents),
      monthlyPrice: "",
      allowOutbound: false,
    };
  }
  if (!listing) return emptySellForm();
  const sells: SellWhat = listing.sells === "copies" ? "copies" : "use";
  const form: SellForm = {
    sells,
    choice: CHOICE_OF_MODEL[listing.pricingModel] ?? "free",
    perUsePrice: priceText(listing.pricePerRequestCents),
    monthlyPrice: priceText(listing.monthlyPriceCents),
    allowOutbound: (listing.allowedTools ?? []).some((tool) => OUTBOUND_TOOLS.includes(tool)),
  };
  if (sells === "use" && !sellChoices(agentKind).some((choice) => choice.id === form.choice && choice.selectable)) {
    form.choice = "free";
  }
  return form;
}

/** The agent's tools that send requests to other websites, by name, each once. */
export function outboundToolsOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  const names = tools
    .map((tool) => (tool as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string" && OUTBOUND_TOOLS.includes(name));
  return [...new Set(names)];
}

// ============================================
// Prices
// ============================================

export type SellField = "choice" | "perUsePrice" | "monthlyPrice";
export type SellErrors = Partial<Record<SellField, string>>;

function unitOf(
  form: Pick<SellForm, "sells" | "choice">,
  agentKind: AgentKind | null | undefined,
  subject: SellSubject = "agent",
): string {
  if (subject === "workflow") return "run";
  if (form.choice === "monthly") return "month";
  return form.sells === "copies" ? "request" : unitWordOfUse(agentKind);
}

function checkPrice(text: string, unit: string, min: number, max: number): { cents: number } | { message: string } {
  if (!text.trim()) return { message: `Enter a price per ${unit}.` };
  const cents = dollarsToCents(text);
  if (cents === null) return { message: `Enter the price per ${unit} in dollars and cents, like ${(min / 100).toFixed(2)}.` };
  if (cents < min) return { message: `The price per ${unit} must be at least ${formatCents(min)}.` };
  if (cents > max) return { message: `The price per ${unit} can be at most ${formatCents(max)}.` };
  return { cents };
}

/** The price the form's choice asks for, in cents; null for a choice without a price or a price that cannot be read. */
export function priceCentsOf(form: SellForm): number | null {
  if (form.choice === "per_use") return dollarsToCents(form.perUsePrice);
  if (form.choice === "monthly") return dollarsToCents(form.monthlyPrice);
  return null;
}

/**
 * "At $0.05 a message you earn $0.04." From the same integer rule the API
 * pays by. null for a choice without a price, while no whole-cent price is
 * typed, or (when the limits are given) for a price below the smallest one
 * that can be sold.
 */
export function earningsLine(
  form: SellForm,
  agentKind: AgentKind | null | undefined,
  limits?: SellLimits,
  subject: SellSubject = "agent",
): string | null {
  const cents = priceCentsOf(form);
  if (cents === null || cents <= 0) return null;
  // A price below the floor cannot be sold, so nothing is said to be earned at it.
  if (limits) {
    const floor =
      form.choice === "monthly" ? limits.minMonthlyCents : form.sells === "copies" ? MIN_COPY_REQUEST_CENTS : limits.minPerUseCents;
    if (cents < floor) return null;
  }
  const { grossCents, creatorCents } = splitCents(cents);
  if (grossCents !== cents) return null;
  return `At ${formatCents(grossCents)} a ${unitOf(form, agentKind, subject)} you earn ${formatCents(creatorCents)}.`;
}

// ============================================
// What a save sends
// ============================================

/** The part of a listing create or update that the question decides. */
export interface SellSave {
  sells: SellWhat;
  pricingModel: "free" | "per_request" | "monthly" | "tokenized";
  pricePerRequestCents?: number;
  monthlyPriceCents?: number;
  /** Only for a listing that sells use: the tools people who pay get. */
  allowedTools?: string[];
}

export type SellSaveResult = { ok: true; save: SellSave } | { ok: false; errors: SellErrors };

/**
 * What the form sends to the listing routes, or why it cannot be sent yet,
 * each problem under the input it is about. The server checks the same
 * floors again.
 */
export function buildSellSave(
  form: SellForm,
  agent: { agentKind?: AgentKind | null; tools?: unknown },
  limits: SellLimits = DEFAULT_SELL_LIMITS,
  subject: SellSubject = "agent",
): SellSaveResult {
  const choices = choicesOf(form, agent.agentKind, limits, subject);
  const choice = choices.find((candidate) => candidate.id === form.choice);
  if (!choice || !choice.selectable) {
    const names = choices.filter((candidate) => candidate.selectable).map((candidate) => candidate.title);
    const last = names.pop();
    return { ok: false, errors: { choice: `Choose ${names.length > 0 ? `${names.join(", ")} or ${last}` : last}.` } };
  }

  // A workflow sells use and has no tools to allow: the API refuses a workflow listing that names any.
  const base: Pick<SellSave, "sells" | "allowedTools"> =
    subject === "workflow"
      ? { sells: "use" }
      : form.sells === "use"
        ? { sells: "use", allowedTools: form.allowOutbound ? outboundToolsOf(agent.tools) : [] }
        : { sells: "copies" };

  if (form.choice === "per_use") {
    const min = form.sells === "copies" && subject !== "workflow" ? MIN_COPY_REQUEST_CENTS : limits.minPerUseCents;
    const price = checkPrice(form.perUsePrice, unitOf(form, agent.agentKind, subject), min, MAX_PRICE_PER_USE_CENTS);
    if ("message" in price) return { ok: false, errors: { perUsePrice: price.message } };
    return { ok: true, save: { ...base, pricingModel: "per_request", pricePerRequestCents: price.cents } };
  }
  if (form.choice === "monthly") {
    const price = checkPrice(form.monthlyPrice, "month", limits.minMonthlyCents, MAX_MONTHLY_PRICE_CENTS);
    if ("message" in price) return { ok: false, errors: { monthlyPrice: price.message } };
    return { ok: true, save: { ...base, pricingModel: "monthly", monthlyPriceCents: price.cents } };
  }
  return { ok: true, save: { ...base, pricingModel: form.choice === "token_holders" ? "tokenized" : "free" } };
}

/** Why the form cannot be saved, in one sentence; null when it can. */
export function sellProblem(
  form: SellForm,
  agent: { agentKind?: AgentKind | null; tools?: unknown },
  limits: SellLimits = DEFAULT_SELL_LIMITS,
  subject: SellSubject = "agent",
): string | null {
  const built = buildSellSave(form, agent, limits, subject);
  if (built.ok) return null;
  return built.errors.choice ?? built.errors.perUsePrice ?? built.errors.monthlyPrice ?? null;
}

/**
 * The body of a save of the question on a listing that exists. A listing
 * that is not on sale goes on sale in the same request; one that is stays
 * as it is, so `publish` is left out.
 */
export function sellUpdateOf(save: SellSave, listing: { status?: string } | null | undefined): SellSave & { publish?: true } {
  return listing?.status === "published" ? save : { ...save, publish: true };
}

/** The listing routes' own field names, and the input of the question each one is about. */
const SELL_FIELD_OF: Record<string, SellField> = {
  pricePerRequestCents: "perUsePrice",
  monthlyPriceCents: "monthlyPrice",
  pricingModel: "choice",
  sells: "choice",
};

/**
 * The sentences of a refused save (400 `validation_failed`), each under the
 * input it is about. A field the question does not ask for (the title, the
 * short description, a tool) is left out, so its sentence is shown as the
 * refusal's message and never under a choice it is not about.
 */
export function sellFieldErrors(fields: Record<string, string>): SellErrors {
  const errors: SellErrors = {};
  for (const [path, sentence] of Object.entries(fields)) {
    const field = Object.prototype.hasOwnProperty.call(SELL_FIELD_OF, path) ? SELL_FIELD_OF[path] : undefined;
    if (field) errors[field] ??= sentence;
  }
  return errors;
}

/** Whether two states of the form would send the same thing. */
export function sameSellForm(a: SellForm, b: SellForm): boolean {
  const key = (form: SellForm) =>
    JSON.stringify([
      form.sells,
      form.choice,
      form.choice === "per_use" ? form.perUsePrice.trim() : "",
      form.choice === "monthly" ? form.monthlyPrice.trim() : "",
      form.sells === "use" && form.allowOutbound,
    ]);
  return key(a) === key(b);
}

/** Whether the form asks people to pay for use: the lines under the price and the switches are about that. */
export function asksForPayment(form: SellForm): boolean {
  return form.sells === "use" && (form.choice === "per_use" || form.choice === "monthly");
}

// ============================================
// The listing a first sale makes
// ============================================

export const LISTING_TITLE_MAX = 100;
export const LISTING_LINE_MIN = 10;
export const LISTING_LINE_MAX = 280;

/** The line a listing opens with: the listing's own, else the agent's description, else what was typed; null when none is long enough. */
export function sellLineOf(candidates: ReadonlyArray<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const line = (candidate ?? "").trim();
    if (line.length >= LISTING_LINE_MIN) return line.slice(0, LISTING_LINE_MAX).trim();
  }
  return null;
}

/** The sentence under the one-line input while what is typed is too short. */
export const SELL_LINE_TOO_SHORT = `Write at least ${LISTING_LINE_MIN} characters.`;

/** The body that makes an agent's first listing from its page: its name, its line, and the answer to the question. */
export function firstListingOf(
  agent: { id: string; name: string },
  line: string,
  save: SellSave,
): SellSave & { agentId: string; title: string; shortDescription: string; category: "other"; publish: true } {
  return {
    agentId: agent.id,
    title: agent.name.trim().slice(0, LISTING_TITLE_MAX),
    shortDescription: line,
    category: "other",
    ...save,
    publish: true,
  };
}

// ============================================
// Where the sale stands
// ============================================

export type SaleStanding = "not_listed" | "draft" | "in_review" | "on_sale" | "stopped";

export function saleStanding(listing: { status?: string } | null | undefined): SaleStanding {
  if (!listing) return "not_listed";
  if (listing.status === "published") return "on_sale";
  if (listing.status === "archived") return "stopped";
  if (listing.status === "pending_review") return "in_review";
  return "draft";
}

const STANDING_WORDS: Record<Exclude<SaleStanding, "not_listed" | "on_sale">, { label: string; sentence: string }> = {
  draft: { label: "Draft", sentence: "This agent has a listing that is a draft. Nobody else can see it yet." },
  in_review: { label: "In review", sentence: "This listing is being reviewed. It goes on sale once it is approved." },
  stopped: { label: "Not on sale", sentence: "You stopped selling this agent. Nobody new can find it on the marketplace." },
};

/** "$0.05 per message", "$9.00 a month", "Free"; for copies "$0.05 per request", "Token holders". */
export function salePriceText(listing: SellListing, agentKind: AgentKind | null | undefined): string {
  const copies = listing.sells === "copies";
  if (listing.pricingModel === "per_request" && (listing.pricePerRequestCents ?? 0) > 0) {
    return `${formatCents(listing.pricePerRequestCents ?? 0)} per ${copies ? "request" : unitWordOfUse(agentKind)}`;
  }
  if (listing.pricingModel === "monthly" && (listing.monthlyPriceCents ?? 0) > 0) {
    return `${formatCents(listing.monthlyPriceCents ?? 0)} a month`;
  }
  if (listing.pricingModel === "tokenized") return "Token holders";
  return "Free";
}

/** The badge and the sentence at the top of the Sell tab for an agent that has a listing. */
export function saleStatus(
  listing: SellListing,
  agentKind: AgentKind | null | undefined,
): { standing: SaleStanding; label: string; sentence: string } {
  const standing = saleStanding(listing);
  if (standing !== "on_sale" && standing !== "not_listed") return { standing, ...STANDING_WORDS[standing] };
  const price = salePriceText(listing, agentKind);
  if (listing.sells === "copies") {
    return { standing, label: "On sale", sentence: `${SELL_WORDS.sellsCopies} Price of a copy: ${price}.` };
  }
  const sentence =
    listing.pricingModel === "free"
      ? "Anyone with the link can use it. No sign-in."
      : `People pay ${price} to use it on its page or through the API.`;
  return { standing, label: "On sale", sentence };
}

// ============================================
// What a change does to today's buyers
// ============================================

function buyersOf(listing: Pick<SellListing, "buyers"> | null | undefined): { copies: number; using: number; subscribed: number } {
  const whole = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0);
  return {
    copies: whole(listing?.buyers?.copies),
    using: whole(listing?.buyers?.using),
    subscribed: whole(listing?.buyers?.subscribed),
  };
}

function subscribersKeep(subscribed: number): string {
  return subscribed === 1
    ? "1 subscriber keeps access until the month they paid for ends and is not charged again."
    : `${count(subscribed)} subscribers keep access until the month they paid for ends and are not charged again.`;
}

/**
 * "3 people already have a copy. They keep it." What is true of a listing
 * that sold copies, whatever it sells next. null when nobody has one.
 */
export function copiesKeptLine(listing: Pick<SellListing, "buyers"> | null | undefined): string | null {
  const { copies } = buyersOf(listing);
  if (copies === 0) return null;
  return copies === 1 ? "1 person already has a copy. They keep it." : `${count(copies)} people already have a copy. They keep it.`;
}

/**
 * What stopping does, for the confirm dialog: "Stop selling. People who pay
 * per use lose access now. 2 subscribers keep access until the month they
 * paid for ends and are not charged again." The numbers are the listing's
 * own; a sentence about people it does not have is left out.
 */
export function stopSellingSentence(listing: SellListing): string {
  const { subscribed } = buyersOf(listing);
  const lines = ["Stop selling."];
  if (listing.sells === "copies") {
    lines.push("Nobody new can get a copy.");
    const kept = copiesKeptLine(listing);
    if (kept) lines.push(kept);
  } else if (listing.pricingModel === "free" && subscribed === 0) {
    lines.push("Your agent leaves the marketplace.");
  } else {
    lines.push("People who pay per use lose access now.");
  }
  if (subscribed > 0) lines.push(subscribersKeep(subscribed));
  return lines.join(" ");
}

/**
 * What switching a listing that sells use to copies does to the people who
 * pay now, with their numbers; null when nobody pays. Shown in the copies
 * dialog under its warning.
 */
export function switchToCopiesLine(listing: SellListing | null | undefined): string | null {
  if (!listing || listing.sells === "copies" || listing.status !== "published") return null;
  const { using, subscribed } = buyersOf(listing);
  const lines: string[] = [];
  if (listing.pricingModel === "per_request" && using > 0) lines.push("People who pay per use lose access now.");
  if (subscribed > 0) lines.push(subscribersKeep(subscribed));
  return lines.length > 0 ? lines.join(" ") : null;
}

/** The numbers under the status, each with its label; a number the listing does not have is left out. */
export function buyerStats(listing: SellListing): Array<{ label: string; value: string }> {
  if (!listing.buyers) return [];
  const { copies, using, subscribed } = buyersOf(listing);
  const stats: Array<{ label: string; value: string }> = [];
  if (listing.sells !== "copies" || using > 0) stats.push({ label: "People using it", value: count(using) });
  if (listing.pricingModel === "monthly" || subscribed > 0) stats.push({ label: "Subscribers", value: count(subscribed) });
  if (listing.sells === "copies" || copies > 0) stats.push({ label: "Copies", value: count(copies) });
  return stats;
}

/**
 * What the listing earned, from the revenue the API reports for it: the
 * creator's part of settled payments and how many paid uses they were for.
 * null when the API reported nothing for this listing.
 */
export function earnedOf(
  revenueByListing: ReadonlyArray<{ listingId: string | null; totalRevenueCents: number; totalRequests: number }> | null | undefined,
  listingId: string,
): { earned: string; uses: string } | null {
  const row = (revenueByListing ?? []).find((candidate) => candidate.listingId === listingId);
  if (!row) return null;
  return { earned: formatCents(Math.max(0, row.totalRevenueCents)), uses: count(Math.max(0, row.totalRequests)) };
}

// ============================================
// Guaranteed delivery (a task agent)
// ============================================

export const GUARANTEED_PRICE_LABEL = `Price per task (minimum ${formatCents(JOB_MIN_PRICE_CENTS)})`;

/** "Delivered within: 10 minutes, 1 hour, 1 day." */
export const DELIVERY_TIMES: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 600, label: "10 minutes" },
  { seconds: 3_600, label: "1 hour" },
  { seconds: 86_400, label: "1 day" },
];
export const DEFAULT_DELIVERY_SECONDS = 3_600;

/** The delivery times to choose from; a time the offering has that is none of the three is kept as a fourth. */
export function deliveryOptions(currentSeconds?: number | null): Array<{ seconds: number; label: string }> {
  const options = [...DELIVERY_TIMES];
  if (
    typeof currentSeconds === "number" &&
    currentSeconds > 0 &&
    !options.some((option) => option.seconds === currentSeconds)
  ) {
    options.push({ seconds: currentSeconds, label: formatDuration(currentSeconds) });
  }
  return options.sort((a, b) => a.seconds - b.seconds);
}

/** The price of a task as typed, in cents, or the sentence that says why it cannot be saved. */
export function checkTaskPrice(text: string): { ok: true; cents: number } | { ok: false; message: string } {
  const price = checkPrice(text, "task", JOB_MIN_PRICE_CENTS, JOB_MAX_PRICE_CENTS);
  return "message" in price ? { ok: false, message: price.message } : { ok: true, cents: price.cents };
}

interface OfferingLike {
  agentId: string | null;
  status: string;
  formInSync?: boolean | null;
}

/**
 * The offering that sells this agent's task with guaranteed delivery from
 * its own form: one that is on first, then one that is paused or a draft.
 * An offering whose form was written by hand is not it.
 */
export function guaranteedOfferingOf<T extends OfferingLike>(offerings: readonly T[], agentId: string): T | null {
  const own = offerings.filter(
    (offering) =>
      offering.agentId === agentId &&
      offering.status !== "archived" &&
      (offering.formInSync === true || offering.formInSync === false),
  );
  return own.find((offering) => offering.status === "active") ?? own[0] ?? null;
}

/** How many other offerings this agent has, with a form written by hand. */
export function handWrittenOfferings(offerings: readonly OfferingLike[], agentId: string): number {
  return offerings.filter(
    (offering) =>
      offering.agentId === agentId &&
      offering.status !== "archived" &&
      offering.formInSync !== true &&
      offering.formInSync !== false,
  ).length;
}

/** The body that makes the offering: the agent, its name and line, the price and time, and its own form. */
export function guaranteedOfferingBody(
  agent: { id: string; name: string },
  line: string,
  priceCents: number,
  slaSeconds: number,
): {
  productKind: "agent";
  agentId: string;
  title: string;
  description: string;
  priceCents: number;
  slaSeconds: number;
  fromAgentForm: true;
} {
  return {
    productKind: "agent",
    agentId: agent.id,
    title: agent.name.trim().slice(0, LISTING_TITLE_MAX),
    description: line,
    priceCents,
    slaSeconds,
    fromAgentForm: true,
  };
}
