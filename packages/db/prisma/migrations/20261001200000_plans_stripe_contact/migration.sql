-- Platform plans (Starter/Pro/Enterprise), Stripe webhook idempotency,
-- refund tracking on credit purchases, contact-sales requests, and the
-- marketplace priority-placement flag for paid plans.

-- AlterTable
ALTER TABLE "agent_listings" ADD COLUMN "priority_placement" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "stripe_purchases" ADD COLUMN "stripe_payment_intent_id" TEXT,
ADD COLUMN "refunded_cents" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "org_subscriptions" (
    "org_id" UUID NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'starter',
    "status" TEXT NOT NULL DEFAULT 'none',
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "current_period_end" TIMESTAMP(3),
    "trial_ends_at" TIMESTAMP(3),
    "trial_used_at" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "last_stripe_event_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_subscriptions_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_requests" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "topic" TEXT NOT NULL DEFAULT 'enterprise',
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stripe_purchases_stripe_payment_intent_id_key" ON "stripe_purchases"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_subscriptions_stripe_customer_id_key" ON "org_subscriptions"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_subscriptions_stripe_subscription_id_key" ON "org_subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "contact_requests_created_at_idx" ON "contact_requests"("created_at");

-- AddForeignKey
ALTER TABLE "org_subscriptions" ADD CONSTRAINT "org_subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
