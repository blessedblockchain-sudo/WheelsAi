-- AlterTable
ALTER TABLE "deployments" ADD COLUMN     "run_generation" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "nosana_orphan_deployments" (
    "id" UUID NOT NULL,
    "nosana_deployment_id" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" TEXT,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reclaimed_at" TIMESTAMP(3),

    CONSTRAINT "nosana_orphan_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "nosana_orphan_deployments_nosana_deployment_id_key" ON "nosana_orphan_deployments"("nosana_deployment_id");

-- CreateIndex
CREATE INDEX "nosana_orphan_deployments_reclaimed_at_created_at_idx" ON "nosana_orphan_deployments"("reclaimed_at", "created_at");
