/**
 * Adapter from `(deployment) => ComputeCostResult` (the
 * SettlementCycleDeps.getComputeCost shape) to the underlying
 * `calculateDeploymentComputeCost(jobIds, tier)` from computeMetering.ts.
 *
 * The treasury-settlement BullMQ shell wires this into the cycle deps;
 * tests of the cycle don't need to touch the Nosana SDK because the
 * shape of this provider is the seam.
 */

import { calculateDeploymentComputeCost } from "./computeMetering.js";
import type { NosanaJob } from "./nosana.js";
import type {
  ComputeCostResult,
  DeploymentForSettlement,
} from "./treasurySettlement.js";

export interface ComputeCostProviderConfig {
  getJobStatus: (jobId: string) => Promise<NosanaJob | null>;
}

export function makeComputeCostProvider(
  config: ComputeCostProviderConfig,
): (deployment: DeploymentForSettlement) => Promise<ComputeCostResult> {
  return async (deployment) => {
    return calculateDeploymentComputeCost(
      deployment.nosanaJobIds,
      deployment.gpuTier,
      { getJobStatus: config.getJobStatus },
    );
  };
}
