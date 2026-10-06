-- ============================================
-- Subscriptions
-- ============================================

-- AlterTable
ALTER TABLE "agent_subscriptions" ADD COLUMN     "end_reason" TEXT,
ADD COLUMN     "last_renewal_attempt_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "agent_subscriptions_status_last_renewal_attempt_at_idx" ON "agent_subscriptions"("status", "last_renewal_attempt_at");

-- The agreed price is what the subscription was last charged, not the
-- listing's price on the day the column was added (the earlier backfill),
-- which a publisher may have changed since the buyer subscribed. Rows with
-- no settled charge keep what they have; a row left NULL is not renewed at
-- the listing's current price (the buyer is asked to accept it instead).
UPDATE "agent_subscriptions" s
SET "price_cents" = r."gross_amount_cents"
FROM (
  SELECT DISTINCT ON ("subscription_id") "subscription_id", "gross_amount_cents"
  FROM "marketplace_revenue"
  WHERE "subscription_id" IS NOT NULL
    AND "status" = 'settled'
    AND "type" IN ('subscription', 'subscription_renewal')
  ORDER BY "subscription_id", "created_at" DESC
) r
WHERE r."subscription_id" = s."id"
  AND s."price_cents" IS DISTINCT FROM r."gross_amount_cents";

-- ============================================
-- Contributor invitations
-- ============================================

-- An invitation sent to an email is stored under that email and bound to
-- an account only when it is accepted.
-- AlterTable
ALTER TABLE "agent_contributors" ALTER COLUMN "user_id" DROP NOT NULL,
ADD COLUMN     "invited_email" TEXT;

-- Existing rows were resolved to an account at invite time: record the
-- address they were sent to. One row per (agent, address); a second
-- account whose email differs only by case keeps NULL.
UPDATE "agent_contributors" c
SET "invited_email" = e."email"
FROM (
  SELECT DISTINCT ON (c2."agent_id", LOWER(u."email")) c2."id", LOWER(u."email") AS "email"
  FROM "agent_contributors" c2
  JOIN "users" u ON u."id" = c2."user_id"
  WHERE u."email" IS NOT NULL
  ORDER BY c2."agent_id", LOWER(u."email"), c2."created_at" ASC
) e
WHERE c."id" = e."id";

-- CreateIndex
CREATE UNIQUE INDEX "agent_contributors_agent_id_invited_email_key" ON "agent_contributors"("agent_id", "invited_email");

-- ============================================
-- Contributor earnings
-- ============================================

-- AlterTable
ALTER TABLE "contributor_earnings" ALTER COLUMN "recipient_org_id" DROP NOT NULL,
ADD COLUMN     "accrued_at" TIMESTAMP(3);

-- Every earning recorded so far was accrued in the transaction that wrote it.
UPDATE "contributor_earnings" SET "accrued_at" = "created_at";

-- CreateIndex
CREATE INDEX "contributor_earnings_user_id_accrued_at_idx" ON "contributor_earnings"("user_id", "accrued_at");

-- Contributors who accepted before acceptance created a payout profile:
-- give the first organization each of them owns one, so their shares
-- accrue at settlement. The slug cannot collide ('org-' + the org id).
INSERT INTO "publisher_profiles" ("org_id", "display_name", "slug", "updated_at")
SELECT DISTINCT ON (o."owner_id") o."id", o."name", 'org-' || o."id", NOW()
FROM "agent_contributors" c
JOIN "organizations" o ON o."owner_id" = c."user_id"
WHERE c."accepted_at" IS NOT NULL
ORDER BY o."owner_id", o."created_at" ASC
ON CONFLICT DO NOTHING;
