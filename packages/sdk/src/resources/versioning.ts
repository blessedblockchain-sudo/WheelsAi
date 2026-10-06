import { seg, type WheelsAIClient } from "../client.js";

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

    rollback: (agentId: string, version: string) =>
      client.post<AgentVersion>(`${base(agentId)}/versions/${seg(version)}/rollback`),

    tag: (agentId: string, version: string, tags: string[]) =>
      client.post<AgentVersion>(`${base(agentId)}/versions/${seg(version)}/tag`, { tags }),

    publish: (agentId: string, version: string) =>
      client.post<AgentVersion>(`${base(agentId)}/versions/${seg(version)}/publish`),

    delete: (agentId: string, version: string) =>
      client.delete<void>(`${base(agentId)}/versions/${seg(version)}`),
  };
}
