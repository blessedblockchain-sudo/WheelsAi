/**
 * Production wiring for the Slack install + events routes (W2).
 *
 * Both plugins are ALWAYS mounted and answer 501 when Slack is not
 * configured, matching the wallet-topup precedent: a 404 would make an
 * unconfigured deployment indistinguishable from a broken one, and Slack
 * needs the Events URL to respond even before an app exists.
 *
 * The install writes into `OpenClawChannel` — the row the running channel
 * stack decrypts for `signingSecret` (inbound) and `botToken` (outbound).
 * Nothing here touches the `Integration` model.
 */

import { Redis } from "ioredis";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { resolveChannelConfigByExternalId } from "../services/channelConfig.js";
import { normalizeInboundMessage } from "../services/channelNormalize.js";
import { encryptConfig, decryptConfig } from "../services/openclaw.js";
import { makeRedisNonceStore } from "../services/oauthStateStore.js";
import { exchangeSlackCode } from "../services/slackOAuth.js";
import { enqueueAgentMessage } from "../queues/agent-message.queue.js";
import { createSlackEventsRoutes, type SlackEventsDeps } from "./slackEvents.js";
import { createSlackOAuthRoutes, type SlackOAuthDeps } from "./slackOAuth.js";
import type { FastifyPluginAsync } from "fastify";

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  }
  return redis;
}

function slackConfigured(): boolean {
  return Boolean(
    env.SLACK_OAUTH_ENABLED &&
      env.SLACK_CLIENT_ID &&
      env.SLACK_CLIENT_SECRET &&
      env.SLACK_SIGNING_SECRET &&
      env.PUBLIC_API_URL,
  );
}

export function buildSlackOAuthDeps(): SlackOAuthDeps {
  const redirectUri = `${env.PUBLIC_API_URL ?? ""}/api/integrations/slack/callback`;

  return {
    enabled: slackConfigured(),
    clientId: env.SLACK_CLIENT_ID ?? "",
    clientSecret: env.SLACK_CLIENT_SECRET ?? "",
    signingSecret: env.SLACK_SIGNING_SECRET ?? "",
    redirectUri,
    webBaseUrl: env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN,
    // The state secret is distinct in purpose from JWT_SECRET but shares
    // its material — one fewer secret to provision, and a compromise of
    // either already implies the other in this deployment model.
    stateSecret: env.JWT_SECRET,
    nonces: makeRedisNonceStore(getRedis() as never),

    ownsDeployment: async ({ deploymentId, orgId }) => {
      // OpenClawDeployment carries no orgId — ownership runs through its
      // agent, the same join the AgentDeployment scoping uses.
      const row = await prisma.openClawDeployment.findFirst({
        where: { id: deploymentId, agent: { orgId } },
        select: { id: true },
      });
      return row !== null;
    },

    exchangeCode: (code) =>
      exchangeSlackCode(code, {
        clientId: env.SLACK_CLIENT_ID ?? "",
        clientSecret: env.SLACK_CLIENT_SECRET ?? "",
        redirectUri,
      }),

    findChannelByTeam: async (teamId) => {
      const row = await prisma.openClawChannel.findFirst({
        where: { platform: "slack", externalId: teamId },
        select: { deploymentId: true },
      });
      return row;
    },

    upsertSlackChannel: async (args) => {
      // Upsert on the (deploymentId, platform) unique key: re-installing
      // must refresh the token in place, not accumulate rows that the
      // resolver would then pick between arbitrarily.
      await prisma.openClawChannel.upsert({
        where: {
          deploymentId_platform: {
            deploymentId: args.deploymentId,
            platform: "slack",
          },
        },
        create: {
          deploymentId: args.deploymentId,
          platform: "slack",
          externalId: args.teamId,
          externalName: args.teamName,
          enabled: true,
          configEncrypted: encryptConfig({
            botToken: args.botToken,
            botUserId: args.botUserId,
            teamId: args.teamId,
            scopes: args.scopes,
            signingSecret: args.signingSecret,
          }),
        },
        update: {
          externalId: args.teamId,
          externalName: args.teamName,
          enabled: true,
          configEncrypted: encryptConfig({
            botToken: args.botToken,
            botUserId: args.botUserId,
            teamId: args.teamId,
            scopes: args.scopes,
            signingSecret: args.signingSecret,
          }),
        },
      });
    },
  };
}

export function buildSlackEventsDeps(): SlackEventsDeps {
  return {
    enabled: slackConfigured(),
    signingSecret: env.SLACK_SIGNING_SECRET ?? "",

    resolveDeploymentByTeam: async (teamId) => {
      const config = await resolveChannelConfigByExternalId("slack", teamId, {
        prisma: prisma as never,
        decryptConfig,
      });
      return config?.deploymentId ?? null;
    },

    normalize: (payload) =>
      normalizeInboundMessage({ platform: "slack", payload }),

    enqueue: (args) =>
      enqueueAgentMessage({
        deploymentId: args.deploymentId,
        platform: args.platform as never,
        message: args.message as never,
      }),
  };
}

export function createSlackOAuthRoutesProduction(): FastifyPluginAsync {
  return createSlackOAuthRoutes(buildSlackOAuthDeps());
}

export function createSlackEventsRoutesProduction(): FastifyPluginAsync {
  return createSlackEventsRoutes(buildSlackEventsDeps());
}
