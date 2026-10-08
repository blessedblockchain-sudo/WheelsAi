/**
 * Public per-agent transparency feed (plan C5).
 *
 * GET /a/:handle — unauthenticated, presents the public-safe slice of an
 * agent's economic state: identity, treasury balance + cumulative compute
 * paid, recent settlement signatures, enabled channels, deployment summary.
 * The handle is the agent's public address, unique across the platform.
 *
 * It also says how the page can be used right now (`use`): view only, on
 * (with the page's publishable key), or paused, and what the panel of the
 * agent's kind needs. Never the agent's instructions, its tools, its
 * secrets' names, its organization or its daily cap.
 *
 * This is the single most differentiated artifact in the product — it is
 * the visible manifestation of "agents that pay for their own compute"
 * and the first surface a regulator or holder lands on. Privacy
 * guarantees pinned by tests:
 *   - orgId never appears in the response
 *   - payment errorMessage redacted (status only)
 *   - disabled channels filtered out; a configured channel with no working
 *     path is listed as not live, never as active
 *   - deployments expose tier + replicas + status, not internal job IDs
 *
 * The loader signals "not found OR not public" with a single null return,
 * so the route never reveals the existence of a private agent.
 */

import type { TaskInputSchema } from "@wheelsai/shared/agent-kind";
import type { FastifyPluginAsync } from "fastify";

const LAMPORTS_PER_SOL = 1_000_000_000;

// ============================================
// Shapes
// ============================================

/** What a visitor may send in one chat from the page (the public chat's own limits). */
export interface PublicAgentChatUse {
  maxMessages: number;
  maxMessageChars: number;
  maxTotalChars: number;
}

/**
 * How the page can be used right now. `off` is not a state here: a page
 * that is off answers 404. Exactly one of chat, task and scheduled is set,
 * by the agent's kind.
 */
export interface PublicAgentUse {
  state: "view_only" | "on" | "paused";
  /** The page's publishable key, only while state is "on". */
  key: string | null;
  /** Whether the owner keeps a copy of what visitors send and get back. */
  transcriptsStored: boolean;
  chat?: PublicAgentChatUse;
  task?: {
    /** The form as a JSON Schema, its properties in the order of the questions. */
    inputSchema: TaskInputSchema;
    maxInputChars: number;
  };
  scheduled?: {
    resultsPublic: boolean;
    latest: Array<{ finishedAt: Date; text: string }>;
  };
}

export interface PublicAgentDetail {
  agent: {
    name: string;
    slug: string;
    framework: string;
    createdAt: Date;
    /** The owner's public description. Never the instructions. */
    description: string | null;
    handle: string;
    agentKind: "conversation" | "task" | "scheduled";
  };
  use: PublicAgentUse;
  treasury: {
    address: string;
    balanceLamports: bigint;
    cumulativeComputePaidLamports: bigint;
  } | null;
  /**
   * Σ computeSeconds / requestCount over the agent's UsageRecords — the
   * same derivation the on-chain attestation worker aggregates, so the
   * public figure matches what holders can verify on-chain. Null when
   * the agent has no model deployments (nothing measurable yet).
   */
  uptime: {
    totalComputeSeconds: bigint;
    totalRequests: number;
  } | null;
  /**
   * Whether the agent currently clears the token-launch substance gate.
   * Boolean only — the gate's reasons stay private to the publisher.
   * Null when the agent has no listing (gate not applicable).
   */
  eligibility: { eligible: boolean } | null;
  deployments: Array<{ gpuTier: string; replicas: number; status: string }>;
  /**
   * `enabled` = the owner configured and switched it on. `live` = a message
   * sent there reaches the agent today. A platform without a working
   * inbound path is enabled and not live, and the page says so.
   */
  channels: Array<{ platform: string; enabled: boolean; live: boolean }>;
  recentPayments: Array<{
    amountLamports: bigint;
    status: string;
    txSignature: string | null;
    paidAt: Date | null;
  }>;
}

export interface PublicAgentDeps {
  /** By public handle. null for an unknown handle and for an agent that is not public. */
  loadPublicAgent: (handle: string) => Promise<PublicAgentDetail | null>;
}

// ============================================
// Serialization
// ============================================

function lamportsToSol4dp(lamports: bigint): number {
  // Convert without losing precision. Round to 4 decimal places for display.
  // Use string math to keep the bigint exact, then parseFloat the result.
  const whole = lamports / BigInt(LAMPORTS_PER_SOL);
  const remainder = lamports % BigInt(LAMPORTS_PER_SOL);
  const fractional = Number(remainder) / LAMPORTS_PER_SOL;
  const exact = Number(whole) + fractional;
  return Math.round(exact * 10_000) / 10_000;
}

/** Field by field, like the rest of this answer: nothing the loader carries extra crosses. */
function serializeUse(use: PublicAgentUse) {
  return {
    state: use.state,
    key: use.state === "on" ? use.key : null,
    transcriptsStored: use.transcriptsStored,
    ...(use.chat && {
      chat: {
        maxMessages: use.chat.maxMessages,
        maxMessageChars: use.chat.maxMessageChars,
        maxTotalChars: use.chat.maxTotalChars,
      },
    }),
    ...(use.task && {
      task: { inputSchema: use.task.inputSchema, maxInputChars: use.task.maxInputChars },
    }),
    ...(use.scheduled && {
      scheduled: {
        resultsPublic: use.scheduled.resultsPublic,
        latest: use.scheduled.latest.map((result) => ({
          finishedAt: result.finishedAt.toISOString(),
          text: result.text,
        })),
      },
    }),
  };
}

function serialize(detail: PublicAgentDetail) {
  return {
    agent: {
      name: detail.agent.name,
      slug: detail.agent.slug,
      framework: detail.agent.framework,
      createdAt: detail.agent.createdAt.toISOString(),
      description: detail.agent.description,
      handle: detail.agent.handle,
      agentKind: detail.agent.agentKind,
    },
    use: serializeUse(detail.use),
    treasury: detail.treasury
      ? {
          address: detail.treasury.address,
          balanceLamports: detail.treasury.balanceLamports.toString(),
          balanceSol: lamportsToSol4dp(detail.treasury.balanceLamports),
          cumulativeComputePaidLamports:
            detail.treasury.cumulativeComputePaidLamports.toString(),
        }
      : null,
    uptime: detail.uptime
      ? {
          totalComputeSeconds: detail.uptime.totalComputeSeconds.toString(),
          // Rounded hours for display; the exact seconds string is the
          // verifiable figure.
          totalComputeHours:
            Math.round(
              (Number(detail.uptime.totalComputeSeconds) / 3600) * 100,
            ) / 100,
          totalRequests: detail.uptime.totalRequests,
        }
      : null,
    eligibility: detail.eligibility
      ? { eligible: detail.eligibility.eligible }
      : null,
    deployments: detail.deployments.map((d) => ({
      gpuTier: d.gpuTier,
      replicas: d.replicas,
      status: d.status,
    })),
    channels: detail.channels
      .filter((c) => c.enabled)
      .map((c) => ({ platform: c.platform, enabled: c.enabled, live: c.live })),
    recentPayments: detail.recentPayments.map((p) => ({
      amountLamports: p.amountLamports.toString(),
      status: p.status,
      txSignature: p.txSignature,
      paidAt: p.paidAt ? p.paidAt.toISOString() : null,
    })),
  };
}

// ============================================
// Plugin
// ============================================

export function createPublicAgentRoutes(deps: PublicAgentDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { handle: string } }>("/a/:handle", async (request, reply) => {
      const { handle } = request.params;
      const detail = await deps.loadPublicAgent(handle);
      if (!detail) {
        // 404, not 401/403 — never reveal that a private agent with this handle exists.
        return reply.status(404).send({ error: "agent_not_found" });
      }
      return reply.status(200).send(serialize(detail));
    });
  };
}
