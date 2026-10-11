-- A deposit address an organization can be paid at from anywhere, and one
-- record for every on-chain transfer that is credited.
--
--   deposit_addresses   one row per organization: the address its prepared
--                       top-ups already pay into, how far its history has
--                       been read, and what it last held. With the row the
--                       address can be shown, watched for transfers sent
--                       straight to it (a withdrawal from an exchange), and
--                       later emptied.
--   onchain_receipts    one row per transfer that was, or is waiting to be,
--                       credited, whether it belongs to a prepared top-up or
--                       was sent straight to the address. UNIQUE (network,
--                       tx_signature, asset): one transfer is credited once,
--                       whichever path sees it first.
--
-- EXISTING ROWS.
--   1. Every organization that has a wallet top-up gets its deposit_addresses
--      row, with the address its newest top-up was prepared for. Nothing has
--      been read yet (no cursors, balances of zero), so the first scan reads
--      its whole history.
--   2. Every top-up that was already credited and has a signature gets its
--      receipt, marked credited. That is what stops the first scan from
--      crediting an old top-up a second time.
--   3. A top-up the older code ended as failed or expired although its
--      transfer did land gets no receipt here. The first scan finds that
--      transfer on the chain and credits it once, through its top-up. That
--      is by design: it was paid for and never credited.
-- No balance and no ledger row is touched by this migration.
--
-- After a clean run this counts none:
--   SELECT count(*) FROM wallet_topups t
--   WHERE t.status = 'credited' AND t.tx_signature IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM onchain_receipts r WHERE r.topup_id = t.id);

-- CreateTable
CREATE TABLE "deposit_addresses" (
    "org_id" UUID NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "usdc_account_opened_at" TIMESTAMP(3),
    "usdc_account_opened_by" TEXT,
    "usdc_account_requested_at" TIMESTAMP(3),
    "last_sol_signature" TEXT,
    "last_usdc_signature" TEXT,
    "last_seen_lamports" BIGINT NOT NULL DEFAULT 0,
    "last_seen_usdc_raw" BIGINT NOT NULL DEFAULT 0,
    "scan_requested_at" TIMESTAMP(3),
    "last_scanned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_addresses_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "onchain_receipts" (
    "id" UUID NOT NULL,
    "network" TEXT NOT NULL,
    "tx_signature" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "org_id" UUID NOT NULL,
    "deposit_address" TEXT NOT NULL,
    "amount_raw" BIGINT NOT NULL,
    "slot" BIGINT,
    "block_time" TIMESTAMP(3),
    "sender_addresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "topup_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "ignored_reason" TEXT,
    "amount_usd_cents" BIGINT,
    "bonus_cents" BIGINT NOT NULL DEFAULT 0,
    "quote_price_micro_usd" BIGINT,
    "quote_publish_time" TIMESTAMP(3),
    "quote_source" TEXT,
    "credited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onchain_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deposit_addresses_address_key" ON "deposit_addresses"("address");
CREATE INDEX "deposit_addresses_last_scanned_at_idx" ON "deposit_addresses"("last_scanned_at");
CREATE UNIQUE INDEX "onchain_receipts_topup_id_key" ON "onchain_receipts"("topup_id");
CREATE UNIQUE INDEX "onchain_receipts_network_tx_signature_asset_key" ON "onchain_receipts"("network", "tx_signature", "asset");
CREATE INDEX "onchain_receipts_org_id_created_at_idx" ON "onchain_receipts"("org_id", "created_at");
CREATE INDEX "onchain_receipts_status_idx" ON "onchain_receipts"("status");

-- AddForeignKey
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "onchain_receipts" ADD CONSTRAINT "onchain_receipts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "onchain_receipts" ADD CONSTRAINT "onchain_receipts_topup_id_fkey" FOREIGN KEY ("topup_id") REFERENCES "wallet_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 1. The address each organization's top-ups were prepared for.
INSERT INTO "deposit_addresses" ("org_id", "address", "network", "updated_at")
SELECT DISTINCT ON (t."org_id") t."org_id", t."deposit_address", t."network", CURRENT_TIMESTAMP
FROM "wallet_topups" t
WHERE NOT EXISTS (
  -- The same address prepared for two organizations cannot happen (it is
  -- derived from the organization); if a hand-made row ever says so, the
  -- newer organization is left without a row rather than failing here.
  SELECT 1 FROM "wallet_topups" o
  WHERE o."deposit_address" = t."deposit_address" AND o."org_id" <> t."org_id" AND o."created_at" < t."created_at"
)
ORDER BY t."org_id", t."created_at" DESC
ON CONFLICT DO NOTHING;

-- 2. The transfers already credited.
INSERT INTO "onchain_receipts" (
  "id", "network", "tx_signature", "asset", "org_id", "deposit_address", "amount_raw", "source", "topup_id",
  "status", "amount_usd_cents", "bonus_cents", "quote_price_micro_usd", "quote_publish_time", "quote_source",
  "credited_at", "created_at", "updated_at"
)
SELECT gen_random_uuid(), t."network", t."tx_signature", t."asset", t."org_id", t."deposit_address",
       t."amount_raw"::BIGINT, 'prepared', t."id",
       'credited', t."amount_usd_cents", t."bonus_cents", t."quote_price_micro_usd", t."quote_publish_time", t."quote_source",
       COALESCE(t."credited_at", t."updated_at"), COALESCE(t."credited_at", t."updated_at"), CURRENT_TIMESTAMP
FROM "wallet_topups" t
WHERE t."status" = 'credited' AND t."tx_signature" IS NOT NULL
ON CONFLICT DO NOTHING;
