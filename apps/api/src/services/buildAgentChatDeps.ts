/**
 * Composition root for agent chat (services/agentChat.ts): binds the pure
 * core to Prisma, Redis, the free-model catalog, retrieval, marketplace
 * metering, the skills registry and the chat runtime.
 *
 * Both entry points - the playground route and the /v1 agent routes - build
 * their deps here, so they cannot drift on who is charged or which tools run.
 */

import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { getAvailableFreeModels, isFreeModel } from "../config/free-models.js";
import { prisma } from "../lib/prisma.js";
import { checkFreeTierLimit } from "../middleware/free-tier-limit.js";
import { createLogger } from "../utils/logger.js";
import type { AgentChatDeps, AgentChatUsageRecord, AgentGraphOutcome } from "./agentChat.js";
import { retrieveContextForAgent } from "./agentRetrieval.js";
import { openAgentEnv } from "./agentSecrets.js";
import { recordAgentUsage } from "./agentUsage.js";
import { buildAgentRetrievalDeps } from "./buildAgentRetrievalDeps.js";
import { resolveHostedModel } from "./hostedModel.js";
import { createInFlightRuns, ServerShuttingDownError } from "./inFlightRuns.js";
import {
  MarketplaceLicenceRevokedError,
  MarketplacePaymentRequiredError,
} from "./marketplaceMetering.js";
import { beginMarketplaceMetering } from "./marketplaceMeteringProduction.js";
import {
  answerToStream,
  resolveModelForPlayground,
  runChat,
  runChatStream,
} from "./mastra-runtime.js";
import { runAgentGraph } from "./runAgentGraph.js";
import { getDefaultRegistry } from "./skills/production.js";
import { resolveToolMode } from "./skills/runMode.js";
import {
  createRedisToolContinuationStore,
  type ToolContinuationStore,
} from "./toolContinuationStore.js";

const logger = createLogger("agent-chat");

const AGENT_COLUMNS = {
  id: true,
  orgId: true,
  slug: true,
  name: true,
  version: true,
  systemPrompt: true,
  tools: true,
  modelConfig: true,
  env: true,
  knowledgeBaseId: true,
  entrypoint: true,
} as const;

/** Every charged agent chat in this process, so shutdown can end them. */
const inFlightChats = createInFlightRuns();

/**
 * Called on SIGTERM, before the server stops accepting work. Cancels every
 * in-flight agent chat and waits for each to refund its marketplace charge,
 * instead of the process being killed with the charge stranded `pending`.
 * Chats that arrive afterwards are refused, uncharged.
 */
export function cancelInFlightAgentChats(timeoutMs: number) {
  return inFlightChats.cancelAll(timeoutMs);
}

/**
 * Runs the agent's saved graph and reports how it ended as a value. The run
 * meters itself (services/runAgentGraph.ts): it charges before it starts,
 * settles on delivered output and refunds a failed run.
 */
async function runGraphForChat(args: {
  agentId: string;
  orgId: string;
  input: string;
  signal: AbortSignal;
}): Promise<AgentGraphOutcome> {
  // Asked first, scoped through the agent's organization, so "no graph" is a
  // named answer rather than something read out of an error message.
  const graph = await prisma.agentGraph.findFirst({
    where: { agentId: args.agentId, agent: { orgId: args.orgId } },
    select: { nodes: true },
  });
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) return { kind: "no_graph" };

  let record;
  try {
    record = await runAgentGraph(args.agentId, args.orgId, args.input, { signal: args.signal });
  } catch (err) {
    if (err instanceof MarketplaceLicenceRevokedError) {
      return {
        kind: "licence_revoked",
        listingTitle: err.listingTitle,
        revocation: err.reason,
        token: err.token,
      };
    }
    if (err instanceof MarketplacePaymentRequiredError) {
      return {
        kind: "payment_required",
        listingTitle: err.listingTitle,
        requiredCents: err.requiredCents,
        balanceCents: err.balanceCents,
      };
    }
    if (err instanceof ServerShuttingDownError) return { kind: "shutting_down" };
    throw err;
  }

  const run = {
    executionId: record.executionId,
    durationMs: record.durationMs,
    // Which nodes ran and how each ended. What a node was given and what it
    // produced stay in the stored execution, for the graph's author.
    steps: record.trace.map((entry) => ({
      nodeId: entry.nodeId,
      nodeType: entry.nodeType,
      label: entry.label,
      status: entry.status,
      durationMs: entry.durationMs,
    })),
  };
  if (record.status === "completed") return { kind: "completed", output: record.output, run };
  const stopped = [...record.trace].reverse().find((entry) => entry.status !== "success");
  return { kind: "failed", run, failedStep: stopped?.label ?? null };
}

let continuationRedis: Redis | null = null;
let continuationStore: ToolContinuationStore | null = null;

function getContinuationStore(): ToolContinuationStore {
  if (!continuationStore) {
    continuationRedis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      // A continuation is an optimisation: a command that cannot be sent now
      // is a miss now, not something to queue behind a reconnect.
      enableOfflineQueue: false,
    });
    continuationRedis.on("error", (err) => {
      logger.warn({ err }, "tool continuation Redis error");
    });
    continuationRedis.connect().catch((err) => {
      logger.warn({ err }, "tool continuations are unavailable: Redis did not connect");
    });
    continuationStore = createRedisToolContinuationStore({
      redis: continuationRedis,
      onError: (err, op) => logger.warn({ err, op }, "tool continuation store failed; treated as a miss"),
    });
  }
  return continuationStore;
}

/** For the server's onClose hook. */
export async function closeAgentChatConnections(): Promise<void> {
  const redis = continuationRedis;
  continuationRedis = null;
  continuationStore = null;
  await redis?.quit().catch(() => {});
}

/**
 * Two records per chat. The agent's hourly rollup (AgentUsageRecord) takes
 * every admitted chat, answered or not - it is what the agent's usage and
 * latency numbers are read from. The daily per-model counter (FreeTierUsage)
 * takes answered chats only, as it always has; tokens are added to it only
 * when the provider reported them.
 */
async function recordUsage(record: AgentChatUsageRecord): Promise<void> {
  // Independent rows: one failing must not cost the other.
  const rollup = recordAgentUsage(prisma, record).catch((err) => {
    logger.error({ err, agentId: record.agentId }, "failed to record agent usage rollup");
  });
  try {
    await recordModelUsage(record);
  } finally {
    await rollup;
  }
}

async function recordModelUsage(record: AgentChatUsageRecord): Promise<void> {
  if (!record.ok) return;
  const provider = record.modelId.split("/")[1] ?? record.modelId.split("/")[0] ?? "unknown";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const inputTokens = record.usage?.inputTokens ?? 0;
  const outputTokens = record.usage?.outputTokens ?? 0;

  await prisma.freeTierUsage.upsert({
    where: { orgId_model_date: { orgId: record.orgId, model: record.modelId, date: today } },
    update: {
      inputTokens: { increment: inputTokens },
      outputTokens: { increment: outputTokens },
      requestCount: { increment: 1 },
    },
    create: {
      orgId: record.orgId,
      model: record.modelId,
      provider,
      inputTokens,
      outputTokens,
      requestCount: 1,
      date: today,
    },
  });
}

export function buildAgentChatDeps(): AgentChatDeps {
  return {
    loadAgent: (where) =>
      "id" in where
        ? prisma.agent.findFirst({
            where: { id: where.id, orgId: where.orgId },
            select: AGENT_COLUMNS,
          })
        : prisma.agent.findUnique({
            where: { orgId_slug: { orgId: where.orgId, slug: where.slug } },
            select: AGENT_COLUMNS,
          }),
    openAgentEnv: (sealed) => openAgentEnv(sealed as never),
    availableFreeModelIds: () => getAvailableFreeModels().map((model) => model.id),
    isFreeModel,
    resolveModel: resolveModelForPlayground,
    resolveHostedModel: (args) => resolveHostedModel(args),
    checkFreeTierLimit: async (orgId, { failClosed }) => {
      if (failClosed) {
        // The limiter (middleware/free-tier-limit.ts) fails OPEN when Redis is
        // down and cannot yet be told otherwise. Until it can, a caller that
        // must be limited is refused rather than let through unlimited. No
        // route passes failClosed today (it is for the public widget).
        const now = Math.floor(Date.now() / 1000);
        return {
          allowed: false,
          remaining: { rpm: 0, rpd: 0 },
          resetAt: { rpm: now + 60, rpd: now + 60 },
        };
      }
      return checkFreeTierLimit(orgId);
    },
    retrieveContext: (args) => retrieveContextForAgent(args, buildAgentRetrievalDeps()),
    beginMetering: beginMarketplaceMetering,
    resolveToolMode: (args) => resolveToolMode(args),
    skillKeys: () => getDefaultRegistry().list().map((skill) => skill.key),
    runChat: (resolved, config, messages, options) =>
      runChat(resolved, config, messages, false, options),
    runChatStream,
    runGraph: runGraphForChat,
    answerStream: (result, modelName) => answerToStream(result, modelName, false),
    beginRun: () => inFlightChats.begin(),
    recordUsage,
    continuations: getContinuationStore(),
    deadlineMs: env.AGENT_CHAT_TIMEOUT_MS,
    logger,
  };
}
