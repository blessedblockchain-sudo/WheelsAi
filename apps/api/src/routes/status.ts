/**
 * Public platform status (claims ledger P6) — backs the /status page.
 *
 *   GET /api/status   (mounted with prefix "/api/status")
 *
 * Unauthenticated and read-only. It reports only what it measured on this
 * request (or within the short cache window below):
 *
 *   components  Postgres (SELECT 1) and Redis (PING), each with the latency
 *               of that probe. A failed or hung probe is "outage", never
 *               a guess.
 *   workers     For each BullMQ worker this deployment is configured to run:
 *               when a job last completed and last failed, read from the
 *               queue's own completed/failed sets (scored by finish time).
 *               A worker with no recorded runs is "no_data", not "ok".
 *   monitors    Uptime monitors owned by the operator's status organisation
 *               (STATUS_PAGE_ORG_ID). Customer monitors are private and are
 *               never read here. With no status org configured the answer is
 *               `configured: false` — the page says "no public monitors
 *               yet" instead of inventing an uptime figure. Percentages are
 *               the prober's own stored figures (recordUptimeEvent) and the
 *               per-day history is counted from UptimeEvent rows; days with
 *               no checks come back as null, not 100.
 *
 * Always answers 200 with a body, even mid-outage: a status page that 503s
 * when the database is down cannot say that the database is down.
 *
 * IO is injected (same pattern as routes/health.ts) so every path is unit
 * tested without a network, database or Redis; buildStatusDeps() is the
 * production wiring.
 */

import type { FastifyPluginAsync } from "fastify";
import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

// ============================================
// Types
// ============================================

export type ComponentStatus = "operational" | "outage";
export type WorkerStatus = "operational" | "delayed" | "failing" | "no_data";
export type MonitorStatus = "operational" | "degraded" | "outage" | "no_data";
export type OverallStatus = "operational" | "degraded" | "major_outage";

export interface WorkerDescriptor {
  /** BullMQ queue name, e.g. "deployment-status". */
  queue: string;
  /** User-facing name. */
  name: string;
  description: string;
  /** Repeat interval the worker is scheduled at (> 0). */
  intervalMs: number;
}

export interface WorkerRunInfo {
  lastCompletedAt: Date | null;
  lastFailedAt: Date | null;
}

export interface PublicMonitorRow {
  id: string;
  name: string;
  currentStatus: string;
  lastCheckAt: Date | null;
  uptimePercent24h: number | null;
  uptimePercent7d: number | null;
  uptimePercent30d: number | null;
  avgLatencyMs: number | null;
}

export interface MonitorDayRow {
  monitorId: string;
  /** UTC calendar day, "YYYY-MM-DD". */
  day: string;
  checks: number;
  up: number;
}

export interface StatusDeps {
  /** Resolves if Postgres answers; throws otherwise. */
  checkDatabase: () => Promise<void>;
  /** Resolves if Redis answers; throws otherwise. */
  checkRedis: () => Promise<void>;
  /** Workers this deployment is configured to run (enabled ones only). */
  workers: WorkerDescriptor[];
  /** Last completion/failure per queue name. Throws if Redis is unreadable. */
  readWorkerRuns: (queues: string[]) => Promise<Record<string, WorkerRunInfo>>;
  /**
   * The operator's public monitors, or null when no status organisation is
   * configured (then nothing is read and the response says so).
   */
  loadPublicMonitors: (() => Promise<PublicMonitorRow[]>) | null;
  /** Per-monitor, per-UTC-day check counts since `since`. */
  loadMonitorDays: (monitorIds: string[], since: Date) => Promise<MonitorDayRow[]>;
  /** Releases connections on server close. */
  close?: () => Promise<void> | void;
  now?: () => Date;
  /** Per-probe ceiling. */
  timeoutMs?: number;
  /** How long one computed answer is reused. 0 disables the cache. */
  cacheTtlMs?: number;
  /** Days of per-monitor history returned. */
  historyDays?: number;
}

export interface StatusResponse {
  status: OverallStatus;
  generatedAt: string;
  components: Array<{
    id: "database" | "redis";
    name: string;
    status: ComponentStatus;
    latencyMs: number | null;
  }>;
  workers: {
    /** false when Redis could not be read, so run history is unknown. */
    available: boolean;
    items: Array<{
      id: string;
      name: string;
      description: string;
      intervalSeconds: number;
      status: WorkerStatus;
      lastCompletedAt: string | null;
      lastFailedAt: string | null;
    }>;
  };
  monitors: {
    /** false = no public status organisation configured. */
    configured: boolean;
    /** false = configured, but the monitor data could not be read. */
    available: boolean;
    historyDays: number;
    items: Array<{
      name: string;
      status: MonitorStatus;
      lastCheckAt: string | null;
      uptimePercent: { "24h": number | null; "7d": number | null; "30d": number | null };
      avgLatencyMs: number | null;
      days: Array<{ date: string; checks: number; uptimePercent: number | null }>;
    }>;
  };
}

// ============================================
// Pure helpers (exported for tests)
// ============================================

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_HISTORY_DAYS = 30;
const MAX_PUBLIC_MONITORS = 20;

/** Two decimals, or null. Never turns "no data" into a number. */
function round2(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * How long past its interval a worker may go without completing before it
 * is reported "delayed": three intervals, and never less than one interval
 * plus a minute (short intervals jitter under load).
 */
export function workerGraceMs(intervalMs: number): number {
  return Math.max(intervalMs * 3, intervalMs + 60_000);
}

export function classifyWorker(
  run: WorkerRunInfo | undefined,
  intervalMs: number,
  now: Date,
): WorkerStatus {
  const completed = run?.lastCompletedAt ?? null;
  const failed = run?.lastFailedAt ?? null;
  if (!completed && !failed) return "no_data";
  if (failed && (!completed || failed.getTime() > completed.getTime())) return "failing";
  if (completed && now.getTime() - completed.getTime() > workerGraceMs(intervalMs)) {
    return "delayed";
  }
  return "operational";
}

/** Maps UptimeMonitor.currentStatus (the prober's vocabulary) to the page's. */
export function classifyMonitor(currentStatus: string, lastCheckAt: Date | null): MonitorStatus {
  if (!lastCheckAt) return "no_data";
  switch (currentStatus) {
    case "up":
      return "operational";
    case "degraded":
      return "degraded";
    case "down":
    case "timeout":
    case "error":
      return "outage";
    default:
      return "no_data";
  }
}

/** The last `days` UTC calendar days, oldest first, ending with today. */
export function utcDayRange(now: Date, days: number): string[] {
  const out: string[] = [];
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(todayUtc - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

export function overallStatus(
  components: StatusResponse["components"],
  workers: StatusResponse["workers"]["items"],
  monitors: StatusResponse["monitors"]["items"],
): OverallStatus {
  if (components.some((c) => c.id === "database" && c.status === "outage")) {
    return "major_outage";
  }
  const degraded =
    components.some((c) => c.status === "outage") ||
    workers.some((w) => w.status === "delayed" || w.status === "failing") ||
    monitors.some((m) => m.status === "outage" || m.status === "degraded");
  return degraded ? "degraded" : "operational";
}

async function timed(
  run: () => Promise<unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; latencyMs: number | null }> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  } catch {
    // A failed probe has no meaningful latency to report.
    return { ok: false, latencyMs: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ============================================
// Status computation
// ============================================

export async function computeStatus(deps: StatusDeps): Promise<StatusResponse> {
  const now = (deps.now ?? (() => new Date()))();
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const historyDays = deps.historyDays ?? DEFAULT_HISTORY_DAYS;

  // Concurrently, so a slow database cannot eat Redis's budget.
  const [database, redis] = await Promise.all([
    timed(deps.checkDatabase, timeoutMs),
    timed(deps.checkRedis, timeoutMs),
  ]);

  const components: StatusResponse["components"] = [
    {
      id: "database",
      name: "Database",
      status: database.ok ? "operational" : "outage",
      latencyMs: database.latencyMs,
    },
    {
      id: "redis",
      name: "Queues and cache",
      status: redis.ok ? "operational" : "outage",
      latencyMs: redis.latencyMs,
    },
  ];

  // ---- Workers -------------------------------------------------------
  let runs: Record<string, WorkerRunInfo> | null = null;
  if (redis.ok && deps.workers.length > 0) {
    try {
      runs = await withTimeout(
        () => deps.readWorkerRuns(deps.workers.map((w) => w.queue)),
        timeoutMs,
      );
    } catch {
      runs = null;
    }
  }
  const workersAvailable = runs !== null || deps.workers.length === 0;
  const workerItems: StatusResponse["workers"]["items"] = workersAvailable
    ? deps.workers.map((w) => {
        const run = runs?.[w.queue];
        return {
          id: w.queue,
          name: w.name,
          description: w.description,
          intervalSeconds: Math.round(w.intervalMs / 1000),
          status: classifyWorker(run, w.intervalMs, now),
          lastCompletedAt: run?.lastCompletedAt?.toISOString() ?? null,
          lastFailedAt: run?.lastFailedAt?.toISOString() ?? null,
        };
      })
    : [];

  // ---- Public monitors -----------------------------------------------
  const monitors: StatusResponse["monitors"] = {
    configured: deps.loadPublicMonitors !== null,
    available: true,
    historyDays,
    items: [],
  };
  if (deps.loadPublicMonitors) {
    if (!database.ok) {
      monitors.available = false;
    } else {
      try {
        const rows = (
          await withTimeout(deps.loadPublicMonitors, timeoutMs)
        ).slice(0, MAX_PUBLIC_MONITORS);
        const dayKeys = utcDayRange(now, historyDays);
        const since = new Date(`${dayKeys[0]}T00:00:00.000Z`);
        const dayRows =
          rows.length > 0
            ? await withTimeout(
                () => deps.loadMonitorDays(rows.map((r) => r.id), since),
                timeoutMs,
              )
            : [];
        const byMonitorDay = new Map<string, MonitorDayRow>();
        for (const d of dayRows) byMonitorDay.set(`${d.monitorId}|${d.day}`, d);

        monitors.items = rows.map((m) => ({
          name: m.name,
          status: classifyMonitor(m.currentStatus, m.lastCheckAt),
          lastCheckAt: m.lastCheckAt?.toISOString() ?? null,
          uptimePercent: {
            "24h": round2(m.uptimePercent24h),
            "7d": round2(m.uptimePercent7d),
            "30d": round2(m.uptimePercent30d),
          },
          avgLatencyMs:
            m.avgLatencyMs === null || !Number.isFinite(m.avgLatencyMs)
              ? null
              : Math.round(m.avgLatencyMs),
          days: dayKeys.map((date) => {
            const row = byMonitorDay.get(`${m.id}|${date}`);
            const checks = row?.checks ?? 0;
            return {
              date,
              checks,
              uptimePercent: checks > 0 ? round2(((row?.up ?? 0) / checks) * 100) : null,
            };
          }),
        }));
      } catch {
        monitors.available = false;
        monitors.items = [];
      }
    }
  }

  return {
    status: overallStatus(components, workerItems, monitors.items),
    generatedAt: now.toISOString(),
    components,
    workers: { available: workersAvailable, items: workerItems },
    monitors,
  };
}

// ============================================
// Route
// ============================================

export function createStatusRoutes(deps: StatusDeps): FastifyPluginAsync {
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const clock = deps.now ?? (() => new Date());

  let cached: { at: number; body: StatusResponse } | null = null;
  // Concurrent requests during a recompute share one computation, so a burst
  // of page loads costs one database round, not one per visitor.
  let inflight: Promise<StatusResponse> | null = null;

  const getStatus = async (): Promise<StatusResponse> => {
    const nowMs = clock().getTime();
    if (cacheTtlMs > 0 && cached && nowMs - cached.at < cacheTtlMs) {
      return cached.body;
    }
    if (!inflight) {
      inflight = computeStatus(deps)
        .then((body) => {
          cached = { at: clock().getTime(), body };
          return body;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };

  return async (app) => {
    if (deps.close) {
      const close = deps.close;
      app.addHook("onClose", async () => {
        await close();
      });
    }

    app.get(
      "/",
      {
        schema: {
          tags: ["Status"],
          description:
            "Public platform status: database and Redis probes, worker last-run times, and the operator's public uptime monitors.",
        },
      },
      async (_request, reply) => {
        const body = await getStatus();
        reply.header("Cache-Control", `public, max-age=${Math.max(0, Math.floor(cacheTtlMs / 1000))}`);
        return body;
      },
    );
  };
}

// ============================================
// Production wiring
// ============================================

/**
 * The workers this process starts, mirroring the enable conditions in
 * queues/*.queue.ts (interval > 0 plus each queue's feature flag). Workers
 * that are switched off are not listed: "disabled" is configuration, not a
 * status. A worker whose interval is set but which is refused at start for
 * a missing key/config shows up as "no_data" or "delayed", which is the
 * truth about it.
 */
export function configuredWorkers(e: typeof env = env): WorkerDescriptor[] {
  const all: Array<WorkerDescriptor & { enabled: boolean }> = [
    {
      queue: "deployment-status",
      name: "Deployment health sync",
      description: "Reconciles GPU deployment status and node health with Nosana.",
      intervalMs: e.DEPLOYMENT_STATUS_INTERVAL_MS,
      enabled: e.DEPLOYMENT_STATUS_INTERVAL_MS > 0,
    },
    {
      queue: "scheduler",
      name: "Scheduled tasks",
      description: "Runs agent tasks and workflows on their schedules.",
      intervalMs: e.SCHEDULER_INTERVAL_MS,
      enabled: e.SCHEDULER_INTERVAL_MS > 0,
    },
    {
      queue: "uptime-prober",
      name: "Uptime checks",
      description: "Probes monitored endpoints and records their availability.",
      intervalMs: e.UPTIME_PROBER_INTERVAL_MS,
      enabled: e.UPTIME_PROBER_INTERVAL_MS > 0,
    },
    {
      queue: "alert-evaluator",
      name: "Alerts",
      description: "Evaluates alert rules and notifies alert channels.",
      intervalMs: e.ALERT_EVALUATOR_INTERVAL_MS,
      enabled: e.ALERT_EVALUATOR_INTERVAL_MS > 0,
    },
    {
      queue: "analytics-snapshot",
      name: "Analytics snapshots",
      description: "Records the usage history behind analytics charts.",
      intervalMs: e.ANALYTICS_SNAPSHOT_INTERVAL_MS,
      enabled: e.ANALYTICS_SNAPSHOT_INTERVAL_MS > 0,
    },
    {
      queue: "x402-settlement",
      name: "x402 settlement",
      description: "Settles verified x402 payments on Solana.",
      intervalMs: e.X402_SETTLEMENT_INTERVAL_MS,
      enabled: e.X402_SETTLEMENT_WORKER_ENABLED && e.X402_SETTLEMENT_INTERVAL_MS > 0,
    },
    {
      queue: "token-indexer",
      name: "Token trade indexer",
      description: "Indexes trades of agent tokens.",
      intervalMs: e.TOKEN_INDEXER_INTERVAL_MS,
      enabled: e.TOKEN_INDEXER_INTERVAL_MS > 0,
    },
    {
      queue: "treasury-settlement",
      name: "Treasury settlement",
      description: "Bills agent treasuries for the compute they used.",
      intervalMs: e.TREASURY_SETTLEMENT_INTERVAL_MS,
      enabled: e.TREASURY_SETTLEMENT_INTERVAL_MS > 0,
    },
    {
      queue: "payment-submit",
      name: "Treasury payment submission",
      description: "Signs and broadcasts treasury compute payments.",
      intervalMs: e.PAYMENT_SUBMIT_INTERVAL_MS,
      enabled: e.PAYMENT_SUBMIT_INTERVAL_MS > 0 && Boolean(e.WALLET_MASTER_KEY),
    },
    {
      queue: "payment-poll",
      name: "Treasury payment confirmation",
      description: "Confirms broadcast treasury payments on-chain.",
      intervalMs: e.PAYMENT_POLL_INTERVAL_MS,
      enabled: e.PAYMENT_POLL_INTERVAL_MS > 0,
    },
    {
      queue: "payment-reap",
      name: "Payment recovery",
      description: "Recovers treasury payments whose confirmation was interrupted.",
      intervalMs: e.PAYMENT_REAP_INTERVAL_MS,
      enabled: e.PAYMENT_REAP_INTERVAL_MS > 0,
    },
    {
      queue: "fee-router",
      name: "Fee routing",
      description: "Routes token trading fees to agent treasuries.",
      intervalMs: e.FEE_ROUTER_INTERVAL_MS,
      enabled: e.FEE_ROUTER_INTERVAL_MS > 0,
    },
    {
      queue: "reputation-attestation",
      name: "Usage attestation",
      description: "Writes usage attestations to the reputation oracle.",
      intervalMs: e.REPUTATION_ATTESTATION_INTERVAL_MS,
      enabled: e.REPUTATION_ATTESTATION_INTERVAL_MS > 0,
    },
    {
      queue: "payout-executor",
      name: "Creator payouts",
      description: "Pays out approved creator earnings.",
      intervalMs: e.PAYOUT_EXECUTOR_INTERVAL_MS,
      enabled: e.PAYOUTS_ENABLED && e.PAYOUT_EXECUTOR_INTERVAL_MS > 0,
    },
    {
      queue: "embedding-backfill",
      name: "Embedding backfill",
      description: "Embeds knowledge-base content for semantic search.",
      intervalMs: e.EMBEDDING_BACKFILL_INTERVAL_MS,
      enabled: e.EMBEDDING_BACKFILL_INTERVAL_MS > 0,
    },
    {
      queue: "subscription-renewal",
      name: "Subscription renewals",
      description: "Renews monthly marketplace subscriptions that are due.",
      intervalMs: e.SUBSCRIPTION_RENEWAL_INTERVAL_MS,
      enabled: e.SUBSCRIPTION_RENEWAL_INTERVAL_MS > 0,
    },
  ];
  return all
    .filter((w) => w.enabled)
    .map(({ enabled: _enabled, ...w }) => w);
}

/**
 * Reads the newest entry of each queue's completed/failed sorted set. BullMQ
 * scores both by the job's finish time in ms (moveToFinished), so the top
 * score is "last completed at" / "last failed at" — one pipelined round trip
 * for every queue.
 */
export async function readRunsFromRedis(
  redis: Pick<Redis, "pipeline">,
  queues: string[],
  prefix = "bull",
): Promise<Record<string, WorkerRunInfo>> {
  const pipeline = redis.pipeline();
  for (const q of queues) {
    pipeline.zrevrange(`${prefix}:${q}:completed`, 0, 0, "WITHSCORES");
    pipeline.zrevrange(`${prefix}:${q}:failed`, 0, 0, "WITHSCORES");
  }
  const results = (await pipeline.exec()) ?? [];

  const scoreAt = (index: number): Date | null => {
    const entry = results[index];
    if (!entry || entry[0]) {
      throw entry?.[0] ?? new Error("missing pipeline result");
    }
    const value = entry[1] as string[] | null;
    const score = Number(value?.[1]);
    return Number.isFinite(score) && score > 0 ? new Date(score) : null;
  };

  const out: Record<string, WorkerRunInfo> = {};
  queues.forEach((q, i) => {
    out[q] = { lastCompletedAt: scoreAt(i * 2), lastFailedAt: scoreAt(i * 2 + 1) };
  });
  return out;
}

/**
 * Production wiring. One lazily created Redis client, reused (see the note
 * in routes/health.ts on why per-request clients leak during outages).
 *
 * STATUS_PAGE_ORG_ID (config/env.ts) names the organisation whose uptime
 * monitors are public: the operator creates monitors for the platform's
 * own endpoints in that org. Unset means "no public monitors".
 */
export function buildStatusDeps(): StatusDeps {
  let client: Redis | null = null;
  const getClient = (): Redis => {
    if (!client) {
      client = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 3_000,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      // Reconnect errors are expected during a Redis outage — the one time
      // this endpoint must keep answering.
      client.on("error", () => {});
    }
    return client;
  };
  const connected = async (): Promise<Redis> => {
    const redis = getClient();
    if (redis.status === "wait" || redis.status === "end") {
      await redis.connect();
    }
    return redis;
  };

  const publicOrgId = env.STATUS_PAGE_ORG_ID ?? null;

  return {
    async checkDatabase() {
      await prisma.$queryRaw`SELECT 1`;
    },
    async checkRedis() {
      await (await connected()).ping();
    },
    workers: configuredWorkers(),
    async readWorkerRuns(queues) {
      return readRunsFromRedis(await connected(), queues);
    },
    loadPublicMonitors: publicOrgId
      ? async () =>
          prisma.uptimeMonitor.findMany({
            where: { orgId: publicOrgId, isEnabled: true },
            orderBy: { name: "asc" },
            take: MAX_PUBLIC_MONITORS,
            select: {
              id: true,
              name: true,
              currentStatus: true,
              lastCheckAt: true,
              uptimePercent24h: true,
              uptimePercent7d: true,
              uptimePercent30d: true,
              avgLatencyMs: true,
            },
          })
      : null,
    async loadMonitorDays(monitorIds, since) {
      if (monitorIds.length === 0) return [];
      // checked_at is a UTC timestamp without time zone, so its date part is
      // the UTC day.
      const rows = await prisma.$queryRaw<
        Array<{ monitorId: string; day: string; checks: number; up: number }>
      >`
        SELECT monitor_id::text AS "monitorId",
               to_char(checked_at, 'YYYY-MM-DD') AS "day",
               count(*)::int AS "checks",
               (count(*) FILTER (WHERE status = 'up'))::int AS "up"
        FROM uptime_events
        WHERE monitor_id = ANY(${monitorIds}::uuid[])
          AND checked_at >= ${since}
        GROUP BY 1, 2
      `;
      return rows.map((r) => ({
        monitorId: r.monitorId,
        day: r.day,
        checks: Number(r.checks),
        up: Number(r.up),
      }));
    },
    close() {
      client?.disconnect();
      client = null;
    },
  };
}

/** Production-wired plugin, as mounted by index.ts. */
export const statusRoutes: FastifyPluginAsync = createStatusRoutes(buildStatusDeps());
