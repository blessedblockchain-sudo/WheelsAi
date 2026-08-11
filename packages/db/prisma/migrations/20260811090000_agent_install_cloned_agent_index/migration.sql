-- Marketplace per-request metering resolves "is this agent a billable
-- install?" on every inference request, keyed by the cloned agent.
CREATE INDEX IF NOT EXISTS "agent_installs_cloned_agent_id_status_idx"
  ON "agent_installs" ("cloned_agent_id", "status");
