import type { AgentDeployment, WheelsAI } from "@wheelsai/sdk";

/** What the API reports about the chat channels attached to a deployed agent. */
export type ChannelReport =
  | { kind: "reported"; source: "deployment" | "openclaw"; channels: unknown[] }
  | { kind: "none-reported" };

/** One channel as text: a bare string, the `platform` of an object, else its JSON. */
export function channelLabel(channel: unknown): string {
  if (typeof channel === "string") return channel;
  if (channel && typeof channel === "object") {
    const { platform, enabled } = channel as { platform?: unknown; enabled?: unknown };
    if (typeof platform === "string") return enabled === false ? `${platform} (disabled)` : platform;
  }
  return JSON.stringify(channel);
}

/**
 * The channels the API reports for an agent's deployment. The agent-deployment
 * row carries none today; chat channels (Discord, Telegram, Slack) are attached to
 * the agent's OpenClaw deployment, which is looked up as a best effort and counted
 * only while it is RUNNING: a stopped one delivers nothing. When the API reports
 * nothing, the report says so: nothing is ever filled in.
 */
export async function findChannels(
  wheels: WheelsAI,
  agentId: string,
  deployment: AgentDeployment,
): Promise<ChannelReport> {
  if (Array.isArray(deployment.channels)) {
    return { kind: "reported", source: "deployment", channels: deployment.channels };
  }
  try {
    const { deployments } = await wheels.openclaw.list();
    const match = deployments.find(
      (candidate) => candidate.agentId === agentId && String(candidate.status).toUpperCase() === "RUNNING",
    );
    if (match && Array.isArray(match.channels) && match.channels.length > 0) {
      return { kind: "reported", source: "openclaw", channels: match.channels };
    }
  } catch {
    // Channel lookup is informational; a failure must not fail a finished deploy.
  }
  return { kind: "none-reported" };
}
