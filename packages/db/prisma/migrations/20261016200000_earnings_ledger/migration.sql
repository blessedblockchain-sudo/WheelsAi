-- A ledger for what creators are owed.
--
--   earnings_transactions   one row for every change to
--                           publisher_profiles.pending_payout_cents: a sale,
--                           a month of a subscription, a settled job, a
--                           contributor's share, a payout reserved, a payout
--                           put back. amount_cents is signed (above zero =
--                           owed more), balance_after is the balance the
--                           change left, and reference_id names the revenue
--                           row, payout or contributor earning it belongs to.
--
-- Until now that balance was a bare number that seven places added to or
-- took from, with nothing behind it. From here on only
-- apps/api/src/services/earningsLedger.ts changes it, and it writes the row
-- in the same transaction.
--
-- EXISTING ROWS. Every creator whose balance is not zero gets one
-- 'opening_balance' row for exactly that balance, so each creator's rows
-- add up to the balance from the first day. No balance is changed, and no
-- revenue row, payout or credit is touched. A payout that is open today
-- holds its amount outside the balance, as before; if it later fails or is
-- cancelled, the amount comes back as a 'payout_restored' row.
--
-- After a clean run this counts none:
--   SELECT count(*) FROM publisher_profiles p
--   WHERE p.pending_payout_cents <> COALESCE(
--     (SELECT sum(e.amount_cents) FROM earnings_transactions e WHERE e.org_id = p.org_id), 0);

-- CreateTable
CREATE TABLE "earnings_transactions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT,
    "reference_id" TEXT,
    "balance_after" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "earnings_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "earnings_transactions_org_id_created_at_idx" ON "earnings_transactions"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "earnings_transactions" ADD CONSTRAINT "earnings_transactions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The balance each creator already has, as the first row of their ledger.
INSERT INTO "earnings_transactions" ("id", "org_id", "amount_cents", "type", "description", "balance_after")
SELECT gen_random_uuid(), p."org_id", p."pending_payout_cents", 'opening_balance',
       'Owed when the earnings ledger began', p."pending_payout_cents"
FROM "publisher_profiles" p
WHERE p."pending_payout_cents" <> 0;
