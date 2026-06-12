-- AlterTable
ALTER TABLE "compute_payments" ADD COLUMN     "period_end" TIMESTAMP(3),
ADD COLUMN     "period_start" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "compute_payments_treasury_job_period_key" ON "compute_payments"("treasury_id", "nosana_job_id", "period_start");

