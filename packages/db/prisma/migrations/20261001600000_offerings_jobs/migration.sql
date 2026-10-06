-- AlterTable
ALTER TABLE "marketplace_revenue" ADD COLUMN     "job_id" UUID,
ALTER COLUMN "listing_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "offerings" (
    "id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "product_kind" TEXT NOT NULL,
    "agent_id" UUID,
    "orchestration_id" UUID,
    "deployment_id" UUID,
    "listing_id" UUID,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price_cents" BIGINT NOT NULL,
    "sla_seconds" INTEGER NOT NULL,
    "input_schema" JSONB,
    "sample_inputs" JSONB NOT NULL DEFAULT '[]',
    "instructions" TEXT,
    "deliverable_checks" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offerings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "offering_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "publisher_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "check_results" JSONB,
    "price_cents" BIGINT NOT NULL,
    "failure_reason" TEXT,
    "rejection_reason" TEXT,
    "deadline_at" TIMESTAMP(3),
    "review_deadline_at" TIMESTAMP(3),
    "funded_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "submitted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "rating" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offerings_slug_key" ON "offerings"("slug");

-- CreateIndex
CREATE INDEX "offerings_publisher_id_idx" ON "offerings"("publisher_id");

-- CreateIndex
CREATE INDEX "offerings_status_product_kind_idx" ON "offerings"("status", "product_kind");

-- CreateIndex
CREATE INDEX "jobs_buyer_id_created_at_idx" ON "jobs"("buyer_id", "created_at");

-- CreateIndex
CREATE INDEX "jobs_publisher_id_created_at_idx" ON "jobs"("publisher_id", "created_at");

-- CreateIndex
CREATE INDEX "jobs_status_deadline_at_idx" ON "jobs"("status", "deadline_at");

-- CreateIndex
CREATE INDEX "jobs_status_review_deadline_at_idx" ON "jobs"("status", "review_deadline_at");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_revenue_job_id_key" ON "marketplace_revenue"("job_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_offering_id_fkey" FOREIGN KEY ("offering_id") REFERENCES "offerings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

