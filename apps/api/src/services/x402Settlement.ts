import { createHmac, randomUUID } from "crypto";

import { Connection, type SignatureStatus } from "@solana/web3.js";
import { prisma, type X402Payment } from "@wheelsai/db";

import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("x402-settlement-worker");

let connectionInstance: Connection | null = null;
let settlementInterval: NodeJS.Timeout | null = null;
let isTickRunning = false;
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
  retried: 0,
  skipped: 0,
};

type SettlementOutcome = "settled" | "failed" | "retried" | "skipped";

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

export async function getX402OrgPaymentSummary(
  orgId: string
): Promise<X402OrgPaymentSummary> {
  const [total, pending, verified, settled, failed, oldestPending] = await Promise.all([
    prisma.x402Payment.count({ where: { orgId } }),
    prisma.x402Payment.count({ where: { orgId, status: "pending" } }),
    prisma.x402Payment.count({ where: { orgId, status: "verified" } }),
    prisma.x402Payment.count({ where: { orgId, status: "settled" } }),
    prisma.x402Payment.count({ where: { orgId, status: "failed" } }),
    prisma.x402Payment.findFirst({
      where: { orgId, status: "pending" },
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

export function startX402SettlementWorker(): () => void {
  workerMetrics.enabled = env.X402_SETTLEMENT_WORKER_ENABLED;

  if (!env.X402_SETTLEMENT_WORKER_ENABLED) {
    logger.info("X402 settlement worker disabled");
    return () => {};
  }

  if (settlementInterval) {
    return stopX402SettlementWorker;
  }

  logger.info(
    {
      intervalMs: env.X402_SETTLEMENT_INTERVAL_MS,
      batchSize: env.X402_SETTLEMENT_BATCH_SIZE,
      maxRetries: env.X402_SETTLEMENT_MAX_RETRIES,
      submitTransactions: env.X402_SUBMIT_TRANSACTIONS,
      metricsRetentionDays: env.X402_METRICS_RETENTION_DAYS,
      metricsPruneIntervalMinutes: env.X402_METRICS_PRUNE_INTERVAL_MINUTES,
    },
    "Starting X402 settlement worker"
  );

  const runTick = () => {
    void runX402SettlementTick().catch((error) => {
      logger.error({ error }, "X402 settlement tick failed");
    });
  };

  settlementInterval = setInterval(runTick, env.X402_SETTLEMENT_INTERVAL_MS);
  workerMetrics.running = true;
  workerMetrics.startedAt = new Date().toISOString();
  void runTick();

  return stopX402SettlementWorker;
}

export function stopX402SettlementWorker(): void {
  if (!settlementInterval) {
    return;
  }

  clearInterval(settlementInterval);
  settlementInterval = null;
  workerMetrics.running = false;
  logger.info("Stopped X402 settlement worker");
}

export async function runX402SettlementTick(): Promise<void> {
  if (isTickRunning) {
    return;
  }

  isTickRunning = true;
  const tickStart = Date.now();

  try {
    const payments = await prisma.x402Payment.findMany({
      where: {
        status: { in: ["verified", "pending"] },
        retryCount: { lt: env.X402_SETTLEMENT_MAX_RETRIES },
      },
      orderBy: { createdAt: "asc" },
      take: env.X402_SETTLEMENT_BATCH_SIZE,
    });

    let settled = 0;
    let failed = 0;
    let retried = 0;
    let skipped = 0;

    for (const payment of payments) {
      const outcome = await settlePayment(payment);
      if (outcome === "settled") settled += 1;
      if (outcome === "failed") failed += 1;
      if (outcome === "retried") retried += 1;
      if (outcome === "skipped") skipped += 1;
    }

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
        retried,
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
  return { ...workerMetrics };
}

async function settlePayment(payment: X402Payment): Promise<SettlementOutcome> {
  if (payment.status === "pending") {
    return retryOrFail(
      payment,
      "Payment is pending verification and cannot be settled yet"
    );
  }

  if (payment.status !== "verified") {
    return "skipped";
  }

  if (!payment.txSignature) {
    return retryOrFail(payment, "Verified payment is missing transaction signature");
  }

  if (!env.X402_SUBMIT_TRANSACTIONS) {
    return markSettled(payment.id);
  }

  const status = await fetchSignatureStatus(payment.txSignature);
  if (!status) {
    return retryOrFail(payment, "Transaction not visible on chain yet");
  }

  if (status.err) {
    return markFailed(payment, `On-chain transaction error: ${JSON.stringify(status.err)}`);
  }

  if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
    return markSettled(payment.id);
  }

  return retryOrFail(
    payment,
    `Transaction confirmation status is ${status.confirmationStatus ?? "unknown"}`
  );
}

async function fetchSignatureStatus(
  txSignature: string
): Promise<SignatureStatus | null> {
  try {
    const connection = getConnection();
    const statuses = await connection.getSignatureStatuses([txSignature], {
      searchTransactionHistory: true,
    });
    return statuses.value[0] ?? null;
  } catch (error) {
    logger.error({ error, txSignature }, "Failed to fetch transaction status");
    return null;
  }
}

async function markSettled(paymentId: string): Promise<SettlementOutcome> {
  const result = await prisma.x402Payment.updateMany({
    where: {
      id: paymentId,
      status: "verified",
    },
    data: {
      status: "settled",
      settledAt: new Date(),
      failureReason: null,
    },
  });

  return result.count > 0 ? "settled" : "skipped";
}

async function retryOrFail(
  payment: X402Payment,
  reason: string
): Promise<SettlementOutcome> {
  const nextRetryCount = payment.retryCount + 1;
  const shouldFail = nextRetryCount >= env.X402_SETTLEMENT_MAX_RETRIES;

  const result = await prisma.x402Payment.updateMany({
    where: {
      id: payment.id,
      status: payment.status,
      retryCount: payment.retryCount,
    },
    data: shouldFail
      ? {
          status: "failed",
          retryCount: { increment: 1 },
          failureReason: reason,
        }
      : {
          retryCount: { increment: 1 },
          failureReason: reason,
        },
  });

  if (result.count === 0) {
    return "skipped";
  }

  return shouldFail ? "failed" : "retried";
}

async function markFailed(
  payment: X402Payment,
  reason: string
): Promise<SettlementOutcome> {
  const result = await prisma.x402Payment.updateMany({
    where: {
      id: payment.id,
      status: payment.status,
      retryCount: payment.retryCount,
    },
    data: {
      status: "failed",
      retryCount: { increment: 1 },
      failureReason: reason,
    },
  });

  return result.count > 0 ? "failed" : "skipped";
}

function getConnection(): Connection {
  if (!connectionInstance) {
    const endpoint =
      env.SOLANA_NETWORK === "mainnet-beta"
        ? env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
        : "https://api.devnet.solana.com";

    connectionInstance = new Connection(endpoint, "confirmed");
  }
  return connectionInstance;
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
