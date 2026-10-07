-- Measured latency: one row per chat request that reached a model (an agent
-- chat, or a call to a model deployment), written by the API when the request
-- ends. Every latency the product states - the public p50, alert rules on
-- latency_p95 / latency_avg, analytics percentiles - is computed from these
-- rows with percentile_disc, so a stated figure is the time of a request
-- that was actually served and can be re-derived from the table.
--
-- Append-only telemetry: no foreign keys (nothing is checked on the request
-- path, and a deleted agent's past timings stay true), no content, and rows
-- older than LATENCY_SAMPLE_RETENTION_DAYS are pruned.

-- CreateTable
CREATE TABLE "request_latency_samples" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "surface" TEXT NOT NULL,
    "agent_id" UUID,
    "deployment_id" UUID,
    "model" TEXT,
    "provider" TEXT NOT NULL,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT NOT NULL,
    "status_code" INTEGER,
    "total_ms" INTEGER NOT NULL,
    "upstream_ms" INTEGER,
    "first_token_ms" INTEGER,
    "output_tokens" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_latency_samples_pkey" PRIMARY KEY ("id")
);

-- A sample is a measurement: never negative, and its parts never exceed it.
ALTER TABLE "request_latency_samples" ADD CONSTRAINT "request_latency_samples_ms_check" CHECK (
    "total_ms" >= 0
    AND ("upstream_ms" IS NULL OR ("upstream_ms" >= 0 AND "upstream_ms" <= "total_ms"))
    AND ("first_token_ms" IS NULL OR ("first_token_ms" >= 0 AND "first_token_ms" <= "total_ms"))
);

ALTER TABLE "request_latency_samples" ADD CONSTRAINT "request_latency_samples_outcome_check" CHECK ("outcome" IN ('ok', 'error', 'timeout', 'cancelled'));

-- CreateIndex
CREATE INDEX "request_latency_samples_created_at_idx" ON "request_latency_samples"("created_at");

-- CreateIndex
CREATE INDEX "request_latency_samples_org_id_created_at_idx" ON "request_latency_samples"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "request_latency_samples_deployment_id_created_at_idx" ON "request_latency_samples"("deployment_id", "created_at");

-- CreateIndex
CREATE INDEX "request_latency_samples_agent_id_created_at_idx" ON "request_latency_samples"("agent_id", "created_at");
