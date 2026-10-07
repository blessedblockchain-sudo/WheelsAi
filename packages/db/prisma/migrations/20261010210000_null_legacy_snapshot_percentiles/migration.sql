-- Analytics snapshots stored "p50 / p95 / p99 latency" that were percentiles
-- of each (deployment, hour) MEAN - an average of averages, not a percentile
-- of anything a caller experienced. From this release the three columns are
-- percentile_disc over the per-request samples (request_latency_samples), or
-- NULL for a day with none.
--
-- The values already stored cannot be recomputed (no per-request data exists
-- for those days), so they are cleared rather than left to pass for request
-- percentiles. avg_latency_ms is kept: it was a true mean (total latency over
-- request count) of the time model deployments' nodes took; from this release
-- it is the mean end-to-end time of answered requests.
--
-- Data only; no schema change. Safe to re-run.
UPDATE "analytics_snapshots"
   SET "p50_latency_ms" = NULL,
       "p95_latency_ms" = NULL,
       "p99_latency_ms" = NULL
 WHERE "p50_latency_ms" IS NOT NULL
    OR "p95_latency_ms" IS NOT NULL
    OR "p99_latency_ms" IS NOT NULL;
