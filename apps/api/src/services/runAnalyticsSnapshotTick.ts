/**
 * Analytics-snapshot tick (Wave 1) — the first caller
 * createDailySnapshot ever had. The daily-snapshot writer (totals,
 * latency percentiles, per-deployment and per-agent breakdowns) was
 * complete but nothing invoked it, so the historical-analytics surface
 * had no history.
 *
 * One pass = for every org with usage in the last two days, upsert
 * TODAY's rolling snapshot and re-upsert YESTERDAY's (finalizing it —
 * late usage rows land in the right day). Upserts make the tick freely
 * re-runnable. Per-org isolation.
 *
 * The same pass enforces the retention of the per-request latency samples
 * the snapshots are computed from (LATENCY_SAMPLE_RETENTION_DAYS), after the
 * snapshots are written so a day is summarised before any of it can go. A
 * failed prune is reported and never costs the snapshots.
 */

export interface AnalyticsSnapshotTickDeps {
  /** Orgs with any usage in the lookback window — never "all orgs". */
  loadActiveOrgIds: (args: { since: Date }) => Promise<string[]>;
  /** createDailySnapshot(orgId, day) — upsert, null when day had no usage. */
  snapshotOrgDay: (orgId: string, day: Date) => Promise<unknown | null>;
  /** Deletes latency samples past retention; resolves to how many rows went. */
  pruneLatencySamples: () => Promise<number>;
}

export interface AnalyticsSnapshotTickResult {
  orgs: number;
  snapshots: number;
  empty: number;
  failed: number;
  prunedLatencySamples: number;
  /** The prune threw: samples past retention are still stored. */
  latencyPruneFailed: boolean;
}

export async function runAnalyticsSnapshotTick(
  input: { now: Date },
  deps: AnalyticsSnapshotTickDeps,
): Promise<AnalyticsSnapshotTickResult> {
  const since = new Date(input.now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const orgIds = await deps.loadActiveOrgIds({ since });

  const yesterday = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);

  const result: AnalyticsSnapshotTickResult = {
    orgs: orgIds.length,
    snapshots: 0,
    empty: 0,
    failed: 0,
    prunedLatencySamples: 0,
    latencyPruneFailed: false,
  };

  for (const orgId of orgIds) {
    for (const day of [yesterday, input.now]) {
      try {
        const snapshot = await deps.snapshotOrgDay(orgId, day);
        if (snapshot === null) result.empty += 1;
        else result.snapshots += 1;
      } catch {
        result.failed += 1;
      }
    }
  }

  try {
    result.prunedLatencySamples = await deps.pruneLatencySamples();
  } catch {
    result.latencyPruneFailed = true;
  }

  return result;
}
