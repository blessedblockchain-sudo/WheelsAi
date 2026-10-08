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
    /** False when no public uptime monitors are listed. */
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
  /** The measured response time, with the histogram and error share behind it. */
  latency: PublicLatencyDetail;
}

/**
 * The measured response time of chat answers. A latency is present only when
 * `status` is `"measured"`; there is no fallback value.
 */
export interface PublicLatency {
  /**
   * `measured`: enough answered requests from enough organizations in the window.
   * `insufficient_data`: readable, but below a publication threshold; no latency is stated.
   * `unavailable`: the measurements could not be read.
   */
  status: "measured" | "insufficient_data" | "unavailable";
  metric: "response_time";
  /** What is measured, in words. */
  definition: string;
  /** The request surfaces that count. */
  surfaces: string[];
  windowHours: number;
  /**
   * Answered requests in the window that count: at most `maxSamplesPerOrg`
   * (the most recent) from any one organization. Null only when unavailable.
   */
  sampleCount: number | null;
  minSampleCount: number;
  minOrgCount: number;
  /** How many of one organization's most recent answers count toward the figure. */
  maxSamplesPerOrg: number;
  /** Milliseconds; non-null only when measured. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** From streamed answers; null without enough of them. */
  firstTokenP50Ms: number | null;
  firstTokenSampleCount: number | null;
  /** When the measurements were read. */
  computedAt: string | null;
}

export interface PublicLatencyDetail extends PublicLatency {
  /** Answered requests per bucket (`upToMs` null = slower than the last edge); null unless measured. */
  histogram: Array<{ upToMs: number | null; count: number }> | null;
  /** Share of recorded requests that ended in an error or a timeout; null unless measured. */
  errorSharePercent: number | null;
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
  /** The measured response time of chat answers. */
  latency: PublicLatency;
}

/** `GET /api/capabilities`: what works on this server right now. */
export interface Capabilities {
  chat: {
    /** The models an agent can answer on now, in the order the platform tries them. */
    models: Array<{ id: string; label: string }>;
    /** The model an agent with none of its own answers on; null when there is none. */
    defaultModel: string | null;
  };
  /** Earnings can be paid out. */
  payouts: { available: boolean };
  /** Results can be sent by email. */
  emailDelivery: { available: boolean };
  /** An agent can be put on a dedicated GPU. */
  agentGpu: { available: boolean };
  /** A paid task can be run. */
  paidTasks: { available: boolean };
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

    /** Needs an API key or a session. Check it before offering something the server may not do now. */
    capabilities: () =>
      client.get<Capabilities>("/api/capabilities"),
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
