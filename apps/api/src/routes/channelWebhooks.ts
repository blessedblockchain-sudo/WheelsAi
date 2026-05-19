/**
 * Inbound channel webhooks (plan A6).
 *
 * POST /webhooks/:deploymentId/:platform
 *
 * Flow:
 *   1. Resolve the deployment's channel config (encrypted in the DB) for the
 *      requested platform. 404 if unknown.
 *   2. Verify the platform-specific signature. 401 if invalid.
 *   3. Handle Discord PING (type=1) with an inline pong; Slack
 *      url_verification with the challenge passthrough — neither enqueues.
 *   4. Normalize the payload. If it's a bot message or malformed, 204 with
 *      no enqueue (idempotent drop).
 *   5. Enqueue an agent-message job. 204.
 *
 * Everything the handler needs is dependency-injected so tests can drive
 * the route without Prisma or Redis.
 */

import type { FastifyPluginAsync } from "fastify";

import {
  verifyDiscordSignature,
  verifyTelegramSignature,
  verifySlackSignature,
} from "../services/channelAuth.js";
import {
  normalizeInboundMessage,
  type InboundMessage,
  type SupportedPlatform,
} from "../services/channelNormalize.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("channel-webhook");

export type ChannelCredentials =
  | { kind: "discord"; publicKeyHex: string }
  | { kind: "telegram"; botToken: string }
  | { kind: "slack"; signingSecret: string };

export interface ChannelConfig {
  deploymentId: string;
  platform: SupportedPlatform;
  credentials: ChannelCredentials;
}

export interface ChannelWebhookDeps {
  resolveChannelConfig: (
    deploymentId: string,
    platform: string,
  ) => Promise<ChannelConfig | null>;
  enqueue: (payload: {
    deploymentId: string;
    platform: SupportedPlatform;
    message: InboundMessage;
  }) => Promise<void>;
}

const SUPPORTED: ReadonlySet<string> = new Set(["discord", "telegram", "slack"]);

export function createChannelWebhookRoutes(
  deps: ChannelWebhookDeps,
): FastifyPluginAsync {
  return async (app) => {
    // Need access to the raw body to recompute signatures. Register a
    // content-type parser that keeps the body as a string alongside the
    // parsed JSON.
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          const parsed = body === "" ? {} : JSON.parse(body as string);
          done(null, { parsed, raw: body as string });
        } catch (err) {
          done(err as Error, undefined);
        }
      },
    );

    app.post<{ Params: { deploymentId: string; platform: string } }>(
      "/webhooks/:deploymentId/:platform",
      async (request, reply) => {
        const { deploymentId, platform } = request.params;

        if (!SUPPORTED.has(platform)) {
          return reply.status(404).send({ error: "unsupported platform" });
        }

        const config = await deps.resolveChannelConfig(deploymentId, platform);
        if (!config || config.platform !== platform) {
          return reply.status(404).send({ error: "channel not configured" });
        }

        const parsedBody = (request.body as { parsed: unknown; raw: string } | undefined);
        const rawBody = parsedBody?.raw ?? "";
        const parsed = parsedBody?.parsed ?? {};

        // ----- verify -----
        let verified = false;
        if (config.credentials.kind === "discord") {
          const signature = String(request.headers["x-signature-ed25519"] ?? "");
          const timestamp = String(request.headers["x-signature-timestamp"] ?? "");
          verified = verifyDiscordSignature({
            publicKeyHex: config.credentials.publicKeyHex,
            timestamp,
            body: rawBody,
            signature,
          });
        } else if (config.credentials.kind === "telegram") {
          const signature = String(request.headers["x-telegram-signature"] ?? "");
          verified = verifyTelegramSignature({
            botToken: config.credentials.botToken,
            body: rawBody,
            signature,
          });
        } else if (config.credentials.kind === "slack") {
          const signature = String(request.headers["x-slack-signature"] ?? "");
          const timestamp = String(request.headers["x-slack-request-timestamp"] ?? "");
          verified = verifySlackSignature({
            signingSecret: config.credentials.signingSecret,
            timestamp,
            body: rawBody,
            signature,
          });
        }

        if (!verified) {
          logger.warn({ deploymentId, platform }, "signature verification failed");
          return reply.status(401).send({ error: "signature verification failed" });
        }

        // ----- protocol handshakes -----
        if (
          config.credentials.kind === "discord" &&
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { type?: number }).type === 1
        ) {
          return reply.status(200).send({ type: 1 }); // pong
        }

        // ----- normalize -----
        const normalized = normalizeInboundMessage({
          platform: platform as SupportedPlatform,
          payload: parsed,
        });

        if (normalized && "__special" in normalized) {
          if (normalized.__special === "slack_url_verification") {
            return reply.status(200).send({ challenge: normalized.challenge });
          }
          // Unknown special sentinel — safest behavior is to drop.
          return reply.status(204).send();
        }

        if (!normalized) {
          // Bot-authored, non-message event, or unparseable — drop idempotently.
          return reply.status(204).send();
        }

        await deps.enqueue({
          deploymentId,
          platform: platform as SupportedPlatform,
          message: normalized,
        });

        return reply.status(204).send();
      },
    );
  };
}
