-- A wallet top-up that any account can pay, that a failed send cannot lose,
-- and that says why it ended in words the product wrote.
--
--   wallet_topups.failure_code           why the row ended, as a code the API
--                                        turns into a sentence:
--                                        'unsigned_expired' | 'never_landed' |
--                                        'failed_on_chain'. failure_reason
--                                        stays beside it with the chain's own
--                                        words, for operators only; it is no
--                                        longer sent to a customer.
--   wallet_topups.signed_tx_b64          the signed transaction exactly as the
--                                        wallet returned it, written by the
--                                        same compare-and-set that records
--                                        tx_signature, before it is broadcast.
--                                        It is what the worker sends again
--                                        while the transaction can still land.
--   wallet_topups.quote_price_micro_usd  SOL only: the exact price the amount
--   wallet_topups.quote_publish_time     was worked out from (micro-dollars
--   wallet_topups.quote_source           per SOL), that price's own publish
--                                        time, and where it came from
--                                        ('pyth' | 'static').
--   wallet_topups.submitted_at           when the signed transfer was first
--                                        handed to the network.
--
-- EXISTING ROWS. Every new column is NULL on every existing row, and no row
-- is rewritten. A NULL failure_code on a failed or expired row reads as the
-- general sentence. A NULL signed_tx_b64 on a row that is in flight means
-- there is nothing to send again: the row is still ended only by what the
-- chain says about its signature. quoted_sol_price_usd keeps the figure the
-- older SOL test top-ups were priced at.
--
-- No status, amount, balance or ledger row is touched, and nothing is
-- credited or refunded by this migration.

-- AlterTable
ALTER TABLE "wallet_topups"
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "signed_tx_b64" TEXT,
  ADD COLUMN "quote_price_micro_usd" BIGINT,
  ADD COLUMN "quote_publish_time" TIMESTAMP(3),
  ADD COLUMN "quote_source" TEXT,
  ADD COLUMN "submitted_at" TIMESTAMP(3);
