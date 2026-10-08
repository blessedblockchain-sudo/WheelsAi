import { seg, type WheelsAIClient } from "../client.js";
import type { AgentKind, KindConfig } from "./agents.js";

export type ChangeType = "major" | "minor" | "patch";

/** Versions are addressed by their semantic version string, e.g. `1.0.1`. */
export interface AgentVersion {
  id: string;
  version: string;
  versionNumber: number;
  changeLog: string | null;
  changeType: ChangeType;
  tags: string[];
  /** The user who created the version; null when an API key did. */
  createdById: string | null;
  /** The API key that created the version; null when a user did. */
  createdByApiKeyId: string | null;
  createdByName: string | null;
  /**
   * How the agent answered at this version; a rollback restores it. null on versions taken
   * before it was recorded (a rollback to one leaves the agent's entrypoint as it is).
   */
  entrypoint: "chat" | "graph" | null;
  /**
   * How people used the agent at this version, and that kind's settings; a rollback restores
   * both. `agentKind` is null on versions taken before it was recorded: a rollback to one
   * makes the agent a `conversation` and leaves its settings as they are.
   */
  agentKind: AgentKind | null;
  kindConfig: KindConfig | null;
  isLatest: boolean;
  isPublished: boolean;
  createdAt: string;
  [field: string]: unknown;
}

export interface VersionDiff {
  id: string;
  agentId: string;
  fromVersion: string;
  toVersion: string;
  /** By field name, for example `systemPrompt`, `tools`, `agentKind` or `kindConfig`. */
  changes: Record<string, { from: unknown; to: unknown }>;
  addedFields: string[];
  removedFields: string[];
  modifiedFields: string[];
  linesAdded: number;
  linesRemoved: number;
  createdAt: string;
}

export function versioningResource(client: WheelsAIClient) {
  const base = (agentId: string) => `/api/versioning/agents/${seg(agentId)}`;

  return {
    list: (agentId: string, params?: { limit?: number; offset?: number }) =>
      client.get<{ versions: AgentVersion[]; total: number }>(`${base(agentId)}/versions`, params),

    latest: (agentId: string) =>
      client.get<AgentVersion>(`${base(agentId)}/versions/latest`),

    get: (agentId: string, version: string) =>
      client.get<AgentVersion>(`${base(agentId)}/versions/${seg(version)}`),

    /** Snapshots the agent's current configuration as a new version. */
    create: (agentId: string, input: { changeLog?: string; changeType?: ChangeType; tags?: string[] }) =>
      client.post<AgentVersion>(`${base(agentId)}/versions`, input),

    /** `GET /api/versioning/agents/{agentId}/compare?from=&to=`. */
    compare: (agentId: string, fromVersion: string, toVersion: string) =>
      client.get<VersionDiff>(`${base(agentId)}/compare`, { from: fromVersion, to: toVersion }),

    history: (agentId: string, params?: { limit?: number }) =>
      client.get<Array<Partial<AgentVersion> & { diff: unknown | null }>>(`${base(agentId)}/history`, params),

    /**
     * The new version that records the rollback. `schedulePaused` is `true` only when the rollback
     * turned the agent's own schedule off, because the restored kind is no longer `scheduled`.
     */
    rollback: (agentId: string, version: string) =>
      client.post<AgentVersion & { schedulePaused?: true }>(`${base(agentId)}/versions/${seg(version)}/rollback`),

    tag: (agentId: string, version: string, tags: string[]) =>
      client.post<AgentVersion>(`${base(agentId)}/versions/${seg(version)}/tag`, { tags }),

    publish: (agentId: string, version: string) =>
      client.post<AgentVersion>(`${base(agentId)}/versions/${seg(version)}/publish`),

    delete: (agentId: string, version: string) =>
      client.delete<void>(`${base(agentId)}/versions/${seg(version)}`),
  };
}
