-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "branding" JSONB DEFAULT '{}';

-- CreateTable
CREATE TABLE "agent_contributors" (
    "id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'contributor',
    "revenue_share" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "added_by" UUID,
    "accepted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_contributors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_contributors_agent_id_idx" ON "agent_contributors"("agent_id");

-- CreateIndex
CREATE INDEX "agent_contributors_user_id_idx" ON "agent_contributors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_contributors_agent_id_user_id_key" ON "agent_contributors"("agent_id", "user_id");

-- AddForeignKey
ALTER TABLE "agent_contributors" ADD CONSTRAINT "agent_contributors_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_contributors" ADD CONSTRAINT "agent_contributors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
