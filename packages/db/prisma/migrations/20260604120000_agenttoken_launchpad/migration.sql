-- Bags launchpad support.
--
-- AgentToken gains:
--   - launchpad: which launchpad minted the token ("pumpfun" | "bags").
--     Discriminator for the Bags fee-claim sweep, which only operates on
--     bags-launched tokens. Existing rows backfill to "pumpfun".
--   - meteora_config_key: Bags Meteora fee-share config key (base58).
--     Null for pump.fun.

ALTER TABLE "agent_tokens"
  ADD COLUMN "launchpad" TEXT NOT NULL DEFAULT 'pumpfun',
  ADD COLUMN "meteora_config_key" TEXT;

CREATE INDEX "agent_tokens_launchpad_idx" ON "agent_tokens"("launchpad");
