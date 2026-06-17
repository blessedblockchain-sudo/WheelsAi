-- Remediation D9: integer raw-unit money columns alongside the legacy
-- Floats (which become display-only). New columns are added nullable,
-- backfilled exactly from the Floats via `numeric` (no double rounding),
-- then promoted to NOT NULL. The conversion factors must match
-- apps/api/src/lib/tokenUnits.ts: SOL → lamports (×1e9), pump.fun tokens
-- → raw (×1e6, 6 decimals). ROUND(numeric) is half-away-from-zero,
-- matching the JS Math.round at the indexer boundary.

-- AlterTable: revenue split in basis points (0–10000). Default 0 covers
-- existing rows; backfill from the Float mirror for any non-zero shares.
ALTER TABLE "agent_contributors" ADD COLUMN     "revenue_share_bps" INTEGER NOT NULL DEFAULT 0;
UPDATE "agent_contributors"
  SET "revenue_share_bps" = ROUND("revenue_share"::numeric * 10000)::int;

-- AlterTable: holder balance in raw token units (tokens × 1e6).
ALTER TABLE "agent_token_holders" ADD COLUMN     "balance_raw" BIGINT;
UPDATE "agent_token_holders"
  SET "balance_raw" = ROUND("balance"::numeric * 1000000)::bigint;
ALTER TABLE "agent_token_holders" ALTER COLUMN "balance_raw" SET NOT NULL;

-- AlterTable: trade amounts in raw integer units.
ALTER TABLE "agent_token_trades" ADD COLUMN     "sol_lamports" BIGINT,
ADD COLUMN     "token_amount_raw" BIGINT;
UPDATE "agent_token_trades"
  SET "sol_lamports" = ROUND("sol_amount"::numeric * 1000000000)::bigint,
      "token_amount_raw" = ROUND("token_amount"::numeric * 1000000)::bigint;
ALTER TABLE "agent_token_trades" ALTER COLUMN "sol_lamports" SET NOT NULL;
ALTER TABLE "agent_token_trades" ALTER COLUMN "token_amount_raw" SET NOT NULL;
