-- CreateTable
CREATE TABLE "free_tier_usage" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_tier_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "free_tier_usage_org_id_model_date_key" ON "free_tier_usage"("org_id", "model", "date");
