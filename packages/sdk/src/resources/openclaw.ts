import { seg, type WheelsAIClient } from "../client.js";

export interface OpenClawChannel {
  id: string;
  platform: string;
  enabled?: boolean;
  [field: string]: unknown;
}

/** A chat-channel deployment of an agent (Discord, Telegram, Slack). */
export interface OpenClawDeployment {
  id: string;
  agentId: string;
  agentName: string;
  slug: string;
  status: string;
  healthStatus: string | null;
  publicUrl: string | null;
  channelCount: number;
  channels: OpenClawChannel[];
  createdAt: string;
  updatedAt: string;
  [field: string]: unknown;
}

export function openclawResource(client: WheelsAIClient) {
  return {
    list: () =>
      client.get<{ deployments: OpenClawDeployment[] }>("/api/openclaw"),

    get: (id: string) =>
      client.get<{ deployment: OpenClawDeployment }>(`/api/openclaw/${seg(id)}`),
  };
}
