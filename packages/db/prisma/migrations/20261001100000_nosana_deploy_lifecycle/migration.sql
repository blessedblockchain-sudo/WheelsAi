-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "billed_through_at" TIMESTAMP(3),
ADD COLUMN     "status_reason" TEXT,
ADD COLUMN     "vault_reclaimed_at" TIMESTAMP(3);
