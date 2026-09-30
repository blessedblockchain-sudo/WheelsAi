/**
 * Production wiring for the GitHub App (W2).
 *
 * Always mounted; 501 when unconfigured — GitHub needs the webhook URL to
 * answer during App setup, and a 404 would make "not configured" look
 * like "broken" (the walletTopup / Slack precedent).
 */

import { Redis } from "ioredis";
import { openAgentEnv } from "../services/agentSecrets.js";

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import {
  getInstallationToken,
  verifyInstallation,
  type GitHubAppConfig,
} from "../services/githubApp.js";
import {
  markInstallationRemoved,
  resolveInstallationForOrg,
  resolveOrgByInstallation,
  saveInstallation,
} from "../services/githubInstallations.js";
import { makeRedisNonceStore } from "../services/oauthStateStore.js";
import { createAgentVersion } from "../services/versioning.js";
import { createGitHubAppRoutes, type GitHubAppRouteDeps } from "./githubApp.js";
import type { MatchedAgent } from "../services/githubPushHandler.js";
import { createLogger } from "../utils/logger.js";
import type { FastifyPluginAsync } from "fastify";

const logger = createLogger("github-app-bindings");

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
  return redis;
}

export function githubAppConfigured(): boolean {
  return Boolean(
    env.GITHUB_APP_ENABLED &&
      env.GITHUB_APP_ID &&
      env.GITHUB_APP_SLUG &&
      env.GITHUB_APP_PRIVATE_KEY &&
      env.GITHUB_WEBHOOK_SECRET &&
      env.PUBLIC_API_URL,
  );
}

function appConfig(): GitHubAppConfig {
  return {
    appId: env.GITHUB_APP_ID ?? "",
    privateKey: env.GITHUB_APP_PRIVATE_KEY ?? "",
  };
}

/**
 * Mints an installation token for an org, or null when the org has no
 * installation. Callers treat null as "unauthenticated GitHub access",
 * which still works for public repos.
 */
export async function getOrgInstallationToken(
  orgId: string,
): Promise<string | null> {
  if (!githubAppConfigured()) return null;
  const installationId = await resolveInstallationForOrg(orgId);
  if (!installationId) return null;
  try {
    const token = await getInstallationToken(installationId, { config: appConfig() });
    return token.token;
  } catch (err) {
    logger.error({ err, orgId }, "failed to mint installation token");
    return null;
  }
}

export function buildGitHubAppDeps(): GitHubAppRouteDeps {
  return {
    enabled: githubAppConfigured(),
    appSlug: env.GITHUB_APP_SLUG ?? "",
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    webBaseUrl: env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN,
    stateSecret: env.JWT_SECRET,
    nonces: makeRedisNonceStore(getRedis() as never),

    verifyInstallation: (installationId) =>
      verifyInstallation(installationId, { config: appConfig() }),

    saveInstallation,
    removeInstallation: markInstallationRemoved,

    // SET NX EX: the first caller for a delivery id wins, retries lose.
    claimDelivery: async (deliveryId) => {
      const result = await getRedis().set(
        `gh-delivery:${deliveryId}`,
        "1",
        "EX",
        86_400,
        "NX",
      );
      return result === "OK";
    },

    pushDeps: {
      resolveOrgByInstallation,

      findAgentsForRepo: async ({ orgId, repoFullName }) => {
        // Cheap prefilter in SQL; the authoritative match is the
        // normalizing comparison in the pure handler.
        const agents = await prisma.agent.findMany({
          where: {
            orgId,
            sourceType: "github",
            sourceUrl: { contains: repoFullName, mode: "insensitive" },
          },
          select: {
            id: true,
            orgId: true,
            sourceUrl: true,
            env: true,
            deployments: {
              where: { status: "running" },
              select: { id: true },
              take: 1,
            },
          },
        });

        return agents.map((a): MatchedAgent => {
          const agentEnv: Record<string, unknown> = openAgentEnv(a.env);
          return {
            id: a.id,
            orgId: a.orgId,
            sourceUrl: a.sourceUrl,
            // Opt-in, default OFF. A push spending an org's credits
            // without anyone asking is not a feature.
            autoRedeploy: agentEnv.autoRedeployOnPush === "true" ||
              agentEnv.autoRedeployOnPush === true,
            runningDeploymentId: a.deployments[0]?.id ?? null,
          };
        });
      },

      recordVersion: async ({ agentId, commitSha, ref, pusher }) => {
        const agent = await prisma.agent.findUnique({
          where: { id: agentId },
          select: { orgId: true, org: { select: { ownerId: true } } },
        });
        if (!agent) return;
        await createAgentVersion(
          { agentId, orgId: agent.orgId },
          // A push has no platform user. The org owner satisfies the
          // required author column; createdByName records who actually
          // pushed, so the attribution is not a lie.
          agent.org.ownerId,
          {
            changeType: "patch",
            changeLog: `Pushed ${commitSha.slice(0, 12)} to ${ref} by ${pusher}`,
            createdByName: `github:${pusher}`,
          } as never,
        );
      },

      redeploy: async () => ({
        attempted: false as const,
        // Honest refusal: no agent-runtime image in this repo consumes
        // AGENT_SOURCE_URL and builds a pushed commit, so re-submitting
        // would redeploy the SAME image and report success for code that
        // never shipped. The version snapshot above is real; this is not
        // yet, and says so.
        reason:
          "auto-redeploy is not available yet: no agent runtime image builds pushed commits. The commit was recorded as a new version.",
      }),

      emitRefused: async ({ orgId, agentId, reason }) => {
        logger.info({ orgId, agentId, reason }, "push redeploy refused");
      },
    },
  };
}

export function createGitHubAppRoutesProduction(): FastifyPluginAsync {
  return createGitHubAppRoutes(buildGitHubAppDeps());
}
