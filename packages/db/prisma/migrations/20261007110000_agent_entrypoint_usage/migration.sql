-- What answers when an agent is chatted with: 'chat' runs its prompt, model
-- and tools; 'graph' runs the graph saved in the builder. Existing agents
-- keep 'chat', so nothing changes behaviour until an owner switches.
ALTER TABLE "agents" ADD COLUMN "entrypoint" TEXT NOT NULL DEFAULT 'chat';

-- Hourly rollup of agent chat traffic (playground and /v1), written by the
-- shared agent-chat service. agent_id and org_id carry NO foreign key: agents
-- are hard-deleted, and usage history has to outlive the agent it describes.
CREATE TABLE "agent_usage_records" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "request_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "streamed_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "usage_unreported_count" INTEGER NOT NULL DEFAULT 0,
    "total_latency_ms" BIGINT NOT NULL DEFAULT 0,
    "tool_call_count" INTEGER NOT NULL DEFAULT 0,
    "latency_histogram" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_usage_records_agent_id_source_period_start_key" ON "agent_usage_records"("agent_id", "source", "period_start");

-- CreateIndex
CREATE INDEX "agent_usage_records_org_id_period_start_idx" ON "agent_usage_records"("org_id", "period_start");
