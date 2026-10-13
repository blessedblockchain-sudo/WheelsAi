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
 * secrets' names, its organization or its daily cap. For a self-running
 * agent whose owner shows its results, the last three of them: when each
 * finished and its text, and nothing else of a run.
 *
 * While a published listing sells use of the agent at a price the state is
 * "paid": the key is never sent, and `use.paid` carries the terms a person
 * sees before paying (the listing, the price, the limits per buyer, whether
 * the owner keeps a copy, whether the agent sends requests out). Never what
 * another buyer pays or uses, how many buyers there are, or the owner's
 * allowance. A self-running agent that is sold shows when its results
 * arrived and its schedule, and never their text: that is what is sold.
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
 *
 * GET /a/:handle/api is unauthenticated too. It answers what the API page of a listing
 * draws (services/agentApiPage.ts), built from the same read as the page
 * above. 404 exactly where that read answers 404, and for an agent that has
 * no API page: its use is not sold at a price, or it is not one that is
 * called.
 */

import type { TaskInputSchema } from "@wheelsai/shared/agent-kind";
import type { FastifyPluginAsync } from "fastify";

import { agentApiPageOf } from "../services/agentApiPage.js";
import { PUBLIC_RESULT_MAX_CHARS, PUBLIC_RESULTS_LIMIT } from "../services/publicPageState.js";

const LAMPORTS_PER_SOL = 1_000_000_000;

// The page's two result limits live with the page's states, where the paid
// routes read them too (a free listing's results are the page's).
export { PUBLIC_RESULT_MAX_CHARS, PUBLIC_RESULTS_LIMIT };

// ============================================
// Shapes
// ============================================

/** What a visitor may send in one chat from the page (the public chat's own limits). */
export interface PublicAgentChatUse {
  maxMessages: number;
  maxMessageChars: number;
  maxTotalChars: number;
}

/** The terms of paid use, as a person sees them before paying. */
export interface PublicAgentPaidUse {
  listingId: string;
  listingSlug: string;
  /** per_request or monthly. */
  pricingModel: string;
  /** The price of one unit, in cents. */
  priceCents: bigint;
  /** What one payment buys. */
  unit: "message" | "run" | "month";
  /** The most one buyer may use it in a minute, and in a day. */
  perMinute: number;
  perDay: number;
  /** Whether the owner keeps a copy of what buyers send and get back. */
  transcriptsStored: boolean;
  /** Whether the agent may send requests to other websites for a buyer. */
  sendsRequests: boolean;
  /**
   * The paid plans the listing offers on top of its price per use, in the
   * order they are shown. Empty for a listing sold by the month and for one
   * with no plan. Cents are bigint here and numbers in the answer.
   */
  plans?: Array<{
    id: string;
    name: string;
    /** What 30 days cost. */
    priceCents: bigint;
    includedUses: number;
    /** What each use past the included ones costs. Null = the plan stops until it renews. */
    extraUsePriceCents: bigint | null;
  }>;
}

/**
 * How the page can be used right now. `off` is not a state here: a page
 * that is off answers 404. Exactly one of chat, task and scheduled is set,
 * by the agent's kind.
 */
export interface PublicAgentUse {
  state: "view_only" | "on" | "paused" | "paid";
  /** The page's publishable key, only while state is "on". */
  key: string | null;
  /** Whether the owner keeps a copy of what visitors send and get back. */
  transcriptsStored: boolean;
  /** Set while state is "paid", and only then. */
  paid?: PublicAgentPaidUse | null;
  chat?: PublicAgentChatUse;
  task?: {
    /** The form as a JSON Schema, its properties in the order of the questions. */
    inputSchema: TaskInputSchema;
    maxInputChars: number;
  };
  scheduled?: {
    /** The owner's switch, "Show its latest results on this page". */
    resultsPublic: boolean;
    /**
     * The last successful results of the agent's own schedule, newest first,
     * and only while the switch is on. When each finished and its text:
     * never what it was told, a run that failed, or where results are sent.
     */
    latest: Array<{ finishedAt: Date; text?: string }>;
    /** Only while state is "paid": when the latest result arrived. */
    lastResultAt?: Date | null;
    /** Only while state is "paid": when it runs, for a schedule that is on. */
    schedule?: { cronExpression: string; timezone: string } | null;
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
  /**
   * The address this API is reached at from outside (PUBLIC_API_URL), for
   * the API page. Unset or null: the page uses the address it reached the
   * API at.
   */
  publicApiUrl?: string | null;
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
  // The terms exist only in the paid state, and the paid state only with them.
  // A paid state that arrives without them is answered as paused: the page
  // loads, and nobody uses it free.
  const paid = use.state === "paid" ? (use.paid ?? null) : null;
  const state = use.state === "paid" && !paid ? "paused" : use.state;
  const sold = use.state === "paid";
  return {
    state,
    key: state === "on" ? use.key : null,
    transcriptsStored: use.transcriptsStored,
    paid: paid
      ? {
          listingId: paid.listingId,
          listingSlug: paid.listingSlug,
          pricingModel: paid.pricingModel,
          priceCents: Number(paid.priceCents),
          unit: paid.unit,
          perMinute: paid.perMinute,
          perDay: paid.perDay,
          transcriptsStored: paid.transcriptsStored,
          sendsRequests: paid.sendsRequests,
          // Field by field, like the terms above: a plan row also holds its
          // place, its dates and whether it was ended.
          plans: (paid.plans ?? []).map((plan) => ({
            id: plan.id,
            name: plan.name,
            priceCents: Number(plan.priceCents),
            includedUses: plan.includedUses,
            extraUsePriceCents: plan.extraUsePriceCents === null ? null : Number(plan.extraUsePriceCents),
          })),
        }
      : null,
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
    ...(use.scheduled &&
      !sold && {
        scheduled: {
          resultsPublic: use.scheduled.resultsPublic,
          // The switch and the limits are held here too, whatever the loader
          // carried: no result while the switch is off, three at most, each cut.
          latest: (use.scheduled.resultsPublic ? use.scheduled.latest : [])
            .slice(0, PUBLIC_RESULTS_LIMIT)
            .map((result) => ({
              finishedAt: result.finishedAt.toISOString(),
              text: (result.text ?? "").slice(0, PUBLIC_RESULT_MAX_CHARS),
            })),
        },
      }),
    // Sold: the text of a result is what a subscriber pays for, so only when
    // each arrived crosses, whatever the loader carried and whatever the
    // owner's switch says. With it, when the latest arrived and the schedule.
    ...(use.scheduled &&
      sold && {
        scheduled: {
          resultsPublic: false,
          latest: use.scheduled.latest
            .slice(0, PUBLIC_RESULTS_LIMIT)
            .map((result) => ({ finishedAt: result.finishedAt.toISOString() })),
          lastResultAt: use.scheduled.lastResultAt ? use.scheduled.lastResultAt.toISOString() : null,
          schedule: use.scheduled.schedule
            ? {
                cronExpression: use.scheduled.schedule.cronExpression,
                timezone: use.scheduled.schedule.timezone,
              }
            : null,
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

    // The same read, the same 404, and no sign-in: an API page is for
    // people who have not started yet.
    app.get<{ Params: { handle: string } }>("/a/:handle/api", async (request, reply) => {
      const detail = await deps.loadPublicAgent(request.params.handle);
      const page = detail && agentApiPageOf(detail, { publicApiUrl: deps.publicApiUrl });
      if (!page) return reply.status(404).send({ error: "agent_not_found" });
      return reply.status(200).send(page);
    });
  };
}
