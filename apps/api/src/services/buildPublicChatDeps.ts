/**
 * Composition root for public chat (services/publicChat.ts): binds the pure
 * core to Prisma, the fail-closed Redis limiter, the plan meter, the Try it
 * session check and agent chat itself.
 *
 * Both public surfaces - the widget routes and the Try it routes - build
 * their deps here, so they cannot drift on what is limited, who is charged
 * or what an anonymous visitor's chat may do.
 *
 * `bindPublicChatDeps` takes structural surfaces (the unit test passes
 * fakes); `buildPublicChatDeps` hands it the real ones.
 */

import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { getAvailableFreeModels } from "../config/free-models.js";
import { prisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import { prepareAgentChat, type AgentChatDeps } from "./agentChat.js";
import { buildAgentChatDeps } from "./buildAgentChatDeps.js";
import {
  createFailClosedLimiter,
  createRedisLimiterStore,
  LIMITER_COMMAND,
  LIMITER_LUA,
  type FailClosedLimiter,
  type LimiterRedis,
} from "./failClosedLimiter.js";
import { meterApiCall } from "./orgPlan.js";
import { PlanLimitError } from "./plans.js";
import {
  PUBLIC_CHAT_MAX_OUTPUT_TOKENS,
  PUBLIC_CHAT_MAX_TOOL_ROUNDS,
  type PublicChatDeps,
  type PublicChatLimitConfig,
  type PublicChatTranscript,
  type PublicWidgetKey,
} from "./publicChat.js";
import { createTrialFunding, type TrialFundingDb } from "./trialFunding.js";
import { findUseListing, isPaidUse, type UseListingDb } from "./useListing.js";
import { verifyTrialSession } from "./trialSession.js";
import { hashBucket, ipBucket } from "./widgetKeys.js";

const logger = createLogger("public-chat");

// ============================================
// The limiter
// ============================================

let limiterRedis: Redis | null = null;
let limiter: FailClosedLimiter | null = null;
/** Settles when the first connection attempt has succeeded or failed. */
let limiterConnected: Promise<void> = Promise.resolve();

/**
 * The one fail-closed limiter of this process. It has a Redis connection of
 * its own, configured to give up quickly: a command that cannot be sent now
 * is "cannot count" now (so: refuse), not something to queue behind a
 * reconnect while a visitor waits.
 */
export function getPublicChatLimiter(): FailClosedLimiter {
  if (!limiter) {
    limiterRedis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 2_000,
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
    });
    limiterRedis.defineCommand(LIMITER_COMMAND, { lua: LIMITER_LUA });
    limiterRedis.on("error", (err) => {
      logger.warn({ err }, "public chat limiter Redis error");
    });
    limiterConnected = limiterRedis.connect().catch((err) => {
      logger.error({ err }, "public chat is unavailable: the limiter's Redis did not connect");
    });
    limiter = createFailClosedLimiter(createRedisLimiterStore(limiterRedis as unknown as LimiterRedis), {
      // Logged as an error on purpose: while this fires, every widget and
      // every Try it is answering 503.
      onUnavailable: (err) => logger.error({ err }, "public chat limiter unavailable; refusing"),
    });
  }
  return limiter;
}

/** The limiter, once its first connection attempt is over (at most connectTimeout). */
async function connectedLimiter(): Promise<FailClosedLimiter> {
  const opened = getPublicChatLimiter();
  // Commands are not queued while disconnected, so one sent before the
  // connection is up fails - and failing closed, would refuse the first
  // visitors after every start. A failed attempt resolves too: the command
  // then fails, and the answer is `unavailable`.
  await limiterConnected;
  return opened;
}

/**
 * The same limiter, opened on first use: building routes at boot (or in a
 * test) connects to nothing. index.ts opens it at start-up.
 */
export const publicChatLimiter: FailClosedLimiter = {
  consume: async (rules) => (await connectedLimiter()).consume(rules),
  peek: async (key) => (await connectedLimiter()).peek(key),
};

/** Opens the limiter's connection ahead of the first request. */
export async function warmPublicChatLimiter(): Promise<void> {
  await connectedLimiter();
}

/** For the server's onClose hook. */
export async function closePublicChatConnections(): Promise<void> {
  const redis = limiterRedis;
  limiterRedis = null;
  limiter = null;
  limiterConnected = Promise.resolve();
  await redis?.quit().catch(() => {});
}

// ============================================
// Bindings
// ============================================

const WIDGET_KEY_COLUMNS = {
  id: true,
  orgId: true,
  agentId: true,
  allowedOrigins: true,
  dailyMessageCap: true,
  perIpPerMinute: true,
  storeTranscripts: true,
  enabled: true,
  revokedAt: true,
  lastUsedAt: true,
  // What makes a key the key of its agent's public page, and what that
  // rule and a task run (services/publicTask.ts) read of the agent. None of
  // it reaches a visitor.
  pageOfAgentId: true,
  agent: { select: { isPublic: true, agentKind: true, kindConfig: true, name: true } },
} as const;

interface TrialListingRow {
  id: string;
  slug: string;
  agentId: string;
  publisherId: string;
  trialFundedDailyCap: number;
  sells: string;
  agent: { orgId: string; entrypoint: string | null; systemPrompt: string | null };
}

interface TranscriptTx {
  conversation: {
    update(args: {
      where: { id: string };
      data: { messageCount: { increment: number }; lastMessageAt: Date };
      select: { messageCount: true };
    }): Promise<{ messageCount: number }>;
  };
  message: {
    createMany(args: {
      data: Array<{ conversationId: string; role: string; content: string; sequenceNum: number }>;
    }): Promise<unknown>;
  };
}

/** The slice of Prisma public chat touches. */
export interface PublicChatPrisma {
  widgetKey: {
    findUnique(args: {
      where: { publicKey: string };
      select: typeof WIDGET_KEY_COLUMNS;
    }): Promise<PublicWidgetKey | null>;
    updateMany(args: {
      where: { id: string; lastUsedAt: Date | null };
      data: { lastUsedAt: Date };
    }): Promise<unknown>;
  };
  agentListing: {
    /** The published listing that sells use of a page key's agent (findUseListing). */
    findFirst(
      args: Parameters<UseListingDb["agentListing"]["findFirst"]>[0],
    ): ReturnType<UseListingDb["agentListing"]["findFirst"]>;
    findFirst(args: {
      where: { slug: string; status: "published" };
      select: {
        id: true;
        slug: true;
        agentId: true;
        publisherId: true;
        trialFundedDailyCap: true;
        sells: true;
        agent: { select: { orgId: true; entrypoint: true; systemPrompt: true } };
      };
    }): Promise<TrialListingRow | null>;
  };
  conversation: {
    upsert(args: {
      where: { orgId_sessionId: { orgId: string; sessionId: string } };
      create: {
        orgId: string;
        agentId: string;
        sessionId: string;
        title: string;
        metadata: { channel: "web"; origin: string | null; widgetKeyId: string };
      };
      update: Record<string, never>;
      select: { id: true };
    }): Promise<{ id: string }>;
  };
  trialDailyUsage: {
    upsert(args: {
      where: { listingId_day: { listingId: string; day: string } };
      create: { listingId: string; day: string; baseCount: number };
      update: { baseCount: { increment: number } };
    }): Promise<unknown>;
  };
  $transaction<T>(fn: (tx: TranscriptTx) => Promise<T>): Promise<T>;
}

export interface PublicChatBindings {
  prisma: PublicChatPrisma;
  limiter: Pick<FailClosedLimiter, "consume">;
  limits: PublicChatLimitConfig;
  /** Keys the address buckets and signs Try it sessions. */
  secret: string;
  appOrigins: readonly string[];
  turnstileConfigured: boolean;
  freeModelIds(): string[];
  /** Throws PlanLimitError when the plan's calls for the month are used up. */
  meterApiCall(orgId: string): Promise<unknown>;
  /** Called on first use, so building the deps opens nothing. */
  agentChatDeps(): AgentChatDeps;
  holdFundedMessage?: PublicChatDeps["holdFundedMessage"];
  now?: () => Date;
  logger?: PublicChatDeps["logger"];
}

/**
 * Whether a published listing sells use of this agent at a price right now.
 * A page key (WidgetKey.pageOfAgentId) is held to it at every use: the key's
 * own switch is kept right when a listing is published or repriced, and this
 * read is what holds when two such edits cross. Throws when the listing
 * cannot be read; the caller then treats the key as not found.
 */
export async function pageSoldAtAPrice(db: UseListingDb, agentId: string): Promise<boolean> {
  const listing = await findUseListing(db, agentId);
  return listing !== null && isPaidUse(listing);
}

/** How a widget conversation is filed: one per key and visitor session. */
export function widgetConversationSessionId(widgetKeyId: string, sessionId: string | null): string {
  // A client that sent no session id still gets its exchange stored, as a
  // conversation of its own.
  return `web:${widgetKeyId}:${sessionId ?? `anon-${randomUUID()}`}`;
}

async function writeTranscript(db: PublicChatPrisma, transcript: PublicChatTranscript, at: Date): Promise<void> {
  const sessionId = widgetConversationSessionId(transcript.widgetKeyId, transcript.sessionId);
  // Outside the transaction: two first messages of one session can race on
  // the unique (orgId, sessionId), and a unique violation inside a
  // transaction would abort it. Here it surfaces as a rejection the core
  // logs; the next message finds the row.
  const conversation = await db.conversation.upsert({
    where: { orgId_sessionId: { orgId: transcript.orgId, sessionId } },
    create: {
      orgId: transcript.orgId,
      agentId: transcript.agentId,
      sessionId,
      title: transcript.userMessage.slice(0, 80),
      metadata: { channel: "web", origin: transcript.origin, widgetKeyId: transcript.widgetKeyId },
    },
    update: {},
    select: { id: true },
  });
  await db.$transaction(async (tx) => {
    // The increment is the row lock: two exchanges of one conversation
    // cannot be handed the same sequence numbers.
    const { messageCount } = await tx.conversation.update({
      where: { id: conversation.id },
      data: { messageCount: { increment: 2 }, lastMessageAt: at },
      select: { messageCount: true },
    });
    await tx.message.createMany({
      data: [
        {
          conversationId: conversation.id,
          role: "user",
          content: transcript.userMessage,
          sequenceNum: messageCount - 1,
        },
        {
          conversationId: conversation.id,
          role: "assistant",
          content: transcript.assistantMessage,
          sequenceNum: messageCount,
        },
      ],
    });
  });
}

export function bindPublicChatDeps(bindings: PublicChatBindings): PublicChatDeps {
  const { prisma: db, secret } = bindings;
  const now = bindings.now ?? (() => new Date());

  return {
    limiter: bindings.limiter,
    limits: bindings.limits,
    // Keyed: neither Redis nor a session token holds a readable address.
    bucketOf: (ip) => hashBucket(ipBucket(ip), secret),
    appOrigins: bindings.appOrigins,

    // The publishable key IS the lookup: there is no caller organization to
    // scope by. The agent it names is then loaded scoped to the key's own
    // organization (prepareAgentChat), so a key can only ever reach an agent
    // of the organization that created it.
    //
    // The key of an agent's public page also carries whether use of that
    // agent is sold at a price, which loadLiveWidgetKey holds it to. A key
    // that is switched off or revoked answers nobody already, and a key
    // made for a website is not held to the listing: neither costs a read.
    // A listing that cannot be read leaves the page key not found: free
    // use of a priced agent is never the fallback.
    loadWidgetKey: async (publicKey) => {
      const key = await db.widgetKey.findUnique({ where: { publicKey }, select: WIDGET_KEY_COLUMNS });
      if (!key || key.pageOfAgentId == null || !key.enabled || key.revokedAt !== null) return key;
      try {
        return { ...key, soldAtAPrice: await pageSoldAtAPrice(db, key.pageOfAgentId) };
      } catch (err) {
        (bindings.logger ?? logger).error(
          { err, widgetKeyId: key.id },
          "a page key was refused: the listing of its agent could not be read",
        );
        return null;
      }
    },

    loadTrialListing: async (slug) => {
      const listing = await db.agentListing.findFirst({
        where: { slug, status: "published" },
        select: {
          id: true,
          slug: true,
          agentId: true,
          publisherId: true,
          trialFundedDailyCap: true,
          // What the listing sells, and the instructions a held answer is
          // checked against when it sells use. Neither reaches a visitor.
          sells: true,
          agent: { select: { orgId: true, entrypoint: true, systemPrompt: true } },
        },
      });
      if (!listing) return null;
      return {
        id: listing.id,
        slug: listing.slug,
        agentId: listing.agentId,
        agentOrgId: listing.agent.orgId,
        publisherId: listing.publisherId,
        agentEntrypoint: listing.agent.entrypoint,
        trialFundedDailyCap: listing.trialFundedDailyCap,
        sells: listing.sells,
        agentInstructions: listing.agent.systemPrompt,
      };
    },

    verifyTrialSession: (args) => verifyTrialSession(args, { secret, now }),
    anonymousTrialAllowed: () => bindings.turnstileConfigured,
    trialModelId: () => bindings.freeModelIds()[0] ?? null,

    meterOwnerCall: async (orgId) => {
      try {
        await bindings.meterApiCall(orgId);
        return true;
      } catch (err) {
        if (err instanceof PlanLimitError) return false;
        throw err;
      }
    },

    ...(bindings.holdFundedMessage && { holdFundedMessage: bindings.holdFundedMessage }),

    prepareChat: (input) => prepareAgentChat(input, bindings.agentChatDeps()),

    writeTranscript: (transcript) => writeTranscript(db, transcript, now()),

    // Compare-and-set on the value that was read: of many requests that all
    // saw the same stale lastUsedAt, one writes.
    markKeyUsed: async ({ id, previous, at }) => {
      await db.widgetKey.updateMany({ where: { id, lastUsedAt: previous }, data: { lastUsedAt: at } });
    },

    recordPlatformTrialMessage: async ({ listingId, day }) => {
      await db.trialDailyUsage.upsert({
        where: { listingId_day: { listingId, day } },
        create: { listingId, day, baseCount: 1 },
        update: { baseCount: { increment: 1 } },
      });
    },

    now,
    logger: bindings.logger,
  };
}

/** The limits as the environment states them. */
export function publicChatLimitsFromEnv(): PublicChatLimitConfig {
  return {
    widget: {
      perIpPerMinute: env.WIDGET_PER_IP_PER_MINUTE,
      perIpPerDay: env.WIDGET_PER_IP_PER_DAY,
      perKeyPerMinute: env.WIDGET_PER_KEY_PER_MINUTE,
      defaultDailyCap: env.WIDGET_DEFAULT_DAILY_CAP,
    },
    trial: {
      perIpPerHour: env.TRIAL_PER_IP_PER_HOUR,
      messagesPerSession: env.TRIAL_MESSAGES_PER_SESSION,
      signedInPerDay: env.TRIAL_SIGNED_IN_PER_DAY,
      globalPerMinute: env.TRIAL_GLOBAL_PER_MINUTE,
      baseDailyMessages: env.TRIAL_BASE_DAILY_MESSAGES,
    },
    maxOutputTokens: PUBLIC_CHAT_MAX_OUTPUT_TOKENS,
    maxToolRounds: PUBLIC_CHAT_MAX_TOOL_ROUNDS,
  };
}

/** The platform's own web origins: always allowed to load a widget (preview). */
export function publicChatAppOrigins(): string[] {
  return [env.CORS_ORIGIN, env.PUBLIC_WEB_URL].filter((origin): origin is string => Boolean(origin));
}

export interface BuildPublicChatDepsOptions {
  /**
   * The publisher-funded Try it hold (services/trialFunding.ts). Omitted =
   * funded messages are not configured, and a listing has only the
   * platform's daily ones.
   */
  holdFundedMessage?: PublicChatDeps["holdFundedMessage"];
}

let chatDeps: AgentChatDeps | null = null;

export function buildPublicChatDeps(options: BuildPublicChatDepsOptions = {}): PublicChatDeps {
  return bindPublicChatDeps({
    prisma: prisma as unknown as PublicChatPrisma,
    limiter: publicChatLimiter,
    limits: publicChatLimitsFromEnv(),
    secret: env.JWT_SECRET,
    appOrigins: publicChatAppOrigins(),
    turnstileConfigured: Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY),
    freeModelIds: () => getAvailableFreeModels().map((model) => model.id),
    meterApiCall: (orgId) => meterApiCall(orgId),
    // A public caller brings no functions of its own, so there is no
    // hand-back to resume and no continuation store to open.
    agentChatDeps: () => (chatDeps ??= buildAgentChatDeps({ continuations: false })),
    holdFundedMessage: options.holdFundedMessage,
    logger,
  });
}

/**
 * The publisher-funded hold, when a funded message has a price. Without one
 * there is none: a listing then has only the platform's daily messages, and
 * setting a funded cap answers 501 (routes/tryIt.ts).
 */
export function fundedHoldFromEnv(): PublicChatDeps["holdFundedMessage"] {
  const cents = env.TRIAL_FUNDED_MESSAGE_CENTS;
  if (cents === undefined) return undefined;
  const funding = createTrialFunding(prisma as unknown as TrialFundingDb, { messageCents: () => BigInt(cents) });
  return (args) => funding.hold(args);
}

let production: PublicChatDeps | null = null;

/**
 * The one set of public chat deps of this process. The widget routes and the
 * Try it routes both take it, so they share limits, counters and charges.
 */
export function productionPublicChatDeps(): PublicChatDeps {
  return (production ??= buildPublicChatDeps({ holdFundedMessage: fundedHoldFromEnv() }));
}
