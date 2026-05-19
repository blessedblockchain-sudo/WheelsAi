-- Adds program_initialized flag to agent_treasuries.
--
-- When true, the BullMQ payment-submit worker dispatches via the
-- agent-treasury Anchor program (pay_nosana ix); when false (default
-- for all existing rows), it falls back to the legacy
-- SystemProgram.transfer path. The flag is flipped to true by the
-- one-shot backfill script after `initialize_treasury` lands on-chain
-- for each treasury PDA.

ALTER TABLE "agent_treasuries"
  ADD COLUMN "program_initialized" BOOLEAN NOT NULL DEFAULT false;
