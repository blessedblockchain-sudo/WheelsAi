import { Queue, Worker } from "bullmq";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { readSignatureFate } from "../services/buildSignatureFateDeps.js";
import { buildTopupReconcileTickDeps } from "../services/buildTopupReconcileTickDeps.js";
import {
  TOPUP_RECONCILE_BATCH_SIZE,
  runTopupReconcileTick,
  topupReconcileEnabled,
} from "../services/runTopupReconcileTick.js";
import { describeSignatureFate } from "../services/signatureFate.js";
import { createLogger } from "../utils/logger.js";
import { getQueueConnectionOpts } from "./connection.js";

const QUEUE_NAME = "topup-reconcile";
const REPEATABLE_JOB_KEY = "topup-reconcile-tick";

const logger = createLogger("topup-reconcile-queue");

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Starts the top-up reconcile BullMQ queue and worker (payments pass,
 * batch 2). It ends wallet top-ups from the chain: credits a transfer
 * that landed after the request (or the tab) was gone, fails one that
 * failed on the chain, expires one that can no longer land, and sends
 * the signed bytes again for one whose first send may not have arrived.
 *
 * Only starts when WALLET_TOPUPS_ENABLED and
 * TOPUP_RECONCILE_INTERVAL_MS > 0 (env.ts refuses to start with top-ups
 * on and this worker off outside development). A run is skipped while
 * the node is not on the cluster SOLANA_NETWORK names.
 */
export async function startTopupReconcileQueue(): Promise<void> {
  const enabled = topupReconcileEnabled({
    walletTopupsEnabled: env.WALLET_TOPUPS_ENABLED,
    intervalMs: env.TOPUP_RECONCILE_INTERVAL_MS,
  });
  if (!enabled) {
    logger.info(
      "Top-up reconcile worker disabled (WALLET_TOPUPS_ENABLED off or interval <= 0)",
    );
    return;
  }

  const { connection } = getQueueConnectionOpts();
  queue = new Queue(QUEUE_NAME, { connection });

  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.key === REPEATABLE_JOB_KEY || job.name === REPEATABLE_JOB_KEY) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    REPEATABLE_JOB_KEY,
    {},
    {
      repeat: { every: env.TOPUP_RECONCILE_INTERVAL_MS },
      jobId: REPEATABLE_JOB_KEY,
    },
  );

  worker = new Worker(
    QUEUE_NAME,
    async () => {
      const deps = buildTopupReconcileTickDeps({
        prisma,
        network: env.SOLANA_NETWORK === "mainnet-beta" ? "solana:mainnet" : "solana:devnet",
        checkCluster: ensureSolanaCluster,
        readFate: readSignatureFate,
        // The same send settings as the submit route: these are the same
        // bytes, so the node should judge them the same way.
        sendRawTransaction: (raw) =>
          getSolanaConnection().sendRawTransaction(raw, {
            skipPreflight: false,
            maxRetries: 3,
          }),
        log: (event) => {
          // Rows that are only waiting, or that another request ended
          // first, are normal and would fill the log every interval.
          if (event.action === "waiting" && !event.detail) return;
          if (event.action === "lost_race") return;
          const line = {
            topupId: event.topupId,
            action: event.action,
            detail: event.detail,
            ...(event.fate ? describeSignatureFate(event.fate) : {}),
          };
          if (event.action === "error") {
            logger.error(line, "Top-up reconcile: row threw, left as it was");
          } else if (event.action === "waiting") {
            logger.warn(line, "Top-up reconcile: row still waiting");
          } else {
            logger.info(line, "Top-up reconcile: row changed");
          }
        },
      });
      const result = await runTopupReconcileTick(
        { enabled, limit: TOPUP_RECONCILE_BATCH_SIZE },
        deps,
      );
      if (result.skipped === "chain_unavailable") {
        logger.warn(
          "Top-up reconcile run skipped: the Solana cluster check is not ok",
        );
      } else if (result.loaded > 0) {
        logger.info(result, "Top-up reconcile tick complete");
      }
    },
    { connection, concurrency: 1 },
  );

  worker.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Top-up reconcile job failed");
  });

  logger.info(
    { intervalMs: env.TOPUP_RECONCILE_INTERVAL_MS },
    "Top-up reconcile queue started",
  );
}

export async function stopTopupReconcileQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
