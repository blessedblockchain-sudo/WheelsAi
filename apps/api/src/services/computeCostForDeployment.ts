/**
 * Adapter from `(deployment, window) => ComputeCostResult` (the
 * SettlementCycleDeps.getComputeCost shape) to the underlying
 * `calculateDeploymentComputeCostForWindow(jobIds, tier, window)` from
 * computeMetering.ts.
 *
 * Windowed on purpose (remediation D2): the settlement loop bills the
 * DELTA since the treasury's lastComputeBillAt cursor, never cumulative
 * job lifetime — the cumulative calculateDeploymentComputeCost re-billed
 * a job's whole history every tick.
 *
 * The treasury-settlement BullMQ shell wires this into the cycle deps;
 * tests of the cycle don't need to touch the Nosana SDK because the
 * shape of this provider is the seam.
 */

import { calculateDeploymentComputeCostForWindow } from "./computeMetering.js";
import type { NosanaJob } from "./nosana.js";
import type {
  BillingWindow,
  ComputeCostResult,
  DeploymentForSettlement,
} from "./treasurySettlement.js";

export interface ComputeCostProviderConfig {
  getJobStatus: (jobId: string) => Promise<NosanaJob | null>;
}

export function makeComputeCostProvider(
  config: ComputeCostProviderConfig,
): (
  deployment: DeploymentForSettlement,
  window: BillingWindow,
) => Promise<ComputeCostResult> {
  return async (deployment, window) => {
    return calculateDeploymentComputeCostForWindow(
      deployment.nosanaJobIds,
      deployment.gpuTier,
      window,
      { getJobStatus: config.getJobStatus },
    );
  };
}
