/**
 * Slack Events endpoint for the distributed app (W2).
 *
 * The existing channel webhook route keys on `:deploymentId` in the path
 * (routes/channelWebhooks.ts). A distributed Slack app cannot use that:
 * its app configuration holds exactly ONE Events Request URL for every
 * workspace that installs it. So this is a second front door — not a
 * second stack. It verifies, resolves `team_id` → channel row, and then
 * hands off to the SAME normalize + enqueue path the per-deployment route
 * uses. Everything downstream (worker, dispatch, retry classification) is
 * untouched.
 *
 * Ordering matters here: the signature is verified with the PLATFORM
 * signing secret from env, which means Slack's `url_verification` probe
 * succeeds before any workspace has installed. Verifying against a
 * per-install secret would make the Request URL unverifiable — you could
 * never complete the app setup that installs are supposed to follow.
 */

import type { FastifyPluginAsync } from "fastify";

import { verifySlackSignature } from "../services/channelAuth.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("slack-events");

export interface SlackEventsDeps {
  enabled: boolean;
  /** App-level signing secret from env. */
  signingSecret: string;
  /** team_id → the deployment that installed this workspace. */
  resolveDeploymentByTeam: (teamId: string) => Promise<string | null>;
  normalize: (payload: unknown) => unknown;
  enqueue: (args: {
    deploymentId: string;
    platform: string;
    message: unknown;
  }) => Promise<unknown>;
  now?: () => Date;
}

interface RawBody {
  parsed: unknown;
  raw: string;
}

export function createSlackEventsRoutes(
  deps: SlackEventsDeps,
): FastifyPluginAsync {
  return async (app) => {
    // Plugin-scoped raw-body parser. The signature is computed over the
    // EXACT bytes Slack sent; re-serializing the parsed object would
    // change key order and unicode escaping and break verification. This
    // repo does not use fastify-plugin, so the parser stays private to
    // this plugin rather than leaking to sibling routes.
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, { parsed: JSON.parse(body as string), raw: body as string });
        } catch {
          done(null, { parsed: null, raw: body as string });
        }
      },
    );

    app.post("/slack/events", async (request, reply) => {
      if (!deps.enabled) {
        return reply.status(501).send({
          error: "slack_events_not_configured",
          message: "Slack is not configured on this deployment.",
        });
      }

      const body = request.body as RawBody | undefined;
      if (!body || typeof body.raw !== "string") {
        return reply.status(400).send({ error: "invalid_body" });
      }

      const timestamp = request.headers["x-slack-request-timestamp"];
      const signature = request.headers["x-slack-signature"];
      if (typeof timestamp !== "string" || typeof signature !== "string") {
        return reply.status(401).send({ error: "unsigned" });
      }

      const valid = verifySlackSignature({
        signingSecret: deps.signingSecret,
        timestamp,
        body: body.raw,
        signature,
        now: deps.now?.(),
      });
      if (!valid) {
        return reply.status(401).send({ error: "bad_signature" });
      }

      const normalized = deps.normalize(body.parsed) as
        | { __special?: string; challenge?: string; messageId?: string }
        | null;

      // Answer the Request URL handshake BEFORE any database lookup —
      // this runs at app-setup time, when no install exists yet.
      if (normalized && normalized.__special === "slack_url_verification") {
        return reply.status(200).send({ challenge: normalized.challenge });
      }
      if (!normalized) {
        // Bot messages, edits, unsupported subtypes: acknowledged and
        // dropped. Slack retries anything that is not a 2xx.
        return reply.status(204).send();
      }

      const payload = body.parsed as { team_id?: unknown } | null;
      const teamId =
        payload && typeof payload.team_id === "string" ? payload.team_id : null;
      if (!teamId) {
        return reply.status(204).send();
      }

      const deploymentId = await deps.resolveDeploymentByTeam(teamId);
      if (!deploymentId) {
        // Unknown workspace — 204, not 404. A distinct status would tell
        // an unauthenticated caller which workspaces are installed.
        return reply.status(204).send();
      }

      try {
        await deps.enqueue({
          deploymentId,
          platform: "slack",
          message: normalized,
        });
      } catch (err) {
        logger.error({ err, teamId }, "failed to enqueue slack message");
        // 500 so Slack retries; the queue job id dedupes the replay.
        return reply.status(500).send({ error: "enqueue_failed" });
      }

      return reply.status(204).send();
    });
  };
}
