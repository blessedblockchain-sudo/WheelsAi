-- Adds the per-treasury cursor for the fee-router BullMQ worker.
--
-- The worker reads agent_token_trades since this timestamp, computes
-- 1% of the volume in lamports, sends fee_receive on-chain, and bumps
-- this column to the latest included trade's timestamp. Null means
-- "never routed" (treat as -infinity).

ALTER TABLE "agent_treasuries"
  ADD COLUMN "last_fee_routed_at" TIMESTAMP(3);
