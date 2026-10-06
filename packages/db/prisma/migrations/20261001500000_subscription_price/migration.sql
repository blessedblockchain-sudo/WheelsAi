-- AlterTable
ALTER TABLE "agent_subscriptions" ADD COLUMN     "price_cents" BIGINT;

-- Existing subscriptions keep the price they were charged at: the
-- listing's monthly price at the time of this migration.
UPDATE "agent_subscriptions" s
SET "price_cents" = l."monthly_price_cents"
FROM "agent_listings" l
WHERE s."listing_id" = l."id" AND s."price_cents" IS NULL;
