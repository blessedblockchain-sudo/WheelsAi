-- A schedule that belongs to its agent, and a record of where each result
-- was sent.
--
--   task_executions.delivery   where the result of a finished agent run was
--                              sent and how that went: a list of
--                              { channelId, name, type,
--                                status: sent | failed | skipped,
--                                reason?, at }.
--                              NULL on every existing row, and on every run
--                              that was not asked to send its result. It is
--                              written after the run is closed and never
--                              changes the run's status.
--   scheduled_tasks.agent_id   gains a foreign key to agents, ON DELETE
--                              CASCADE, and an index. Until now it was a
--                              bare column: deleting an agent left its
--                              tasks in place, enabled and still firing
--                              (and failing) at every scheduled time.
--
-- EXISTING ROWS. A task whose agent_id names an agent that no longer exists
-- cannot keep that id once the foreign key is there, and must not be
-- deleted: its executions are its owner's history. So, before the key is
-- added, each such task is DETACHED (agent_id NULL) and PAUSED (is_enabled
-- false), and nothing else about it is lost: the task, its payload, its
-- schedule and every execution stay. It says why in last_error, which the
-- Scheduler shows. Its owner can give it another agent and turn it on
-- again, or delete it.
--
-- Only tasks that pointed at a missing agent are touched. A task with a
-- live agent, and a task that never had one (a webhook, a workflow run),
-- keeps every value it has. Running the UPDATE again changes nothing: after
-- it, no task points at a missing agent. After a clean run this counts none:
--   SELECT count(*) FROM scheduled_tasks t
--   WHERE t.agent_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = t.agent_id);

-- AlterTable
ALTER TABLE "task_executions" ADD COLUMN "delivery" JSONB;

-- Detach and pause the tasks whose agent is gone; their history is kept.
-- 'paused' is what the API writes when a task is switched off; a task that
-- had already ended ('completed', 'failed', 'disabled') keeps that status.
UPDATE "scheduled_tasks" t
SET
  "agent_id" = NULL,
  "is_enabled" = false,
  "status" = CASE WHEN t."status" = 'active' THEN 'paused' ELSE t."status" END,
  "last_error" = 'this task''s agent was deleted, so the task was paused; choose another agent to run it again',
  "updated_at" = CURRENT_TIMESTAMP
WHERE t."agent_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "agents" a WHERE a."id" = t."agent_id");

-- CreateIndex
CREATE INDEX "scheduled_tasks_agent_id_idx" ON "scheduled_tasks"("agent_id");

-- AddForeignKey
-- CASCADE: a task goes with its agent, and its executions go with the task
-- (task_executions_task_id_fkey), so a deleted agent leaves nothing firing.
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
