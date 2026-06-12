-- CreateEnum
CREATE TYPE "OnChainAttestationStatus" AS ENUM ('SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "FeeRoutingBatchStatus" AS ENUM ('CLAIMED', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- AlterTable
ALTER TABLE "agent_token_trades" ADD COLUMN     "fee_routing_batch_id" UUID;

-- AlterTable
ALTER TABLE "on_chain_attestations" ADD COLUMN     "last_valid_block_height" BIGINT,
ADD COLUMN     "signed_tx_b64" TEXT,
ADD COLUMN     "status" "OnChainAttestationStatus" NOT NULL DEFAULT 'SUBMITTED',
ALTER COLUMN "cumulative_uptime_seconds" DROP NOT NULL,
ALTER COLUMN "cumulative_message_count" DROP NOT NULL,
ALTER COLUMN "attestation_count" DROP NOT NULL,
ALTER COLUMN "observed_at" DROP NOT NULL,
ALTER COLUMN "observed_at" DROP DEFAULT;

-- Backfill: rows written before this migration were inserted AFTER a
-- broadcast under the old broadcast-as-finality worker. Grandfather them
-- as CONFIRMED (their observed_at stays as recorded) so existing mirror
-- data keeps counting; every new row starts at SUBMITTED and is only
-- promoted by the confirmation/recovery scan.
UPDATE "on_chain_attestations" SET "status" = 'CONFIRMED';

-- CreateTable
CREATE TABLE "fee_routing_batches" (
    "id" UUID NOT NULL,
    "treasury_id" UUID NOT NULL,
    "status" "FeeRoutingBatchStatus" NOT NULL DEFAULT 'CLAIMED',
    "lamports" BIGINT NOT NULL,
    "trade_count" INTEGER NOT NULL,
    "tx_signature" TEXT,
    "signed_tx_b64" TEXT,
    "last_valid_block_height" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_routing_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_routing_batches_tx_signature_key" ON "fee_routing_batches"("tx_signature");

-- CreateIndex
CREATE INDEX "fee_routing_batches_status_idx" ON "fee_routing_batches"("status");

-- CreateIndex
CREATE INDEX "fee_routing_batches_treasury_id_created_at_idx" ON "fee_routing_batches"("treasury_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_token_trades_fee_routing_batch_id_idx" ON "agent_token_trades"("fee_routing_batch_id");

-- CreateIndex
CREATE INDEX "on_chain_attestations_status_idx" ON "on_chain_attestations"("status");

-- AddForeignKey
ALTER TABLE "agent_token_trades" ADD CONSTRAINT "agent_token_trades_fee_routing_batch_id_fkey" FOREIGN KEY ("fee_routing_batch_id") REFERENCES "fee_routing_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_routing_batches" ADD CONSTRAINT "fee_routing_batches_treasury_id_fkey" FOREIGN KEY ("treasury_id") REFERENCES "agent_treasuries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
