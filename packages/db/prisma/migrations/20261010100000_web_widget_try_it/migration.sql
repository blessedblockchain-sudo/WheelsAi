-- The web chat channel and Try it.
--
-- widget_keys: the publishable key an embed snippet carries. Public by
-- design, so the key alone grants nothing: allowed_origins holds browsers to
-- the owner's sites, and the limits are enforced per key and per address.
--
-- trial_daily_usage / trial_charges: a listing's Try it messages per UTC day,
-- and the publisher-funded ones as money that is held, then settled or
-- refunded exactly once.

-- AlterTable
ALTER TABLE "agent_listings" ADD COLUMN     "trial_funded_daily_cap" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_trial_funded_daily_cap_check" CHECK ("trial_funded_daily_cap" >= 0);

-- CreateTable
CREATE TABLE "widget_keys" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "allowed_origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daily_message_cap" INTEGER,
    "per_ip_per_minute" INTEGER,
    "title" TEXT,
    "greeting" VARCHAR(500),
    "primary_color" TEXT,
    "position" TEXT NOT NULL DEFAULT 'bottom-right',
    "store_transcripts" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "widget_keys_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_limits_check" CHECK (("daily_message_cap" IS NULL OR "daily_message_cap" > 0) AND ("per_ip_per_minute" IS NULL OR "per_ip_per_minute" > 0));
ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_position_check" CHECK ("position" IN ('bottom-right', 'bottom-left'));

-- CreateTable
CREATE TABLE "trial_daily_usage" (
    "listing_id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "base_count" INTEGER NOT NULL DEFAULT 0,
    "funded_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trial_daily_usage_pkey" PRIMARY KEY ("listing_id","day")
);

ALTER TABLE "trial_daily_usage" ADD CONSTRAINT "trial_daily_usage_counts_check" CHECK ("base_count" >= 0 AND "funded_count" >= 0);

-- CreateTable
CREATE TABLE "trial_charges" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'held',
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "trial_charges_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "trial_charges" ADD CONSTRAINT "trial_charges_status_check" CHECK ("status" IN ('held', 'settled', 'refunded'));
ALTER TABLE "trial_charges" ADD CONSTRAINT "trial_charges_amount_check" CHECK ("amount_cents" > 0);

-- CreateIndex
CREATE UNIQUE INDEX "widget_keys_public_key_key" ON "widget_keys"("public_key");

-- CreateIndex
CREATE INDEX "widget_keys_org_id_idx" ON "widget_keys"("org_id");

-- CreateIndex
CREATE INDEX "widget_keys_agent_id_idx" ON "widget_keys"("agent_id");

-- CreateIndex
CREATE INDEX "trial_charges_listing_id_day_idx" ON "trial_charges"("listing_id", "day");

-- CreateIndex
CREATE INDEX "trial_charges_status_created_at_idx" ON "trial_charges"("status", "created_at");

-- AddForeignKey
ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_daily_usage" ADD CONSTRAINT "trial_daily_usage_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "agent_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
