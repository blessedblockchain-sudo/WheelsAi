/**
 * The deployments this process's status worker failed because Nosana could
 * not place them (services/runDeploymentStatusTick.ts), with Nosana's own
 * message, for the operator view (GET /api/platform/compute).
 *
 * In memory, newest first, bounded: the durable record is the row itself
 * (status `failed`, its reason code) and the worker's error log. What only
 * lives here is Nosana's message, which is never stored where a customer
 * reads it. A process that did not run the tick has none, and the view then
 * shows the row with no detail.
 */

import type { PlacementFailure } from "./runDeploymentStatusTick.js";

/** How many failures are kept. */
export const MAX_PLACEMENT_FAILURES = 100;

const recent: PlacementFailure[] = [];

export function recordPlacementFailure(failure: PlacementFailure): void {
  recent.unshift(failure);
  if (recent.length > MAX_PLACEMENT_FAILURES) recent.length = MAX_PLACEMENT_FAILURES;
}

/** Newest first. A copy. */
export function recentPlacementFailures(): PlacementFailure[] {
  return recent.slice();
}

/** Test seam. */
export function resetPlacementFailuresForTests(): void {
  recent.length = 0;
}
