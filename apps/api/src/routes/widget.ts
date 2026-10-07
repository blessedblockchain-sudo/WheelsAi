/**
 * /api/widget: what the web chat widget on an owner's site calls.
 *
 *   GET  /:publicKey/config   the widget's look and limits
 *   POST /:publicKey/chat     one message; streamed unless `stream` is false
 *
 * There is no caller identity here. The key in the path is public, the
 * request's Origin is checked against the origins the key's owner listed,
 * and everything is held to limits that fail closed. These routes never read
 * request.auth: a WheelsAI session cookie means nothing to them (and the
 * CORS policy for these two paths never allows credentials -
 * lib/corsPolicy.ts).
 *
 * The chat itself, and every decision about it, is services/publicChat.ts.
 */

import type { FastifyPluginAsync } from "fastify";

import { abortOnClientClose } from "../services/chatStreamSettlement.js";
import type { FailClosedLimiter } from "../services/failClosedLimiter.js";
import {
  consumePublicLimit,
  PUBLIC_CHAT_LIMITS,
  publicChatKeys,
  runPublicChat,
  type PublicChatDeps,
  type PublicChatRefusal,
} from "../services/publicChat.js";
import { isPublicKey, originAllowed } from "../services/widgetKeys.js";
import {
  installPublicErrorHandler,
  sendPublicChatResult,
  sendPublicRefusal,
  varyByOrigin,
} from "./publicChatReply.js";

/** What a widget needs to draw itself. */
export interface WidgetKeyConfig {
  orgId: string;
  agentName: string;
  allowedOrigins: string[];
  title: string | null;
  greeting: string | null;
  primaryColor: string | null;
  position: string;
  storeTranscripts: boolean;
  hideBranding: boolean;
  enabled: boolean;
  revokedAt: Date | null;
}

export interface WidgetRouteDeps {
  chat: PublicChatDeps;
  config: {
    limiter: Pick<FailClosedLimiter, "consume">;
    /** Configuration loads per address a minute. */
    perIpPerMinute: number;
    loadKeyConfig(publicKey: string): Promise<WidgetKeyConfig | null>;
    /** Whether the organization's plan lets it hide "Powered by WheelsAI". */
    whiteLabel(orgId: string): Promise<boolean>;
  };
}

/** A chat request is text: 20 messages of 4,000 characters fit several times over. */
export const WIDGET_BODY_LIMIT_BYTES = 64 * 1024;

const KEY_NOT_FOUND: PublicChatRefusal = { status: 404, code: "widget_key_not_found", message: "Not found." };

const ORIGIN_NOT_ALLOWED: PublicChatRefusal = {
  status: 403,
  code: "origin_not_allowed",
  message: "This site is not allowed to use this chat widget.",
};

export function createWidgetRoutes(deps: WidgetRouteDeps): FastifyPluginAsync {
  return async (app) => {
    installPublicErrorHandler(app);

    app.get<{ Params: { publicKey: string } }>("/:publicKey/config", async (request, reply) => {
      varyByOrigin(reply);
      // Counted before anything is looked up, like a chat.
      const limited = await consumePublicLimit(
        deps.config.limiter,
        [
          {
            scope: "ip",
            key: publicChatKeys.widgetConfigIpMinute(deps.chat.bucketOf(request.ip)),
            limit: deps.config.perIpPerMinute,
            windowSeconds: 60,
          },
        ],
        "widget-config",
        deps.chat.logger,
      );
      if (limited) return sendPublicRefusal(reply, limited);

      const { publicKey } = request.params;
      if (!isPublicKey(publicKey)) return sendPublicRefusal(reply, KEY_NOT_FOUND);
      const key = await deps.config.loadKeyConfig(publicKey);
      // Revoked and disabled keys are as unknown as a wrong one.
      if (!key || !key.enabled || key.revokedAt !== null) return sendPublicRefusal(reply, KEY_NOT_FOUND);
      if (!originAllowed(request.headers.origin, key.allowedOrigins, deps.chat.appOrigins)) {
        return sendPublicRefusal(reply, ORIGIN_NOT_ALLOWED);
      }

      // The owner's wish counts only while their plan includes it. A plan
      // that cannot be read shows the line: it is the default, not a risk.
      const poweredBy = !(key.hideBranding && (await deps.config.whiteLabel(key.orgId).catch(() => false)));

      // Private: the answer depends on the Origin that asked.
      reply.header("cache-control", "private, max-age=60");
      return {
        agent: { name: key.agentName },
        appearance: {
          title: key.title,
          greeting: key.greeting,
          primaryColor: key.primaryColor,
          position: key.position === "bottom-left" ? "bottom-left" : "bottom-right",
        },
        poweredBy,
        limits: {
          maxMessageChars: PUBLIC_CHAT_LIMITS.maxMessageChars,
          maxMessages: PUBLIC_CHAT_LIMITS.maxMessages,
          maxTotalChars: PUBLIC_CHAT_LIMITS.maxTotalChars,
        },
        transcriptsStored: key.storeTranscripts,
      };
    });

    app.post<{ Params: { publicKey: string } }>(
      "/:publicKey/chat",
      { bodyLimit: WIDGET_BODY_LIMIT_BYTES },
      async (request, reply) => {
        // Before the first await: a visitor who closes the page stops the
        // run, and whatever it had charged its owner goes back.
        const abort = abortOnClientClose(reply.raw);
        varyByOrigin(reply);
        const { publicKey } = request.params;
        // No lookup for something that cannot be a key.
        if (!isPublicKey(publicKey)) return sendPublicRefusal(reply, KEY_NOT_FOUND);

        const result = await runPublicChat(
          {
            surface: { kind: "widget", publicKey, origin: request.headers.origin },
            ip: request.ip,
            body: request.body,
            signal: abort.signal,
          },
          deps.chat,
        );
        return sendPublicChatResult(reply, result, abort);
      },
    );
  };
}
