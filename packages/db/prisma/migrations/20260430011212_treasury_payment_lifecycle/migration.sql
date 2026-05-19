-- Treasury payment lifecycle (plan A2/A3) and real compute metering (plan A5).
--
-- Captures the schema additions backing:
--   • the BullMQ treasury-settlement / submit / poll / reap workers
--   • the on-chain agent-treasury PDA mirror
--   • real Nosana-derived compute cost (vs the prior 70/10/20 estimate)
--
-- This migration is additive only — no destructive ALTERs on columns that
-- already exist in production.

-- ============================================================
-- agent_treasuries
-- Per-agent treasury PDA mirror; see services/treasurySettlement.ts
-- ============================================================
CREATE TABLE "agent_treasuries" (
    "id" UUID NOT NULL,
    "token_id" UUID NOT NULL,
    "treasury_pda_address" TEXT NOT NULL,
    "authority_bump" INTEGER NOT NULL,
    "sol_balance_lamports" BIGINT NOT NULL DEFAULT 0,
    "accrued_fee_lamports" BIGINT NOT NULL DEFAULT 0,
    "last_compute_bill_lamports" BIGINT,
    "last_compute_bill_at" TIMESTAMP(3),
    "runway_seconds_estimate" BIGINT NOT NULL DEFAULT 0,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_treasuries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_treasuries_token_id_key" ON "agent_treasuries"("token_id");
CREATE UNIQUE INDEX "agent_treasuries_treasury_pda_address_key" ON "agent_treasuries"("treasury_pda_address");

ALTER TABLE "agent_treasuries"
    ADD CONSTRAINT "agent_treasuries_token_id_fkey"
    FOREIGN KEY ("token_id") REFERENCES "agent_tokens"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- compute_payments + ComputePaymentStatus
-- Lifecycle states: PENDING → SUBMITTED → CONFIRMED | FAILED.
-- submitted_at + retry_count are load-bearing for the reaper and
-- the lifecycle's shouldRetry() policy respectively.
-- ============================================================
CREATE TYPE "ComputePaymentStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

CREATE TABLE "compute_payments" (
    "id" UUID NOT NULL,
    "treasury_id" UUID NOT NULL,
    "nosana_job_id" TEXT NOT NULL,
    "amount_lamports" BIGINT NOT NULL,
    "compute_seconds" BIGINT NOT NULL,
    "tx_signature" TEXT,
    "status" "ComputePaymentStatus" NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "scheduled_for" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "compute_payments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "compute_payments_tx_signature_key" ON "compute_payments"("tx_signature");
CREATE INDEX "compute_payments_treasury_id_status_idx" ON "compute_payments"("treasury_id", "status");
CREATE INDEX "compute_payments_status_scheduled_for_idx" ON "compute_payments"("status", "scheduled_for");

ALTER TABLE "compute_payments"
    ADD CONSTRAINT "compute_payments_treasury_id_fkey"
    FOREIGN KEY ("treasury_id") REFERENCES "agent_treasuries"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- agent_tokens: treasury PDA mirror + lifetime counters
-- treasury_address is the on-chain PDA derived from mint_address.
-- compute_paid_lamports + revenue_lamports are kept-warm counters
-- updated by the treasury-settlement worker (so the dashboard
-- doesn't have to re-aggregate compute_payments on every read).
-- ============================================================
ALTER TABLE "agent_tokens"
    ADD COLUMN "treasury_address" TEXT,
    ADD COLUMN "treasury_pda_authority_bump" INTEGER,
    ADD COLUMN "compute_paid_lamports" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "revenue_lamports" BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "agent_tokens_treasury_address_key" ON "agent_tokens"("treasury_address");

-- ============================================================
-- usage_records: real compute metering (plan A5)
-- compute_seconds is sum of (job.endTime - job.startTime) per period;
-- actual_cost_cents = MARKETS[tier].pricePerSecond * compute_seconds.
-- cost_cents is preserved for backwards compat during rollout.
-- ============================================================
ALTER TABLE "usage_records"
    ADD COLUMN "compute_seconds" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "actual_cost_cents" BIGINT NOT NULL DEFAULT 0;
