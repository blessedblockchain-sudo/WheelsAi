-- AlterTable
ALTER TABLE "agent_deployments" ADD COLUMN     "reservation_cents" BIGINT,
ADD COLUMN     "reservation_released_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "reservation_cents" BIGINT,
ADD COLUMN     "reservation_released_at" TIMESTAMP(3);
