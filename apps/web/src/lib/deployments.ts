/**
 * How GPU deployment outcomes are worded in the dashboard.
 *
 * The API tells an owner WHAT happened in terms that are theirs (their
 * credits, their deployment); how the platform pays its GPU provider is not
 * shown. So a refusal carries no provider reason here, and a run that ended
 * is explained only for the reasons that have a plain meaning to the owner.
 */

import { getApiErrorBody } from "./api";

/** Shown when the API answers 503 compute_capacity_unavailable. */
export const COMPUTE_PAUSED_MESSAGE =
  "New GPU deployments are temporarily unavailable. Nothing was reserved or charged. Try again in a few minutes.";

/**
 * Whether a failed create, restart or scale-up was refused because new GPU
 * capacity is paused (503 compute_capacity_unavailable). The response's
 * `reason` is the operator's business and is deliberately not read.
 */
export function isComputePaused(err: unknown): boolean {
  const failure = getApiErrorBody(err);
  return failure?.status === 503 && failure.body.error === "compute_capacity_unavailable";
}

export interface DeploymentEndNote {
  title: string;
  body: string;
}

/** statusReason values (or the code they start with) of a run capacity was refused for. */
const PAUSED_BEFORE_START = [
  "nosana_credits_low",
  "nosana_credits_unavailable",
  "nosana_auth_failed",
  "gpu_price_below_cost",
  "gpu_cost_unavailable",
];

/**
 * Why a stopped or failed deployment is no longer running, for the reasons an
 * owner can act on or needs to know were not their doing. Null for anything
 * else (a reason this page does not know is not echoed).
 */
export function deploymentEndNote(
  status: string,
  statusReason: string | null | undefined,
): DeploymentEndNote | null {
  if (status !== "stopped" && status !== "failed") return null;
  // A failed submit stores "<code>: <detail>"; the code is the part with a meaning.
  const code = (statusReason ?? "").split(":")[0]!.trim();
  if (code === "nosana_insufficient_funds") {
    return {
      title: "This deployment was stopped on our side",
      body: "The stop had nothing to do with your account. You were not charged for time after the stop, and your reservation was returned. You can start it again.",
    };
  }
  if (PAUSED_BEFORE_START.includes(code)) {
    return {
      title: "This deployment did not start",
      body: "New GPU deployments were temporarily unavailable when it tried to start. You were not charged for GPU time, and your reservation was returned. You can start it again.",
    };
  }
  // The three endings of a deployment that never started serving. None of
  // them was billed: billing starts only when the model can answer.
  if (code === "nosana_list_failed") {
    return {
      title: "This deployment could not be started",
      body: "The GPU network could not start it, and that had nothing to do with your account. Nothing was charged, and your reservation was returned. You can start it again; if it ends the same way, contact support.",
    };
  }
  if (code === "no_capacity") {
    return {
      title: "No GPU became available",
      body: "No GPU of this type was free in time, so the deployment was not started. Nothing was charged, and your reservation was returned. You can start it again, or choose another GPU type.",
    };
  }
  if (code === "start_timeout") {
    return {
      title: "The model did not finish starting",
      body: "A GPU was assigned, but the model was not ready in time, so the deployment was stopped. Nothing was charged, and your reservation was returned. You can start it again.",
    };
  }
  if (code === "insufficient_credits") {
    return {
      title: "Stopped: your credits ran out",
      body: "Your balance could no longer cover the GPU time, so the deployment was stopped. Add credits, then start it again.",
    };
  }
  return null;
}

/**
 * The toast after a stop. `fundsReleased` false means the GPU provider is
 * still winding the run down; that finishes in the background and costs the
 * owner nothing, so it is said without alarm. Absent (an older API) reads as
 * a plain stop.
 */
export function stopConfirmation(result: { fundsReleased?: boolean }): string {
  return result.fundsReleased === false
    ? "Deployment stopped. Its GPUs are winding down."
    : "Deployment stopped";
}

/**
 * A month of a deployment that never stops: the price per hour times the
 * replicas, 24 hours a day for 30 days. The same for every engine.
 */
export function estimatedMonthlyCost(pricePerHour: number, replicas: number): number {
  return pricePerHour * replicas * 24 * 30;
}
