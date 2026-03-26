import type { AgentDetail } from "@/lib/api";

export interface AgentTabProps {
  agent: AgentDetail;
  agentId: string;
  loadAgent: () => Promise<void>;
}
