-- CreateTable
CREATE TABLE "scheduled_tasks" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "schedule_type" TEXT NOT NULL,
    "cron_expression" TEXT,
    "interval_seconds" INTEGER,
    "scheduled_at" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "task_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "timeout" INTEGER NOT NULL DEFAULT 300000,
    "max_retries" INTEGER NOT NULL DEFAULT 3,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_run_at" TIMESTAMP(3),
    "last_run_status" TEXT,
    "last_run_duration_ms" INTEGER,
    "last_error" TEXT,
    "next_run_at" TIMESTAMP(3),
    "total_runs" INTEGER NOT NULL DEFAULT 0,
    "successful_runs" INTEGER NOT NULL DEFAULT 0,
    "failed_runs" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_executions" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "logs" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "next_retry_at" TIMESTAMP(3),
    "triggered_by" TEXT NOT NULL DEFAULT 'scheduler',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_bases" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "embedding_model" TEXT NOT NULL DEFAULT 'text-embedding-ada-002',
    "chunk_size" INTEGER NOT NULL DEFAULT 512,
    "chunk_overlap" INTEGER NOT NULL DEFAULT 50,
    "status" TEXT NOT NULL DEFAULT 'active',
    "total_documents" INTEGER NOT NULL DEFAULT 0,
    "total_chunks" INTEGER NOT NULL DEFAULT 0,
    "total_size_bytes" BIGINT NOT NULL DEFAULT 0,
    "agent_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_bases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "knowledge_base_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" TEXT,
    "source_url" TEXT,
    "source_type" TEXT NOT NULL,
    "raw_content" TEXT,
    "size_bytes" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "processing_error" TEXT,
    "processed_at" TIMESTAMP(3),
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "embedding" BYTEA,
    "embedding_model" TEXT,
    "metadata" JSONB,
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestrations" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "execution_mode" TEXT NOT NULL,
    "max_concurrency" INTEGER NOT NULL DEFAULT 5,
    "timeout" INTEGER NOT NULL DEFAULT 600000,
    "retry_policy" JSONB,
    "input_schema" JSONB,
    "output_schema" JSONB,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "total_runs" INTEGER NOT NULL DEFAULT 0,
    "successful_runs" INTEGER NOT NULL DEFAULT 0,
    "failed_runs" INTEGER NOT NULL DEFAULT 0,
    "avg_duration_ms" INTEGER,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orchestrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestration_steps" (
    "id" UUID NOT NULL,
    "orchestration_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "agent_id" UUID NOT NULL,
    "input_mapping" JSONB,
    "output_mapping" JSONB,
    "condition" JSONB,
    "on_error" TEXT NOT NULL DEFAULT 'fail',
    "fallback_agent_id" UUID,
    "max_retries" INTEGER NOT NULL DEFAULT 0,
    "timeout_ms" INTEGER,
    "depends_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orchestration_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestration_executions" (
    "id" UUID NOT NULL,
    "orchestration_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "input" JSONB,
    "output" JSONB,
    "context" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "triggered_by" TEXT NOT NULL DEFAULT 'manual',
    "triggered_by_id" UUID,
    "error" TEXT,
    "failed_step_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orchestration_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orchestration_step_results" (
    "id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "step_id" UUID NOT NULL,
    "step_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "agent_id" UUID NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orchestration_step_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "long_description" TEXT,
    "category" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL DEFAULT 'beginner',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "framework" TEXT NOT NULL,
    "system_prompt" TEXT,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "model_config" JSONB NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT 'inline',
    "source_code" TEXT,
    "source_url" TEXT,
    "env" JSONB NOT NULL DEFAULT '{}',
    "graph_nodes" JSONB,
    "graph_edges" JSONB,
    "icon_url" TEXT,
    "screenshots" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "readme" TEXT,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "avg_rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "author_name" TEXT NOT NULL,
    "author_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_auth" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "secret" BYTEA NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'SHA1',
    "digits" INTEGER NOT NULL DEFAULT 6,
    "period" INTEGER NOT NULL DEFAULT 30,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "backup_codes" BYTEA,
    "backup_codes_used" INTEGER NOT NULL DEFAULT 0,
    "backup_codes_total" INTEGER NOT NULL DEFAULT 10,
    "recovery_email" TEXT,
    "last_used_at" TIMESTAMP(3),
    "last_method" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "two_factor_auth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "is_used" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_tasks_org_id_is_enabled_idx" ON "scheduled_tasks"("org_id", "is_enabled");

-- CreateIndex
CREATE INDEX "scheduled_tasks_next_run_at_is_enabled_idx" ON "scheduled_tasks"("next_run_at", "is_enabled");

-- CreateIndex
CREATE INDEX "scheduled_tasks_status_idx" ON "scheduled_tasks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_tasks_org_id_name_key" ON "scheduled_tasks"("org_id", "name");

-- CreateIndex
CREATE INDEX "task_executions_task_id_status_idx" ON "task_executions"("task_id", "status");

-- CreateIndex
CREATE INDEX "task_executions_task_id_created_at_idx" ON "task_executions"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "knowledge_bases_org_id_idx" ON "knowledge_bases"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_bases_org_id_name_key" ON "knowledge_bases"("org_id", "name");

-- CreateIndex
CREATE INDEX "knowledge_documents_knowledge_base_id_status_idx" ON "knowledge_documents"("knowledge_base_id", "status");

-- CreateIndex
CREATE INDEX "document_chunks_document_id_chunk_index_idx" ON "document_chunks"("document_id", "chunk_index");

-- CreateIndex
CREATE INDEX "orchestrations_org_id_idx" ON "orchestrations"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "orchestrations_org_id_name_key" ON "orchestrations"("org_id", "name");

-- CreateIndex
CREATE INDEX "orchestration_steps_orchestration_id_idx" ON "orchestration_steps"("orchestration_id");

-- CreateIndex
CREATE UNIQUE INDEX "orchestration_steps_orchestration_id_name_key" ON "orchestration_steps"("orchestration_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "orchestration_steps_orchestration_id_step_order_key" ON "orchestration_steps"("orchestration_id", "step_order");

-- CreateIndex
CREATE INDEX "orchestration_executions_orchestration_id_status_idx" ON "orchestration_executions"("orchestration_id", "status");

-- CreateIndex
CREATE INDEX "orchestration_executions_orchestration_id_created_at_idx" ON "orchestration_executions"("orchestration_id", "created_at");

-- CreateIndex
CREATE INDEX "orchestration_step_results_execution_id_step_id_idx" ON "orchestration_step_results"("execution_id", "step_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_templates_name_key" ON "agent_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "agent_templates_slug_key" ON "agent_templates"("slug");

-- CreateIndex
CREATE INDEX "agent_templates_category_is_published_idx" ON "agent_templates"("category", "is_published");

-- CreateIndex
CREATE INDEX "agent_templates_framework_is_published_idx" ON "agent_templates"("framework", "is_published");

-- CreateIndex
CREATE INDEX "agent_templates_difficulty_is_published_idx" ON "agent_templates"("difficulty", "is_published");

-- CreateIndex
CREATE INDEX "agent_templates_is_featured_is_published_idx" ON "agent_templates"("is_featured", "is_published");

-- CreateIndex
CREATE INDEX "agent_templates_usage_count_idx" ON "agent_templates"("usage_count");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_auth_user_id_key" ON "two_factor_auth"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_challenges_token_key" ON "two_factor_challenges"("token");

-- CreateIndex
CREATE INDEX "two_factor_challenges_user_id_idx" ON "two_factor_challenges"("user_id");

-- CreateIndex
CREATE INDEX "two_factor_challenges_expires_at_idx" ON "two_factor_challenges"("expires_at");

-- AddForeignKey
ALTER TABLE "task_executions" ADD CONSTRAINT "task_executions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_knowledge_base_id_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_steps" ADD CONSTRAINT "orchestration_steps_orchestration_id_fkey" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_executions" ADD CONSTRAINT "orchestration_executions_orchestration_id_fkey" FOREIGN KEY ("orchestration_id") REFERENCES "orchestrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orchestration_step_results" ADD CONSTRAINT "orchestration_step_results_execution_id_fkey" FOREIGN KEY ("execution_id") REFERENCES "orchestration_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_auth" ADD CONSTRAINT "two_factor_auth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
