-- A listing can sell a workflow instead of an agent: the same listing, with
-- the same licences, plans and receipts, and a workflow behind it.
--
--   agent_listings.orchestration_id        the workflow a listing sells. NULL
--                                          on every listing that sells an
--                                          agent, which is every listing from
--                                          before workflows could be sold.
--   agent_listings.agent_id                no longer required: NULL on a
--                                          listing that sells a workflow.
--
--   Exactly one of the two is set on every row
--   (agent_listings_agent_or_workflow_check). A workflow has at most one
--   listing (agent_listings_orchestration_id_key), and a workflow that is on
--   a listing cannot be deleted from under it: the foreign key restricts.
--   A workflow's listing sells use, never copies
--   (agent_listings_workflow_sells_use_check).
--
-- EXISTING ROWS. Every existing listing has agent_id set and gets
-- orchestration_id NULL from the new column: no row is rewritten by a
-- statement of its own, and nothing about a listing that sells an agent
-- changes.
-- After a clean run these both count none:
--   SELECT count(*) FROM agent_listings WHERE orchestration_id IS NOT NULL;
--   SELECT count(*) FROM agent_listings WHERE agent_id IS NULL;

-- AlterTable
ALTER TABLE "agent_listings" ADD COLUMN "orchestration_id" UUID,
ALTER COLUMN "agent_id" DROP NOT NULL;

ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_agent_or_workflow_check" CHECK (num_nonnulls("agent_id", "orchestration_id") = 1);
ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_workflow_sells_use_check" CHECK ("orchestration_id" IS NULL OR "sells" = 'use');

-- CreateIndex
CREATE UNIQUE INDEX "agent_listings_orchestration_id_key" ON "agent_listings"("orchestration_id");

-- AddForeignKey
ALTER TABLE "agent_listings" ADD CONSTRAINT "agent_listings_orchestration_id_fkey" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
