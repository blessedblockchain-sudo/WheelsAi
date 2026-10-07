/**
 * The SQL every stated latency comes from, over `request_latency_samples`.
 *
 * Pure builders returning { text, values } for $queryRawUnsafe, so what a
 * query filters on is testable without a database. Percentiles are
 * percentile_disc: the latency of a request that was actually served, never
 * an interpolation between two.
 *
 * Counts are cast to int and averages to float8 so no bigint or numeric
 * reaches the caller; an aggregate over no rows is NULL, and stays NULL.
 */

import type { LatencyOutcome } from "./latencySamples.js";

export interface SqlQuery {
  text: string;
  values: unknown[];
}

// ============================================
// Platform-wide (the public figure and /status)
// ============================================

export interface PlatformWindow {
  since: Date;
  /** Which ways in count (PUBLIC_LATENCY_SURFACES). */
  surfaces: readonly string[];
  /** Internal and test organizations, kept out of anything published. */
  excludedOrgIds: readonly string[];
  /**
   * How many of one organization's most recent requests count
   * (publicLatencyOrgCap). Without it the busiest customer's timings would be
   * published as the platform's, and anyone could move the figure by sending
   * more requests.
   */
  maxSamplesPerOrg: number;
}

// The dev-only mock deployment answers without running a model, so it is
// never part of a platform-wide figure.
const PLATFORM_FILTER = `created_at >= $1
    AND surface = ANY($2::text[])
    AND provider <> 'nosana_mock'
    AND NOT (org_id = ANY($3::uuid[]))`;

const platformValues = (window: PlatformWindow): unknown[] => [
  window.since,
  [...window.surfaces],
  [...window.excludedOrgIds],
  // A cap that is not a positive whole number counts one request per
  // organization: the safe reading, never "no cap".
  Number.isFinite(window.maxSamplesPerOrg) && window.maxSamplesPerOrg >= 1
    ? Math.floor(window.maxSamplesPerOrg)
    : 1,
];

/**
 * The rows a platform-wide figure is computed from: each organization's most
 * recent $4 requests in the window, not all of them. Every platform query
 * reads through this, so the percentiles, the histogram and the error share
 * rest on the same bounded share per organization.
 */
const cappedSamples = (extraFilter = ""): string => `(
    SELECT org_id, outcome, total_ms, first_token_ms,
           row_number() OVER (PARTITION BY org_id ORDER BY created_at DESC, id DESC) AS org_rank
      FROM request_latency_samples
     WHERE ${PLATFORM_FILTER}${extraFilter}
  ) AS capped
 WHERE org_rank <= $4`;

// Ranked among answers only, so an organization's failures do not use up its
// share of the latency figure.
const CAPPED_ANSWERS = cappedSamples(`
    AND outcome = 'ok'`);

export interface PublicLatencyRow {
  n: number;
  orgs: number;
  p50: number | null;
  p95: number | null;
  first_token_n: number;
  /** Distinct organizations among the answers that have a first-token time. */
  first_token_orgs: number;
  first_token_p50: number | null;
}

/**
 * Successful answers in the window, at most `maxSamplesPerOrg` per
 * organization: how many, from how many orgs, how fast.
 */
export function publicLatencyQuery(window: PlatformWindow): SqlQuery {
  return {
    text: `SELECT count(*)::int AS n,
       count(DISTINCT org_id)::int AS orgs,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95,
       count(first_token_ms)::int AS first_token_n,
       (count(DISTINCT org_id) FILTER (WHERE first_token_ms IS NOT NULL))::int AS first_token_orgs,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY first_token_ms) AS first_token_p50
  FROM ${CAPPED_ANSWERS}`,
    values: platformValues(window),
  };
}

export interface OutcomeCountRow {
  outcome: string;
  n: number;
}

/**
 * Recorded requests in the window by how they ended (the error share), at
 * most `maxSamplesPerOrg` per organization whatever their ending - one
 * customer's failing integration is not the platform's error rate.
 */
export function outcomeCountsQuery(window: PlatformWindow): SqlQuery {
  return {
    text: `SELECT outcome, count(*)::int AS n
  FROM ${cappedSamples()}
 GROUP BY outcome`,
    values: platformValues(window),
  };
}

/** Upper bounds, in ms, of the buckets /status draws; one open bucket follows. */
export const HISTOGRAM_EDGES_MS = [250, 500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface HistogramRow {
  /** 0 = up to the first edge ... edges.length = slower than the last. */
  bucket: number;
  n: number;
}

/**
 * The answers publicLatencyQuery counts, per bucket. A value equal to an edge
 * belongs to the bucket that edge closes ("up to 250 ms" includes 250), hence
 * the - 1.
 */
export function latencyHistogramQuery(
  window: PlatformWindow,
  edgesMs: readonly number[] = HISTOGRAM_EDGES_MS,
): SqlQuery {
  return {
    text: `SELECT width_bucket(total_ms - 1, $5::int[]) AS bucket, count(*)::int AS n
  FROM ${CAPPED_ANSWERS}
 GROUP BY bucket
 ORDER BY bucket`,
    values: [...platformValues(window), [...edgesMs]],
  };
}

// ============================================
// One organization (alerts, analytics, a deployment's or agent's own numbers)
// ============================================

export interface ScopedWindow {
  /** Always bound: a resource id can narrow the scope, never widen it. */
  orgId: string;
  /** [since, until) */
  since: Date;
  until: Date;
  /**
   * Which endings count. An answered-requests figure passes ["ok"]; an alert
   * on what callers experienced also counts errors and timeouts. A request
   * the caller abandoned measures the caller, so "cancelled" is a deliberate
   * choice, not a default.
   */
  outcomes: readonly LatencyOutcome[];
  agentId?: string;
  /** With agentId: the agent's own model deployments, counted as the agent's. */
  deploymentIds?: readonly string[];
}

export interface ScopedLatencyRow {
  n: number;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

const SCOPED_AGGREGATES = `count(*)::int AS n,
       avg(total_ms)::float8 AS avg,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY total_ms) AS p99`;

function scopedFilter(window: ScopedWindow): { where: string; values: unknown[] } {
  const values: unknown[] = [window.orgId, window.since, window.until, [...window.outcomes]];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  const scopes: string[] = [];
  if (window.agentId !== undefined) scopes.push(`agent_id = ${bind(window.agentId)}::uuid`);
  if (window.deploymentIds !== undefined) {
    scopes.push(`deployment_id = ANY(${bind([...window.deploymentIds])}::uuid[])`);
  }
  const scope = scopes.length > 0 ? `\n    AND (${scopes.join(" OR ")})` : "";

  return {
    where: `org_id = $1::uuid
    AND created_at >= $2
    AND created_at < $3
    AND outcome = ANY($4::text[])${scope}`,
    values,
  };
}

export function scopedLatencyQuery(window: ScopedWindow): SqlQuery {
  const { where, values } = scopedFilter(window);
  return {
    text: `SELECT ${SCOPED_AGGREGATES}
  FROM request_latency_samples
 WHERE ${where}`,
    values,
  };
}

/** What a scoped window can be split by. A fixed list: the column is never caller text. */
const GROUP_COLUMNS = {
  deployment: "deployment_id",
  agent: "agent_id",
  surface: "surface",
} as const;
export type LatencyGroup = keyof typeof GROUP_COLUMNS;

export interface GroupedLatencyRow extends ScopedLatencyRow {
  key: string;
}

/**
 * The same window, one row per deployment, agent or surface. Percentiles do
 * not add up, so a breakdown is its own query, never a sum of another's rows.
 * Samples without the grouping column (an agent chat has no deployment) are
 * left out instead of forming a nameless group.
 */
export function groupedLatencyQuery(window: ScopedWindow, groupBy: LatencyGroup): SqlQuery {
  const column = GROUP_COLUMNS[groupBy];
  const { where, values } = scopedFilter(window);
  return {
    text: `SELECT ${column}::text AS key,
       ${SCOPED_AGGREGATES}
  FROM request_latency_samples
 WHERE ${where}
    AND ${column} IS NOT NULL
 GROUP BY ${column}`,
    values,
  };
}

// ============================================
// Retention
// ============================================

/**
 * Deletes one bounded batch of samples older than `before`. Batched so a
 * large backlog never holds one long lock; the caller loops until a batch
 * comes back short.
 */
export function pruneLatencyQuery(args: { before: Date; batchSize: number }): SqlQuery {
  return {
    text: `DELETE FROM request_latency_samples
 WHERE id IN (
   SELECT id FROM request_latency_samples
    WHERE created_at < $1
    ORDER BY created_at
    LIMIT $2
 )`,
    values: [args.before, args.batchSize],
  };
}
