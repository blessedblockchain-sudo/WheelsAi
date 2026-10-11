-- Moving what customers paid off their deposit addresses.
--
--   chain_transfers    one row for every transfer the platform itself sends
--                      on chain: a deposit address emptied to the wallet that
--                      pays creators (the hot wallet) or to the treasury, and
--                      the hot wallet sending what it holds above its float to
--                      the treasury. The row is written with its signature and
--                      its signed bytes before anything is broadcast, and only
--                      the chain ends it.
--   platform_wallets   the platform's wallets that are not derived from the
--                      master key. The treasury is used only once its row is
--                      here: written by scripts/treasury-verify.ts after a
--                      transfer from that address, signed by it, was found.
--
-- chain_transfers_one_open_per_source: one transfer in flight per sending
-- address and asset. Two workers planning the same balance cannot both write
-- their row. Prisma does not model a partial index; it is kept here.
--
-- No existing row is touched, and nothing moves until SWEEPS_ENABLED is set.

-- CreateTable
CREATE TABLE "chain_transfers" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "org_id" UUID,
    "amount_raw" BIGINT NOT NULL,
    "fee_lamports" BIGINT NOT NULL DEFAULT 0,
    "fee_payer" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "tx_signature" TEXT NOT NULL,
    "signed_tx_b64" TEXT NOT NULL,
    "last_valid_block_height" BIGINT NOT NULL,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_wallets" (
    "role" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL,
    "proof_signature" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_wallets_pkey" PRIMARY KEY ("role","network")
);

-- CreateIndex
CREATE UNIQUE INDEX "chain_transfers_tx_signature_key" ON "chain_transfers"("tx_signature");
CREATE INDEX "chain_transfers_status_idx" ON "chain_transfers"("status");
CREATE INDEX "chain_transfers_from_address_asset_idx" ON "chain_transfers"("from_address", "asset");
CREATE INDEX "chain_transfers_org_id_created_at_idx" ON "chain_transfers"("org_id", "created_at");

-- One transfer in flight per sending address and asset.
CREATE UNIQUE INDEX "chain_transfers_one_open_per_source" ON "chain_transfers"("from_address", "asset") WHERE "status" = 'sent';

-- AddForeignKey
ALTER TABLE "chain_transfers" ADD CONSTRAINT "chain_transfers_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
