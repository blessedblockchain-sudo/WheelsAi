/**
 * Public chat: the one service behind every chat with somebody nobody can
 * identify - the web chat widget on an owner's site, and Try it on a
 * marketplace listing.
 *
 * It is not a second chat implementation. The chat itself is
 * prepareAgentChat (services/agentChat.ts), the core behind the playground
 * and /v1, called as a `public` caller: no system or tool messages, no
 * caller-chosen model, no caller tools, the `public` tool mode (nothing that
 * spends, writes, reads the agent's saved data or sends a request out), and
 * a free-tier limiter that fails closed. What this file adds is everything
 * that has to be true BEFORE an anonymous request reaches that core, in one
 * fixed order:
 *
 *   1. limit      the visitor's address, on a limiter that fails closed: if
 *                 it cannot count, the request is refused (503). Nothing
 *                 below runs for a request that was not counted - no lookup,
 *                 no meter, no model.
 *   2. key or     the widget's publishable key (enabled, not revoked), or
 *      listing    the published listing. Unknown is 404.
 *   3. origin     widget only: the request's Origin is one the owner listed.
 *   4. human      Try it only: the session token from the sign-in or
 *      check      Turnstile check, bound to this listing and this network.
 *   5. model      the agent's own for the widget; a platform free model for
 *                 Try it. Never anything the request names. (agentChat
 *                 steps 1-3.)
 *   6. budget     this surface's own first: the key's per-minute limit and
 *                 daily cap and the owner's plan for the widget; the session,
 *                 the listing's platform-funded messages for the day and then
 *                 the publisher-funded ones for Try it. Then the
 *                 organization's free-model allowance (the widget only; the
 *                 platform pays for Try it), so a key's cap bounds what its
 *                 visitors can spend of it. Then the marketplace charge of a
 *                 per-request install. (agentChat steps 4-5; `admit` opens
 *                 step 4.)
 *   7. chat
 *
 * Budget comes after model on purpose: a request that could never have run
 * (no model configured) uses up nobody's cap.
 *
 * What a visitor is told is this file's own vocabulary. The core's refusals
 * carry the buyer's balance, the listing's title, the plan's name and the
 * provider's error text; none of that crosses. A refusal here is a status, a
 * code and at most a reason from a fixed list.
 *
 * Money: a visitor is never charged. A widget chat on a per-request install
 * charges the install's owner through the core (settled or refunded exactly
 * once, there). A publisher-funded Try it message is held in step 6 and
 * settled or refunded exactly once here: `complete` does it itself, and a
 * stream hands back one meter for forwardAndSettle (services/sseReply.ts),
 * because only the socket knows whether the answer arrived.
 *
 * Pure core: every effect is a dependency (services/buildPublicChatDeps.ts
 * binds the real ones), so the unit tests drive this file with fakes.
 */

import { z } from "zod";

import { PUBLIC_MODEL_ERROR, publicToolCalls, toPublicStream, type PublicToolCall } from "../lib/publicSse.js";
import {
  settleOnce,
  type AgentChatFailure,
  type AgentChatInput,
  type AgentChatRefusal,
  type PrepareAgentChatResult,
} from "./agentChat.js";
import type { SettleableMeter } from "./chatStreamSettlement.js";
import type { FailClosedLimiter, LimitRule } from "./failClosedLimiter.js";
import type { ChatStream, StreamOutcome } from "./mastra-runtime.js";
import type { TrialSessionResult } from "./trialSession.js";
import { originAllowed } from "./widgetKeys.js";

// ============================================
// Request body
// ============================================

/** What a public chat request may carry. The widget and Try it show these. */
export const PUBLIC_CHAT_LIMITS = {
  maxMessages: 20,
  maxMessageChars: 4_000,
  maxTotalChars: 16_000,
} as const;

/** Bounds on what one public message may make an agent do. */
export const PUBLIC_CHAT_MAX_OUTPUT_TOKENS = 1_024;
export const PUBLIC_CHAT_MAX_TOOL_ROUNDS = 3;

/**
 * Only user and assistant text. A `system` or `tool` turn would let a
 * visitor rewrite the agent's instructions or invent a tool result.
 */
const publicMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(PUBLIC_CHAT_LIMITS.maxMessageChars),
  })
  .strict();

const publicMessagesSchema = z
  .array(publicMessageSchema)
  .min(1)
  .max(PUBLIC_CHAT_LIMITS.maxMessages)
  .superRefine((messages, ctx) => {
    const total = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (total > PUBLIC_CHAT_LIMITS.maxTotalChars) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `the conversation is longer than ${PUBLIC_CHAT_LIMITS.maxTotalChars} characters`,
      });
    }
    if (messages[messages.length - 1]?.role !== "user") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "the last message must be the visitor's" });
    }
  });

/**
 * Strict: an unknown key (`model`, `system`, `tools`, `temperature`) is a
 * 400, not something silently ignored - a client that sends one believes it
 * did something.
 */
export const publicChatBodySchema = z
  .object({
    messages: publicMessagesSchema,
    /** The widget's own id for a visitor's conversation; groups a transcript. */
    sessionId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16,64}$/)
      .optional(),
    stream: z.boolean().optional(),
  })
  .strict();

export const trialChatBodySchema = z
  .object({
    messages: publicMessagesSchema,
    sessionToken: z.string().min(1).max(2048),
    stream: z.boolean().optional(),
  })
  .strict();

export type PublicChatBody = z.infer<typeof publicChatBodySchema>;
export type TrialChatBody = z.infer<typeof trialChatBodySchema>;

// ============================================
// Input
// ============================================

export type PublicChatSurface =
  /** `origin` is the request's Origin header, as sent. */
  | { kind: "widget"; publicKey: string; origin: string | null | undefined }
  | { kind: "trial"; listingSlug: string };

export interface PublicChatInput {
  surface: PublicChatSurface;
  /** The visitor's address (request.ip, behind the configured proxy hops). */
  ip: string | null | undefined;
  /** The parsed JSON body, not yet validated. */
  body: unknown;
  /** Fires when the client goes away; the run stops and is refunded. */
  signal: AbortSignal;
}

/** The widget-key columns public chat reads. */
export interface PublicWidgetKey {
  id: string;
  orgId: string;
  agentId: string;
  allowedOrigins: string[];
  dailyMessageCap: number | null;
  perIpPerMinute: number | null;
  storeTranscripts: boolean;
  enabled: boolean;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

/** A published listing and the agent behind it, as Try it reads them. */
export interface TrialListing {
  id: string;
  slug: string;
  /** The publisher's own agent, and the organization it lives in. */
  agentId: string;
  agentOrgId: string;
  publisherId: string;
  /** "chat" or "graph". */
  agentEntrypoint: string | null;
  /** Publisher-funded messages a day, above the platform's. */
  trialFundedDailyCap: number;
}

// ============================================
// Dependencies
// ============================================

export interface PublicChatLimitConfig {
  widget: {
    /** Per address, across every key. */
    perIpPerMinute: number;
    perIpPerDay: number;
    perKeyPerMinute: number;
    /** A key's messages a day when its owner set no cap of their own. */
    defaultDailyCap: number;
  };
  trial: {
    perIpPerHour: number;
    messagesPerSession: number;
    /** Per signed-in organization, across every listing. */
    signedInPerDay: number;
    /** Every Try it message on the platform: it runs on shared free models. */
    globalPerMinute: number;
    /** Messages a day the platform pays for, per listing. */
    baseDailyMessages: number;
  };
  maxOutputTokens: number;
  maxToolRounds: number;
}

export type FundedHoldResult =
  | { ok: true; meter: SettleableMeter }
  /** The publisher's cap for the day is used up, or their credits are. */
  | { ok: false };

export interface PublicChatTranscript {
  orgId: string;
  agentId: string;
  widgetKeyId: string;
  /** null when the client sent none: the writer files it on its own. */
  sessionId: string | null;
  origin: string | null;
  userMessage: string;
  assistantMessage: string;
}

export interface PublicChatDeps {
  limiter: Pick<FailClosedLimiter, "consume">;
  limits: PublicChatLimitConfig;
  /** The keyed bucket of an address (hashBucket(ipBucket(ip))). */
  bucketOf(ip: string | null | undefined): string;
  /** The platform's own web origins: always allowed, for the dashboard preview. */
  appOrigins: readonly string[];
  loadWidgetKey(publicKey: string): Promise<PublicWidgetKey | null>;
  /** MUST return published listings only. */
  loadTrialListing(slug: string): Promise<TrialListing | null>;
  verifyTrialSession(args: { token: string; listingId: string; ipBucketHash: string }): TrialSessionResult;
  /**
   * Whether a visitor who is not signed in may use Try it at all: true only
   * while Turnstile is configured. Asked on every message, so a session
   * issued before the keys were removed stops working with them.
   */
  anonymousTrialAllowed(): boolean;
  /** The platform free model Try it runs on; null when none is configured. */
  trialModelId(): string | null;
  /**
   * Counts one call against the owner's plan. false = the plan's calls for
   * the month are used up.
   */
  meterOwnerCall(orgId: string): Promise<boolean>;
  /**
   * Holds one publisher-funded Try it message: debits the publisher and
   * returns the meter that settles or refunds it. Omitted = the price of a
   * funded message is not configured, so there are none.
   */
  holdFundedMessage?(args: {
    listingId: string;
    publisherId: string;
    day: string;
    dailyCap: number;
  }): Promise<FundedHoldResult>;
  /** prepareAgentChat, bound to its production deps. */
  prepareChat(input: AgentChatInput): Promise<PrepareAgentChatResult>;
  /** Best effort: a rejection is logged and never reaches the visitor. */
  writeTranscript?(transcript: PublicChatTranscript): Promise<void>;
  /** Best effort. Called at most once per KEY_USED_EVERY_MS per key. */
  markKeyUsed?(key: { id: string; previous: Date | null; at: Date }): Promise<void>;
  /** Best effort: one platform-funded Try it message was answered. */
  recordPlatformTrialMessage?(args: { listingId: string; day: string }): Promise<void>;
  now?: () => Date;
  logger?: {
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

// ============================================
// Results
// ============================================

export type PublicChatErrorCode =
  | "invalid_request"
  | "trial_session_invalid"
  | "origin_not_allowed"
  | "widget_key_not_found"
  | "listing_not_found"
  | "rate_limited"
  | "trial_cap_reached"
  | "client_closed_request"
  | "not_supported"
  | "model_error"
  | "rate_limiter_unavailable"
  | "agent_unavailable";

export type AgentUnavailableReason =
  | "quota_exhausted"
  | "payment_required"
  | "licence_revoked"
  | "model_not_configured"
  | "agent_misconfigured"
  | "restarting";

/** What the visitor's limit was counted against. */
export type PublicLimitScope = "ip" | "key" | "session" | "org" | "global" | "agent";

/** Everything a visitor is told about a request that was not answered. */
export interface PublicChatRefusal {
  status: 400 | 401 | 403 | 404 | 429 | 499 | 501 | 502 | 503;
  code: PublicChatErrorCode;
  /** Written for a stranger: no balances, plan names, model or env names. */
  message: string;
  reason?: string;
  scope?: PublicLimitScope;
  /** Also the Retry-After header. */
  retryAfterSeconds?: number;
  /** trial_cap_reached: when the listing's day starts over (ISO, UTC). */
  resetsAt?: string;
}

export type PublicChatResult =
  | { kind: "refused"; refusal: PublicChatRefusal }
  | {
      kind: "answer";
      message: { role: "assistant"; content: string };
      toolCalls: PublicToolCall[];
    }
  | {
      kind: "stream";
      /** Already in the public encoding (lib/publicSse.ts). */
      chat: ChatStream;
      /**
       * Every charge behind this answer. The caller MUST forward the stream
       * with streamToReply / forwardAndSettle and this meter.
       */
      meter: SettleableMeter | null;
      /**
       * Call with the outcome forwardAndSettle returned (it knows about
       * delivery): writes the opted-in transcript and the usage record of an
       * answer that arrived. Never throws.
       */
      finished(outcome: StreamOutcome): Promise<void>;
    };

/** The JSON body of a refusal. */
export function publicRefusalBody(refusal: PublicChatRefusal): Record<string, unknown> {
  return {
    error: refusal.code,
    message: refusal.message,
    ...(refusal.reason !== undefined && { reason: refusal.reason }),
    ...(refusal.scope !== undefined && { scope: refusal.scope }),
    ...(refusal.retryAfterSeconds !== undefined && { retryAfterSeconds: refusal.retryAfterSeconds }),
    ...(refusal.resetsAt !== undefined && { resetsAt: refusal.resetsAt }),
  };
}

// ============================================
// Limiter keys
// ============================================

/** UTC `YYYY-MM-DD`: the day a daily cap belongs to. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The limiter keys, in one place: the routes that show an owner today's
 * usage read the same keys this file counts on.
 */
export const publicChatKeys = {
  widgetIpMinute: (bucket: string) => `w:ip:m:${bucket}`,
  widgetIpDay: (bucket: string, day: string) => `w:ip:d:${day}:${bucket}`,
  widgetKeyMinute: (keyId: string) => `w:key:m:${keyId}`,
  /** A key's messages on one UTC day; what its daily cap counts. */
  widgetKeyDay: (keyId: string, day: string) => `w:key:d:${day}:${keyId}`,
  widgetKeyIpMinute: (keyId: string, bucket: string) => `w:kip:m:${keyId}:${bucket}`,
  /** Loading a widget's configuration (routes/widget.ts). */
  widgetConfigIpMinute: (bucket: string) => `w:cfg:m:${bucket}`,
  trialIpHour: (bucket: string) => `t:ip:h:${bucket}`,
  trialSession: (sessionId: string) => `t:sess:${sessionId}`,
  /** Opening Try it sessions (routes/tryIt.ts). */
  trialSessionIpHour: (bucket: string) => `t:new:ip:h:${bucket}`,
  trialSessionOrgHour: (orgId: string) => `t:new:org:h:${orgId}`,
  trialOrgDay: (orgId: string, day: string) => `t:org:d:${day}:${orgId}`,
  trialGlobalMinute: () => "t:global:m",
  /** A listing's platform-funded messages on one UTC day. */
  trialListingDay: (listingId: string, day: string) => `t:listing:d:${day}:${listingId}`,
} as const;

const MINUTE = 60;
const HOUR = 3_600;

/**
 * Seconds until the UTC day of `at` ends. A daily counter's key carries its
 * day, so the count starts over at midnight UTC whatever the counter's age;
 * giving it this as its window makes the Retry-After of a daily refusal the
 * time until then, not 24 hours from the day's first message.
 */
export function secondsLeftInUtcDay(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
}

/** How often a key's lastUsedAt is rewritten, at most. */
export const KEY_USED_EVERY_MS = 5 * 60_000;

// ============================================
// Refusals
// ============================================

const refused = (refusal: PublicChatRefusal): PublicChatResult => ({ kind: "refused", refusal });

const LIMITER_UNAVAILABLE: PublicChatRefusal = {
  status: 503,
  code: "rate_limiter_unavailable",
  message: "Chat is temporarily unavailable. Please try again shortly.",
  retryAfterSeconds: 30,
};

const UNAVAILABLE_MESSAGES: Record<AgentUnavailableReason, string> = {
  quota_exhausted: "This agent has reached its usage limit for now. Please try again later.",
  payment_required: "This agent is not available right now.",
  licence_revoked: "This agent is not available right now.",
  model_not_configured: "This agent is not available right now.",
  agent_misconfigured: "This agent is not available right now.",
  restarting: "Chat is restarting. Please try again in a moment.",
};

function agentUnavailable(reason: AgentUnavailableReason, retryAfterSeconds?: number): PublicChatRefusal {
  return {
    status: 503,
    code: "agent_unavailable",
    message: UNAVAILABLE_MESSAGES[reason],
    reason,
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
  };
}

function rateLimited(scope: PublicLimitScope, retryAfterSeconds: number): PublicChatRefusal {
  return {
    status: 429,
    code: "rate_limited",
    message: "Too many messages. Please wait a moment and try again.",
    scope,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  };
}

const CLIENT_GONE_REFUSAL: PublicChatRefusal = {
  status: 499,
  code: "client_closed_request",
  message: "The request was cancelled.",
};

const MODEL_ERROR: PublicChatRefusal = {
  status: 502,
  code: PUBLIC_MODEL_ERROR.code,
  message: PUBLIC_MODEL_ERROR.message,
};

const SCOPES = new Set<string>(["ip", "key", "session", "org", "global", "agent"]);

/** A refusal thrown out of the core's `admit` hook; caught in runPublicChat. */
class AdmissionRefused extends Error {
  constructor(readonly refusal: PublicChatRefusal) {
    super(refusal.code);
    this.name = "AdmissionRefused";
  }
}

/**
 * The core's refusal, as a visitor may hear it. `notFound` is this surface's
 * own "no such thing" (the agent behind a key or a listing is gone).
 */
export function publicRefusalOf(
  refusal: AgentChatRefusal,
  notFound: "widget_key_not_found" | "listing_not_found",
  nowSeconds: number,
): PublicChatRefusal {
  switch (refusal.kind) {
    case "agent_not_found":
      return { status: 404, code: notFound, message: "Not found." };
    case "invalid_request":
      // An agent set to answer through a graph it does not have is its
      // owner's to fix, not something the visitor sent wrong.
      if (refusal.code === "agent_graph_missing") return agentUnavailable("agent_misconfigured");
      return {
        status: 400,
        code: "invalid_request",
        message: "This agent accepts only user and assistant text messages.",
      };
    case "not_configured":
    case "model_invalid":
    case "hosted_model_unavailable":
      // The core's message names the provider key that is missing.
      return agentUnavailable("model_not_configured");
    case "rate_limited": {
      const { remaining, resetAt } = refusal.limit;
      // Whichever window is used up; the daily one when both are.
      const reset = remaining.rpd <= 0 ? resetAt.rpd : resetAt.rpm;
      return rateLimited("agent", reset - nowSeconds);
    }
    case "licence_revoked":
      return agentUnavailable("licence_revoked");
    case "payment_required":
      // The core's refusal carries the owner's balance. It stops here.
      return agentUnavailable("payment_required");
    case "shutting_down":
      return agentUnavailable("restarting", 5);
    case "client_gone":
      return CLIENT_GONE_REFUSAL;
  }
}

/** A chat that was admitted and produced no answer; its charge is refunded. */
export function publicFailureOf(failure: AgentChatFailure): PublicChatRefusal {
  if (failure.code === "client_gone") return CLIENT_GONE_REFUSAL;
  if (failure.code === "service_unavailable") return agentUnavailable("restarting", 5);
  // Everything else is the model's or ours, and its text is the provider's.
  return MODEL_ERROR;
}

function invalidBody(error: z.ZodError): PublicChatRefusal {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return {
    status: 400,
    code: "invalid_request",
    // zod's own messages describe the request's shape, nothing of ours.
    message: issue ? `${where}${issue.message}` : "The request body is not valid.",
  };
}

function joinMeters(meters: Array<SettleableMeter | null>): SettleableMeter | null {
  const live = meters.filter((meter): meter is SettleableMeter => meter !== null);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0]!;
  // Each is closed whatever happens to the other: one charge failing to
  // settle is not a reason to leave the second one open.
  const all = async (close: (meter: SettleableMeter) => Promise<void>) => {
    const results = await Promise.allSettled(live.map(close));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  };
  return {
    settle: () => all((meter) => meter.settle()),
    refund: (reason) => all((meter) => meter.refund(reason)),
  };
}

/**
 * Counts one request against every rule, or refuses: `unavailable` and
 * `limited` as what a visitor is told, null when every rule was counted.
 * The routes around the chat (a widget's configuration, opening a Try it
 * session) limit with this too, so they fail closed the same way.
 */
export async function consumePublicLimit(
  limiter: Pick<FailClosedLimiter, "consume">,
  rules: LimitRule[],
  surface: string,
  logger?: PublicChatDeps["logger"],
): Promise<PublicChatRefusal | null> {
  const decision = await limiter.consume(rules);
  if (decision.status === "ok") return null;
  if (decision.status === "limited") {
    const scope = SCOPES.has(decision.scope) ? (decision.scope as PublicLimitScope) : "ip";
    return rateLimited(scope, decision.retryAfterSeconds);
  }
  // Anything that is not a count is "could not count": refuse.
  logger?.error({ surface }, "public chat refused: the rate limiter is unavailable");
  return LIMITER_UNAVAILABLE;
}

// ============================================
// The service
// ============================================

export async function runPublicChat(input: PublicChatInput, deps: PublicChatDeps): Promise<PublicChatResult> {
  const now = (deps.now ?? (() => new Date()))();
  const day = utcDay(now);
  const dayLeft = secondsLeftInUtcDay(now);
  const { surface } = input;
  const { limits } = deps;

  const consume = (rules: LimitRule[]) => consumePublicLimit(deps.limiter, rules, surface.kind, deps.logger);

  // 1. The address, before anything is looked up.
  const bucket = deps.bucketOf(input.ip);
  const addressLimit = await consume(
    surface.kind === "widget"
      ? [
          {
            scope: "ip",
            key: publicChatKeys.widgetIpMinute(bucket),
            limit: limits.widget.perIpPerMinute,
            windowSeconds: MINUTE,
          },
          {
            scope: "ip",
            key: publicChatKeys.widgetIpDay(bucket, day),
            limit: limits.widget.perIpPerDay,
            windowSeconds: dayLeft,
          },
        ]
      : [
          {
            scope: "ip",
            key: publicChatKeys.trialIpHour(bucket),
            limit: limits.trial.perIpPerHour,
            windowSeconds: HOUR,
          },
        ],
  );
  if (addressLimit) return refused(addressLimit);

  // The body is read here, not trusted: no lookup depends on it yet.
  const parsed =
    surface.kind === "widget"
      ? publicChatBodySchema.safeParse(input.body)
      : trialChatBodySchema.safeParse(input.body);
  if (!parsed.success) return refused(invalidBody(parsed.error));
  const body = parsed.data;
  const lastUserMessage = body.messages[body.messages.length - 1]!.content;

  /** A publisher-funded Try it message, once one is held. */
  let funded: SettleableMeter | null = null;
  /** Who pays for this Try it message; null for the widget. */
  let trialFunding: "platform" | "publisher" | null = null;
  let chatInput: AgentChatInput;
  let widgetKey: PublicWidgetKey | null = null;
  let trialListing: TrialListing | null = null;
  const notFound = surface.kind === "widget" ? "widget_key_not_found" : "listing_not_found";

  const bounds = {
    caller: "public" as const,
    messages: body.messages,
    signal: input.signal,
    maxOutputTokens: limits.maxOutputTokens,
    maxToolRounds: limits.maxToolRounds,
  };

  if (surface.kind === "widget") {
    // 2. The key. Revoked and disabled keys are as unknown as a wrong one:
    // nothing tells a stranger which.
    const key = await deps.loadWidgetKey(surface.publicKey);
    if (!key || !key.enabled || key.revokedAt !== null) {
      return refused({ status: 404, code: "widget_key_not_found", message: "Not found." });
    }
    widgetKey = key;

    // 3. The origin, before the key's own budgets: a site that is not allowed
    // to use the key must not be able to use up its daily cap.
    if (!originAllowed(surface.origin, key.allowedOrigins, deps.appOrigins)) {
      return refused({
        status: 403,
        code: "origin_not_allowed",
        message: "This site is not allowed to use this chat widget.",
      });
    }

    chatInput = {
      ...bounds,
      orgId: key.orgId,
      agent: { id: key.agentId },
      source: "widget",
      // 6. The key's budgets, then the owner's plan.
      admit: async () => {
        const keyLimit = await consume([
          {
            scope: "key",
            key: publicChatKeys.widgetKeyMinute(key.id),
            limit: limits.widget.perKeyPerMinute,
            windowSeconds: MINUTE,
          },
          {
            scope: "key",
            key: publicChatKeys.widgetKeyDay(key.id, day),
            limit: key.dailyMessageCap ?? limits.widget.defaultDailyCap,
            windowSeconds: dayLeft,
          },
          ...(key.perIpPerMinute !== null
            ? [
                {
                  scope: "ip",
                  key: publicChatKeys.widgetKeyIpMinute(key.id, bucket),
                  limit: key.perIpPerMinute,
                  windowSeconds: MINUTE,
                },
              ]
            : []),
        ]);
        if (keyLimit) throw new AdmissionRefused(keyLimit);
        // Widget messages are the owner's API calls: without this they would
        // bypass the plan altogether.
        if (!(await deps.meterOwnerCall(key.orgId))) {
          throw new AdmissionRefused(agentUnavailable("quota_exhausted"));
        }
      },
    };
  } else {
    // 2. The listing.
    const listing = await deps.loadTrialListing(surface.listingSlug);
    if (!listing) return refused({ status: 404, code: "listing_not_found", message: "Not found." });
    trialListing = listing;

    // 4. The human check: a session from a sign-in or a Turnstile pass, for
    // this listing, on this network.
    const session = deps.verifyTrialSession({
      token: (body as TrialChatBody).sessionToken,
      listingId: listing.id,
      ipBucketHash: bucket,
    });
    if (!session.ok) {
      return refused({
        status: 401,
        code: "trial_session_invalid",
        message: "Your Try it session has ended. Start a new one to keep chatting.",
        reason: session.reason,
      });
    }
    if (session.orgId === null && !deps.anonymousTrialAllowed()) {
      return refused({
        status: 401,
        code: "trial_session_invalid",
        message: "Sign in to try this agent.",
        reason: "signin_required",
      });
    }

    // 5. The model: the platform's, never the publisher's keys.
    if (listing.agentEntrypoint === "graph") {
      // A graph's nodes choose their own models and provider keys, so it
      // cannot be run at the platform's expense. Said as what it is.
      return refused({
        status: 501,
        code: "not_supported",
        message: "This agent answers through a graph, which cannot be previewed yet.",
        reason: "graph_agent_preview",
      });
    }
    const modelId = deps.trialModelId();
    if (!modelId) return refused(agentUnavailable("model_not_configured"));

    chatInput = {
      ...bounds,
      orgId: listing.agentOrgId,
      agent: { id: listing.agentId },
      source: "trial",
      platformFunded: { modelId },
      // 6. The session and the platform's shared capacity, then who pays.
      admit: async () => {
        const sessionLimit = await consume([
          {
            scope: "session",
            key: publicChatKeys.trialSession(session.sessionId),
            limit: limits.trial.messagesPerSession,
            // The session cannot outlive this window (trialSession.ts).
            windowSeconds: HOUR,
          },
          ...(session.orgId !== null
            ? [
                {
                  scope: "org",
                  key: publicChatKeys.trialOrgDay(session.orgId, day),
                  limit: limits.trial.signedInPerDay,
                  windowSeconds: dayLeft,
                },
              ]
            : []),
          {
            scope: "global",
            key: publicChatKeys.trialGlobalMinute(),
            limit: limits.trial.globalPerMinute,
            windowSeconds: MINUTE,
          },
        ]);
        if (sessionLimit) throw new AdmissionRefused(sessionLimit);

        // The platform's messages for the day first; the publisher pays only
        // for what comes after them.
        const decision = await deps.limiter.consume([
          {
            scope: "listing",
            key: publicChatKeys.trialListingDay(listing.id, day),
            limit: limits.trial.baseDailyMessages,
            windowSeconds: dayLeft,
          },
        ]);
        if (decision.status === "ok") {
          trialFunding = "platform";
          return;
        }
        if (decision.status !== "limited") {
          deps.logger?.error({ surface: surface.kind }, "public chat refused: the rate limiter is unavailable");
          throw new AdmissionRefused(LIMITER_UNAVAILABLE);
        }
        if (listing.trialFundedDailyCap > 0 && deps.holdFundedMessage) {
          const hold = await deps.holdFundedMessage({
            listingId: listing.id,
            publisherId: listing.publisherId,
            day,
            dailyCap: listing.trialFundedDailyCap,
          });
          if (hold.ok) {
            funded = settleOnce(hold.meter);
            trialFunding = "publisher";
            return;
          }
        }
        const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        throw new AdmissionRefused({
          status: 429,
          code: "trial_cap_reached",
          message: "This listing's free messages for today are used up. Try again tomorrow, or install it.",
          resetsAt: tomorrow.toISOString(),
          retryAfterSeconds: dayLeft,
        });
      },
    };
  }

  // `funded` is assigned inside admit, which the compiler cannot follow.
  const heldFunding = () => funded as SettleableMeter | null;
  const nowSeconds = Math.floor(now.getTime() / 1000);

  // 5-6. Model and budget, in the core's order (see the header).
  let prepared: PrepareAgentChatResult;
  try {
    prepared = await deps.prepareChat(chatInput);
  } catch (err) {
    // The publisher was debited for a message that will not be answered.
    await heldFunding()?.refund("the chat could not be started");
    if (err instanceof AdmissionRefused) return refused(err.refusal);
    throw err;
  }
  if (!prepared.ok) {
    await heldFunding()?.refund("the chat was refused");
    return refused(publicRefusalOf(prepared.refusal, notFound, nowSeconds));
  }
  const { session } = prepared;

  if (widgetKey && deps.markKeyUsed) {
    const previous = widgetKey.lastUsedAt;
    if (!previous || now.getTime() - previous.getTime() >= KEY_USED_EVERY_MS) {
      void deps
        .markKeyUsed({ id: widgetKey.id, previous, at: now })
        .catch((err) => deps.logger?.warn({ err, widgetKeyId: widgetKey?.id }, "failed to mark a widget key used"));
    }
  }

  /** What follows an answer that reached the visitor. Never throws. */
  const delivered = async (content: string): Promise<void> => {
    if (trialListing && (trialFunding as "platform" | "publisher" | null) === "platform") {
      await deps
        .recordPlatformTrialMessage?.({ listingId: trialListing.id, day })
        .catch((err) => deps.logger?.warn({ err }, "failed to record a platform-funded trial message"));
    }
    // Stored only when the key's owner opted in, and only what was answered.
    if (widgetKey?.storeTranscripts && deps.writeTranscript && content.length > 0) {
      const origin = surface.kind === "widget" ? (surface.origin ?? null) : null;
      await deps
        .writeTranscript({
          orgId: widgetKey.orgId,
          agentId: widgetKey.agentId,
          widgetKeyId: widgetKey.id,
          sessionId: (body as PublicChatBody).sessionId ?? null,
          origin,
          userMessage: lastUserMessage,
          assistantMessage: content,
        })
        .catch((err) => deps.logger?.warn({ err, widgetKeyId: widgetKey?.id }, "failed to store a widget transcript"));
    }
  };

  // 7. The chat. Streaming is the default: it is what a chat window wants.
  if (body.stream === false) {
    const completed = await session.complete();
    if (!completed.ok) {
      await heldFunding()?.refund("the chat produced no answer");
      return refused(
        completed.refusal
          ? publicRefusalOf(completed.refusal, notFound, nowSeconds)
          : publicFailureOf(completed.failure),
      );
    }
    await heldFunding()?.settle();
    await delivered(completed.result.content);
    return {
      kind: "answer",
      message: { role: "assistant", content: completed.result.content },
      toolCalls: publicToolCalls(completed.result.toolCalls),
    };
  }

  const started = await session.stream();
  if (!started.ok) {
    await heldFunding()?.refund("the chat produced no answer");
    return refused(
      started.refusal ? publicRefusalOf(started.refusal, notFound, nowSeconds) : publicFailureOf(started.failure),
    );
  }
  return {
    kind: "stream",
    chat: toPublicStream(started.chat),
    meter: joinMeters([session.meter, heldFunding()]),
    finished: async (outcome) => {
      if (outcome.ok) await delivered(outcome.content ?? "");
    },
  };
}
