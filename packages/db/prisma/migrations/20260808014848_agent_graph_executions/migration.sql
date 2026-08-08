-- CreateTable
CREATE TABLE "agent_graph_executions" (
    "id" UUID NOT NULL,
    "graph_id" UUID NOT NULL,
    "agent_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "input" TEXT,
    "output" TEXT,
    "error" TEXT,
    "trace" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,

    CONSTRAINT "agent_graph_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_graph_executions_agent_id_started_at_idx" ON "agent_graph_executions"("agent_id", "started_at");

-- AddForeignKey
ALTER TABLE "agent_graph_executions" ADD CONSTRAINT "agent_graph_executions_graph_id_fkey" FOREIGN KEY ("graph_id") REFERENCES "agent_graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
