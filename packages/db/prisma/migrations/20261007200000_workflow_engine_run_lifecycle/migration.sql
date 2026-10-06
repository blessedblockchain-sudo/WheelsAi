-- Workflows: step types, prompt templates, loops, queued runs and
-- scheduled workflows.
--
-- Every change relaxes a NOT NULL, adds a nullable or defaulted column, or
-- adds an index, so existing rows need no backfill: existing steps become
-- stepType 'agent' with outputFormat 'text', which is what they were.

-- Workflow definition ---------------------------------------------------

ALTER TABLE "orchestrations" ADD COLUMN "layout" JSONB;

ALTER TABLE "orchestration_steps"
  ADD COLUMN "step_type" TEXT NOT NULL DEFAULT 'agent',
  ADD COLUMN "deployment_id" UUID,
  ADD COLUMN "model_id" TEXT,
  ADD COLUMN "knowledge_base_id" UUID,
  ADD COLUMN "prompt_template" TEXT,
  ADD COLUMN "output_format" TEXT NOT NULL DEFAULT 'text',
  ADD COLUMN "loop" JSONB;
ALTER TABLE "orchestration_steps" ALTER COLUMN "agent_id" DROP NOT NULL;

-- Runs --------------------------------------------------------------------

ALTER TABLE "orchestration_executions"
  ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
  ADD COLUMN "scheduled_task_id" UUID,
  ADD COLUMN "task_execution_id" UUID,
  ADD COLUMN "job_id" UUID;
CREATE UNIQUE INDEX "orchestration_executions_task_execution_id_key"
  ON "orchestration_executions"("task_execution_id");
-- The reaper and the per-organization run cap both read by status.
CREATE INDEX "orchestration_executions_status_created_at_idx"
  ON "orchestration_executions"("status", "created_at");

ALTER TABLE "orchestration_step_results"
  ADD COLUMN "step_type" TEXT NOT NULL DEFAULT 'agent',
  ADD COLUMN "resource_id" UUID,
  ADD COLUMN "iteration" INTEGER;
ALTER TABLE "orchestration_step_results" ALTER COLUMN "agent_id" DROP NOT NULL;

-- Scheduler ---------------------------------------------------------------

ALTER TABLE "scheduled_tasks" ALTER COLUMN "agent_id" DROP NOT NULL;
ALTER TABLE "scheduled_tasks" ADD COLUMN "orchestration_id" UUID;
CREATE INDEX "scheduled_tasks_orchestration_id_idx"
  ON "scheduled_tasks"("orchestration_id");
ALTER TABLE "scheduled_tasks"
  ADD CONSTRAINT "scheduled_tasks_orchestration_id_fkey"
  FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_executions" ADD COLUMN "orchestration_execution_id" UUID;
CREATE UNIQUE INDEX "task_executions_orchestration_execution_id_key"
  ON "task_executions"("orchestration_execution_id");
CREATE INDEX "task_executions_status_started_at_idx"
  ON "task_executions"("status", "started_at");
