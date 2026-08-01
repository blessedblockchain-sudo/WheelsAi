/**
 * agent-message queue (plan A6).
 *
 * Producer + consumer lifecycle for the queue the webhook route uses to
 * hand an inbound channel message to the agent worker. The worker TICK
 * (POST to {nodeUrl}/message → dispatch response back to platform) stays
 * in agent-message.worker.ts as a pure function; this file owns the job
 * shape, the enqueue producer, and — since Wave 0 — the production
 * start/stop pair index.ts registers alongside the other queues. Before
 * that, the consumer was never started anywhere: webhook messages would
 * have queued forever.
 *
 * DI on the queue instance lets the unit tests avoid Redis.
 */

import type { Queue, Worker } from "bullmq";
import type { InboundMessage, SupportedPlatform } from "../services/channelNormalize.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("agent-message-queue");

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

// ============================================
// Consumer lifecycle (production wiring)
// ============================================

const AGENT_CALL_TIMEOUT_MS = 30_000;

/**
 * Production callAgent: POST the inbound message to the running OpenClaw
 * node's /message endpoint and parse the agent's reply. Throws on non-2xx
 * or malformed replies — handleAgentMessage converts that into a
 * BullMQ-retryable failure.
 */
async function callAgentOverHttp(
  nodeUrl: string,
  payload: AgentMessageJobPayload,
): Promise<{ text: string; threadTs?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(`${nodeUrl.replace(/\/$/, "")}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: payload.platform,
        message: payload.message,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`agent node responded ${res.status}`);
    }
    const body = (await res.json()) as { text?: unknown; threadTs?: unknown };
    return {
      text: typeof body.text === "string" ? body.text : "",
      threadTs: typeof body.threadTs === "string" ? body.threadTs : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

let consumer: Worker | null = null;

/**
 * Starts the agent-message consumer. Event-driven (no repeatable tick):
 * jobs arrive from the webhook route's enqueue. Started unconditionally —
 * Redis readiness is already asserted at boot before any queue starts.
 */
export async function startAgentMessageQueue(): Promise<void> {
  const [{ Worker }, { getQueueConnectionOpts }] = await Promise.all([
    import("bullmq"),
    import("./connection.js"),
  ]);
  const { handleAgentMessage } = await import("./agent-message.worker.js");
  const { resolveOutboundCredentials } = await import(
    "../services/channelConfig.js"
  );
  const { decryptConfig } = await import("../services/openclaw.js");
  const { prisma } = await import("@wheelsai/db");

  const { connection } = getQueueConnectionOpts();

  consumer = new Worker(
    AGENT_MESSAGE_QUEUE_NAME,
    async (job) => {
      const result = await handleAgentMessage(
        job.data as AgentMessageJobPayload,
        {
          callAgent: callAgentOverHttp,
          resolveOutboundCredentials: (deploymentId, platform) =>
            resolveOutboundCredentials(deploymentId, platform, {
              prisma: prisma as never,
              decryptConfig,
            }),
          fetchFn: fetch,
        },
      );
      logger.info({ jobId: job.id, result }, "Agent message handled");
    },
    { connection, concurrency: 5 },
  );

  consumer.on("failed", (job, error) => {
    logger.error({ jobId: job?.id, error }, "Agent message job failed");
  });
  consumer.on("error", (error) => {
    logger.error({ error }, "Agent message worker error");
  });

  logger.info({ queue: AGENT_MESSAGE_QUEUE_NAME }, "Agent message consumer started");
}

export async function stopAgentMessageQueue(): Promise<void> {
  if (consumer) {
    await consumer.close();
    consumer = null;
  }
  if (defaultQueue) {
    await defaultQueue.close();
    defaultQueue = null;
  }
  logger.info("Agent message queue stopped");
}
