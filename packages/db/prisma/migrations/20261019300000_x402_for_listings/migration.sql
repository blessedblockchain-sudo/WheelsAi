-- A use of an agent can be paid from a Solana wallet by a caller with no
-- account, through the x402 door of a listing whose creator allows it.
--
--   agent_listings.x402_enabled           the creator's switch. Only on an
--                                         agent's listing that sells use, per
--                                         request, at 5 cents or more
--                                         (agent_listings_x402_per_use_check).
--   x402_payments.listing_id              the listing a payment paid one use
--                                         of. NULL on every payment for a
--                                         deployment, which is every payment
--                                         from before. A payment is for a
--                                         listing or for a deployment, never
--                                         both (x402_payments_listing_or_deployment_check).
--                                         No foreign key: a stranger's failed
--                                         payment must not stand in the way of
--                                         an agent's delete, and
--                                         marketplace_revenue.listing_id has
--                                         none either.
--   x402_payments.message_hash            the sha256 of the message both
--                                         signatures of the transaction sign.
--                                         Set on every payment for a listing
--                                         and on no other
--                                         (x402_payments_listing_has_message_hash_check).
--                                         Unique: one message pays for one
--                                         answer, however many signatures of
--                                         it are presented.
--   x402_payments_one_open_door_payment_per_wallet
--                                         one payment for a listing in flight
--                                         ('held' or 'submitted') per paying
--                                         wallet: a partial unique index.
--   marketplace_revenue.buyer_id          no longer required: NULL on a sale
--                                         paid from a wallet, which has no
--                                         buyer organization.
--   marketplace_revenue.payer_wallet      the wallet that paid such a sale.
--   marketplace_revenue.x402_payment_id   the payment such a sale came from.
--                                         Unique, so a payment is one sale at
--                                         most, and the payment cannot be
--                                         deleted from under its sale.
--
--   Every sale has exactly one of a buyer and a paying wallet
--   (marketplace_revenue_buyer_or_wallet_check), and a sale paid from a
--   wallet always names its payment
--   (marketplace_revenue_wallet_has_payment_check).
--
-- EXISTING ROWS. No row is rewritten by a statement of its own: every listing
-- reads x402_enabled false, every payment gets listing_id and message_hash
-- NULL, and every sale keeps its buyer and gets NULL in the two new columns.
-- After a clean run these all count none:
--   SELECT count(*) FROM agent_listings WHERE x402_enabled;
--   SELECT count(*) FROM x402_payments WHERE listing_id IS NOT NULL OR message_hash IS NOT NULL;
--   SELECT count(*) FROM marketplace_revenue WHERE buyer_id IS NULL OR payer_wallet IS NOT NULL OR x402_payment_id IS NOT NULL;

-- AlterTable
ALTER TABLE "agent_listings" ADD COLUMN "x402_enabled" BOOLEAN NOT NULL DEFAULT false;

-- The price is nullable, and a CHECK passes on NULL, so it is asked for by name.
ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_x402_per_use_check" CHECK (NOT "x402_enabled" OR ("agent_id" IS NOT NULL AND "sells" = 'use' AND "pricing_model" = 'per_request' AND "price_per_request_cents" IS NOT NULL AND "price_per_request_cents" >= 5));

-- AlterTable
ALTER TABLE "x402_payments" ADD COLUMN "listing_id" UUID,
ADD COLUMN "message_hash" TEXT;

ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_listing_or_deployment_check" CHECK ("listing_id" IS NULL OR ("deployment_id" IS NULL AND "agent_deployment_id" IS NULL));
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_listing_has_message_hash_check" CHECK (("listing_id" IS NULL) = ("message_hash" IS NULL));

-- AlterTable
ALTER TABLE "marketplace_revenue" ADD COLUMN "payer_wallet" TEXT,
ADD COLUMN "x402_payment_id" UUID,
ALTER COLUMN "buyer_id" DROP NOT NULL;

ALTER TABLE "marketplace_revenue" ADD CONSTRAINT "marketplace_revenue_buyer_or_wallet_check" CHECK (num_nonnulls("buyer_id", "payer_wallet") = 1);
ALTER TABLE "marketplace_revenue" ADD CONSTRAINT "marketplace_revenue_wallet_has_payment_check" CHECK (("payer_wallet" IS NULL) = ("x402_payment_id" IS NULL));

-- CreateIndex
CREATE UNIQUE INDEX "x402_payments_message_hash_key" ON "x402_payments"("message_hash");

-- CreateIndex
CREATE INDEX "x402_payments_listing_id_created_at_idx" ON "x402_payments"("listing_id", "created_at");

-- One door payment in flight per paying wallet. Prisma does not model a
-- partial index; schema.prisma names it in a comment.
CREATE UNIQUE INDEX "x402_payments_one_open_door_payment_per_wallet" ON "x402_payments"("payer_address") WHERE "listing_id" IS NOT NULL AND "status" IN ('held', 'submitted');

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_revenue_x402_payment_id_key" ON "marketplace_revenue"("x402_payment_id");

-- AddForeignKey
ALTER TABLE "marketplace_revenue" ADD CONSTRAINT "marketplace_revenue_x402_payment_id_fkey" FOREIGN KEY ("x402_payment_id") REFERENCES "x402_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
