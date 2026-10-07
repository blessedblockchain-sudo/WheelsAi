-- Offerings and Jobs: what the runner, the hire API and API-key spending
-- need on top of 20261001600000_offerings_jobs. The offerings and jobs
-- tables are still empty (nothing wrote to them before this), so the new
-- constraints and foreign keys have no rows to validate.

-- ============================================
-- Offerings
-- ============================================

-- AlterTable
ALTER TABLE "offerings" ADD COLUMN     "output_format" TEXT NOT NULL DEFAULT 'text',
ADD COLUMN     "allowed_tools" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "max_attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "max_concurrent_jobs" INTEGER NOT NULL DEFAULT 5,
ADD COLUMN     "active_jobs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "published_at" TIMESTAMP(3);

-- The bounds the API enforces, held by the database as well: a job costs
-- between 50 cents and 1,000 dollars, and a publisher promises delivery in
-- between 5 minutes and 7 days.
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_price_cents_check" CHECK ("price_cents" BETWEEN 50 AND 100000);
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_sla_seconds_check" CHECK ("sla_seconds" BETWEEN 300 AND 604800);
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_max_attempts_check" CHECK ("max_attempts" BETWEEN 1 AND 3);
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_output_format_check" CHECK ("output_format" IN ('text', 'json'));
-- The capacity counter is moved by compare-and-set; it can never go below
-- zero or past the offering's limit, whatever a caller does.
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_active_jobs_check" CHECK ("active_jobs" >= 0 AND "max_concurrent_jobs" BETWEEN 1 AND 50);

-- CreateIndex
CREATE INDEX "offerings_agent_id_idx" ON "offerings"("agent_id");

-- CreateIndex
CREATE INDEX "offerings_orchestration_id_idx" ON "offerings"("orchestration_id");

-- CreateIndex
CREATE INDEX "offerings_listing_id_status_idx" ON "offerings"("listing_id", "status");

-- AddForeignKey
-- Restrict: an offering has jobs, and jobs are money records.
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull: an offering whose product was deleted stays (its jobs point at
-- it) but can no longer run, and the hire path refuses it.
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_orchestration_id_fkey" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offerings" ADD CONSTRAINT "offerings_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "agent_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================
-- Jobs
-- ============================================

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "hired_by_user_id" UUID,
ADD COLUMN     "hired_by_api_key_id" UUID,
ADD COLUMN     "terms" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lease_expires_at" TIMESTAMP(3),
ADD COLUMN     "orchestration_execution_id" UUID,
ADD COLUMN     "review" TEXT,
ADD COLUMN     "rated_at" TIMESTAMP(3);

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_price_cents_check" CHECK ("price_cents" > 0);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);

-- CreateIndex
-- A retried hire carries the same key and finds the first job; NULL keys
-- never collide.
CREATE UNIQUE INDEX "jobs_buyer_id_idempotency_key_key" ON "jobs"("buyer_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "jobs_offering_id_status_idx" ON "jobs"("offering_id", "status");

-- CreateIndex
CREATE INDEX "jobs_status_lease_expires_at_idx" ON "jobs"("status", "lease_expires_at");

-- AddForeignKey
-- Restrict on both sides, like credit_transactions: a job is part of the
-- billing record of the organization that paid and the one that was paid.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_publisher_id_fkey" FOREIGN KEY ("publisher_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- The escrow row of a job. No marketplace_revenue row has a job_id yet.
ALTER TABLE "marketplace_revenue" ADD CONSTRAINT "marketplace_revenue_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================
-- API keys that may spend
-- ============================================

-- AlterTable
-- Both are set on a key granted jobs:hire: the most one job may cost, and
-- the most the key may spend in one UTC day.
ALTER TABLE "api_keys" ADD COLUMN     "max_job_price_cents" BIGINT,
ADD COLUMN     "daily_spend_cap_cents" BIGINT;

-- CreateTable
CREATE TABLE "api_key_spend_windows" (
    "api_key_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "spent_cents" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "api_key_spend_windows_pkey" PRIMARY KEY ("api_key_id","day")
);

-- AddForeignKey
ALTER TABLE "api_key_spend_windows" ADD CONSTRAINT "api_key_spend_windows_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================
-- The pricing a buyer accepted, on the install
-- ============================================

-- AlterTable
-- A free or per-request install was charged whatever the listing said at
-- each request. The install now records the pricing the buyer agreed to;
-- a price above it, or a different pricing model, pauses the install until
-- the buyer accepts (a lower price, or a move to free, applies at once).
ALTER TABLE "agent_installs" ADD COLUMN     "accepted_pricing_model" TEXT,
ADD COLUMN     "accepted_price_per_request_cents" BIGINT,
ADD COLUMN     "pricing_accepted_at" TIMESTAMP(3);

-- Existing installs: the model is the listing's. The per-request price is
-- the one the buyer was last charged (a settled per-request row holds
-- gross = price x requests), because that is the price they have seen; a
-- listing raised since then pauses until they accept it. An install that
-- was never charged takes the listing's price as it stands today.
UPDATE "agent_installs" i
SET "accepted_pricing_model" = l."pricing_model",
    "accepted_price_per_request_cents" = CASE
      WHEN l."pricing_model" = 'per_request' THEN COALESCE(l."price_per_request_cents", 0)
      ELSE NULL
    END,
    "pricing_accepted_at" = i."installed_at"
FROM "agent_listings" l
WHERE l."id" = i."listing_id";

UPDATE "agent_installs" i
SET "accepted_price_per_request_cents" = r."unit_cents"
FROM (
  SELECT DISTINCT ON ("install_id")
    "install_id",
    "gross_amount_cents" / GREATEST("request_count", 1) AS "unit_cents"
  FROM "marketplace_revenue"
  WHERE "install_id" IS NOT NULL
    AND "status" = 'settled'
    AND "type" = 'per_request'
  ORDER BY "install_id", "created_at" DESC
) r
WHERE r."install_id" = i."id"
  AND i."accepted_pricing_model" = 'per_request';
