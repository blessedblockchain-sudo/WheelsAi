-- Offerings and Jobs: what a job's runs used on the platform's own model
-- keys. A paid job is commercial use of those keys, so the tokens are
-- metered on the job and their cost is taken out of the publisher's share
-- when the escrow settles (services/jobEscrow.ts).

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "platform_input_tokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "platform_output_tokens" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "model_cost_cents" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_model_usage_check" CHECK ("platform_input_tokens" >= 0 AND "platform_output_tokens" >= 0 AND "model_cost_cents" >= 0);

-- What the settle moved from the publisher's share to the platform for
-- model usage. gross = platform fee + creator amount still holds; this
-- column says how much of the platform fee is model cost, not commission.
-- AlterTable
ALTER TABLE "marketplace_revenue" ADD COLUMN     "model_cost_cents" BIGINT NOT NULL DEFAULT 0;
