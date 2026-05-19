/**
 * agent-message queue (plan A6).
 *
 * Typed wrapper around a BullMQ queue that the webhook route uses to hand
 * off an inbound channel message to the agent worker. The worker itself
 * (POST to {nodeUrl}/message → dispatch response back to platform) is a
 * separate module; this file is only the producer side + job shape.
 *
 * DI on the queue instance lets the unit tests avoid Redis.
 */

import type { Queue } from "bullmq";
import type { InboundMessage, SupportedPlatform } from "../services/channelNormalize.js";

export const AGENT_MESSAGE_QUEUE_NAME = "agent-message";
export const AGENT_MESSAGE_JOB_NAME = "agent-message";

export interface AgentMessageJobPayload {
  deploymentId: string;
  platform: SupportedPlatform;
  message: InboundMessage;
}

export interface EnqueueDeps {
  queue?: Pick<Queue, "add">;
}

let defaultQueue: Queue | null = null;

// Internal: resolved lazily so tests importing this file don't touch Redis.
async function resolveQueue(): Promise<Pick<Queue, "add">> {
  if (defaultQueue) return defaultQueue;
  const { Queue } = await import("bullmq");
  const { getQueueConnectionOpts } = await import("./connection.js");
  const { connection } = getQueueConnectionOpts();
  defaultQueue = new Queue(AGENT_MESSAGE_QUEUE_NAME, { connection });
  return defaultQueue;
}

export function buildJobId(
  deploymentId: string,
  platform: SupportedPlatform,
  messageId: string,
): string {
  return `${deploymentId}:${platform}:${messageId}`;
}

function validatePayload(p: AgentMessageJobPayload): void {
  if (!p.deploymentId) throw new Error("agent-message: deploymentId is required");
  if (!p.platform) throw new Error("agent-message: platform is required");
  if (!p.message || !p.message.messageId) {
    throw new Error("agent-message: message with a messageId is required");
  }
}

export async function enqueueAgentMessage(
  payload: AgentMessageJobPayload,
  deps: EnqueueDeps = {},
): Promise<{ id: string | undefined }> {
  validatePayload(payload);
  const queue = deps.queue ?? (await resolveQueue());

  const jobId = buildJobId(
    payload.deploymentId,
    payload.platform,
    payload.message.messageId,
  );

  const job = await queue.add(AGENT_MESSAGE_JOB_NAME, payload, {
    jobId, // dedup: duplicate webhook delivery → single queue job
    attempts: 5,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  });

  return { id: job.id };
}
