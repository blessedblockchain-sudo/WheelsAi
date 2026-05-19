-- Plan A4 — on-chain reputation oracle integration.
--
-- 1. AgentToken gains two columns:
--    - reputation_program_initialized: set true once initialize_agent_reputation
--      has landed on-chain for this mint. The attestation worker skips
--      agents where this is false (no AgentReputation PDA to write into).
--    - last_on_chain_attestation_at: cursor advanced by the worker after
--      a successful submit_attestation. Usage records with periodEnd >
--      this cursor contribute to the next attestation. Null = never
--      attested (treat as -infinity).
--
-- 2. New table on_chain_attestations mirrors the AttestationSubmitted
--    events emitted by the reputation-oracle program, so off-chain
--    readers don't have to scan the chain on every load. The on-chain
--    AgentReputation PDA remains the source of truth.

ALTER TABLE "agent_tokens"
  ADD COLUMN "reputation_program_initialized" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "last_on_chain_attestation_at" TIMESTAMP(3);

CREATE TABLE "on_chain_attestations" (
  "id"                        UUID NOT NULL,
  "token_id"                  UUID NOT NULL,
  "tx_signature"              TEXT NOT NULL,
  "attestor_address"          TEXT NOT NULL,
  "uptime_seconds_delta"      BIGINT NOT NULL,
  "message_count_delta"       BIGINT NOT NULL,
  "score"                     INTEGER NOT NULL,
  "cumulative_uptime_seconds" BIGINT NOT NULL,
  "cumulative_message_count"  BIGINT NOT NULL,
  "attestation_count"         INTEGER NOT NULL,
  "attestor_unix_ts"          BIGINT NOT NULL,
  "observed_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "on_chain_attestations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "on_chain_attestations_tx_signature_key"
  ON "on_chain_attestations"("tx_signature");

CREATE INDEX "on_chain_attestations_token_id_attestor_unix_ts_idx"
  ON "on_chain_attestations"("token_id", "attestor_unix_ts");

CREATE INDEX "on_chain_attestations_attestor_address_idx"
  ON "on_chain_attestations"("attestor_address");

ALTER TABLE "on_chain_attestations"
  ADD CONSTRAINT "on_chain_attestations_token_id_fkey"
  FOREIGN KEY ("token_id") REFERENCES "agent_tokens"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
