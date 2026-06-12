-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ComputePaymentStatus" ADD VALUE 'SUBMITTING';
ALTER TYPE "ComputePaymentStatus" ADD VALUE 'PARKED';

-- AlterTable
ALTER TABLE "compute_payments" ADD COLUMN     "last_valid_block_height" BIGINT,
ADD COLUMN     "resolution_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "signed_tx_b64" TEXT;
