/**
 * Plans on a listing that sells use per request, as their creator sets them.
 *
 * A plan is prepaid uses on top of "Pay per use": a name, a price for 30
 * days, a number of uses, and what happens when they run out. The rows as
 * they are typed, the checks before a save, the one body a save sends, where
 * the API's sentences go when it refuses, and every word of the block and of
 * the on-sale lines. Pure, so the Sell tab and the listing wizard only lay it
 * out and cannot drift apart.
 *
 * Every amount is whole cents, read from what was typed digit by digit. What
 * a creator earns comes from `splitCents`, the API's own integer rule.
 */
import { splitCents } from "@wheelsai/shared/revenue";

import type { ListingPlan, ListingPlanInput } from "./api";
import { formatCents } from "./jobs";
import { MAX_MONTHLY_PRICE_CENTS, MAX_PRICE_PER_USE_CENTS, type SellForm } from "./sell-choice";

// ============================================
// Words
// ============================================

export const PLAN_WORDS = {
  title: "Plans",
  name: "Name",
  price: "Price for 30 days",
  uses: "Uses included",
  whenOut: "When they run out",
  stop: "Stop until the next 30 days",
  extra: "Charge for each extra use",
  extraPrice: "Price for each extra use",
  add: "Add a plan",
  remove: "Remove",
  end: "End plan",
  endTitle: "End this plan?",
  noUnlimited: "No plan is unlimited.",
  changed: "People already on this plan keep what they agreed to.",
  /** The listing went through and its plans did not: said first, before the reason. */
  notSaved: "Your listing was saved. Its plans were not.",
} as const;

// ============================================
// Limits
// ============================================

export interface PlanLimits {
  /** How many paid plans one listing can offer. */
  maxPlans: number;
  /** The most uses one plan can include. */
  maxIncludedUses: number;
  /** The smallest price of a plan for its 30 days, in cents. */
  minPlanPriceCents: number;
  /** The smallest price of one use past the included ones, in cents. */
  minExtraUsePriceCents: number;
}

/**
 * The numbers of apps/api/src/services/listingPlans.ts (MAX_PAID_PLANS,
 * MAX_INCLUDED_USES, MIN_PLAN_PRICE_CENTS, MIN_EXTRA_USE_PRICE_CENTS), used
 * only when `GET /api/capabilities` could not be read. The rule that a plan
 * costs at least a cent for each included use is not here on purpose: the
 * API says it in a sentence, and that sentence is shown under the field.
 */
export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  maxPlans: 4,
  maxIncludedUses: 6_000,
  minPlanPriceCents: 100,
  minExtraUsePriceCents: 5,
};

/** The longest name of a plan, counted after trimming. The API's MAX_PLAN_NAME_CHARS. */
export const PLAN_NAME_MAX = 40;

function wholePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The limits as `GET /api/capabilities` gives them; the API's own numbers when it could not be read. */
export function planLimitsOf(
  capabilities:
    | {
        paidUse?: {
          maxPlans?: unknown;
          maxIncludedUses?: unknown;
          minPlanPriceCents?: unknown;
          minExtraUsePriceCents?: unknown;
        } | null;
      }
    | null
    | undefined,
): PlanLimits {
  const paidUse = capabilities?.paidUse;
  return {
    maxPlans: wholePositive(paidUse?.maxPlans) ?? DEFAULT_PLAN_LIMITS.maxPlans,
    maxIncludedUses: wholePositive(paidUse?.maxIncludedUses) ?? DEFAULT_PLAN_LIMITS.maxIncludedUses,
    minPlanPriceCents: wholePositive(paidUse?.minPlanPriceCents) ?? DEFAULT_PLAN_LIMITS.minPlanPriceCents,
    minExtraUsePriceCents: wholePositive(paidUse?.minExtraUsePriceCents) ?? DEFAULT_PLAN_LIMITS.minExtraUsePriceCents,
  };
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

// ============================================
// Amounts as they are typed
// ============================================

/**
 * Dollars as typed, in whole cents: "9.99" is 999, "0.07" is 7, "9" is 900.
 * Read from the digits, so no amount passes through a fraction. null for
 * anything that is not dollars with at most two decimals ("9.999", "1e3",
 * "-1", "abc", an empty box).
 */
export function planCentsOf(text: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** A whole number of uses as typed; null for anything else. */
function usesOf(text: string): number | null {
  const trimmed = text.trim();
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : null;
}

/** "9.00" for 900: an amount as it sits in its input. */
function amountText(cents: number): string {
  const whole = Math.trunc(cents / 100);
  return `${whole}.${String(cents - whole * 100).padStart(2, "0")}`;
}

// ============================================
// The rows
// ============================================

export type PlanEnding = "stop" | "extra";

/** One plan as it is typed. Amounts are text, so an unfinished one can sit in its input. */
export interface PlanRow {
  /** Stable while the row is on screen: the plan's id, or "new-1" for one not saved yet. */
  key: string;
  /** The id of a plan the listing already has: it is changed in place. null for a new plan. */
  id: string | null;
  name: string;
  /** Dollars, as typed: what the 30 days cost. */
  price: string;
  /** As typed: how many uses the plan includes. */
  uses: string;
  /** What happens when the uses run out. */
  ending: PlanEnding;
  /** Dollars, as typed: the price of each extra use. Read only when `ending` is "extra". */
  extraPrice: string;
}

export interface PlansForm {
  /**
   * Whether the listing's plans were read. false: nothing is shown and
   * nothing is ever sent, because a set that was not read would be sent as
   * empty, and an empty set ends every plan.
   */
  loaded: boolean;
  rows: PlanRow[];
}

/** The plans a listing has, as `getMyListings` gives them. */
export type SavedPlan = ListingPlan;

/**
 * The listing's paid plans that are on offer, in the order a buyer sees
 * them. No listing yet: none. null when the listing came without its plans,
 * which is not the same as having none.
 */
export function savedPlansOf(listing: { plans?: readonly SavedPlan[] | null } | null | undefined): SavedPlan[] | null {
  if (!listing) return [];
  if (!Array.isArray(listing.plans)) return null;
  return listing.plans.filter((plan) => plan.kind === "paid" && plan.status === "active");
}

function rowOf(plan: SavedPlan): PlanRow {
  // A plan that came without the field stops, as one that says null does: an ending never flips unasked.
  const extra = plan.extraUsePriceCents ?? null;
  return {
    key: plan.id,
    id: plan.id,
    name: plan.name,
    price: amountText(plan.priceCents),
    uses: String(plan.includedUses),
    ending: extra === null ? "stop" : "extra",
    extraPrice: extra === null ? "" : amountText(extra),
  };
}

export function emptyPlansForm(): PlansForm {
  return { loaded: true, rows: [] };
}

/** The rows of the plans a listing has now. A listing that came without its plans is not loaded. */
export function plansFormOf(listing: { plans?: readonly SavedPlan[] | null } | null | undefined): PlansForm {
  const saved = savedPlansOf(listing);
  return saved === null ? { loaded: false, rows: [] } : { loaded: true, rows: saved.map(rowOf) };
}

export function canAddPlan(form: PlansForm, limits: PlanLimits = DEFAULT_PLAN_LIMITS): boolean {
  return form.loaded && form.rows.length < limits.maxPlans;
}

/** The form with one more empty row; unchanged at the maximum. */
export function addPlanRow(form: PlansForm, limits: PlanLimits = DEFAULT_PLAN_LIMITS): PlansForm {
  if (!canAddPlan(form, limits)) return form;
  const taken = form.rows.map((row) => /^new-(\d+)$/.exec(row.key)).map((match) => (match ? Number(match[1]) : 0));
  const key = `new-${Math.max(0, ...taken) + 1}`;
  return { ...form, rows: [...form.rows, { key, id: null, name: "", price: "", uses: "", ending: "stop", extraPrice: "" }] };
}

/** The form without a row. A plan the listing has is then left out of the save, which ends it. */
export function removePlanRow(form: PlansForm, key: string): PlansForm {
  return { ...form, rows: form.rows.filter((row) => row.key !== key) };
}

/** The form with one row changed. Its key and its id are the row's own and never change. */
export function withPlanRow(form: PlansForm, key: string, patch: Partial<Omit<PlanRow, "key" | "id">>): PlansForm {
  return { ...form, rows: form.rows.map((row) => (row.key === key ? { ...row, ...patch, key: row.key, id: row.id } : row)) };
}

// ============================================
// The checks before a save
// ============================================

/** `row` is a problem with the plan as a whole, not with one of its inputs. */
export type PlanField = "name" | "price" | "uses" | "extraPrice" | "row";
export type PlanRowErrors = Partial<Record<PlanField, string>>;

export interface PlanErrors {
  /** A problem with the set as a whole. */
  set?: string;
  /** Problems of each row, by its place in the list (0 first). */
  rows: Record<number, PlanRowErrors>;
}

export function noPlanErrors(): PlanErrors {
  return { rows: {} };
}

export function hasPlanErrors(errors: PlanErrors): boolean {
  return errors.set !== undefined || Object.keys(errors.rows).length > 0;
}

type RowCheck = { ok: true; plan: ListingPlanInput } | { ok: false; errors: PlanRowErrors };

/** One row as the API takes it, or the sentence under each input that cannot be sent. */
export function checkPlanRow(row: PlanRow, limits: PlanLimits = DEFAULT_PLAN_LIMITS): RowCheck {
  const errors: PlanRowErrors = {};

  const name = row.name.trim();
  // Counted as the API counts: one for each character, whatever it takes to store.
  const nameChars = [...name].length;
  if (nameChars < 1) errors.name = "Give the plan a name.";
  else if (nameChars > PLAN_NAME_MAX) errors.name = `The name of a plan can be at most ${PLAN_NAME_MAX} characters.`;

  const priceCents = planCentsOf(row.price);
  if (!row.price.trim()) errors.price = "Enter a price for 30 days.";
  else if (priceCents === null) {
    errors.price = `Enter the price for 30 days in dollars and cents, like ${amountText(limits.minPlanPriceCents)}.`;
  } else if (priceCents < limits.minPlanPriceCents) {
    errors.price = `The price for 30 days must be at least ${formatCents(limits.minPlanPriceCents)}.`;
  } else if (priceCents > MAX_MONTHLY_PRICE_CENTS) {
    errors.price = `The price for 30 days can be at most ${formatCents(MAX_MONTHLY_PRICE_CENTS)}.`;
  }

  const includedUses = usesOf(row.uses);
  if (!row.uses.trim()) errors.uses = "Enter how many uses the plan includes.";
  else if (includedUses === null && !/^\d+$/.test(row.uses.trim())) errors.uses = "Enter the uses as a whole number, like 500.";
  else if (includedUses === null || includedUses < 1 || includedUses > limits.maxIncludedUses) {
    errors.uses = `A plan includes between 1 and ${count(limits.maxIncludedUses)} uses.`;
  }

  let extraUsePriceCents: number | null = null;
  if (row.ending === "extra") {
    extraUsePriceCents = planCentsOf(row.extraPrice);
    if (!row.extraPrice.trim()) errors.extraPrice = "Enter a price for each extra use.";
    else if (extraUsePriceCents === null) {
      errors.extraPrice = `Enter the price for each extra use in dollars and cents, like ${amountText(limits.minExtraUsePriceCents)}.`;
    } else if (extraUsePriceCents < limits.minExtraUsePriceCents) {
      errors.extraPrice = `The price for each extra use must be at least ${formatCents(limits.minExtraUsePriceCents)}.`;
    } else if (extraUsePriceCents > MAX_PRICE_PER_USE_CENTS) {
      errors.extraPrice = `The price for each extra use can be at most ${formatCents(MAX_PRICE_PER_USE_CENTS)}.`;
    }
  }

  if (Object.keys(errors).length > 0 || priceCents === null || includedUses === null) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      ...(row.id !== null && { id: row.id }),
      kind: "paid",
      name,
      priceCents,
      includedUses,
      // Always said: null is "Stop until the next 30 days".
      extraUsePriceCents,
    },
  };
}

type SetCheck = { ok: true; plans: ListingPlanInput[] } | { ok: false; errors: PlanErrors };

/** Every row as the API takes it, in the order shown, or the problems of each row. */
export function checkPlans(form: Pick<PlansForm, "rows">, limits: PlanLimits = DEFAULT_PLAN_LIMITS): SetCheck {
  const errors = noPlanErrors();
  if (form.rows.length > limits.maxPlans) errors.set = `A listing can have at most ${count(limits.maxPlans)} plans.`;
  const plans: ListingPlanInput[] = [];
  form.rows.forEach((row, index) => {
    const checked = checkPlanRow(row, limits);
    if (checked.ok) plans.push(checked.plan);
    else errors.rows[index] = checked.errors;
  });
  return hasPlanErrors(errors) ? { ok: false, errors } : { ok: true, plans };
}

// ============================================
// What a save sends
// ============================================

export type PlansSave =
  /** No call is made: nothing about the plans changed, they were never read, or the listing is not sold per use. */
  | { kind: "none" }
  /** The whole set, to `marketplaceApi.setListingPlans`. A plan left out of it is ended. */
  | { kind: "send"; plans: ListingPlanInput[] }
  /** A row cannot be sent yet. */
  | { kind: "invalid"; errors: PlanErrors };

export interface PlansSaveInput {
  /** The answer to "Who can use it?" as it is being saved. */
  sell: Pick<SellForm, "sells" | "choice">;
  form: PlansForm;
  /** The listing's plans as they were read; null when they were not. */
  saved: readonly SavedPlan[] | null;
  limits?: PlanLimits;
}

/** Whether the answer is "Pay per use" of the agent itself: the one answer that has plans. */
export function sellsWithPlans(sell: Pick<SellForm, "sells" | "choice">): boolean {
  return sell.sells === "use" && sell.choice === "per_use";
}

function sameAsSaved(plans: readonly ListingPlanInput[], saved: readonly SavedPlan[]): boolean {
  return (
    plans.length === saved.length &&
    plans.every((plan, index) => {
      const before = saved[index]!;
      return (
        plan.id === before.id &&
        plan.name === before.name.trim() &&
        plan.priceCents === before.priceCents &&
        plan.includedUses === before.includedUses &&
        plan.extraUsePriceCents === (before.extraUsePriceCents ?? null)
      );
    })
  );
}

/**
 * The one place the body of a save of plans is made. Always the whole set:
 * a plan from the server keeps its id and is changed in place, a new one has
 * none, a row that was removed is absent (which ends that plan), and every
 * plan says `extraUsePriceCents`, null for one that stops.
 *
 * Nothing is sent when the listing is not sold per use, when nothing about
 * the plans changed, and when the listing's plans were never read.
 */
export function plansSaveOf(input: PlansSaveInput): PlansSave {
  const { sell, form, saved } = input;
  const limits = input.limits ?? DEFAULT_PLAN_LIMITS;
  if (!sellsWithPlans(sell)) return { kind: "none" };
  if (!form.loaded || saved === null) return { kind: "none" };

  const check = checkPlans(form, limits);
  if (!check.ok) {
    // Rows exactly as the server gave them are not this save's to refuse.
    const untouched = JSON.stringify(form.rows) === JSON.stringify(saved.map(rowOf));
    return untouched ? { kind: "none" } : { kind: "invalid", errors: check.errors };
  }
  if (sameAsSaved(check.plans, saved)) return { kind: "none" };
  return { kind: "send", plans: check.plans };
}

const FIELD_ORDER: readonly PlanField[] = ["name", "price", "uses", "extraPrice", "row"];

function firstProblem(errors: PlanErrors): string | null {
  if (errors.set !== undefined) return errors.set;
  const indexes = Object.keys(errors.rows)
    .map(Number)
    .sort((a, b) => a - b);
  for (const index of indexes) {
    const row = errors.rows[index]!;
    const field = FIELD_ORDER.find((candidate) => row[candidate] !== undefined);
    if (field) return `Plan ${index + 1}: ${row[field]}`;
  }
  return null;
}

/** Why the plans cannot be saved, in one sentence that names the plan; null when they can. */
export function plansProblem(input: PlansSaveInput): string | null {
  const save = plansSaveOf(input);
  return save.kind === "invalid" ? firstProblem(save.errors) : null;
}

/** The API's own field names of a plan, and the input each one is about. */
const PLAN_FIELD_OF: Record<string, PlanField> = {
  name: "name",
  priceCents: "price",
  includedUses: "uses",
  extraUsePriceCents: "extraPrice",
  // Not inputs: a plan sent twice, one that is no longer on the listing, a kind that is not sold.
  id: "row",
  kind: "row",
};

/**
 * The sentences of a refused save of plans (400 `validation_failed`), each
 * under the input of the row it is about: "plans[1].priceCents" is the price
 * of the second row, and "plans" is the set as a whole. A field that is not
 * about a plan is left out, so its sentence is shown as the refusal's message.
 */
export function planFieldErrors(fields: Record<string, string>): PlanErrors {
  const errors = noPlanErrors();
  for (const [path, sentence] of Object.entries(fields)) {
    if (path === "plans") {
      errors.set ??= sentence;
      continue;
    }
    const match = /^plans\[(\d+)\]\.([A-Za-z]+)$/.exec(path);
    if (!match) continue;
    const field = Object.prototype.hasOwnProperty.call(PLAN_FIELD_OF, match[2]!) ? PLAN_FIELD_OF[match[2]!] : undefined;
    if (!field) continue;
    const row = (errors.rows[Number(match[1])] ??= {});
    row[field] ??= sentence;
  }
  return errors;
}

/**
 * What is said when the listing was saved and its plans were refused: that,
 * then the API's own sentence as it came. Without one (each sentence is
 * under its field) only the first part is said.
 */
export function plansRefusedLine(message?: string | null): string {
  const reason = (message ?? "").trim();
  return reason ? `${PLAN_WORDS.notSaved} ${reason}` : PLAN_WORDS.notSaved;
}

/**
 * The one line after a save on the Sell tab that went through in part. The
 * listing is saved by then; its plans and the setting to keep a copy are
 * saved after it, each on its own, and one that failed is never left unsaid
 * because the other failed too. `plans` is `plansRefusedLine`'s sentence,
 * `keepCopy` the reason the setting was not saved. null when both went through.
 */
export function partSavedLine(plans: string | null, keepCopy: string | null): string | null {
  if (plans && keepCopy) return `${plans} The setting to keep a copy was not saved: ${keepCopy}`;
  if (plans) return plans;
  if (keepCopy) return `Your choice was saved. The setting to keep a copy was not: ${keepCopy}`;
  return null;
}

// ============================================
// The lines under a row
// ============================================

/**
 * "You earn $8.10 of each $9.00." From the same integer rule the API pays
 * by. null while no price is typed, and for one below the smallest price.
 */
export function planEarnLine(row: Pick<PlanRow, "price">, limits: PlanLimits = DEFAULT_PLAN_LIMITS): string | null {
  const cents = planCentsOf(row.price);
  if (cents === null || cents < limits.minPlanPriceCents) return null;
  const { grossCents, creatorCents } = splitCents(cents);
  if (grossCents !== cents) return null;
  return `You earn ${formatCents(creatorCents)} of each ${formatCents(grossCents)}.`;
}

/** Thousandths of a dollar as money: "$0.018", and "$0.02" when it is a whole cent. */
function formatMills(mills: number): string {
  if (mills % 10 === 0) return formatCents(mills / 10);
  return `$${count(Math.trunc(mills / 1000))}.${String(mills % 1000).padStart(3, "0")}`;
}

/**
 * "That is $0.018 a use. Pay per use is $0.05." The plan's price divided by
 * its uses, to a tenth of a cent, beside the listing's price per use as it
 * is typed in the same form. The second sentence is left out while no price
 * per use is typed. null while the plan has no price or no uses.
 */
export function planPerUseLine(row: Pick<PlanRow, "price" | "uses">, perUsePrice: string): string | null {
  const cents = planCentsOf(row.price);
  const uses = usesOf(row.uses);
  if (cents === null || cents <= 0 || uses === null || uses < 1) return null;
  // Tenths of a cent, a half going up, in whole numbers.
  const mills = Math.floor((cents * 20 + uses) / (uses * 2));
  if (mills < 1) return null;
  const perUse = planCentsOf(perUsePrice);
  const each = `That is ${formatMills(mills)} a use.`;
  return perUse !== null && perUse > 0 ? `${each} Pay per use is ${formatCents(perUse)}.` : each;
}

// ============================================
// A plan that has subscribers
// ============================================

function subscribersOf(plan: Pick<SavedPlan, "subscribers">): number {
  return wholePositive(plan.subscribers) ?? 0;
}

function savedPlanOf(row: Pick<PlanRow, "id">, saved: readonly SavedPlan[] | null): SavedPlan | null {
  if (row.id === null) return null;
  return (saved ?? []).find((plan) => plan.id === row.id) ?? null;
}

/**
 * "People already on this plan keep what they agreed to." Beside a plan
 * that has subscribers once anything about it was changed; null otherwise.
 */
export function planChangedNote(row: PlanRow, saved: readonly SavedPlan[] | null): string | null {
  const before = savedPlanOf(row, saved);
  if (!before || subscribersOf(before) === 0) return null;
  return JSON.stringify(row) === JSON.stringify(rowOf(before)) ? null : PLAN_WORDS.changed;
}

/** What the button that takes a row away says: a plan the listing has is ended, a new row is removed. */
export function removePlanLabel(row: Pick<PlanRow, "id">): string {
  return row.id === null ? PLAN_WORDS.remove : PLAN_WORDS.end;
}

/**
 * What is asked before a plan that has subscribers is ended: "12 subscribers
 * keep this plan until the 30 days they paid for end. They are not charged
 * again." null for a plan nobody is on, and for a new row: those go unasked.
 */
export function endPlanDialog(
  row: Pick<PlanRow, "id">,
  saved: readonly SavedPlan[] | null,
): { title: string; description: string; confirmLabel: string } | null {
  const before = savedPlanOf(row, saved);
  const subscribers = before ? subscribersOf(before) : 0;
  if (subscribers === 0) return null;
  const keep =
    subscribers === 1
      ? "1 subscriber keeps this plan until the 30 days they paid for end."
      : `${count(subscribers)} subscribers keep this plan until the 30 days they paid for end.`;
  return { title: PLAN_WORDS.endTitle, description: `${keep} They are not charged again.`, confirmLabel: PLAN_WORDS.end };
}

/**
 * The plans the listing has that are no longer among the rows, each as one
 * line: a plan is ended by the save, not by the button, and this says so.
 */
export function endingPlanLines(form: PlansForm, saved: readonly SavedPlan[] | null): string[] {
  if (!form.loaded || saved === null) return [];
  const kept = new Set(form.rows.map((row) => row.id));
  return saved.filter((plan) => !kept.has(plan.id)).map((plan) => `${plan.name.trim()} ends when you save.`);
}

// ============================================
// The on-sale state
// ============================================

function subscribersText(subscribers: number): string {
  if (subscribers === 0) return "No subscribers";
  return subscribers === 1 ? "1 subscriber" : `${count(subscribers)} subscribers`;
}

/** "Starter. $9.00 for 30 days. 500 uses. 12 subscribers." The number of subscribers is the creator's to see. */
export function planSaleLine(plan: SavedPlan): string {
  const uses = plan.includedUses === 1 ? "1 use" : `${count(plan.includedUses)} uses`;
  return `${plan.name.trim()}. ${formatCents(plan.priceCents)} for 30 days. ${uses}. ${subscribersText(subscribersOf(plan))}.`;
}

/** One line for each plan of a listing that is sold per use; none for any other listing. */
export function planSaleLines(
  listing: { sells?: string | null; pricingModel: string; plans?: readonly SavedPlan[] | null } | null | undefined,
): Array<{ id: string; line: string }> {
  if (!listing || listing.sells === "copies" || listing.pricingModel !== "per_request") return [];
  return (savedPlansOf(listing) ?? []).map((plan) => ({ id: plan.id, line: planSaleLine(plan) }));
}

/**
 * What moving a listing that is on sale away from "Pay per use" does to the
 * people on its plans, with their number; null when nobody is on one. The
 * API lets a plan run to the end of the 30 days that were paid for and does
 * not renew it once the listing is no longer sold per request
 * (services/useAccess.ts and the renewal in services/marketplaceSubscriptions.ts).
 */
export function plansKeptLine(
  listing: { sells?: string | null; pricingModel: string; status?: string; plans?: readonly SavedPlan[] | null } | null | undefined,
  sell: Pick<SellForm, "sells" | "choice">,
): string | null {
  if (!listing || listing.status !== "published" || listing.sells === "copies" || listing.pricingModel !== "per_request") {
    return null;
  }
  // Selling copies instead has its own dialog, which counts these people among its subscribers.
  if (sell.sells !== "use" || sell.choice === "per_use") return null;
  const subscribers = (savedPlansOf(listing) ?? []).reduce((sum, plan) => sum + subscribersOf(plan), 0);
  if (subscribers === 0) return null;
  return subscribers === 1
    ? "1 subscriber keeps their plan until the 30 days they paid for end and is not charged again."
    : `${count(subscribers)} subscribers keep their plan until the 30 days they paid for end and are not charged again.`;
}
