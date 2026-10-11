import { createHmac, randomUUID } from "crypto";

import { prisma } from "@wheelsai/db";

import { env } from "../config/env.js";
import { ensureSolanaCluster, getSolanaConnection } from "../lib/solana.js";
import { createLogger } from "../utils/logger.js";
import { buildSignatureFateDeps } from "./buildSignatureFateDeps.js";
import { X402_FAILED_ON_CHAIN_REASON, readX402Fate } from "./buildX402PaymentsDeps.js";
import { signatureFate } from "./signatureFate.js";
import { x402NetworkFor } from "./x402.js";
import {
  settleX402Row,
  type X402SettleOutcome,
  type X402SettlementDeps,
  type X402SettlementRow,
} from "./x402Payments.js";
import { returnX402Payment, type X402RefundDb } from "./x402Refund.js";

const logger = createLogger("x402-settlement-worker");

/** What a payment that can never land says on its row. Our own words. */
export const X402_NEVER_LANDED_REASON = "The payment never reached the chain. Nothing was taken.";

let isTickRunning = false;
// Where the next run starts in the list of open rows. A row the chain has
// nothing to say about yet is left as it is, so a full batch of those must
// not keep the rows behind it from ever being looked at.
let scanOffset = 0;
let lastMetricsPruneAt: number | null = null;
const lastCriticalAlertNotificationAt = new Map<string, number>();

export interface WorkerMetrics {
  enabled: boolean;
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  lastError: string | null;
  ticks: number;
  processed: number;
  settled: number;
  failed: number;
  /** Payments returned to their payer's credits by the worker. */
  returned: number;
  /** Rows the chain had nothing to say about yet: left for the next run. */
  retried: number;
  skipped: number;
}

export interface X402AlertThresholds {
  maxPending: number;
  maxFailed: number;
  maxRetriable: number;
  maxFailureRatePercent: number;
  maxOldestPendingMinutes: number;
}

export interface X402Alert {
  code:
    | "pending_high"
    | "failed_high"
    | "retriable_high"
    | "failure_rate_high"
    | "pending_age_high";
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
}

export interface X402OrgPaymentSummary {
  orgId: string;
  total: number;
  pending: number;
  verified: number;
  settled: number;
  failed: number;
  retriable: number;
  failureRatePercent: number;
  oldestPendingMinutes: number | null;
}

export interface X402SettlementSnapshotResult {
  orgId: string;
  summary: X402OrgPaymentSummary;
  alerts: X402Alert[];
}

const workerMetrics: WorkerMetrics = {
  enabled: false,
  running: false,
  startedAt: null,
  lastTickAt: null,
  lastTickDurationMs: null,
  lastError: null,
  ticks: 0,
  processed: 0,
  settled: 0,
  failed: 0,
  returned: 0,
  retried: 0,
  skipped: 0,
};

export function getX402AlertThresholds(): X402AlertThresholds {
  return {
    maxPending: env.X402_ALERT_MAX_PENDING,
    maxFailed: env.X402_ALERT_MAX_FAILED,
    maxRetriable: env.X402_ALERT_MAX_RETRIABLE,
    maxFailureRatePercent: env.X402_ALERT_MAX_FAILURE_RATE_PERCENT,
    maxOldestPendingMinutes: env.X402_ALERT_MAX_OLDEST_PENDING_MINUTES,
  };
}

export function evaluateX402Alerts(
  summary: X402OrgPaymentSummary,
  thresholds: X402AlertThresholds = getX402AlertThresholds()
): X402Alert[] {
  const alerts: X402Alert[] = [];

  if (summary.pending > thresholds.maxPending) {
    alerts.push({
      code: "pending_high",
      severity: summary.pending >= thresholds.maxPending * 2 ? "critical" : "warning",
      message: "Pending payments exceed configured threshold",
      value: summary.pending,
      threshold: thresholds.maxPending,
    });
  }

  if (summary.failed > thresholds.maxFailed) {
    alerts.push({
      code: "failed_high",
      severity: summary.failed >= thresholds.maxFailed * 2 ? "critical" : "warning",
      message: "Failed payments exceed configured threshold",
      value: summary.failed,
      threshold: thresholds.maxFailed,
    });
  }

  if (summary.retriable > thresholds.maxRetriable) {
    alerts.push({
      code: "retriable_high",
      severity:
        summary.retriable >= thresholds.maxRetriable * 2 ? "critical" : "warning",
      message: "Retriable payments exceed configured threshold",
      value: summary.retriable,
      threshold: thresholds.maxRetriable,
    });
  }

  if (summary.failureRatePercent > thresholds.maxFailureRatePercent) {
    alerts.push({
      code: "failure_rate_high",
      severity:
        summary.failureRatePercent >= thresholds.maxFailureRatePercent * 2
          ? "critical"
          : "warning",
      message: "Payment failure rate exceeds configured threshold",
      value: Number(summary.failureRatePercent.toFixed(2)),
      threshold: thresholds.maxFailureRatePercent,
    });
  }

  if (
    summary.oldestPendingMinutes !== null &&
    summary.oldestPendingMinutes > thresholds.maxOldestPendingMinutes
  ) {
    alerts.push({
      code: "pending_age_high",
      severity:
        summary.oldestPendingMinutes >= thresholds.maxOldestPendingMinutes * 2
          ? "critical"
          : "warning",
      message: "Oldest pending payment age exceeds configured threshold",
      value: summary.oldestPendingMinutes,
      threshold: thresholds.maxOldestPendingMinutes,
    });
  }

  return alerts;
}

const NOT_LANDED_STATUSES = ["submitted", "pending"] as const;

export async function getX402OrgPaymentSummary(
  orgId: string
): Promise<X402OrgPaymentSummary> {
  const [total, pending, verified, settled, failed, oldestPending] = await Promise.all([
    prisma.x402Payment.count({ where: { orgId } }),
    // Not yet known to have landed: "submitted" (and "pending" on old rows).
    prisma.x402Payment.count({ where: { orgId, status: { in: [...NOT_LANDED_STATUSES] } } }),
    prisma.x402Payment.count({ where: { orgId, status: "verified" } }),
    prisma.x402Payment.count({ where: { orgId, status: "settled" } }),
    prisma.x402Payment.count({ where: { orgId, status: "failed" } }),
    prisma.x402Payment.findFirst({
      where: { orgId, status: { in: [...NOT_LANDED_STATUSES] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
  ]);

  const retriable = pending + verified;
  const failureRatePercent = total > 0 ? (failed / total) * 100 : 0;
  const oldestPendingMinutes = oldestPending
    ? Math.max(0, Math.floor((Date.now() - oldestPending.createdAt.getTime()) / 60000))
    : null;

  return {
    orgId,
    total,
    pending,
    verified,
    settled,
    failed,
    retriable,
    failureRatePercent,
    oldestPendingMinutes,
  };
}

export async function persistX402SettlementSnapshot(
  orgId: string
): Promise<{ summary: X402OrgPaymentSummary; alerts: X402Alert[] }> {
  const [summary, worker] = await Promise.all([
    getX402OrgPaymentSummary(orgId),
    Promise.resolve(getX402SettlementWorkerMetrics()),
  ]);
  const alerts = evaluateX402Alerts(summary);

  await prisma.$executeRaw`
    INSERT INTO "x402_settlement_metrics" (
      "id",
      "org_id",
      "timestamp",
      "total_payments",
      "pending_payments",
      "verified_payments",
      "settled_payments",
      "failed_payments",
      "retriable_payments",
      "failure_rate_percent",
      "oldest_pending_minutes",
      "worker_ticks",
      "worker_processed",
      "worker_settled",
      "worker_failed",
      "worker_retried",
      "worker_skipped",
      "alert_count",
      "alerts",
      "created_at"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${orgId}::uuid,
      NOW(),
      ${summary.total},
      ${summary.pending},
      ${summary.verified},
      ${summary.settled},
      ${summary.failed},
      ${summary.retriable},
      ${summary.failureRatePercent},
      ${summary.oldestPendingMinutes},
      ${worker.ticks},
      ${worker.processed},
      ${worker.settled},
      ${worker.failed},
      ${worker.retried},
      ${worker.skipped},
      ${alerts.length},
      ${JSON.stringify(alerts)}::jsonb,
      NOW()
    )
  `;

  return { summary, alerts };
}

export async function persistAllX402SettlementSnapshots(): Promise<
  X402SettlementSnapshotResult[]
> {
  const organizations = await prisma.x402Payment.groupBy({
    by: ["orgId"],
  });

  if (organizations.length === 0) {
    return [];
  }

  const snapshots: X402SettlementSnapshotResult[] = [];
  for (const organization of organizations) {
    const snapshot = await persistX402SettlementSnapshot(organization.orgId);
    snapshots.push({
      orgId: organization.orgId,
      summary: snapshot.summary,
      alerts: snapshot.alerts,
    });
  }

  return snapshots;
}

export async function pruneX402SettlementMetricsHistory(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "x402_settlement_metrics"
    WHERE "timestamp" < NOW() - (${env.X402_METRICS_RETENTION_DAYS}::int * INTERVAL '1 day')
  `;
}

export async function runX402SettlementTick(): Promise<void> {
  if (isTickRunning) {
    return;
  }

  isTickRunning = true;
  const tickStart = Date.now();
  if (!workerMetrics.startedAt) {
    // First settlement tick executed by this process — honest per-replica
    // "since when has this worker been doing work" (the BullMQ shell in
    // queues/x402-settlement.queue.ts owns scheduling; the deleted
    // setInterval twin used to fake this at registration time).
    workerMetrics.startedAt = new Date().toISOString();
  }

  try {
    // Rows of THIS chain that are not finished: sent and not yet known to
    // have landed, or landed and not yet final. No count of attempts ends a
    // row; only the chain does.
    const batchSize = env.X402_SETTLEMENT_BATCH_SIZE;
    const payments: X402SettlementRow[] = await prisma.x402Payment.findMany({
      where: {
        status: { in: ["submitted", "verified"] },
        network: x402NetworkFor(env.SOLANA_NETWORK),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: scanOffset,
      take: batchSize,
      select: SETTLEMENT_ROW_SELECT,
    });

    const deps = buildX402SettlementDeps();
    let settled = 0;
    let failed = 0;
    let returned = 0;
    let retried = 0;
    let skipped = 0;

    for (const payment of payments) {
      const outcome = await settlePayment(payment, deps);
      if (outcome === "settled") settled += 1;
      if (outcome === "failed") failed += 1;
      if (outcome === "returned") returned += 1;
      if (outcome === "waiting") retried += 1;
      if (outcome === "skipped") skipped += 1;
    }
    // Rows left as they were stay in the list: the next run starts after
    // them. A short batch was the end of the list.
    scanOffset = payments.length < batchSize ? 0 : scanOffset + retried + skipped;

    const snapshots = await persistAllX402SettlementSnapshots();
    const snapshottedOrgs = snapshots.length;
    const criticalAlertNotifications = await notifyCriticalX402Alerts(snapshots);
    let prunedMetricRows = 0;
    if (shouldRunMetricsPrune()) {
      try {
        prunedMetricRows = await pruneX402SettlementMetricsHistory();
        lastMetricsPruneAt = Date.now();
      } catch (error) {
        logger.warn({ error }, "Failed pruning X402 metrics history");
      }
    }

    workerMetrics.ticks += 1;
    workerMetrics.processed += payments.length;
    workerMetrics.settled += settled;
    workerMetrics.failed += failed;
    workerMetrics.returned += returned;
    workerMetrics.retried += retried;
    workerMetrics.skipped += skipped;
    workerMetrics.lastTickAt = new Date().toISOString();
    workerMetrics.lastTickDurationMs = Date.now() - tickStart;
    workerMetrics.lastError = null;

    logger.info(
      {
        scanned: payments.length,
        settled,
        failed,
        // Payments that landed for a request that was never answered, given
        // back to the payer's credit balance.
        returned,
        // Left for the next run: the chain had nothing final to say yet.
        waiting: retried,
        skipped,
        snapshottedOrgs,
        criticalAlertNotifications,
        prunedMetricRows,
      },
      "Completed X402 settlement tick"
    );
  } catch (error: any) {
    workerMetrics.ticks += 1;
    workerMetrics.lastTickAt = new Date().toISOString();
    workerMetrics.lastTickDurationMs = Date.now() - tickStart;
    workerMetrics.lastError = error?.message ?? "Unknown settlement tick error";
    throw error;
  } finally {
    isTickRunning = false;
  }
}

export function getX402SettlementWorkerMetrics(): WorkerMetrics {
  // enabled/running are config-derived: the BullMQ shell
  // (queues/x402-settlement.queue.ts) starts iff
  // X402_SETTLEMENT_WORKER_ENABLED. There is no per-process setInterval
  // whose liveness could be reported here any more, and with
  // multi-replica BullMQ workers a process-local "running" flag was a
  // lie anyway — any replica may execute the next tick.
  const enabled = env.X402_SETTLEMENT_WORKER_ENABLED;
  return { ...workerMetrics, enabled, running: enabled };
}

const SETTLEMENT_ROW_SELECT = {
  id: true,
  status: true,
  txSignature: true,
  recentBlockhash: true,
  servedAt: true,
  refundedAt: true,
  submittedAt: true,
  verifiedAt: true,
  createdAt: true,
} as const;

/**
 * The worker's reads and writes. The fate of a signature comes from the
 * shared connection; every write is a compare-and-set whose count is
 * checked, so a request finishing the same row at the same moment loses
 * nothing and doubles nothing.
 */
export function buildX402SettlementDeps(
  checkCluster: () => Promise<{ ok: boolean }> = ensureSolanaCluster,
): X402SettlementDeps {
  // Asked once for the run these deps are built for, and only if a row
  // needs the chain read.
  let cluster: Promise<boolean> | null = null;
  return {
    submitTransactions: env.X402_SUBMIT_TRANSACTIONS,
    confirmWaitMs: env.X402_CONFIRM_WAIT_MS,
    now: () => new Date(),

    clusterOk: () => {
      if (!cluster) {
        cluster = (async () => {
          try {
            const ok = (await checkCluster()).ok;
            if (!ok) {
              logger.error(
                "X402 settlement: the node does not serve the configured chain; no payment is decided from it",
              );
            }
            return ok;
          } catch {
            return false;
          }
        })();
      }
      return cluster;
    },

    readFate: (input) =>
      readX402Fate(input, (fateInput) =>
        signatureFate(fateInput, buildSignatureFateDeps({ connection: getSolanaConnection() })),
      ),

    markSettled: async (paymentId, at) => {
      const result = await prisma.x402Payment.updateMany({
        where: {
          id: paymentId,
          status: "verified",
          servedAt: { not: null },
          refundedAt: null,
        },
        data: {
          status: "settled",
          settledAt: at,
          failureReason: null,
        },
      });
      return result.count === 1;
    },

    markFailed: async (paymentId, why) => {
      const result = await prisma.x402Payment.updateMany({
        where: { id: paymentId, status: "submitted" },
        data: {
          status: "failed",
          failureReason:
            why === "failed_on_chain" ? X402_FAILED_ON_CHAIN_REASON : X402_NEVER_LANDED_REASON,
        },
      });
      return result.count === 1;
    },

    refund: (input) => returnX402Payment(prisma as unknown as X402RefundDb, input),
  };
}

/**
 * One row. A row that throws (the database, mid-write) is left for the
 * next run and does not stop the rows after it.
 */
async function settlePayment(
  payment: X402SettlementRow,
  deps: X402SettlementDeps,
): Promise<X402SettleOutcome> {
  try {
    const outcome = await settleX402Row(payment, deps);
    if (outcome === "returned") {
      logger.info(
        { paymentId: payment.id, txSignature: payment.txSignature, was: payment.status },
        "X402 payment returned: it landed for a request that was never answered, and went back to the payer's credit balance",
      );
    }
    return outcome;
  } catch (error) {
    logger.error({ error, paymentId: payment.id }, "Failed settling an X402 payment; left for the next run");
    return "waiting";
  }
}

function shouldRunMetricsPrune(): boolean {
  const pruneIntervalMs = env.X402_METRICS_PRUNE_INTERVAL_MINUTES * 60 * 1000;
  return (
    lastMetricsPruneAt === null || Date.now() - lastMetricsPruneAt >= pruneIntervalMs
  );
}

async function notifyCriticalX402Alerts(
  snapshots: X402SettlementSnapshotResult[]
): Promise<number> {
  if (!env.X402_ALERT_WEBHOOK_URL || snapshots.length === 0) {
    return 0;
  }

  let notificationsSent = 0;
  for (const snapshot of snapshots) {
    const criticalAlerts = snapshot.alerts.filter((alert) => alert.severity === "critical");
    if (criticalAlerts.length === 0) {
      continue;
    }

    const alertsToNotify = criticalAlerts.filter((alert) =>
      shouldNotifyCriticalAlert(snapshot.orgId, alert.code)
    );
    if (alertsToNotify.length === 0) {
      continue;
    }

    try {
      const timestamp = new Date().toISOString();
      const body = JSON.stringify({
        source: "x402-settlement-worker",
        orgId: snapshot.orgId,
        timestamp,
        summary: snapshot.summary,
        alerts: alertsToNotify,
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-wheelsai-alert-timestamp": timestamp,
      };
      if (env.X402_ALERT_WEBHOOK_SECRET) {
        headers["x-wheelsai-alert-signature"] = signX402AlertWebhook(
          timestamp,
          body
        );
        headers["x-wheelsai-alert-signature-alg"] = "hmac-sha256";
      }

      const response = await fetch(env.X402_ALERT_WEBHOOK_URL, {
        method: "POST",
        headers,
        body,
      });

      if (!response.ok) {
        logger.warn(
          {
            status: response.status,
            statusText: response.statusText,
            orgId: snapshot.orgId,
            alertCodes: alertsToNotify.map((alert) => alert.code),
          },
          "Failed posting X402 critical alert webhook"
        );
        continue;
      }

      markCriticalAlertsNotified(snapshot.orgId, alertsToNotify);
      notificationsSent += 1;
    } catch (error) {
      logger.warn(
        {
          error,
          orgId: snapshot.orgId,
          alertCodes: alertsToNotify.map((alert) => alert.code),
        },
        "Failed dispatching X402 critical alert webhook"
      );
    }
  }

  return notificationsSent;
}

function shouldNotifyCriticalAlert(orgId: string, alertCode: X402Alert["code"]): boolean {
  const key = `${orgId}:${alertCode}`;
  const lastSentAt = lastCriticalAlertNotificationAt.get(key);
  if (!lastSentAt) {
    return true;
  }

  const cooldownMs = env.X402_ALERT_NOTIFY_COOLDOWN_MINUTES * 60 * 1000;
  return Date.now() - lastSentAt >= cooldownMs;
}

function markCriticalAlertsNotified(orgId: string, alerts: X402Alert[]): void {
  const notifiedAt = Date.now();
  for (const alert of alerts) {
    lastCriticalAlertNotificationAt.set(`${orgId}:${alert.code}`, notifiedAt);
  }
}

function signX402AlertWebhook(timestamp: string, body: string): string {
  const secret = env.X402_ALERT_WEBHOOK_SECRET;
  if (!secret) {
    return "";
  }

  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `v1=${digest}`;
}
