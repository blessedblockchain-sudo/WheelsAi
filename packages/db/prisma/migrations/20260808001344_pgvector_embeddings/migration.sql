/*
  Warnings:

  - You are about to drop the column `embedding` on the `document_chunks` table. All the data in the column will be lost.
  - You are about to drop the column `embedding` on the `memory_contexts` table. All the data in the column will be lost.

*/
-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- AlterTable
ALTER TABLE "document_chunks" DROP COLUMN "embedding",
ADD COLUMN     "embedded_at" TIMESTAMP(3),
ADD COLUMN     "embedding_dims" INTEGER,
ADD COLUMN     "embedding_vec" vector;

-- AlterTable
ALTER TABLE "memory_contexts" DROP COLUMN "embedding",
ADD COLUMN     "embedded_at" TIMESTAMP(3),
ADD COLUMN     "embedding_dims" INTEGER,
ADD COLUMN     "embedding_model" TEXT,
ADD COLUMN     "embedding_vec" vector;
