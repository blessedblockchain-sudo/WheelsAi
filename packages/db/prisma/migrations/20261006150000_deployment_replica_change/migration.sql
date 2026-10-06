-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "pending_replicas" INTEGER,
ADD COLUMN     "replica_change_id" TEXT,
ADD COLUMN     "replica_change_at" TIMESTAMP(3),
ADD COLUMN     "replica_change_hold_cents" BIGINT,
ADD COLUMN     "gpu_stopped_at" TIMESTAMP(3),
ADD COLUMN     "runway_checked_at" TIMESTAMP(3);
