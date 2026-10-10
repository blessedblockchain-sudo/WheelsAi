/**
 * Try it: chatting with a marketplace listing's agent, for free and within
 * limits, before installing or hiring it. Mounted beside the marketplace
 * routes at /api/marketplace.
 *
 *   GET   /listings/:slug/try           what the panel shows       public
 *   POST  /listings/:slug/try/session   the human check, once      public
 *   POST  /listings/:slug/try/chat      one message                public
 *   GET   /listings/:id/trial           the publisher's settings   publisher
 *   PATCH /listings/:id/trial           the publisher-funded cap   owner, admin
 *
 * Try it is on for every published listing. It runs the publisher's own
 * agent on a free model the platform provides, never on the publisher's
 * keys, with nothing that spends, writes, reads saved data or sends a
 * request out (the `public` tool mode). The visitor is never charged.
 *
 * Who may start a session: someone signed in, or an anonymous visitor who
 * passed a Turnstile check. While Turnstile is not configured the second
 * door does not exist: an anonymous visitor is told to sign in. It never
 * runs unprotected (and services/publicChat.ts refuses an anonymous session
 * on every message while the keys are unset, whatever this file does).
 *
 * The chat, its limits and its money are services/publicChat.ts.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";

import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import type { FailClosedLimiter, LimitRule } from "../services/failClosedLimiter.js";
import {
  consumePublicLimit,
  PUBLIC_CHAT_LIMITS,
  publicChatKeys,
  runPublicChat,
  utcDay,
  type PublicChatDeps,
} from "../services/publicChat.js";
import { issueTrialSession } from "../services/trialSession.js";
import type { TurnstileResult } from "../services/turnstile.js";
import { installPublicErrorHandler, sendPublicChatResult, sendPublicRefusal } from "./publicChatReply.js";

/** Publisher-funded messages a day a listing may be set to. */
export const MAX_TRIAL_FUNDED_DAILY_CAP = 10_000;

/** A published listing, as the Try it panel needs to describe it. */
export interface TrialPreview {
  id: string;
  /** "chat" or "graph". */
  agentEntrypoint: string | null;
  /** The model the installed agent is configured with; null when it names none. */
  agentModelId: string | null;
  /** The names of the agent's tools. */
  agentTools: string[];
  /** conversation, task or scheduled: which sample the panel draws. Absent = conversation. */
  agentKind?: string;
  /** A task agent's form (publicTaskForm's schema); null for every other kind. */
  inputSchema?: unknown;
}

export interface ListingTrialSettings {
  status: string;
  fundedDailyCap: number;
}

export interface TryItRouteDeps {
  chat: PublicChatDeps;
  sessions: {
    limiter: Pick<FailClosedLimiter, "consume" | "peek">;
    /** Sessions an address, and a signed-in organization, may open an hour. */
    perIpPerHour: number;
    perOrgPerHour: number;
    /** Signs the session token; the one the chat verifies with. */
    secret: string;
    /** null = Turnstile is not configured, so there is no anonymous door. */
    turnstile: {
      siteKey: string;
      verify(args: { token: string | undefined; remoteIp: string; listingId: string }): Promise<TurnstileResult>;
    } | null;
  };
  listings: {
    /** MUST return published listings only. */
    loadPreview(slug: string): Promise<TrialPreview | null>;
    /** Of these tools, the ones a preview withholds. */
    disabledTools(toolNames: string[]): string[] | Promise<string[]>;
    modelLabel(modelId: string): string;
    /** Scoped to the publisher: null for another organization's listing. */
    getSettings(orgId: string, listingId: string): Promise<ListingTrialSettings | null>;
    /** False when the listing is not this organization's. */
    setFundedDailyCap(orgId: string, listingId: string, cap: number): Promise<boolean>;
    fundedToday(listingId: string, day: string): Promise<{ fundedCount: number; fundedSpentCents: number }>;
  };
  /** The price of one publisher-funded message; null = not configured. */
  fundedMessageCents: number | null;
  guards: {
    auth: preHandlerAsyncHookHandler;
    /** An owner or admin, or an API key. */
    manage: preHandlerAsyncHookHandler;
  };
  now?: () => Date;
}

const slugParams = z.object({ slug: z.string().min(1).max(200) });
const idParams = z.object({ id: z.string().uuid() });
const sessionBody = z.object({ turnstileToken: z.string().min(1).max(2048).optional() }).strict();
const settingsBody = z
  .object({ fundedDailyCap: z.number().int().min(0).max(MAX_TRIAL_FUNDED_DAILY_CAP) })
  .strict();

const listingNotFound = (reply: FastifyReply) =>
  sendPublicRefusal(reply, { status: 404, code: "listing_not_found", message: "Not found." });

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.status(400).send({
    error: "invalid_request",
    message: "The request is not valid",
    details: error.issues.map((issue) => ({ path: `/${issue.path.join("/")}`, message: issue.message })),
  });

type Gate = "session" | "turnstile" | "signin";

export function createTryItRoutes(deps: TryItRouteDeps): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());
  const { chat, sessions, listings } = deps;

  /** Why this listing cannot be previewed at all, or null when it can. */
  const unavailable = (preview: TrialPreview): "graph_agent_preview" | "no_model_available" | null => {
    if (preview.agentEntrypoint === "graph") return "graph_agent_preview";
    return chat.trialModelId() ? null : "no_model_available";
  };

  const gateFor = (signedIn: boolean): Gate => (signedIn ? "session" : sessions.turnstile ? "turnstile" : "signin");

  const publicRoutes: FastifyPluginAsync = async (app) => {
    // In a scope of its own: the publisher's routes below keep the API's
    // error handler (a plan limit hit by an API key is theirs to read).
    installPublicErrorHandler(app);

    app.get("/listings/:slug/try", async (request, reply) => {
      const params = slugParams.safeParse(request.params);
      if (!params.success) return listingNotFound(reply);
      const preview = await listings.loadPreview(params.data.slug);
      if (!preview) return listingNotFound(reply);

      const disabledReason = unavailable(preview);
      const modelId = chat.trialModelId();
      // A different model than the installed agent's is said, not hidden:
      // the preview's answers are the free model's.
      const substituted = modelId !== null && preview.agentModelId !== modelId;
      const gate = gateFor(Boolean(request.auth));

      // The gate depends on who is asking.
      reply.header("cache-control", "private, no-store");
      return {
        enabled: disabledReason === null,
        disabledReason,
        gate,
        turnstileSiteKey: gate === "turnstile" ? sessions.turnstile!.siteKey : null,
        model:
          modelId === null
            ? null
            : {
                id: modelId,
                label: listings.modelLabel(modelId),
                substituted,
                note: substituted
                  ? "This preview runs on a free model that WheelsAI provides. The installed agent is set up with a different model, so its answers can differ."
                  : null,
              },
        limits: {
          messagesPerSession: chat.limits.trial.messagesPerSession,
          maxMessageChars: PUBLIC_CHAT_LIMITS.maxMessageChars,
          maxMessages: PUBLIC_CHAT_LIMITS.maxMessages,
          maxTotalChars: PUBLIC_CHAT_LIMITS.maxTotalChars,
        },
        disabledTools: await listings.disabledTools(preview.agentTools),
        // What the panel draws: a chat, the form of a task, or one "Run a
        // sample" button. The answers are sent as one message on this route.
        agentKind: preview.agentKind ?? "conversation",
        inputSchema: preview.inputSchema ?? null,
      };
    });

    app.post("/listings/:slug/try/session", async (request, reply) => {
      const auth = request.auth;
      const bucket = chat.bucketOf(request.ip);

      // Counted first, on the limiter that fails closed: every attempt, also
      // the ones that fail the check below.
      const rules: LimitRule[] = [
        {
          scope: "ip",
          key: publicChatKeys.trialSessionIpHour(bucket),
          limit: sessions.perIpPerHour,
          windowSeconds: 3_600,
        },
        ...(auth
          ? [
              {
                scope: "org",
                key: publicChatKeys.trialSessionOrgHour(auth.orgId),
                limit: sessions.perOrgPerHour,
                windowSeconds: 3_600,
              },
            ]
          : []),
      ];
      const limited = await consumePublicLimit(sessions.limiter, rules, "trial-session", chat.logger);
      if (limited) return sendPublicRefusal(reply, limited);

      const params = slugParams.safeParse(request.params);
      if (!params.success) return listingNotFound(reply);
      const body = sessionBody.safeParse(request.body ?? {});
      if (!body.success) return invalid(reply, body.error);

      const preview = await listings.loadPreview(params.data.slug);
      if (!preview) return listingNotFound(reply);

      // Before the check: a visitor should not solve a challenge for a
      // listing that cannot be previewed.
      const reason = unavailable(preview);
      if (reason === "graph_agent_preview") {
        return sendPublicRefusal(reply, {
          status: 501,
          code: "not_supported",
          message: "This agent answers through a graph, so Try it cannot preview it. Install it to chat with it.",
          reason,
        });
      }
      if (reason === "no_model_available") {
        return sendPublicRefusal(reply, {
          status: 503,
          code: "agent_unavailable",
          message: "This agent is not available right now.",
          reason: "model_not_configured",
        });
      }

      reply.header("cache-control", "no-store");
      if (!auth) {
        if (!sessions.turnstile) {
          return reply.status(401).send({
            error: "signin_required",
            message: "Sign in to try this agent.",
          });
        }
        const check = await sessions.turnstile.verify({
          token: body.data.turnstileToken,
          remoteIp: request.ip,
          listingId: preview.id,
        });
        if (check.status === "required") {
          return reply.status(400).send({
            error: "turnstile_required",
            message: "Complete the check to start chatting.",
          });
        }
        if (check.status === "failed") {
          return reply.status(403).send({
            error: "turnstile_failed",
            message: "The check did not pass. Please try it again.",
            codes: check.codes,
          });
        }
        if (check.status !== "ok") {
          // Could not be checked is not a pass.
          return reply.status(503).header("retry-after", "30").send({
            error: "turnstile_unavailable",
            message: "The check could not be made right now. Please try again shortly, or sign in.",
          });
        }
      }

      const session = issueTrialSession(
        { listingId: preview.id, orgId: auth?.orgId ?? null, ipBucketHash: bucket },
        { secret: sessions.secret, now },
      );
      return {
        sessionToken: session.token,
        expiresAt: session.expiresAt.toISOString(),
        messagesRemaining: chat.limits.trial.messagesPerSession,
      };
    });

    app.post("/listings/:slug/try/chat", { bodyLimit: 64 * 1024 }, async (request, reply) => {
      // Before the first await: a visitor who leaves stops the run, and a
      // publisher-funded message is refunded.
      const abort = abortOnClientClose(reply.raw);
      const params = slugParams.safeParse(request.params);
      if (!params.success) return listingNotFound(reply);

      const result = await runPublicChat(
        {
          surface: { kind: "trial", listingSlug: params.data.slug },
          ip: request.ip,
          body: request.body,
          signal: abort.signal,
        },
        chat,
      );
      return sendPublicChatResult(reply, result, abort);
    });

  };

  return async (app) => {
    await app.register(publicRoutes);

    // ============================================
    // The publisher's side
    // ============================================

    const settingsView = async (listingId: string, settings: ListingTrialSettings) => {
      const day = utcDay(now());
      const [funded, baseCount] = await Promise.all([
        listings.fundedToday(listingId, day),
        // The same counter the chat spends from. Unreadable is null.
        sessions.limiter.peek(publicChatKeys.trialListingDay(listingId, day)),
      ]);
      return {
        trial: {
          // Every published listing can be tried; there is no switch.
          enabled: settings.status === "published",
          fundedDailyCap: settings.fundedDailyCap,
        },
        pricing: {
          baseDailyMessages: chat.limits.trial.baseDailyMessages,
          fundedMessageCents: deps.fundedMessageCents,
        },
        today: { day, baseCount, fundedCount: funded.fundedCount, fundedSpentCents: funded.fundedSpentCents },
      };
    };

    const ownerNotFound = (reply: FastifyReply) =>
      reply.status(404).send({ error: "listing_not_found", message: "No such listing." });

    app.get("/listings/:id/trial", { preHandler: [deps.guards.auth] }, async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return ownerNotFound(reply);
      const settings = await listings.getSettings(request.auth!.orgId, params.data.id);
      if (!settings) return ownerNotFound(reply);
      return settingsView(params.data.id, settings);
    });

    app.patch(
      "/listings/:id/trial",
      { preHandler: [deps.guards.auth, deps.guards.manage] },
      async (request, reply) => {
        const params = idParams.safeParse(request.params);
        if (!params.success) return ownerNotFound(reply);
        const body = settingsBody.safeParse(request.body);
        if (!body.success) return invalid(reply, body.error);
        const orgId = request.auth!.orgId;

        const current = await listings.getSettings(orgId, params.data.id);
        if (!current) return ownerNotFound(reply);

        // A cap with no price would promise messages nobody can be charged
        // for. Setting it back to zero always works.
        if (body.data.fundedDailyCap > 0 && deps.fundedMessageCents === null) {
          return reply.status(501).send({
            error: "trial_funding_not_configured",
            message:
              "Paying for more Try it messages is temporarily unavailable. Nothing was changed.",
          });
        }

        if (!(await listings.setFundedDailyCap(orgId, params.data.id, body.data.fundedDailyCap))) {
          return ownerNotFound(reply);
        }
        return settingsView(params.data.id, { ...current, fundedDailyCap: body.data.fundedDailyCap });
      },
    );
  };
}
