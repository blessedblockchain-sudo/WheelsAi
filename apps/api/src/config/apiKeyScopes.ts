/**
 * What an API key may be granted, and what each grant means.
 *
 * A key belongs to an organization, not a person, so it has no role. Scopes
 * are how a key is cut down, with one rule that is not symmetrical:
 *
 *   - An ordinary scope is held by a key that lists it, by a key that lists
 *     "*", and by a key created with no scopes at all (every key made before
 *     scopes existed; they keep the access they always had).
 *   - A SPEND scope is held ONLY by a key that lists it by name. Neither "*"
 *     nor an empty list grants it: a key somebody made last year to read
 *     deployments must not be able to buy things today.
 *
 * A key granted jobs:hire must also carry both spend caps (the most one job
 * may cost, and the most it may spend in a UTC day).
 *
 * Pure: no IO.
 */

export const API_KEY_SCOPES = [
  "*",
  "agents:invoke",
  "workflows:invoke",
  "offerings:write",
  "jobs:read",
  "jobs:hire",
  "jobs:review",
  "marketplace:install",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Scopes that move the organization's money: hiring (escrow), accepting or
 * rejecting a deliverable (release or refund), and installing a listing (a
 * monthly subscription charges at install).
 */
export const SPEND_SCOPES: readonly ApiKeyScope[] = ["jobs:hire", "jobs:review", "marketplace:install"];

export function isSpendScope(scope: string): boolean {
  return (SPEND_SCOPES as readonly string[]).includes(scope);
}

/** Whether a key holding `granted` may use `scope`. */
export function grantsScope(granted: readonly string[] | undefined, scope: string): boolean {
  const scopes = granted ?? [];
  if (scopes.includes(scope)) return true;
  if (isSpendScope(scope)) return false;
  return scopes.length === 0 || scopes.includes("*");
}

/** The most a spending key's caps may be set to: the price of one job, and 100 of them. */
export const MAX_JOB_PRICE_CAP_CENTS = 100_000;
export const MAX_DAILY_SPEND_CAP_CENTS = 10_000_000;

export type KeyGrantProblem =
  | { code: "invalid_scope"; message: string; scopes: string[] }
  | { code: "spend_caps_required"; message: string }
  | { code: "invalid_spend_cap"; message: string };

/** Checks what a new key asks for. null = it may be created as asked. */
export function checkKeyGrant(grant: {
  scopes: readonly string[];
  maxJobPriceCents?: number | null;
  dailySpendCapCents?: number | null;
}): KeyGrantProblem | null {
  const unknown = grant.scopes.filter((scope) => !(API_KEY_SCOPES as readonly string[]).includes(scope));
  if (unknown.length > 0) {
    return {
      code: "invalid_scope",
      message: `Unknown scope${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Allowed: ${API_KEY_SCOPES.join(", ")}.`,
      scopes: unknown,
    };
  }
  const { maxJobPriceCents: perJob, dailySpendCapCents: perDay } = grant;
  const hires = grant.scopes.includes("jobs:hire");
  if (hires && (perJob == null || perDay == null)) {
    return {
      code: "spend_caps_required",
      message:
        "A key that can hire (jobs:hire) needs both spend caps: maxJobPriceCents (the most one job may cost) and dailySpendCapCents (the most it may spend in one UTC day).",
    };
  }
  if (!hires && (perJob != null || perDay != null)) {
    return { code: "invalid_spend_cap", message: "Spend caps apply only to a key granted jobs:hire." };
  }
  const whole = (value: number | null | undefined, max: number) =>
    value == null || (Number.isInteger(value) && value >= 1 && value <= max);
  if (!whole(perJob, MAX_JOB_PRICE_CAP_CENTS) || !whole(perDay, MAX_DAILY_SPEND_CAP_CENTS)) {
    return {
      code: "invalid_spend_cap",
      message: `Spend caps are whole cents: maxJobPriceCents from 1 to ${MAX_JOB_PRICE_CAP_CENTS}, dailySpendCapCents from 1 to ${MAX_DAILY_SPEND_CAP_CENTS}.`,
    };
  }
  if (perJob != null && perDay != null && perJob > perDay) {
    return { code: "invalid_spend_cap", message: "maxJobPriceCents cannot be more than dailySpendCapCents." };
  }
  return null;
}
