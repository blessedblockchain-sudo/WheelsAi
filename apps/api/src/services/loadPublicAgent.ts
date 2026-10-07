/**
 * Prisma-backed loadPublicAgent (companion to routes/publicAgent.ts).
 *
 * Resolves the public-safe slice of an agent's state for the /a/:slug
 * transparency page. Differences from loadAgentDetailByPrisma:
 *
 *   - filter: where { slug, isPublic: true }   (no orgId scope)
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
 * SQL trips: agent + nested includes, then the payment aggregate/list,
 * usage aggregate, and eligibility check run concurrently.
 */

import { LIVE_CHANNEL_PLATFORMS, WEB_CHAT_CHANNEL } from "../routes/channelWebhooks.js";
import type { PublicAgentDetail } from "../routes/publicAgent.js";

const LIVE_WEBHOOK_PLATFORMS: ReadonlySet<string> = new Set(LIVE_CHANNEL_PLATFORMS);

interface AgentRow {
  id: string;
  isPublic: boolean;
  name: string;
  slug: string;
  framework: string;
  createdAt: Date;
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
  /** The agent's enabled, unrevoked web chat keys and the sites each allows. */
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

interface PrismaStub {
  agent: {
    findFirst: (args: {
      where: { slug: string; isPublic: boolean };
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
  slug: string;
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

export async function loadPublicAgentByPrisma(
  input: LoadPublicAgentInput,
  deps: LoadPublicAgentDeps,
): Promise<PublicAgentDetail | null> {
  const agent = await deps.prisma.agent.findFirst({
    where: { slug: input.slug, isPublic: true },
    include: {
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
      widgetKeys: {
        where: { enabled: true, revokedAt: null },
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

  const [paymentsPart, uptimePart, eligibilityPart] = await Promise.all([
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
  ]);

  return {
    agent: {
      name: agent.name,
      slug: agent.slug,
      framework: agent.framework,
      createdAt: agent.createdAt,
    },
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
