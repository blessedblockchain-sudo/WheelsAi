/**
 * Durable record of Nosana deployments that no deployment row tracks.
 *
 * A model Deployment row keeps ONE Nosana id (nosanaJobIds[0]) and the vault
 * sweep reads it from there. That slot cannot hold a deployment whose writer
 * lost its compare-and-set to a later run of the same row, whose row is being
 * deleted, or whose table has no vault stamp at all (agent deployments,
 * training jobs). Dropping such an id strands the platform's vault funds - and
 * if the stop never landed, leaves a GPU running that nobody bills.
 *
 * recordNosanaOrphan writes the id to nosana_orphan_deployments instead; the
 * deployment-status worker's vault sweep stops it if it is still running and
 * retries the withdraw until the funds are verified recovered
 * (buildDeploymentStatusTickDeps).
 */

import { createLogger } from "../utils/logger.js";
import { isMockNosanaId } from "./nosanaIds.js";

const logger = createLogger("nosana-orphans");

export type NosanaOrphanSource = "model" | "agent" | "training";

export interface NosanaOrphanPrisma {
  nosanaOrphanDeployment: {
    createMany(args: {
      data: Array<{
        nosanaDeploymentId: string;
        sourceKind: string;
        sourceId: string | null;
        reason: string;
      }>;
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
}

export interface RecordNosanaOrphanArgs {
  nosanaDeploymentId: string;
  sourceKind: NosanaOrphanSource;
  /** The row the deployment was created for, when one is known. */
  sourceId?: string;
  /** Why no row tracks it (shown to an operator). */
  reason: string;
}

/**
 * Records an untracked Nosana deployment for the vault sweep. Idempotent on the
 * Nosana id (skipDuplicates, so there is no unique-violation to handle).
 *
 * Never throws. `false` means the id could NOT be recorded: it is logged at
 * error level with everything an operator needs to stop and reclaim it by
 * hand, and callers that can still refuse the request should do so.
 */
export async function recordNosanaOrphan(
  db: NosanaOrphanPrisma,
  args: RecordNosanaOrphanArgs,
): Promise<boolean> {
  // Mock ids never existed on Nosana: nothing to stop, no vault.
  if (isMockNosanaId(args.nosanaDeploymentId)) return true;
  try {
    await db.nosanaOrphanDeployment.createMany({
      data: [
        {
          nosanaDeploymentId: args.nosanaDeploymentId,
          sourceKind: args.sourceKind,
          sourceId: args.sourceId ?? null,
          reason: args.reason.slice(0, 300),
        },
      ],
      skipDuplicates: true,
    });
    logger.warn(args, "Recorded an untracked Nosana deployment for the vault sweep");
    return true;
  } catch (err) {
    logger.error(
      { err, ...args },
      "COULD NOT RECORD an untracked Nosana deployment - stop it and reclaim its vault by hand",
    );
    return false;
  }
}
