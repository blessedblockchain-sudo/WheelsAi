/**
 * Composition root for measured latency (services/latencySamples.ts and
 * services/latencyQueries.ts): binds the sample sink and the percentile
 * queries to Prisma.
 *
 * Recording goes through ONE sink per process (recordLatencySample), opened
 * by the first sample, so every way a chat is answered - a route, a worker,
 * a workflow step - writes to the same table the same way and none of them
 * waits for the write. The process closes it on shutdown (closeLatencySink)
 * to flush the last interval.
 *
 * This module does not import config/env.ts: the usage hook of every agent
 * chat reaches it, and that must not pull environment validation into
 * callers that have none. Whoever builds the readers passes the settings
 * (latencyConfigFromEnv).
 */

import { prisma as defaultPrisma } from "@wheelsai/db";

import { createLogger } from "../utils/logger.js";
import {
  HISTOGRAM_EDGES_MS,
  groupedLatencyQuery,
  latencyHistogramQuery,
  outcomeCountsQuery,
  pruneLatencyQuery,
  publicLatencyQuery,
  scopedLatencyQuery,
  type GroupedLatencyRow,
  type HistogramRow,
  type LatencyGroup,
  type OutcomeCountRow,
  type PlatformWindow,
  type PublicLatencyRow,
  type ScopedLatencyRow,
  type ScopedWindow,
} from "./latencyQueries.js";
import {
  LATENCY_OUTCOMES,
  PUBLIC_LATENCY_SURFACES,
  createLatencySampleSink,
  publicLatencyOrgCap,
  type LatencyOutcome,
  type LatencySample,
  type LatencySampleSink,
  type RecordLatency,
} from "./latencySamples.js";

const logger = createLogger("latency-samples");

/** The part of Prisma this module uses; a test passes a fake of this shape. */
export interface LatencyPrisma {
  requestLatencySample: {
    createMany(args: { data: LatencySample[] }): Promise<unknown>;
  };
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

// ============================================
// Recording: the process sink
// ============================================

function sinkOver(prisma: LatencyPrisma): LatencySampleSink {
  return createLatencySampleSink({
    insertMany: (samples) => prisma.requestLatencySample.createMany({ data: samples }),
    logger,
  });
}

let processSink: LatencySampleSink | null = null;

/** The process's sink, opened on first use so importing this opens nothing. */
export function processLatencySink(): LatencySampleSink {
  return (processSink ??= sinkOver(defaultPrisma as unknown as LatencyPrisma));
}

/**
 * Records one request's latency. Synchronous and never throws; the row is
 * written in the background. A null (unmeasured) sample is ignored.
 */
export const recordLatencySample: RecordLatency = (sample) => {
  try {
    processLatencySink().push(sample);
  } catch {
    // Recording is never a reason for a request to fail.
  }
};

/** Flushes what is buffered; for process shutdown. Never rejects. */
export async function closeLatencySink(): Promise<void> {
  const sink = processSink;
  processSink = null;
  await sink?.close().catch(() => {});
}

// ============================================
// Reading
// ============================================

export interface LatencyConfig {
  /** The rolling window of the public figure (PUBLIC_LATENCY_WINDOW_HOURS). */
  windowHours: number;
  /** PUBLIC_LATENCY_EXCLUDED_ORG_IDS: internal and test organizations. */
  excludedOrgIds: readonly string[];
  /** How many of one organization's requests the public figure counts. */
  maxSamplesPerOrg: number;
  /** LATENCY_SAMPLE_RETENTION_DAYS. */
  retentionDays: number;
}

export function latencyConfigFromEnv(env: {
  PUBLIC_LATENCY_WINDOW_HOURS: number;
  PUBLIC_LATENCY_MIN_SAMPLES: number;
  PUBLIC_LATENCY_MIN_ORGS: number;
  PUBLIC_LATENCY_EXCLUDED_ORG_IDS: readonly string[];
  LATENCY_SAMPLE_RETENTION_DAYS: number;
}): LatencyConfig {
  return {
    windowHours: env.PUBLIC_LATENCY_WINDOW_HOURS,
    excludedOrgIds: env.PUBLIC_LATENCY_EXCLUDED_ORG_IDS,
    // Derived from the publication thresholds, not set on its own: a cap
    // chosen apart from them could let one organization hold most of a
    // published figure again.
    maxSamplesPerOrg: publicLatencyOrgCap(
      env.PUBLIC_LATENCY_MIN_SAMPLES,
      env.PUBLIC_LATENCY_MIN_ORGS,
    ),
    retentionDays: env.LATENCY_SAMPLE_RETENTION_DAYS,
  };
}

/**
 * Successful answers on the public surfaces over the rolling window, at most
 * `maxSamplesPerOrg` (the most recent) from any one organization.
 */
export interface PublicLatencyWindow {
  windowHours: number;
  sampleCount: number;
  /** Distinct organizations the samples came from. */
  orgCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  firstTokenSampleCount: number;
  /** Distinct organizations among the samples that carry a first-token time. */
  firstTokenOrgCount: number;
  firstTokenP50Ms: number | null;
  computedAt: Date;
}

export interface LatencyHistogramBucket {
  /** null = slower than the last edge. */
  upToMs: number | null;
  count: number;
}

export interface ScopedLatency {
  sampleCount: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface LatencySampleDeps {
  recordLatency: RecordLatency;
  loadPublicLatencyRow(): Promise<PublicLatencyWindow>;
  /** Every recorded request in the public window, by how it ended. */
  loadOutcomeCounts(): Promise<Record<LatencyOutcome, number>>;
  /** Successful answers per bucket, every bucket present (zero included). */
  loadLatencyHistogram(): Promise<LatencyHistogramBucket[]>;
  /** One organization's latency over [since, until), optionally one resource's. */
  loadScopedLatency(window: ScopedWindow): Promise<ScopedLatency>;
  /** The same window split by deployment, agent or surface; a key with no sample is absent. */
  loadGroupedLatency(window: ScopedWindow, groupBy: LatencyGroup): Promise<Map<string, ScopedLatency>>;
  /** Deletes samples past retention; returns how many rows went. */
  pruneLatencySamples(): Promise<number>;
  close(): Promise<void>;
}

export interface BuildLatencySampleDepsInput {
  config: LatencyConfig;
  /** Omitted = the global client and the process sink. */
  prisma?: LatencyPrisma;
  now?: () => Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PRUNE_BATCH_SIZE = 5_000;
// A bound on one prune call (1M rows), so a backlog cannot hold a worker
// tick for good; the next tick takes the rest.
const PRUNE_MAX_BATCHES = 200;

/** A Postgres integer or float as a number; NULL stays null. */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** No sample, no number: an average or percentile of nothing is null. */
function toScopedLatency(row: ScopedLatencyRow | undefined): ScopedLatency {
  const sampleCount = numberOrNull(row?.n) ?? 0;
  const measured = (value: unknown): number | null =>
    sampleCount > 0 ? numberOrNull(value) : null;
  const avg = measured(row?.avg);
  return {
    sampleCount,
    avgMs: avg === null ? null : Math.round(avg),
    p50Ms: measured(row?.p50),
    p95Ms: measured(row?.p95),
    p99Ms: measured(row?.p99),
  };
}

type RawQuery = Pick<LatencyPrisma, "$queryRawUnsafe">;

/**
 * The org-scoped readers on their own, for callers that need no public
 * window and so no settings (alerts, analytics, a deployment's metrics).
 */
export function scopedLatencyLoader(
  prisma: RawQuery = defaultPrisma as unknown as RawQuery,
): (window: ScopedWindow) => Promise<ScopedLatency> {
  return async (window) => {
    const query = scopedLatencyQuery(window);
    const rows = await prisma.$queryRawUnsafe<ScopedLatencyRow[]>(query.text, ...query.values);
    return toScopedLatency(rows[0]);
  };
}

export function groupedLatencyLoader(
  prisma: RawQuery = defaultPrisma as unknown as RawQuery,
): (window: ScopedWindow, groupBy: LatencyGroup) => Promise<Map<string, ScopedLatency>> {
  return async (window, groupBy) => {
    const query = groupedLatencyQuery(window, groupBy);
    const rows = await prisma.$queryRawUnsafe<GroupedLatencyRow[]>(query.text, ...query.values);
    const out = new Map<string, ScopedLatency>();
    for (const row of rows) {
      const latency = toScopedLatency(row);
      if (typeof row.key === "string" && latency.sampleCount > 0) out.set(row.key, latency);
    }
    return out;
  };
}

export function buildLatencySampleDeps(input: BuildLatencySampleDepsInput): LatencySampleDeps {
  const { config } = input;
  const prisma = input.prisma ?? (defaultPrisma as unknown as LatencyPrisma);
  const now = input.now ?? (() => new Date());
  // An injected database gets a sink of its own; the default is the one the
  // rest of the process records through.
  let ownSink: LatencySampleSink | null = null;
  const sink = (): LatencySampleSink =>
    input.prisma ? (ownSink ??= sinkOver(input.prisma)) : processLatencySink();

  const publicWindow = (at: Date): PlatformWindow => ({
    since: new Date(at.getTime() - config.windowHours * HOUR_MS),
    surfaces: PUBLIC_LATENCY_SURFACES,
    excludedOrgIds: config.excludedOrgIds,
    maxSamplesPerOrg: config.maxSamplesPerOrg,
  });

  return {
    recordLatency: (sample) => {
      try {
        sink().push(sample);
      } catch {
        // Recording is never a reason for a request to fail.
      }
    },

    loadPublicLatencyRow: async () => {
      const computedAt = now();
      const query = publicLatencyQuery(publicWindow(computedAt));
      const rows = await prisma.$queryRawUnsafe<PublicLatencyRow[]>(query.text, ...query.values);
      const row = rows[0];
      const sampleCount = numberOrNull(row?.n) ?? 0;
      const firstTokenSampleCount = numberOrNull(row?.first_token_n) ?? 0;
      return {
        windowHours: config.windowHours,
        sampleCount,
        orgCount: numberOrNull(row?.orgs) ?? 0,
        p50Ms: sampleCount > 0 ? numberOrNull(row?.p50) : null,
        p95Ms: sampleCount > 0 ? numberOrNull(row?.p95) : null,
        firstTokenSampleCount,
        firstTokenOrgCount: numberOrNull(row?.first_token_orgs) ?? 0,
        firstTokenP50Ms: firstTokenSampleCount > 0 ? numberOrNull(row?.first_token_p50) : null,
        computedAt,
      };
    },

    loadOutcomeCounts: async () => {
      const query = outcomeCountsQuery(publicWindow(now()));
      const rows = await prisma.$queryRawUnsafe<OutcomeCountRow[]>(query.text, ...query.values);
      const counts = Object.fromEntries(LATENCY_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
        LatencyOutcome,
        number
      >;
      for (const row of rows) {
        if ((LATENCY_OUTCOMES as readonly string[]).includes(row.outcome)) {
          counts[row.outcome as LatencyOutcome] = numberOrNull(row.n) ?? 0;
        }
      }
      return counts;
    },

    loadLatencyHistogram: async () => {
      const query = latencyHistogramQuery(publicWindow(now()));
      const rows = await prisma.$queryRawUnsafe<HistogramRow[]>(query.text, ...query.values);
      const byBucket = new Map(rows.map((row) => [Number(row.bucket), numberOrNull(row.n) ?? 0]));
      return [...HISTOGRAM_EDGES_MS, null].map((upToMs, bucket) => ({
        upToMs,
        count: byBucket.get(bucket) ?? 0,
      }));
    },

    loadScopedLatency: scopedLatencyLoader(prisma),
    loadGroupedLatency: groupedLatencyLoader(prisma),

    pruneLatencySamples: async () => {
      const before = new Date(now().getTime() - config.retentionDays * DAY_MS);
      const query = pruneLatencyQuery({ before, batchSize: PRUNE_BATCH_SIZE });
      let deleted = 0;
      for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch++) {
        const count = await prisma.$executeRawUnsafe(query.text, ...query.values);
        deleted += count;
        if (count < PRUNE_BATCH_SIZE) break;
      }
      return deleted;
    },

    close: async () => {
      if (input.prisma) await ownSink?.close().catch(() => {});
      else await closeLatencySink();
    },
  };
}
