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
  minReputation?: number;
  minDeploymentAgeDays?: number;
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reasons: EligibilityReason[] };

export function checkTokenEligibility(input: EligibilityInput): EligibilityResult {
  const minReputation = input.minReputation ?? ELIGIBILITY_DEFAULTS.minReputation;
  const minDeploymentAgeDays =
    input.minDeploymentAgeDays ?? ELIGIBILITY_DEFAULTS.minDeploymentAgeDays;

  const reasons: EligibilityReason[] = [];

  if (input.reputationScore < minReputation) {
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
