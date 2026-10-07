/**
 * Composition root of the training poller tick (services/runTrainingPollerTick.ts).
 */

import { createLogger } from "../utils/logger.js";
import { reconcileTrainingJob, type TrainingDeps } from "./trainingJobs.js";
import type { TrainingPollerTickDeps } from "./runTrainingPollerTick.js";
import { ACTIVE_TRAINING_STATES } from "./trainingStateMachine.js";

const logger = createLogger("training-poller");

export interface TrainingPollerPrisma {
  trainingJob: {
    findMany(args: {
      where: { status: { in: string[] } };
      select: { id: true };
      orderBy: [{ lastReconciledAt: { sort: "asc"; nulls: "first" } }, { createdAt: "asc" }];
      take: number;
    }): Promise<Array<{ id: string }>>;
    updateMany(args: {
      where: { id: { in: string[] } };
      data: { lastReconciledAt: Date };
    }): Promise<{ count: number }>;
  };
}

export function buildTrainingPollerTickDeps(args: {
  prisma: TrainingPollerPrisma;
  training: TrainingDeps;
  now?: () => Date;
}): TrainingPollerTickDeps {
  const now = args.now ?? (() => new Date());
  return {
    listActiveJobIds: async (limit) => {
      // Least recently examined first, never examined before all. Ordering by
      // updatedAt starved jobs: a reconcile that only waits writes nothing,
      // so the same rows stayed oldest tick after tick.
      const rows = await args.prisma.trainingJob.findMany({
        where: { status: { in: [...ACTIVE_TRAINING_STATES] } },
        select: { id: true },
        orderBy: [{ lastReconciledAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
        take: limit,
      });
      const ids = rows.map((row) => row.id);
      if (ids.length > 0) {
        // Stamped as they are taken, before any is reconciled: a job whose
        // reconcile throws also goes to the back, and cannot hold its place.
        await args.prisma.trainingJob.updateMany({
          where: { id: { in: ids } },
          data: { lastReconciledAt: now() },
        });
      }
      return ids;
    },
    reconcile: (jobId) => reconcileTrainingJob(args.training, jobId),
    onError: (jobId, error) =>
      logger.error({ err: error, jobId }, "Reconciling a training job failed"),
  };
}
