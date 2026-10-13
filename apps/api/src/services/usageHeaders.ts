/**
 * The usage headers of a paid answer.
 *
 * A buyer who calls a paid agent by API reads where they stand from the
 * headers, without parsing the body and without asking again: what this use
 * cost, what credits are left and, on a plan, how much of it is used.
 *
 *   usageHeadersOf          the headers of an answer, from the billing object
 *                           its body carries.
 *   refusalUsageHeadersOf   the plan's headers of the one refusal that has
 *                           them (a plan that is used up), and nothing for
 *                           every other refusal.
 *   setUsageHeaders         puts either on a reply, before its body.
 *   clearUsageHeaders       takes them off a reply that will not carry the
 *                           answer after all.
 *
 * The numbers are the body's: both functions only write out what they are
 * given, so a header can never say something else than `billing` does, and
 * nothing is counted or read for a header.
 *
 * A header that cannot be worked out is left out, one by one. Neither
 * function throws, whatever it is handed: a header must never cost a buyer
 * the answer they paid for.
 *
 * Pure: types only are imported, so the API page's data and the docs can
 * list the names from here without loading anything.
 */

import type { PaidUseBilling } from "./paidUse.js";

/**
 * What the headers need of a refusal (services/paidUse.ts, PaidUseRefusal).
 * `planCount` is the count the refusal was decided on: the plan's id and its
 * uses, as they were read for that request.
 */
export interface UsageRefusal {
  code: string;
  /** plan_used_up: when the plan's count starts again. Left out when the plan will not renew. */
  resetsAt?: string;
  planCount?: {
    id: string | null;
    includedUses: number;
    carriedUses: number;
    usedUses: number;
  };
}

/** What this use cost, in cents: 0 for an included use and inside a paid month. */
export const CHARGED_CENTS_HEADER = "x-wheelsai-charged-cents";
/** The buyer's credits after the use, in cents. Left out when they could not be read. */
export const BALANCE_CENTS_HEADER = "x-wheelsai-balance-cents";
/** The id of the plan the buyer is on. */
export const PLAN_HEADER = "x-wheelsai-plan";
/** The uses of the plan's period: included plus carried. */
export const PLAN_LIMIT_HEADER = "x-wheelsai-plan-limit";
export const PLAN_USED_HEADER = "x-wheelsai-plan-used";
export const PLAN_REMAINING_HEADER = "x-wheelsai-plan-remaining";
/** When the count starts again, an ISO time. Left out when the plan will not renew. */
export const PLAN_RESET_HEADER = "x-wheelsai-plan-reset";
/** 85 or 100. Left out below 85. */
export const PLAN_WARNING_HEADER = "x-wheelsai-plan-warning";

/** The headers only an answer on a plan, or the refusal that a plan is used up, carries. */
export const PLAN_USAGE_HEADER_NAMES = [
  PLAN_HEADER,
  PLAN_LIMIT_HEADER,
  PLAN_USED_HEADER,
  PLAN_REMAINING_HEADER,
  PLAN_RESET_HEADER,
  PLAN_WARNING_HEADER,
] as const;

/** Every usage header, in the order they are told. */
export const USAGE_HEADER_NAMES = [CHARGED_CENTS_HEADER, BALANCE_CENTS_HEADER, ...PLAN_USAGE_HEADER_NAMES] as const;

export type UsageHeaderName = (typeof USAGE_HEADER_NAMES)[number];
export type UsageHeaders = Partial<Record<UsageHeaderName, string>>;

/** The warnings a header may tell. */
const WARNING_LEVELS: readonly unknown[] = [85, 100];

/** A plan's id as a header may carry it: what an id is made of, and nothing a header could not hold. */
const HEADER_SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A count or an amount of cents as whole digits; null when it is not one. */
function digits(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

/** An ISO time exactly as it was given; null when it is not one. */
function isoTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = new Date(value);
  return !Number.isNaN(time.getTime()) && time.toISOString() === value ? value : null;
}

function put(headers: UsageHeaders, name: UsageHeaderName, value: string | null): void {
  if (value !== null) headers[name] = value;
}

/** What both the answer and the refusal say of a plan. */
function planHeaders(
  headers: UsageHeaders,
  plan: {
    id: unknown;
    includedUses: unknown;
    carriedUses: unknown;
    usedUses: unknown;
    remainingUses: unknown;
    resetsAt?: unknown;
    warning: unknown;
  },
): void {
  put(headers, PLAN_HEADER, typeof plan.id === "string" && HEADER_SAFE_ID.test(plan.id) ? plan.id : null);
  const included = digits(plan.includedUses);
  const carried = digits(plan.carriedUses);
  put(headers, PLAN_LIMIT_HEADER, included !== null && carried !== null ? digits(Number(included) + Number(carried)) : null);
  put(headers, PLAN_USED_HEADER, digits(plan.usedUses));
  put(headers, PLAN_REMAINING_HEADER, digits(plan.remainingUses));
  put(headers, PLAN_RESET_HEADER, isoTime(plan.resetsAt));
  put(headers, PLAN_WARNING_HEADER, WARNING_LEVELS.includes(plan.warning) ? String(plan.warning) : null);
}

/**
 * The headers of one paid answer, from the billing object its body carries.
 * Without a plan (a price per use, a paid month): the charge and the balance.
 */
export function usageHeadersOf(billing: PaidUseBilling): UsageHeaders {
  const headers: UsageHeaders = {};
  try {
    put(headers, CHARGED_CENTS_HEADER, digits(billing.chargedCents));
    put(headers, BALANCE_CENTS_HEADER, digits(billing.balanceCents));
    const { plan } = billing;
    if (plan) planHeaders(headers, plan);
  } catch {
    // Not a billing object at all. What was worked out so far stands.
  }
  return headers;
}

/**
 * The plan's headers of a refusal that a plan is used up: the count as it
 * stands, nothing remaining, and when it starts again if it will. Nothing
 * was charged and no use was taken, so it says no charge and no balance.
 * Every other refusal has no usage header at all.
 */
export function refusalUsageHeadersOf(refusal: UsageRefusal): UsageHeaders {
  const headers: UsageHeaders = {};
  try {
    if (refusal.code !== "plan_used_up" || !refusal.planCount) return headers;
    const count = refusal.planCount;
    planHeaders(headers, {
      id: count.id,
      includedUses: count.includedUses,
      carriedUses: count.carriedUses,
      usedUses: count.usedUses,
      remainingUses: 0,
      resetsAt: refusal.resetsAt,
      warning: 100,
    });
  } catch {
    // Not a refusal at all: it carries none.
  }
  return headers;
}

/** What the two below need of a reply. Fastify's reply satisfies it. */
export interface UsageHeaderReply {
  header(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
}

/** Puts usage headers on a reply. Each value was checked where it was built, so none can spoil the reply. */
export function setUsageHeaders(reply: UsageHeaderReply, headers: UsageHeaders): void {
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
}

/** Takes an answer's usage headers off a reply that will not carry the answer after all. */
export function clearUsageHeaders(reply: UsageHeaderReply): void {
  for (const name of USAGE_HEADER_NAMES) reply.removeHeader(name);
}
