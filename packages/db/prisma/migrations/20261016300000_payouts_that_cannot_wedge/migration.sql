-- Payouts that cannot get stuck or be paid twice.
--
-- Until now a wallet payout stored one signature and, if the send failed for
-- any reason (an empty paying wallet was enough), every later run only
-- looked that signature up. The payout stayed 'processing' for ever, its
-- amount stayed reserved, and it could not be cancelled.
--
--   creator_payouts.signed_tx_b64            the signed transfer, stored by the
--   creator_payouts.last_valid_block_height  same compare-and-set that claims
--   creator_payouts.claimed_at               the payout, before it is
--   creator_payouts.attempt_count            broadcast; the last block height
--   creator_payouts.expired_signatures       at which it can land; how many
--                                            transfers were signed; and the
--                                            signatures of earlier ones that
--                                            failed or can no longer land.
--   creator_payouts.amount_raw               what was sent, in base units, and
--   creator_payouts.quote_price_micro_usd    for SOL the exact price it was
--   creator_payouts.quote_publish_time       worked out from.
--   creator_payouts.quote_source
--   creator_payouts.waiting_reason           why a pending wallet payout has
--                                            not been sent yet, as a code.
--   creator_payouts.failure_code             why a failed payout failed, as a
--                                            code the API turns into a
--                                            sentence. failure_reason keeps
--                                            the chain's own words for
--                                            operators.
--
--   creator_payouts_one_open_per_publisher   a creator has at most one payout
--                                            that is pending or processing.
--                                            The request already checked this
--                                            by reading first; two requests at
--                                            once could both pass that read.
--                                            Now the database refuses the
--                                            second. (A partial index: Prisma's
--                                            schema cannot express it and its
--                                            drift check does not see it.)
--
-- EXISTING ROWS.
--   1. A payout that is 'processing' with no signature was claimed and never
--      sent (the claim and the send were separate steps). It goes back to
--      'pending', where the worker picks it up again and its creator can
--      cancel it. Its amount stays reserved, as it was.
--   2. A payout that is 'processing' WITH a signature keeps its status. It has
--      no stored block height, so the worker notes when it first sees it and
--      gives it up only if its signature is still unseen 30 minutes later.
--   3. If any creator already has more than one open payout, this migration
--      stops and names them: which one stands is a decision about money and
--      is not made here. None are expected.
--   Every new column is NULL (or 0, or an empty list) on existing rows. No
--   amount, balance or ledger row is touched.

-- AlterTable
ALTER TABLE "creator_payouts"
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "waiting_reason" TEXT,
  ADD COLUMN "signed_tx_b64" TEXT,
  ADD COLUMN "last_valid_block_height" BIGINT,
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expired_signatures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "amount_raw" TEXT,
  ADD COLUMN "quote_price_micro_usd" BIGINT,
  ADD COLUMN "quote_publish_time" TIMESTAMP(3),
  ADD COLUMN "quote_source" TEXT;

-- 1. Claimed and never sent: back to pending.
UPDATE "creator_payouts"
SET "status" = 'pending'
WHERE "status" = 'processing' AND "tx_signature" IS NULL;

-- 3. Refuse to guess between two open payouts of one creator.
DO $$
DECLARE
  doubled TEXT;
BEGIN
  SELECT string_agg(t."publisher_id"::text, ', ') INTO doubled
  FROM (
    SELECT "publisher_id" FROM "creator_payouts"
    WHERE "status" IN ('pending', 'processing')
    GROUP BY "publisher_id" HAVING count(*) > 1
  ) t;
  IF doubled IS NOT NULL THEN
    RAISE EXCEPTION 'creator_payouts: more than one open payout for publisher(s) %; cancel or complete the extra ones, then run this migration again', doubled;
  END IF;
END $$;

-- CreateIndex
CREATE UNIQUE INDEX "creator_payouts_one_open_per_publisher"
  ON "creator_payouts"("publisher_id")
  WHERE "status" IN ('pending', 'processing');
