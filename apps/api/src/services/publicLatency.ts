/**
 * The public latency figure: what the landing page, the CLI and /status state.
 *
 * One definition, three honest states:
 *   measured           enough successful answers from enough organizations in
 *                      the window; the p50 and p95 are stated
 *   insufficient_data  the samples could be read but are too few, or come
 *                      from too few organizations; no latency is stated
 *   unavailable        the samples could not be read; nothing is stated
 *
 * There is no fallback number. A figure exists only when it was measured, and
 * everything that would let a reader work out a single customer's timings
 * (percentiles, the histogram, the error share) is withheld below the
 * publication thresholds. The samples behind it are capped per organization
 * (latencyQueries.ts), so the thresholds cannot be met by one busy customer
 * plus two idle ones.
 *
 * The reader is cached because the endpoints that serve it are public: a page
 * load must never be what runs a percentile query. One query runs at a time,
 * its result is reused for a minute, and a failure falls back to the last
 * good answer for a bounded time - with the time it was computed, so a stale
 * figure never passes for a fresh one.
 *
 * Pure: the queries and the clock are dependencies.
 */

import type {
  LatencyHistogramBucket,
  PublicLatencyWindow,
} from "./buildLatencySampleDeps.js";
import {
  PUBLIC_LATENCY_SURFACES,
  publicLatencyOrgCap,
  type LatencyOutcome,
} from "./latencySamples.js";

// ============================================
// The figure
// ============================================

export const PUBLIC_LATENCY_DEFINITION =
  "Time the WheelsAI API took to produce the complete answer to a chat request, " +
  "successful answers only; network time between the caller and the API is not included. " +
  "Each organization counts for a bounded number of its most recent answers.";

export type PublicLatencyStatus = "measured" | "insufficient_data" | "unavailable";

export interface PublicLatency {
  status: PublicLatencyStatus;
  metric: "response_time";
  definition: string;
  /** The ways in that count (services/latencySamples.ts). */
  surfaces: string[];
  windowHours: number;
  /**
   * Successful answers in the window that count, i.e. after the
   * per-organization cap. null only when unavailable.
   */
  sampleCount: number | null;
  /** Publication thresholds: below either, no latency is stated. */
  minSampleCount: number;
  minOrgCount: number;
  /**
   * How many of one organization's most recent answers count. Derived from
   * the two thresholds, so no single organization can supply more than an
   * equal share of the minimum.
   */
  maxSamplesPerOrg: number;
  /** Non-null only when measured. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** From streamed answers; held to the same thresholds on its own samples. */
  firstTokenP50Ms: number | null;
  firstTokenSampleCount: number | null;
  /** When the samples were read. A stale answer keeps its original time. */
  computedAt: string | null;
}

/** The figure plus what the /status proof section draws around it. */
export interface PublicLatencyDetail extends PublicLatency {
  /** Successful answers per bucket; null unless measured. */
  histogram: LatencyHistogramBucket[] | null;
  /**
   * Requests that ended in an error or a timeout, as a share of every
   * recorded request in the window. null unless measured: the headline counts
   * successful answers only, so this is what it leaves out.
   */
  errorSharePercent: number | null;
}

export interface PublicLatencyThresholds {
  windowHours: number;
  minSamples: number;
  minOrgs: number;
}

/** A whole number of ms, or null: a percentile is never rounded up from nothing. */
function wholeMs(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** `window` null = the samples could not be read. */
export function summarizePublicLatency(
  window: PublicLatencyWindow | null,
  thresholds: PublicLatencyThresholds,
): PublicLatency {
  const base = {
    metric: "response_time" as const,
    definition: PUBLIC_LATENCY_DEFINITION,
    surfaces: [...PUBLIC_LATENCY_SURFACES],
    windowHours: thresholds.windowHours,
    minSampleCount: thresholds.minSamples,
    minOrgCount: thresholds.minOrgs,
    maxSamplesPerOrg: publicLatencyOrgCap(thresholds.minSamples, thresholds.minOrgs),
  };
  const nothing = { p50Ms: null, p95Ms: null, firstTokenP50Ms: null };

  if (window === null) {
    return {
      ...base,
      status: "unavailable",
      sampleCount: null,
      ...nothing,
      firstTokenSampleCount: null,
      computedAt: null,
    };
  }

  const counted = {
    sampleCount: window.sampleCount,
    firstTokenSampleCount: window.firstTokenSampleCount,
    computedAt: window.computedAt.toISOString(),
  };
  const p50Ms = wholeMs(window.p50Ms);
  const p95Ms = wholeMs(window.p95Ms);
  const enough =
    window.sampleCount >= thresholds.minSamples &&
    window.orgCount >= thresholds.minOrgs &&
    // Enough rows without a percentile cannot happen; if it ever does, it is
    // not a measurement.
    p50Ms !== null &&
    p95Ms !== null;
  if (!enough) return { ...base, status: "insufficient_data", ...counted, ...nothing };

  const firstTokenEnough =
    window.firstTokenSampleCount >= thresholds.minSamples &&
    window.firstTokenOrgCount >= thresholds.minOrgs;
  return {
    ...base,
    status: "measured",
    ...counted,
    p50Ms,
    p95Ms,
    firstTokenP50Ms: firstTokenEnough ? wholeMs(window.firstTokenP50Ms) : null,
  };
}

/** What one read of the sample table returns. */
export interface PublicLatencySnapshot {
  window: PublicLatencyWindow;
  /** Every recorded request in the window, by how it ended. */
  outcomes: Record<LatencyOutcome, number>;
  histogram: LatencyHistogramBucket[];
}

export function errorSharePercent(outcomes: Record<LatencyOutcome, number>): number | null {
  const recorded = outcomes.ok + outcomes.error + outcomes.timeout + outcomes.cancelled;
  if (!(recorded > 0)) return null;
  return Math.round(((outcomes.error + outcomes.timeout) / recorded) * 10_000) / 100;
}

/** `snapshot` null = the samples could not be read. */
export function summarizePublicLatencyDetail(
  snapshot: PublicLatencySnapshot | null,
  thresholds: PublicLatencyThresholds,
): PublicLatencyDetail {
  const figure = summarizePublicLatency(snapshot?.window ?? null, thresholds);
  if (snapshot === null || figure.status !== "measured") {
    return { ...figure, histogram: null, errorSharePercent: null };
  }
  return {
    ...figure,
    histogram: snapshot.histogram.map((bucket) => ({ ...bucket })),
    errorSharePercent: errorSharePercent(snapshot.outcomes),
  };
}

// ============================================
// The cached reader
// ============================================

export interface PublicLatencyReaderDeps {
  /** Reads the sample table. May reject or hang; the reader bounds both. */
  loadSnapshot(): Promise<PublicLatencySnapshot>;
  thresholds: PublicLatencyThresholds;
  now?: () => number;
  /** How long one read is reused. */
  ttlMs?: number;
  /** How old a good read may be and still stand in for a failed one. */
  maxStaleMs?: number;
  /** How long a caller waits for a read before it counts as failed. */
  timeoutMs?: number;
  /** After a failed read, how long before the next one is attempted. */
  retryMs?: number;
}

export interface PublicLatencyReader {
  /** The figure. Never rejects. */
  figure(): Promise<PublicLatency>;
  /** The figure with its histogram and error share. Never rejects. */
  detail(): Promise<PublicLatencyDetail>;
  /** What a route states if the reader itself cannot be reached. */
  unavailableFigure(): PublicLatency;
  unavailableDetail(): PublicLatencyDetail;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_STALE_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_MS = 5_000;

export function createPublicLatencyReader(deps: PublicLatencyReaderDeps): PublicLatencyReader {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const maxStaleMs = deps.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;

  let good: { at: number; snapshot: PublicLatencySnapshot } | null = null;
  let failedAt: number | null = null;
  // The read itself, not a caller's wait for it: a query slower than the
  // timeout is still the only one running, and later callers wait on it
  // instead of piling more onto a struggling database.
  let inflight: Promise<PublicLatencySnapshot> | null = null;

  const read = (): Promise<PublicLatencySnapshot> => {
    if (!inflight) {
      const started = Promise.resolve()
        .then(() => deps.loadSnapshot())
        .then(
          (snapshot) => {
            good = { at: now(), snapshot };
            failedAt = null;
            return snapshot;
          },
          (err: unknown) => {
            failedAt = now();
            throw err;
          },
        )
        .finally(() => {
          if (inflight === started) inflight = null;
        });
      // A caller that timed out has stopped listening; the rejection of a
      // late failure must not go unhandled.
      started.catch(() => {});
      inflight = started;
    }
    return inflight;
  };

  const bounded = async (): Promise<PublicLatencySnapshot> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`exceeded ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /** The snapshot to state, or null when there is none worth stating. */
  const current = async (): Promise<PublicLatencySnapshot | null> => {
    const at = now();
    if (good && at - good.at < ttlMs) return good.snapshot;
    const stale = (): PublicLatencySnapshot | null =>
      good && now() - good.at < maxStaleMs ? good.snapshot : null;
    if (failedAt !== null && at - failedAt < retryMs) return stale();
    try {
      return await bounded();
    } catch {
      return stale();
    }
  };

  return {
    figure: async () => summarizePublicLatency((await current())?.window ?? null, deps.thresholds),
    detail: async () => summarizePublicLatencyDetail(await current(), deps.thresholds),
    unavailableFigure: () => summarizePublicLatency(null, deps.thresholds),
    unavailableDetail: () => summarizePublicLatencyDetail(null, deps.thresholds),
  };
}
