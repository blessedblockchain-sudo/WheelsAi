/**
 * Token-launch eligibility gate (plan A1 + A4).
 *
 * Pure check that runs BEFORE the pump.fun create-token call. This is the
 * platform's anti-scam differentiator vs. open launchpads (Virtuals,
 * auto.fun, raw pump.fun): an agent can only mint a token after the
 * platform has observed it long enough to have something to verify.
 *
 * Three callers must agree on the same numbers:
 *   1. The launch UI shows "you can launch in 4 more days" up-front
 *   2. The launch route enforces it at submit time
 *   3. The public transparency page renders it as the agent's "eligibility
 *      badge" so prospective holders can see why they should trust it
 *
 * Returning every violation in one pass (instead of fail-fast) lets the UI
 * show a single "fix these 3 things" panel rather than driving the user
 * through a frustrating retry loop.
 *
 * All thresholds are inclusive (rep >= 50, uptime >= 7d) so an agent that
 * just hit the boundary doesn't get rejected by a one-second jitter.
 */

export const ELIGIBILITY_DEFAULTS = {
  minReputation: 50,
  minDeploymentAgeDays: 7,
} as const;

export interface LaunchGateThresholds {
  minReputation: number;
  minDeploymentAgeDays: number;
}

/**
 * Where the two settings are read from: the process environment as the
 * server has it, or the parsed settings of config/env.ts (numbers).
 */
export interface LaunchGateSource {
  TOKEN_LAUNCH_MIN_REPUTATION?: number | string;
  TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS?: number | string;
}

/**
 * The gate's two numbers as this server is configured
 * (TOKEN_LAUNCH_MIN_REPUTATION, TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS).
 * Unset, they are ELIGIBILITY_DEFAULTS: the production rule. A devnet
 * rehearsal may lower them. The launch route, the eligibility preview and
 * the wizard must all read them from here, so what the wizard promises is
 * what the route enforces.
 *
 * The default source is process.env, not the parsed `env` of config/env.ts.
 * Importing that module validates every setting the moment it is loaded
 * and ends the process when one is missing, and this file is imported by
 * routes whose tests load them before any setting exists. The server has
 * already refused to start on a value config/env.ts does not accept, so
 * here a value that cannot be read is treated as unset: the production
 * rule, never a lower one.
 */
export function launchGateThresholds(
  source: LaunchGateSource = process.env as LaunchGateSource,
): LaunchGateThresholds {
  return {
    minReputation:
      readGateNumber(source.TOKEN_LAUNCH_MIN_REPUTATION, { max: 100, whole: false }) ??
      ELIGIBILITY_DEFAULTS.minReputation,
    minDeploymentAgeDays:
      readGateNumber(source.TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS, { whole: true }) ??
      ELIGIBILITY_DEFAULTS.minDeploymentAgeDays,
  };
}

// The same bounds config/env.ts sets: reputation 0 to 100, days a whole
// number from 0. An empty value counts as unset.
function readGateNumber(
  value: number | string | undefined,
  rule: { max?: number; whole: boolean },
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  if (rule.max !== undefined && parsed > rule.max) return undefined;
  if (rule.whole && !Number.isInteger(parsed)) return undefined;
  return parsed;
}

/**
 * Sybil discount (B4/T7): every SETTLED x402 payment attributed to the
 * agent shaves one point off the reputation requirement, capped at half
 * the default threshold.
 *
 * Why this is sybil-resistant where raw usage is not: reputation is fed
 * by usage the org can generate against itself for free. A settled x402
 * payment is money that verifiably left a wallet on-chain and landed in
 * the PLATFORM treasury — even "self"-payment forfeits real funds, so
 * the signal is costly by construction. The cap keeps paid traffic from
 * fully substituting for observed behavior: at best it halves the
 * reputation bar, and every other gate (uptime, listing, not-already-
 * tokenized, creator wallet) stays hard.
 */
export const PAID_REQUEST_DISCOUNT_POINTS = 1;
export const MAX_PAID_DISCOUNT_POINTS = 25;

/**
 * Days the creator's allocation is locked after launch. Single source of
 * truth — imported by the launch routes and the legacy custodial path so
 * the number can't drift across the codebase (or the UI that displays it).
 */
export const CREATOR_LOCKUP_DAYS = 30;

export type EligibilityReason =
  | "reputation_too_low"
  | "uptime_insufficient"
  | "listing_not_published"
  | "already_tokenized"
  | "creator_address_missing";

export interface EligibilityInput {
  reputationScore: number;
  deploymentAgeDays: number;
  hasPublishedListing: boolean;
  alreadyTokenized: boolean;
  creatorAddress: string;
  /**
   * Count of SETTLED x402 payments attributed to this agent's
   * deployments (confirmed on-chain into the platform treasury).
   * Discounts the reputation requirement — see the constants above.
   */
  settledPaidRequests?: number;
  // Left out, the two numbers are the server's: launchGateThresholds().
  minReputation?: number;
  minDeploymentAgeDays?: number;
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reasons: EligibilityReason[] };

/**
 * `gate` is the two numbers in force: the server's settings unless a test
 * passes its own. A number on the input itself still wins over both, so a
 * caller with a rule of its own keeps it.
 */
export function checkTokenEligibility(
  input: EligibilityInput,
  gate: LaunchGateThresholds = launchGateThresholds(),
): EligibilityResult {
  const minReputation = input.minReputation ?? gate.minReputation;
  const minDeploymentAgeDays = input.minDeploymentAgeDays ?? gate.minDeploymentAgeDays;

  const reasons: EligibilityReason[] = [];

  const paidDiscount = Math.min(
    Math.max(input.settledPaidRequests ?? 0, 0) * PAID_REQUEST_DISCOUNT_POINTS,
    MAX_PAID_DISCOUNT_POINTS,
  );
  const effectiveMinReputation = minReputation - paidDiscount;

  if (input.reputationScore < effectiveMinReputation) {
    reasons.push("reputation_too_low");
  }
  if (input.deploymentAgeDays < minDeploymentAgeDays) {
    reasons.push("uptime_insufficient");
  }
  if (!input.hasPublishedListing) {
    reasons.push("listing_not_published");
  }
  if (input.alreadyTokenized) {
    reasons.push("already_tokenized");
  }
  if (!input.creatorAddress || input.creatorAddress.trim().length === 0) {
    reasons.push("creator_address_missing");
  }

  if (reasons.length === 0) return { eligible: true };
  // Sort reasons so callers (UI, transparency page) render them deterministically.
  reasons.sort();
  return { eligible: false, reasons };
}
