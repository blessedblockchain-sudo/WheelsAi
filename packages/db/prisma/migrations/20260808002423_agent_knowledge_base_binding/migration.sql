-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "knowledge_base_id" UUID;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
