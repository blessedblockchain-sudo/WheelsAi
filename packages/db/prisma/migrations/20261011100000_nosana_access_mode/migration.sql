-- Nosana access mode per stored Nosana id.
--
-- The platform can now pay Nosana in two ways: a Solana wallet that funds a
-- vault per deployment, or a dashboard API key that draws on prepaid USD
-- credits. A deployment belongs to the account that created it, so every row
-- that stores a Nosana id also stores which credential created it. Stop,
-- reclaim, scale, status and runway calls pass it, and a deployment created
-- with one credential is never looked up with the other after the primary
-- mode is switched.
--
-- Values: 'wallet' | 'api_key'. NULL means wallet: every existing row was
-- created by the wallet, so nothing is backfilled.

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN "nosana_access_mode" TEXT;

-- AlterTable
ALTER TABLE "agent_deployments" ADD COLUMN "nosana_access_mode" TEXT;

-- AlterTable
ALTER TABLE "training_jobs" ADD COLUMN "nosana_access_mode" TEXT;

-- AlterTable
ALTER TABLE "openclaw_deployments" ADD COLUMN "nosana_access_mode" TEXT;

-- AlterTable
ALTER TABLE "nosana_orphan_deployments" ADD COLUMN "access_mode" TEXT;
