/**
 * GitHub App install + webhook (W2).
 *
 * Install mirrors the Slack flow exactly — signed, single-use state — for
 * the same reason: the callback arrives from github.com with no session
 * for our origin, so the state token is the only thing carrying the org
 * binding, and it must be both unforgeable and unreplayable.
 *
 * The webhook is the sharper surface. It is a public POST endpoint whose
 * body an attacker fully controls once they know (or guess) the secret,
 * so three things are non-negotiable:
 *   - X-Hub-Signature-256 verified with a timing-safe compare over the
 *     RAW bytes (SHA-1's X-Hub-Signature is ignored outright — accepting
 *     it would let a downgrade past the strong check).
 *   - Deliveries deduped by X-GitHub-Delivery: GitHub retries, and a
 *     retried push must not re-trigger a redeploy.
 *   - Tenancy from the STORED installation row, never from the payload.
 */

import type { FastifyPluginAsync } from "fastify";

import { timingSafeEqualHex } from "../services/channelAuth.js";
import type { NonceStore } from "../services/oauthStateStore.js";
import { signState, verifyState } from "../services/signedState.js";
import { isSafeReturnPath } from "../services/slackOAuth.js";
import {
  handleGitHubPush,
  type PushHandlerDeps,
  type PushPayload,
} from "../services/githubPushHandler.js";
import { createLogger } from "../utils/logger.js";
import { replaceJsonBodyParser } from "./emptyJsonBody.js";

const logger = createLogger("github-app");

const STATE_PURPOSE = "github-install";
const STATE_TTL_SECONDS = 600;
/** GitHub push payloads routinely exceed Fastify's 1MB default. */
const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;

export interface GitHubAppRouteDeps {
  enabled: boolean;
  appSlug: string;
  webhookSecret: string;
  webBaseUrl: string;
  stateSecret: string;
  nonces: NonceStore;
  /** Proves the installation exists and is reachable by this App. */
  verifyInstallation: (
    installationId: string,
  ) => Promise<{ ok: true; accountLogin: string } | { ok: false; error: string }>;
  saveInstallation: (args: {
    orgId: string;
    installationId: string;
    accountLogin: string;
  }) => Promise<void>;
  removeInstallation: (installationId: string) => Promise<void>;
  /** Redis SET NX EX; false when this delivery id was already handled. */
  claimDelivery: (deliveryId: string) => Promise<boolean>;
  pushDeps: PushHandlerDeps;
  now?: () => Date;
}

interface RawBody {
  parsed: unknown;
  raw: string;
}

export function createGitHubAppRoutes(
  deps: GitHubAppRouteDeps,
): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());
  const disabled = {
    error: "github_app_not_configured",
    message: "The WheelsAI GitHub App is temporarily unavailable. Try again later.",
  };

  return async (app) => {
    // Plugin-scoped raw body: the signature covers the exact bytes GitHub
    // sent, and re-serializing the parsed object would not reproduce them.
    replaceJsonBodyParser(app);
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: WEBHOOK_BODY_LIMIT },
      (_req, body, done) => {
        try {
          done(null, { parsed: JSON.parse(body as string), raw: body as string });
        } catch {
          done(null, { parsed: null, raw: body as string });
        }
      },
    );

    // ============================================
    // GET /github/install
    // ============================================
    app.get("/github/install", async (request, reply) => {
      if (!deps.enabled) return reply.status(501).send(disabled);
      if (!request.auth) return reply.status(401).send({ error: "unauthenticated" });

      const query = (request.query ?? {}) as Record<string, unknown>;
      const returnTo = isSafeReturnPath(query.returnTo)
        ? query.returnTo
        : "/dashboard/integrations";

      const state = signState({
        payload: {
          purpose: STATE_PURPOSE,
          orgId: request.auth.orgId,
          userId: request.auth.userId,
          returnTo,
        },
        secret: deps.stateSecret,
        ttlSeconds: STATE_TTL_SECONDS,
        now,
      });
      const verified = verifyState({
        token: state,
        secret: deps.stateSecret,
        expectedPurpose: STATE_PURPOSE,
        now,
      });
      if (!verified.ok) return reply.status(500).send({ error: "state_mint_failed" });
      await deps.nonces.mint(verified.payload.nonce, STATE_TTL_SECONDS);

      return reply.redirect(
        302,
        `https://github.com/apps/${encodeURIComponent(deps.appSlug)}/installations/new?state=${encodeURIComponent(state)}`,
      );
    });

    // ============================================
    // GET /github/callback
    // ============================================
    app.get("/github/callback", async (request, reply) => {
      if (!deps.enabled) return reply.status(501).send(disabled);

      const query = (request.query ?? {}) as Record<string, unknown>;
      const installationId =
        typeof query.installation_id === "string" ? query.installation_id : "";
      const state = typeof query.state === "string" ? query.state : "";
      if (!installationId || !state) {
        return reply.status(400).send({ error: "invalid_state" });
      }

      const verified = verifyState({
        token: state,
        secret: deps.stateSecret,
        expectedPurpose: STATE_PURPOSE,
        now,
      });
      if (!verified.ok) {
        logger.warn({ reason: verified.reason }, "github callback state rejected");
        return reply.status(400).send({ error: "invalid_state" });
      }
      if (!(await deps.nonces.consume(verified.payload.nonce))) {
        return reply.status(400).send({ error: "state_replayed" });
      }

      // installation_id arrived in the query string, i.e. from the user's
      // browser. Minting a token against it is the proof it is real and
      // ours — persisting it unverified would let anyone bind their org to
      // an arbitrary installation.
      const confirmed = await deps.verifyInstallation(installationId);
      if (!confirmed.ok) {
        return reply.status(400).send({
          error: "github_installation_unverified",
          detail: confirmed.error,
        });
      }

      await deps.saveInstallation({
        orgId: String(verified.payload.orgId ?? ""),
        installationId,
        accountLogin: confirmed.accountLogin,
      });

      const returnTo = isSafeReturnPath(verified.payload.returnTo)
        ? verified.payload.returnTo
        : "/dashboard/integrations";
      return reply.redirect(302, `${deps.webBaseUrl}${returnTo}?github=connected`);
    });

    // ============================================
    // POST /github/webhook
    // ============================================
    app.post("/github/webhook", async (request, reply) => {
      if (!deps.enabled) return reply.status(501).send(disabled);

      const body = request.body as RawBody | undefined;
      if (!body || typeof body.raw !== "string") {
        return reply.status(400).send({ error: "invalid_body" });
      }

      // ONLY the SHA-256 header. GitHub still sends X-Hub-Signature
      // (SHA-1) for compatibility; honouring it would hand an attacker a
      // downgrade path around the strong signature.
      const presented = request.headers["x-hub-signature-256"];
      if (typeof presented !== "string" || !presented.startsWith("sha256=")) {
        return reply.status(401).send({ error: "unsigned" });
      }
      const { createHmac } = await import("node:crypto");
      const expected = createHmac("sha256", deps.webhookSecret)
        .update(body.raw)
        .digest("hex");
      if (!timingSafeEqualHex(expected, presented.slice("sha256=".length))) {
        return reply.status(401).send({ error: "bad_signature" });
      }

      // GitHub retries deliveries; without this a retried push would
      // record a duplicate version and re-trigger a redeploy.
      const deliveryId = request.headers["x-github-delivery"];
      if (typeof deliveryId === "string" && deliveryId.length > 0) {
        if (!(await deps.claimDelivery(deliveryId))) {
          return reply.status(200).send({ deduped: true });
        }
      }

      const event = request.headers["x-github-event"];
      if (event === "ping") return reply.status(200).send({ ok: true });

      if (event === "installation") {
        const payload = body.parsed as {
          action?: string;
          installation?: { id?: number | string };
        } | null;
        const action = payload?.action;
        const id = payload?.installation?.id;
        if (id && (action === "deleted" || action === "suspend")) {
          await deps.removeInstallation(String(id));
        }
        return reply.status(200).send({ ok: true });
      }

      if (event === "push") {
        const result = await handleGitHubPush(
          (body.parsed ?? {}) as PushPayload,
          deps.pushDeps,
        );
        logger.info(result, "handled github push");
        return reply.status(200).send(result);
      }

      // Subscribed-but-unhandled events are acknowledged, not errored —
      // a 4xx would make GitHub retry something we will never act on.
      return reply.status(204).send();
    });
  };
}
