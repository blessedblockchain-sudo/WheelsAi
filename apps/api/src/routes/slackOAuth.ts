/**
 * Slack install flow (W2): GET /slack/install → Slack → GET /slack/callback.
 *
 * The callback is necessarily UNAUTHENTICATED — the browser arrives from
 * slack.com carrying no session cookie for our API origin. Everything
 * that authorizes the install therefore has to live in the state token:
 * it is HMAC-signed (so the org binding cannot be forged) AND carries a
 * single-use nonce (so a captured callback URL cannot be replayed).
 * Neither property alone is sufficient — signed-only is replayable,
 * nonce-only is forgeable.
 *
 * Every IO surface is injected so the whole flow is testable without
 * Slack, Redis, or Prisma.
 */

import type { FastifyPluginAsync } from "fastify";

import {
  buildSlackAuthorizeUrl,
  isSafeReturnPath,
  SLACK_BOT_SCOPES,
  type SlackInstall,
} from "../services/slackOAuth.js";
import type { NonceStore } from "../services/oauthStateStore.js";
import { signState, verifyState } from "../services/signedState.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("slack-oauth");

const STATE_PURPOSE = "slack-install";
const STATE_TTL_SECONDS = 600;

export interface SlackOAuthDeps {
  /** Master gate — false ⇒ every route answers 501 (never 404). */
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  /** App-level signing secret, written onto the channel row at install. */
  signingSecret: string;
  redirectUri: string;
  /** Absolute origin of the web app, for the post-install redirect. */
  webBaseUrl: string;
  stateSecret: string;
  nonces: NonceStore;
  /** Confirms the caller's org owns the OpenClaw deployment. */
  ownsDeployment: (args: {
    deploymentId: string;
    orgId: string;
  }) => Promise<boolean>;
  exchangeCode: (code: string) => Promise<
    { ok: true; install: SlackInstall } | { ok: false; error: string }
  >;
  /** Which deployment (if any) already holds this workspace. */
  findChannelByTeam: (teamId: string) => Promise<{ deploymentId: string } | null>;
  /** Writes the credentials where the running channel stack reads them. */
  upsertSlackChannel: (args: {
    deploymentId: string;
    teamId: string;
    teamName: string;
    botToken: string;
    botUserId: string;
    scopes: string[];
    signingSecret: string;
  }) => Promise<void>;
  now?: () => Date;
}

export function createSlackOAuthRoutes(
  deps: SlackOAuthDeps,
): FastifyPluginAsync {
  const now = deps.now ?? (() => new Date());

  const disabled = {
    error: "slack_oauth_not_configured",
    message: "Installing Slack is temporarily unavailable. Try again later.",
  };

  return async (app) => {
    // ============================================
    // GET /slack/install — authenticated, org-scoped
    // ============================================
    app.get("/slack/install", async (request, reply) => {
      if (!deps.enabled) return reply.status(501).send(disabled);
      if (!request.auth) return reply.status(401).send({ error: "unauthenticated" });

      const query = (request.query ?? {}) as Record<string, unknown>;
      const deploymentId = typeof query.deploymentId === "string" ? query.deploymentId : "";
      if (!deploymentId) {
        return reply.status(400).send({
          error: "deployment_required",
          message: "Pick which agent deployment this workspace should talk to.",
        });
      }

      // The install binds a workspace to a deployment, so the caller must
      // own that deployment — otherwise anyone could attach their Slack
      // workspace to someone else's agent.
      const owns = await deps.ownsDeployment({
        deploymentId,
        orgId: request.auth.orgId,
      });
      if (!owns) {
        return reply.status(404).send({ error: "deployment_not_found" });
      }

      // Validated HERE, at mint time, so an open-redirect value can never
      // enter a signed token that later code is entitled to trust.
      const returnTo = isSafeReturnPath(query.returnTo)
        ? query.returnTo
        : "/dashboard/integrations";

      const state = signState({
        payload: {
          purpose: STATE_PURPOSE,
          orgId: request.auth.orgId,
          userId: request.auth.userId,
          deploymentId,
          returnTo,
        },
        secret: deps.stateSecret,
        ttlSeconds: STATE_TTL_SECONDS,
        now,
      });

      // The nonce lives inside the signed payload; register it so the
      // callback can spend it exactly once.
      const verified = verifyState({
        token: state,
        secret: deps.stateSecret,
        expectedPurpose: STATE_PURPOSE,
        now,
      });
      if (!verified.ok) {
        // Unreachable unless signState/verifyState disagree.
        return reply.status(500).send({ error: "state_mint_failed" });
      }
      await deps.nonces.mint(verified.payload.nonce, STATE_TTL_SECONDS);

      return reply.redirect(
        302,
        buildSlackAuthorizeUrl({
          clientId: deps.clientId,
          redirectUri: deps.redirectUri,
          state,
          scopes: SLACK_BOT_SCOPES,
        }),
      );
    });

    // ============================================
    // GET /slack/callback — unauthenticated by necessity
    // ============================================
    app.get("/slack/callback", async (request, reply) => {
      if (!deps.enabled) return reply.status(501).send(disabled);

      const query = (request.query ?? {}) as Record<string, unknown>;
      const code = typeof query.code === "string" ? query.code : "";
      const state = typeof query.state === "string" ? query.state : "";

      if (typeof query.error === "string") {
        // The user declined the Slack consent screen — not an error state
        // worth a 500, just a fact to report.
        return reply.status(400).send({
          error: "slack_install_declined",
          detail: query.error,
        });
      }
      if (!code || !state) {
        return reply.status(400).send({ error: "invalid_state" });
      }

      const verified = verifyState({
        token: state,
        secret: deps.stateSecret,
        expectedPurpose: STATE_PURPOSE,
        now,
      });
      if (!verified.ok) {
        // The specific reason is logged, never returned — it would tell an
        // attacker which part of their forgery to fix.
        logger.warn({ reason: verified.reason }, "slack callback state rejected");
        return reply.status(400).send({ error: "invalid_state" });
      }

      const spent = await deps.nonces.consume(verified.payload.nonce);
      if (!spent) {
        logger.warn("slack callback state replayed");
        return reply.status(400).send({ error: "state_replayed" });
      }

      const orgId = String(verified.payload.orgId ?? "");
      const deploymentId = String(verified.payload.deploymentId ?? "");
      const returnTo = isSafeReturnPath(verified.payload.returnTo)
        ? verified.payload.returnTo
        : "/dashboard/integrations";

      // Re-check ownership: the state is authentic, but it was minted
      // minutes ago and the deployment may since have been deleted or
      // moved.
      const owns = await deps.ownsDeployment({ deploymentId, orgId });
      if (!owns) {
        return reply.status(404).send({ error: "deployment_not_found" });
      }

      const exchanged = await deps.exchangeCode(code);
      if (!exchanged.ok) {
        return reply.status(400).send({
          error: "slack_oauth_exchange_failed",
          detail: exchanged.error,
        });
      }
      const install = exchanged.install;

      // One workspace, one deployment. Silently rebinding would hijack
      // the previous install's events, so a conflicting install is
      // refused by name.
      const existing = await deps.findChannelByTeam(install.teamId);
      if (existing && existing.deploymentId !== deploymentId) {
        return reply.status(409).send({
          error: "slack_workspace_already_installed",
          message:
            "This Slack workspace is already connected to another agent deployment. Disconnect it there first.",
        });
      }

      await deps.upsertSlackChannel({
        deploymentId,
        teamId: install.teamId,
        teamName: install.teamName,
        botToken: install.botToken,
        botUserId: install.botUserId,
        scopes: install.scopes,
        // Written onto the row so the inbound verifier reads the same
        // secret whether or not the platform env later rotates.
        signingSecret: deps.signingSecret,
      });

      return reply.redirect(302, `${deps.webBaseUrl}${returnTo}?slack=connected`);
    });
  };
}
