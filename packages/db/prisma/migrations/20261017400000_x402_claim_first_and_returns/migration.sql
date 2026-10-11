-- x402: a payment is recorded before it is sent, and one that lands for a
-- request that is not answered goes back to the payer's credits.
--
--   x402_payments   gains the signed transaction and its blockhash (written
--                   with the new status 'submitted' before the broadcast),
--                   what the transfer actually carried, the request's price
--                   in millionths of a dollar, the SOL rate it was quoted at,
--                   and how the payment ended: served_at, or refunded_at with
--                   what was returned.
--   credit_balances gains x402_refund_carry_micro_usd: returned payments are
--                   fractions of a cent, so they add up here and whole cents
--                   move to the balance with a ledger row.
--
-- EXISTING ROWS. Nothing is rewritten. A row that is already 'verified' or
-- 'settled' was served under the old code, which had no column to say so:
-- served_at is set to when it was verified, so the settlement worker never
-- takes an old, answered request for one that died and returns its payment.
-- Old 'failed' rows carry no signature and keep nothing that could be
-- returned.

-- AlterTable
ALTER TABLE "x402_payments"
  ADD COLUMN "signed_tx_b64" TEXT,
  ADD COLUMN "recent_blockhash" TEXT,
  ADD COLUMN "submitted_at" TIMESTAMP(3),
  ADD COLUMN "amount_received_raw" TEXT,
  ADD COLUMN "amount_micro_usd" BIGINT,
  ADD COLUMN "sol_micro_usd_per_sol" BIGINT,
  ADD COLUMN "served_at" TIMESTAMP(3),
  ADD COLUMN "refunded_at" TIMESTAMP(3),
  ADD COLUMN "refund_micro_usd" BIGINT;

-- AlterTable
ALTER TABLE "credit_balances" ADD COLUMN "x402_refund_carry_micro_usd" BIGINT NOT NULL DEFAULT 0;

-- Rows the old code answered.
UPDATE "x402_payments"
SET "served_at" = COALESCE("verified_at", "settled_at", "updated_at")
WHERE "status" IN ('verified', 'settled') AND "served_at" IS NULL;
