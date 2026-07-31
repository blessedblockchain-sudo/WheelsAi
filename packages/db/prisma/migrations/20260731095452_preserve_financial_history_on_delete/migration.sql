-- DropForeignKey
ALTER TABLE "credit_transactions" DROP CONSTRAINT "credit_transactions_org_id_fkey";

-- DropForeignKey
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_deployment_id_fkey";

-- DropForeignKey
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_org_id_fkey";

-- DropForeignKey
ALTER TABLE "x402_payments" DROP CONSTRAINT "x402_payments_org_id_fkey";

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
