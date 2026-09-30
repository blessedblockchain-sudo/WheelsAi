-- CreateTable
CREATE TABLE "contributor_earnings" (
    "id" UUID NOT NULL,
    "revenue_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "contributor_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "recipient_org_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "share_bps" INTEGER NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contributor_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contributor_earnings_recipient_org_id_created_at_idx" ON "contributor_earnings"("recipient_org_id", "created_at");

-- CreateIndex
CREATE INDEX "contributor_earnings_agent_id_idx" ON "contributor_earnings"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "contributor_earnings_revenue_id_user_id_key" ON "contributor_earnings"("revenue_id", "user_id");
