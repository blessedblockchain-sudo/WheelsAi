-- Plans on a listing that sells use per request: a creator offers a count of
-- uses for 30 days at a price, and a buyer's subscription carries the count.
-- Pay per request stays the base price of the listing; a plan is prepaid use
-- on top of it.
--
--   listing_plans                          one row per plan a listing offers.
--     kind                                 'paid' or 'trial'.
--     name                                 what the creator calls it, 1 to 40
--                                          characters.
--     price_cents                          what 30 days cost: 0 for a trial,
--                                          at least 100 for a paid plan.
--     included_uses                        how many uses the 30 days include,
--                                          1 to 100,000. No plan is unlimited.
--     extra_use_price_cents                what each use past the included
--                                          ones costs, at least 5. NULL = the
--                                          plan stops until it renews. Always
--                                          NULL for a trial.
--     position                             0 = the trial, 1 to 4 = the paid
--                                          plans in the order they are shown.
--     status, retired_at                   'active' or 'retired'. A plan is
--                                          changed in place and never deleted.
--
--   agent_subscriptions gains the plan a row is on and a copy of the terms
--   the buyer agreed to:
--     plan_id                              the plan. NULL on every row that is
--                                          not on one.
--     included_uses                        THE MARKER. NULL = a month with no
--                                          count, which is every row from
--                                          before plans existed; such a row is
--                                          read and renewed as it always was.
--     used_in_period                       uses taken since
--                                          current_period_start.
--     carried_uses                         unused uses brought into this
--                                          period by a move to a bigger plan;
--                                          a renewal sets it back to 0.
--     extra_use_price_cents                the extra price agreed. NULL = the
--                                          plan stops.
--     warned_level                         the highest warning already given
--                                          this period: 0, 85 or 100.
--     trial_used_at                        when this buyer's free trial of the
--                                          listing started. It stays set, so a
--                                          trial is taken once.
--
-- EXISTING ROWS. No listing has a plan. Every existing subscription gets
-- plan_id NULL, included_uses NULL and zero counters from the column
-- defaults: no row is rewritten by a statement of its own, nothing is
-- charged, renewed, ended or re-priced, and no balance is touched.
-- After a clean run these both count none:
--   SELECT count(*) FROM listing_plans;
--   SELECT count(*) FROM agent_subscriptions WHERE included_uses IS NOT NULL OR plan_id IS NOT NULL;

-- CreateTable
CREATE TABLE "listing_plans" (
    "id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price_cents" BIGINT NOT NULL,
    "included_uses" INTEGER NOT NULL,
    "extra_use_price_cents" BIGINT,
    "position" SMALLINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_plans_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "listing_plans" ADD CONSTRAINT "listing_plans_kind_check" CHECK ("kind" IN ('paid', 'trial'));

ALTER TABLE "listing_plans" ADD CONSTRAINT "listing_plans_status_check" CHECK ("status" IN ('active', 'retired'));

ALTER TABLE "listing_plans" ADD CONSTRAINT "listing_plans_name_check" CHECK (char_length("name") BETWEEN 1 AND 40);

ALTER TABLE "listing_plans" ADD CONSTRAINT "listing_plans_price_check" CHECK (("kind" = 'trial' AND "price_cents" = 0) OR ("kind" = 'paid' AND "price_cents" >= 100));

ALTER TABLE "listing_plans" ADD CONSTRAINT "listing_plans_included_uses_check" CHECK ("included_uses" BETWEEN 1 AND 100000);

ALTER TABLE "listing_plans" ADD CONSTRAINT "listing_plans_extra_use_price_check" CHECK ("extra_use_price_cents" IS NULL OR ("kind" = 'paid' AND "extra_use_price_cents" >= 5));

ALTER TABLE "listing_plans" ADD CONSTRAINT "listing_plans_position_check" CHECK (("kind" = 'trial' AND "position" = 0) OR ("kind" = 'paid' AND "position" BETWEEN 1 AND 4));

-- CreateIndex
CREATE INDEX "listing_plans_listing_id_status_idx" ON "listing_plans"("listing_id", "status");

-- One active plan per place on a listing: at most four paid plans and one
-- trial, also when two saves arrive at once. A partial index, so it is
-- written here and has no counterpart in schema.prisma.
CREATE UNIQUE INDEX "listing_plans_listing_id_position_active_key" ON "listing_plans"("listing_id", "position") WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "listing_plans" ADD CONSTRAINT "listing_plans_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "agent_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "agent_subscriptions"
  ADD COLUMN "plan_id" UUID,
  ADD COLUMN "included_uses" INTEGER,
  ADD COLUMN "used_in_period" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "carried_uses" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "extra_use_price_cents" BIGINT,
  ADD COLUMN "warned_level" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "trial_used_at" TIMESTAMP(3);

ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_included_uses_check" CHECK ("included_uses" IS NULL OR "included_uses" BETWEEN 1 AND 100000);

ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_used_in_period_check" CHECK ("used_in_period" >= 0);

ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_carried_uses_check" CHECK ("carried_uses" >= 0);

ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_extra_use_price_check" CHECK ("extra_use_price_cents" IS NULL OR "extra_use_price_cents" >= 5);

ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_warned_level_check" CHECK ("warned_level" IN (0, 85, 100));

-- CreateIndex
CREATE INDEX "agent_subscriptions_plan_id_idx" ON "agent_subscriptions"("plan_id");

-- AddForeignKey
ALTER TABLE "agent_subscriptions" ADD CONSTRAINT "agent_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "listing_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
