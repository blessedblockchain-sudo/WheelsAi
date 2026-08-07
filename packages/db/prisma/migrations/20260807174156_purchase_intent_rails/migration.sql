-- CreateTable
CREATE TABLE "stripe_purchases" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "stripe_session_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "bonus_cents" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'created',
    "completed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stripe_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_topups" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "asset" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "amount_usd_cents" BIGINT NOT NULL,
    "bonus_cents" BIGINT NOT NULL DEFAULT 0,
    "amount_raw" TEXT NOT NULL,
    "quoted_sol_price_usd" DOUBLE PRECISION,
    "payer_address" TEXT NOT NULL,
    "deposit_address" TEXT NOT NULL,
    "unsigned_message_b64" TEXT NOT NULL,
    "tx_signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "failure_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "credited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_topups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stripe_purchases_stripe_session_id_key" ON "stripe_purchases"("stripe_session_id");

-- CreateIndex
CREATE INDEX "stripe_purchases_org_id_created_at_idx" ON "stripe_purchases"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "stripe_purchases_status_idx" ON "stripe_purchases"("status");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_topups_tx_signature_key" ON "wallet_topups"("tx_signature");

-- CreateIndex
CREATE INDEX "wallet_topups_org_id_created_at_idx" ON "wallet_topups"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_topups_status_idx" ON "wallet_topups"("status");

-- AddForeignKey
ALTER TABLE "stripe_purchases" ADD CONSTRAINT "stripe_purchases_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_topups" ADD CONSTRAINT "wallet_topups_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
