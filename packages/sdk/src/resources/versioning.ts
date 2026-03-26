import type { WheelsAIClient } from "../client.js";

export interface AgentVersion {
  id: string;
  version: string;
  versionNumber: number;
  changeLog: string;
  changeType: "major" | "minor" | "patch";
  tags: string[];
  isLatest: boolean;
  isPublished: boolean;
  createdAt: string;
}

export interface VersionDiff {
  id: string;
  fromVersion: string;
  toVersion: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  addedFields: string[];
  removedFields: string[];
  modifiedFields: string[];
  linesAdded: number;
  linesRemoved: number;
}

export function versioningResource(client: WheelsAIClient) {
  return {
    list: (agentId: string) =>
      client.get<{ versions: AgentVersion[] }>(`/api/versioning/agents/${agentId}/versions`),

    get: (agentId: string, versionId: string) =>
      client.get<{ version: AgentVersion }>(`/api/versioning/agents/${agentId}/versions/${versionId}`),

    create: (agentId: string, input: { changeLog: string; changeType: "major" | "minor" | "patch"; tags?: string[] }) =>
      client.post<{ version: AgentVersion }>(`/api/versioning/agents/${agentId}/versions`, input),

    compare: (agentId: string, fromVersion: string, toVersion: string) =>
      client.get<{ diff: VersionDiff }>(`/api/versioning/agents/${agentId}/versions/compare`, {
        from: fromVersion,
        to: toVersion,
      }),

    rollback: (agentId: string, versionId: string) =>
      client.post<{ agent: unknown; message: string }>(`/api/versioning/agents/${agentId}/versions/${versionId}/rollback`),

    publish: (agentId: string, versionId: string) =>
      client.post<{ version: AgentVersion }>(`/api/versioning/agents/${agentId}/versions/${versionId}/publish`),
  };
}
