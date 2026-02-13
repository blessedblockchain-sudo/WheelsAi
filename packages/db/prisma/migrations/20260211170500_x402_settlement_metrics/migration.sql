-- CreateTable
CREATE TABLE "x402_settlement_metrics" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_payments" INTEGER NOT NULL DEFAULT 0,
    "pending_payments" INTEGER NOT NULL DEFAULT 0,
    "verified_payments" INTEGER NOT NULL DEFAULT 0,
    "settled_payments" INTEGER NOT NULL DEFAULT 0,
    "failed_payments" INTEGER NOT NULL DEFAULT 0,
    "retriable_payments" INTEGER NOT NULL DEFAULT 0,
    "failure_rate_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oldest_pending_minutes" INTEGER,
    "worker_ticks" INTEGER NOT NULL DEFAULT 0,
    "worker_processed" INTEGER NOT NULL DEFAULT 0,
    "worker_settled" INTEGER NOT NULL DEFAULT 0,
    "worker_failed" INTEGER NOT NULL DEFAULT 0,
    "worker_retried" INTEGER NOT NULL DEFAULT 0,
    "worker_skipped" INTEGER NOT NULL DEFAULT 0,
    "alert_count" INTEGER NOT NULL DEFAULT 0,
    "alerts" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "x402_settlement_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "x402_settlement_metrics_org_id_timestamp_idx" ON "x402_settlement_metrics"("org_id", "timestamp");

-- CreateIndex
CREATE INDEX "x402_settlement_metrics_timestamp_idx" ON "x402_settlement_metrics"("timestamp");

-- AddForeignKey
ALTER TABLE "x402_settlement_metrics" ADD CONSTRAINT "x402_settlement_metrics_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
