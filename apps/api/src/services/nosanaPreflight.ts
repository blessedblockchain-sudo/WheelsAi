/**
 * The deploy pre-flight every caller runs before anything is reserved, and the
 * HTTP answer for a refusal that comes from the platform's own funding.
 *
 * With wallet access the pre-flight is the static check it always was. With
 * API-key access it also reads the platform's prepaid credits (fresh, fail
 * closed) and compares the tier's retail price with what Nosana charges. Both
 * live on NosanaClient.preflightDeploy; a port that does not implement it (a
 * test fake, an older adapter) falls back to assertCanDeploy.
 */

import type { NosanaAccessMode } from "../config/nosanaAccess.js";
import type { NosanaClient } from "./nosana.js";

export type DeployPreflightPort = Pick<NosanaClient, "assertCanDeploy"> &
  Partial<Pick<NosanaClient, "preflightDeploy">>;

/** Throws what assertCanDeploy / preflightDeploy throw; resolves when a deploy may proceed. */
export async function runDeployPreflight(
  port: DeployPreflightPort,
  tier: string,
  replicas: number,
  kind: "service" | "batch" = "service",
  options: { timeoutSeconds?: number } = {},
): Promise<void> {
  if (typeof port.preflightDeploy === "function") {
    await port.preflightDeploy(tier, replicas, kind, options);
    return;
  }
  port.assertCanDeploy(tier);
}

/**
 * What a customer reads when the platform's own compute setup refuses a
 * deploy: no Nosana account is loaded, or the chosen tier has no market on
 * the network in use. The detail (which setting) goes to the log, never here.
 */
export const COMPUTE_UNAVAILABLE_MESSAGE =
  "New GPU deployments are temporarily unavailable. Nothing was reserved or charged. Try again later.";
export const GPU_TIER_UNAVAILABLE_MESSAGE =
  "This GPU tier is not available right now. Choose another tier. Nothing was reserved.";

/**
 * Refusals that mean "the platform cannot pay for new compute right now".
 * The reason is for an operator and for support; the message is for the
 * customer and never states an amount.
 */
const COMPUTE_REFUSAL_MESSAGES: Record<string, string> = {
  nosana_credits_low:
    "New GPU deployments are temporarily unavailable. Nothing was reserved or charged. Try again in a few minutes.",
  nosana_credits_unavailable:
    "New GPU deployments are temporarily unavailable. Nothing was reserved or charged. Try again in a few minutes.",
  nosana_auth_failed:
    "New GPU deployments are temporarily unavailable. Nothing was reserved or charged. Try again in a few minutes.",
  gpu_price_below_cost:
    "This GPU tier is temporarily unavailable. Choose another tier, or try again later. Nothing was reserved.",
  gpu_cost_unavailable:
    "This GPU tier is temporarily unavailable. Choose another tier, or try again later. Nothing was reserved.",
};

export const COMPUTE_REFUSAL_CODES: ReadonlySet<string> = new Set(
  Object.keys(COMPUTE_REFUSAL_MESSAGES),
);

export interface ComputeRefusal {
  status: 503;
  body: { error: "compute_capacity_unavailable"; reason: string; message: string };
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The 503 for a funding refusal, or null when `error` is something else. */
export function computeRefusal(error: unknown): ComputeRefusal | null {
  const code = codeOf(error);
  if (!code || !COMPUTE_REFUSAL_CODES.has(code)) return null;
  return {
    status: 503,
    body: {
      error: "compute_capacity_unavailable",
      reason: code,
      message: COMPUTE_REFUSAL_MESSAGES[code]!,
    },
  };
}

/** A row's Nosana id belongs to an access mode this process has no credential for. */
export function isAccessModeUnavailable(error: unknown): boolean {
  return codeOf(error) === "nosana_access_mode_unavailable";
}

/** One-shot jobs were asked of API-key access (NosanaOneShotUnavailableError). */
export function isOneShotUnavailable(error: unknown): boolean {
  return codeOf(error) === "nosana_one_shot_unavailable";
}

/** The mode to store beside a Nosana id: null for the dev mock, which has none. */
export function storedAccessMode(mode: NosanaAccessMode | undefined): NosanaAccessMode | null {
  return mode ?? null;
}
