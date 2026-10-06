import type { WheelsAIClient } from "../client.js";

export type OverallStatus = "operational" | "degraded" | "major_outage";

/** `GET /api/status`: what the API measured about itself. Public. */
export interface PlatformStatus {
  status: OverallStatus;
  generatedAt: string;
  components: Array<{
    id: "database" | "redis";
    name: string;
    status: "operational" | "outage";
    latencyMs: number | null;
  }>;
  workers: {
    /** False when run history could not be read. */
    available: boolean;
    items: Array<{
      id: string;
      name: string;
      description: string;
      intervalSeconds: number;
      status: "operational" | "delayed" | "failing" | "no_data";
      lastCompletedAt: string | null;
      lastFailedAt: string | null;
    }>;
  };
  monitors: {
    /** False when the operator has no public monitors configured. */
    configured: boolean;
    available: boolean;
    historyDays: number;
    items: Array<{
      name: string;
      status: "operational" | "degraded" | "outage" | "no_data";
      lastCheckAt: string | null;
      uptimePercent: { "24h": number | null; "7d": number | null; "30d": number | null };
      avgLatencyMs: number | null;
      days: Array<{ date: string; checks: number; uptimePercent: number | null }>;
    }>;
  };
}

/** `GET /api/public/stats`: platform facts read from the constants the product runs on. Public. */
export interface PublicStats {
  frameworks: number;
  models: number;
  pricingModels: number;
  channels: number;
  channelPlatforms: string[];
  /** Null when the count could not be read. */
  publishedListings: number | null;
}

export interface Skill {
  key: string;
  version: string | number;
  name: string;
  description: string;
  inputSchema: unknown;
  moneyMoving: boolean;
  requires: string[];
  /** False when the server cannot run it right now; `unavailableReason` says why. */
  available: boolean;
  unavailableReason: string | null;
}

export function platformResource(client: WheelsAIClient) {
  return {
    /** Public. Always answers 200, even mid-outage; read `status`. */
    status: () =>
      client.get<PlatformStatus>("/api/status"),

    /** Public. */
    stats: () =>
      client.get<PublicStats>("/api/public/stats"),
  };
}

export function skillsResource(client: WheelsAIClient) {
  return {
    /**
     * The agent skills (tools) catalogue with availability. Pass `agentId` to fold in
     * agent-level facts (for example `knowledge_search` needs a bound knowledge base).
     */
    list: (params?: { agentId?: string }) =>
      client.get<{ skills: Skill[] }>("/api/skills", params),
  };
}
