/**
 * Prisma-backed loadPublicAgent (companion to routes/publicAgent.ts).
 *
 * Resolves the public-safe slice of an agent's state for its public page,
 * /a/<handle>. Differences from loadAgentDetailByPrisma:
 *
 *   - filter: where { publicHandle, isPublic: true }   (no orgId scope).
 *     The handle is unique across the platform, which a slug is not: two
 *     organizations with the same slug have two pages.
 *   - returns null on miss OR private          (no existence reveal)
 *   - aggregates cumulativeComputePaidLamports across status='CONFIRMED'
 *     payments only — failed/pending compute does not count toward the
 *     publicly displayed "paid to date" figure
 *   - aggregates uptime (Σ computeSeconds / requestCount) across the
 *     UsageRecords of the agent's model deployments — the same rows the
 *     attestation worker sums, so the public figure matches what lands
 *     on-chain. No orgId in the where: the deployment ids themselves
 *     derive from the loaded agent, which is the tenancy anchor here.
 *   - eligibility is a DI'd check (checkTokenEligibility underneath).
 *     Only the boolean crosses the public boundary; a thrown check
 *     degrades to null rather than 500ing the public page.
 *
 *   - `use` says how the page can be used right now (publicPageStateOf):
 *     the page key's publishable key only while the page is on, and what
 *     the panel of the agent's kind needs (the chat's limits, the task's
 *     form, or whether a self-running agent shows its results). It is made
 *     from the agent's kind, its form and its page key, and from nothing
 *     else: no instructions, no tools, no caps.
 *
 *   - a self-running agent's latest results are read only while its owner
 *     shows them (Agent.publicResults): the last three successful runs of
 *     its own schedule, each as when it finished and its text
 *     (latestOwnResults). Whether the page can be used does not matter:
 *     showing results is its own switch.
 *
 *   - while a published listing sells use of the agent at a price
 *     (findUseListing, isPaidUse) the state is "paid": the key is never
 *     sent, whatever the key row says, and `paid` carries the terms. A free
 *     use listing changes nothing here, and neither does one that sells
 *     copies. A listing read that fails fails the page: a page that cannot
 *     tell whether use is sold must not hand out its key. With the terms go
 *     the paid plans a listing sold per use offers (services/planOffers.ts):
 *     each one's id, name and terms, and nothing else of its row.
 *
 *   - with the terms go, internally, what the x402 door reads of the listing
 *     and its agent (x402DoorOf), for the API page's serve test. The route
 *     never sends it: the creator's switch is not told as it is.
 *
 *   - a self-running agent that is sold shows when its last results
 *     arrived, never their text, with when the latest arrived and the
 *     schedule while it is on. The owner's switch does not decide it.
 *
 * SQL trips: agent + nested includes, the listing that sells use, then the
 * payment aggregate/list, usage aggregate, eligibility check, latest results
 * and (sold, self-running) the schedule run concurrently.
 */

import { LIVE_CHANNEL_PLATFORMS, WEB_CHAT_CHANNEL } from "../routes/channelWebhooks.js";
import {
  PUBLIC_RESULT_MAX_CHARS,
  PUBLIC_RESULTS_LIMIT,
  type PublicAgentDetail,
  type PublicAgentPaidUse,
  type PublicAgentUse,
} from "../routes/publicAgent.js";
import { publicTaskForm } from "./agentKind.js";
import { findOwnSchedule, latestOwnResults, type OwnScheduleDb } from "./agentOwnSchedule.js";
import { TASK_MAX_INPUT_CHARS } from "./agentTask.js";
import { PUBLIC_CHAT_LIMITS } from "./publicChat.js";
import {
  PAID_USE_PER_BUYER_PER_DAY,
  PAID_USE_PER_BUYER_PER_MINUTE,
  publicPageStateOf,
} from "./publicPageState.js";
import {
  offersPlans,
  readOffers,
  type OffersDb,
  type PlanOfferRow,
  type TrialOfferRow,
} from "./planOffers.js";
import {
  findUseListing,
  isPaidUse,
  usePriceCents,
  useUnitOf,
  type UseListingDb,
  type UseListingRow,
} from "./useListing.js";

const LIVE_WEBHOOK_PLATFORMS: ReadonlySet<string> = new Set(LIVE_CHANNEL_PLATFORMS);

interface AgentRow {
  id: string;
  /** Internal only: scopes the read of the agent's own results. */
  orgId: string;
  isPublic: boolean;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
  /** What the owner wrote for the public. Never the instructions. */
  description?: string | null;
  publicHandle?: string | null;
  agentKind?: string | null;
  /** Internal only: the task form is read from it, nothing else. */
  kindConfig?: unknown;
  /** Internal only: what answers a chat ('chat' or 'graph'), for the x402 door's serve test. */
  entrypoint?: string | null;
  publicResults?: boolean | null;
  /** The key of this agent's public page, when it has one. */
  pageKey?: {
    publicKey: string;
    enabled: boolean;
    revokedAt: Date | null;
    storeTranscripts: boolean;
  } | null;
  deployments: Array<{
    gpuTier: string;
    replicas: number;
    status: string;
    /** Internal only — feeds the usage aggregate, never the response. */
    modelDeploymentId: string | null;
  }>;
  openclawDeployment: {
    channels: Array<{ platform: string; enabled: boolean }>;
  } | null;
  /**
   * The agent's enabled, unrevoked web chat keys and the sites each allows.
   * Without the page key: that one serves the page, not a website.
   */
  widgetKeys?: Array<{ allowedOrigins: string[] }>;
  listing: {
    /** Internal only — both feed the eligibility check, never the response. */
    id: string;
    publisherId: string;
    agentToken: {
      treasury: {
        id: string;
        treasuryPdaAddress: string;
        solBalanceLamports: bigint;
      } | null;
    } | null;
  } | null;
}

interface PaymentRow {
  amountLamports: bigint;
  status: string;
  txSignature: string | null;
  paidAt: Date | null;
}

type PublicResult = NonNullable<PublicAgentUse["scheduled"]>["latest"][number];

type PublicSchedule = NonNullable<NonNullable<PublicAgentUse["scheduled"]>["schedule"]>;

interface PrismaStub extends Pick<OwnScheduleDb, "scheduledTask" | "taskExecution">, UseListingDb, OffersDb {
  agent: {
    findFirst: (args: {
      where: { publicHandle: string; isPublic: boolean };
      include: unknown;
    }) => Promise<AgentRow | null>;
  };
  computePayment: {
    aggregate: (args: {
      where: { treasuryId: string; status: string };
      _sum: { amountLamports: true };
    }) => Promise<{ _sum: { amountLamports: bigint | null } }>;
    findMany: (args: {
      where: { treasuryId: string };
      orderBy: { createdAt: "desc" };
      take: number;
    }) => Promise<PaymentRow[]>;
  };
  usageRecord: {
    aggregate: (args: {
      where: { deploymentId: { in: string[] } };
      _sum: { computeSeconds: true; requestCount: true };
    }) => Promise<{
      _sum: { computeSeconds: bigint | null; requestCount: number | null };
    }>;
  };
}

export interface LoadPublicAgentInput {
  /** The agent's public handle (Agent.publicHandle), as the address carries it. */
  handle: string;
  paymentsLimit: number;
}

export interface LoadPublicAgentDeps {
  prisma: PrismaStub;
  /**
   * Substance-gate check (checkTokenEligibility in production). Receives
   * the listing's own id + publisherId — NOT caller-derived, so this is
   * "does this listing clear its own gate", not an authz surface.
   */
  checkEligibility: (
    listingId: string,
    publisherId: string,
  ) => Promise<{ eligible: boolean }>;
}

/**
 * What the x402 door reads of the listing and its agent, as they were read,
 * for the API page's serve test (x402ListingServed). Absent when the agent's
 * entrypoint was not read: a page that cannot tell offers no door.
 */
function x402DoorOf(agent: AgentRow, listing: UseListingRow): PublicAgentPaidUse["x402Door"] {
  if (typeof agent.entrypoint !== "string") return undefined;
  return {
    listing: {
      agentId: listing.agentId,
      // A listing found by its agent sells no workflow: the database holds
      // exactly one of the two (agent_listings_agent_or_workflow_check).
      orchestrationId: null,
      status: listing.status,
      sells: listing.sells,
      pricingModel: listing.pricingModel,
      pricePerRequestCents: listing.pricePerRequestCents,
      x402Enabled: listing.x402Enabled === true,
    },
    agent: {
      isPublic: agent.isPublic,
      // An unread kind is no kind, as the door reads it.
      agentKind: agent.agentKind ?? "",
      entrypoint: agent.entrypoint,
    },
  };
}

/**
 * The terms of paid use, from the listing that sells it. null unless a
 * price is set: a free use listing is the public link as it is.
 */
function paidOf(
  agent: AgentRow,
  listing: UseListingRow | null,
  plans: PlanOfferRow[],
  trial: TrialOfferRow | null,
): PublicAgentUse["paid"] {
  if (!listing || !isPaidUse(listing)) return null;
  const priceCents = usePriceCents(listing);
  if (priceCents === null) return null;
  const x402Door = x402DoorOf(agent, listing);
  // Field by field: the listing row also holds its publisher.
  return {
    listingId: listing.id,
    listingSlug: listing.slug,
    pricingModel: listing.pricingModel,
    priceCents,
    unit: useUnitOf(agent.agentKind, listing.pricingModel),
    perMinute: PAID_USE_PER_BUYER_PER_MINUTE,
    perDay: PAID_USE_PER_BUYER_PER_DAY,
    transcriptsStored: agent.pageKey && !agent.pageKey.revokedAt ? agent.pageKey.storeTranscripts : false,
    sendsRequests: listing.useAllowedTools.length > 0,
    // Field by field: a plan row also holds its place and its dates.
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      includedUses: plan.includedUses,
      extraUsePriceCents: plan.extraUsePriceCents,
    })),
    // The free trial it offers, by itself: never one of the plans.
    trial: trial && { id: trial.id, includedUses: trial.includedUses },
    ...(x402Door && { x402Door }),
  };
}

/**
 * How the page can be used right now, and what its panel needs. Never
 * called for a page that is off: that page is a 404.
 */
function useOf(
  agent: AgentRow,
  paid: PublicAgentUse["paid"],
  latest: PublicResult[],
  schedule: PublicSchedule | null,
): PublicAgentUse {
  const pageKey = agent.pageKey ?? null;
  const state = publicPageStateOf(true, pageKey, Boolean(paid));
  const live = pageKey && !pageKey.revokedAt ? pageKey : null;
  const use = {
    // "off" cannot happen for an agent that was found public.
    state: state === "off" ? "view_only" : state,
    // The key is sent only while it can be used: a paused page has none,
    // and a page whose use is sold never has one.
    key: state === "on" && pageKey ? pageKey.publicKey : null,
    transcriptsStored: live ? live.storeTranscripts : false,
    ...(paid ? { paid } : {}),
  } as const;
  if (agent.agentKind === "task") {
    return {
      ...use,
      // Built from the stored form on every answer, its properties in the
      // order of the questions.
      task: { inputSchema: publicTaskForm(agent.kindConfig).schema, maxInputChars: TASK_MAX_INPUT_CHARS },
    };
  }
  if (agent.agentKind === "scheduled") {
    if (paid) {
      // Sold: when each result arrived, and never its text.
      return {
        ...use,
        scheduled: {
          resultsPublic: false,
          latest: latest.map((result) => ({ finishedAt: result.finishedAt })),
          lastResultAt: latest[0]?.finishedAt ?? null,
          schedule,
        },
      };
    }
    const resultsPublic = agent.publicResults === true;
    // Field by field: when it finished and its text, and nothing else.
    return {
      ...use,
      scheduled: {
        resultsPublic,
        latest: resultsPublic ? latest.map((result) => ({ finishedAt: result.finishedAt, text: result.text })) : [],
      },
    };
  }
  return {
    ...use,
    chat: {
      maxMessages: PUBLIC_CHAT_LIMITS.maxMessages,
      maxMessageChars: PUBLIC_CHAT_LIMITS.maxMessageChars,
      maxTotalChars: PUBLIC_CHAT_LIMITS.maxTotalChars,
    },
  };
}

export async function loadPublicAgentByPrisma(
  input: LoadPublicAgentInput,
  deps: LoadPublicAgentDeps,
): Promise<PublicAgentDetail | null> {
  const agent = await deps.prisma.agent.findFirst({
    where: { publicHandle: input.handle, isPublic: true },
    include: {
      pageKey: {
        select: { publicKey: true, enabled: true, revokedAt: true, storeTranscripts: true },
      },
      deployments: {
        select: {
          gpuTier: true,
          replicas: true,
          status: true,
          modelDeploymentId: true,
        },
      },
      openclawDeployment: {
        select: {
          channels: { select: { platform: true, enabled: true } },
        },
      },
      // The keys that are enabled and not revoked, with the sites each one
      // answers. No `take`: an agent's keys are capped (MAX_KEYS_PER_AGENT),
      // and one row would not tell a key no site can use from one that works.
      // The page key is left out: it lists no sites, so it would show the
      // web channel as "set up, not live" on the very page it serves.
      widgetKeys: {
        where: { enabled: true, revokedAt: null, pageOfAgentId: null },
        select: { allowedOrigins: true },
      },
      listing: {
        select: {
          id: true,
          publisherId: true,
          agentToken: {
            select: {
              treasury: {
                select: {
                  id: true,
                  treasuryPdaAddress: true,
                  solBalanceLamports: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!agent) return null;

  // Before anything of the page is decided: whether use of it is sold at a
  // price. Not caught: without this answer the key must not be sent.
  const useListing = await findUseListing(deps.prisma, agent.id);
  // The plans it offers and its free trial, read together and only for a
  // listing sold at a price per use: no other listing has any to show.
  const offers =
    useListing && isPaidUse(useListing) && offersPlans(useListing)
      ? await readOffers(deps.prisma, useListing.id)
      : { plans: [], trial: null };
  const paid = paidOf(agent, useListing, offers.plans, offers.trial);
  const soldSchedule = Boolean(paid) && agent.agentKind === "scheduled";

  const treasuryRow = agent.listing?.agentToken?.treasury ?? null;
  // A key with no allowed origin answers only the dashboard's preview and
  // 403 everywhere else, so it is a channel set up, not one a visitor can
  // reach. The wizard's "Web Chat" option creates exactly such a key.
  const webChatKeys = agent.widgetKeys ?? [];
  const webChatConfigured = webChatKeys.length > 0;
  const webChatLive = webChatKeys.some((k) => k.allowedOrigins.length > 0);
  // A platform row says a channel was configured. Whether a message sent
  // there reaches the agent is a separate fact, and the page states both:
  // only the platforms with a working inbound path are live. The web chat
  // channel is its widget key, not a platform row, so a row for it is
  // replaced by the key's own state.
  const channels: PublicAgentDetail["channels"] = [
    ...(agent.openclawDeployment?.channels ?? [])
      .filter((c) => !(webChatConfigured && (c.platform === WEB_CHAT_CHANNEL || c.platform === "webchat")))
      .map((c) => ({
        platform: c.platform,
        enabled: c.enabled,
        live: c.enabled && LIVE_WEBHOOK_PLATFORMS.has(c.platform),
      })),
    ...(webChatConfigured ? [{ platform: WEB_CHAT_CHANNEL, enabled: true, live: webChatLive }] : []),
  ];

  // Dedupe the model-deployment ids the usage aggregate keys off (empty-set
  // short-circuit: Postgres rejects a literal IN () and we'd waste the trip).
  const modelDeploymentIds = Array.from(
    new Set(
      agent.deployments
        .map((d) => d.modelDeploymentId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );

  const [paymentsPart, uptimePart, eligibilityPart, latestResults, schedulePart] = await Promise.all([
    (async () => {
      if (!treasuryRow) {
        return {
          treasury: null as PublicAgentDetail["treasury"],
          recentPayments: [] as PublicAgentDetail["recentPayments"],
        };
      }
      const [agg, payments] = await Promise.all([
        deps.prisma.computePayment.aggregate({
          where: { treasuryId: treasuryRow.id, status: "CONFIRMED" },
          _sum: { amountLamports: true },
        }),
        deps.prisma.computePayment.findMany({
          where: { treasuryId: treasuryRow.id },
          orderBy: { createdAt: "desc" },
          take: input.paymentsLimit,
        }),
      ]);
      return {
        treasury: {
          address: treasuryRow.treasuryPdaAddress,
          balanceLamports: treasuryRow.solBalanceLamports,
          cumulativeComputePaidLamports: agg._sum.amountLamports ?? 0n,
        } as PublicAgentDetail["treasury"],
        recentPayments: payments.map((p) => ({
          amountLamports: p.amountLamports,
          status: p.status,
          txSignature: p.txSignature,
          paidAt: p.paidAt,
        })),
      };
    })(),
    (async (): Promise<PublicAgentDetail["uptime"]> => {
      if (modelDeploymentIds.length === 0) return null;
      const agg = await deps.prisma.usageRecord.aggregate({
        where: { deploymentId: { in: modelDeploymentIds } },
        _sum: { computeSeconds: true, requestCount: true },
      });
      return {
        totalComputeSeconds: agg._sum.computeSeconds ?? 0n,
        totalRequests: agg._sum.requestCount ?? 0,
      };
    })(),
    (async (): Promise<PublicAgentDetail["eligibility"]> => {
      if (!agent.listing) return null;
      try {
        const result = await deps.checkEligibility(
          agent.listing.id,
          agent.listing.publisherId,
        );
        return { eligible: result.eligible };
      } catch {
        // A failed check must not 500 the public page; "unknown" beats
        // fabricating either answer.
        return null;
      }
    })(),
    (async (): Promise<PublicResult[]> => {
      // Read only for a self-running agent whose owner shows its results.
      // Scoped by the loaded agent's own organization, never a caller's. A
      // failed read is not answered as "no results yet": it fails the page.
      // When its results are sold, only the times are wanted: the text is
      // cut to nothing as it is read, so none of it is held here.
      if (agent.agentKind !== "scheduled") return [];
      if (!soldSchedule && agent.publicResults !== true) return [];
      return latestOwnResults(deps.prisma, {
        orgId: agent.orgId,
        agentId: agent.id,
        limit: PUBLIC_RESULTS_LIMIT,
        maxChars: soldSchedule ? 0 : PUBLIC_RESULT_MAX_CHARS,
      });
    })(),
    (async (): Promise<PublicSchedule | null> => {
      // Only for a self-running agent that is sold: a buyer is told when it
      // runs. Of the schedule only its times and its zone leave here, and
      // only while it is on: never what it is told, where results go, or an id.
      if (!soldSchedule) return null;
      const { schedule } = await findOwnSchedule(deps.prisma, { orgId: agent.orgId, agentId: agent.id });
      if (!schedule || !schedule.enabled || schedule.scheduleType !== "cron" || !schedule.cronExpression) return null;
      return { cronExpression: schedule.cronExpression, timezone: schedule.timezone };
    })(),
  ]);

  return {
    agent: {
      name: agent.name,
      slug: agent.slug,
      framework: agent.framework,
      createdAt: agent.createdAt,
      description: agent.description ?? null,
      // The row was found by it.
      handle: agent.publicHandle ?? input.handle,
      agentKind: agent.agentKind === "task" || agent.agentKind === "scheduled" ? agent.agentKind : "conversation",
    },
    use: useOf(agent, paid, latestResults, schedulePart),
    treasury: paymentsPart.treasury,
    uptime: uptimePart,
    eligibility: eligibilityPart,
    deployments: agent.deployments.map((d) => ({
      gpuTier: d.gpuTier,
      replicas: d.replicas,
      status: d.status,
    })),
    channels,
    recentPayments: paymentsPart.recentPayments,
  };
}
