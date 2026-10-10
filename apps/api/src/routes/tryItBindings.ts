/**
 * Production wiring for Try it (routes/tryIt.ts), mounted beside the
 * marketplace routes at /api/marketplace.
 *
 * Always mounted. What is not configured answers as what it is: without the
 * Turnstile keys an anonymous visitor is asked to sign in; without a price
 * for a funded message a publisher-funded cap answers 501.
 *
 * buildTryItRouteDeps is exported for the wiring test.
 */

import type { FastifyPluginAsync } from "fastify";

import { env } from "../config/env.js";
import { getAllFreeModels, getAvailableFreeModels } from "../config/free-models.js";
import { publicTaskForm } from "../services/agentKind.js";
import { resolveAgentModelId } from "../services/agentModelResolution.js";
import { productionPublicChatDeps, publicChatLimiter } from "../services/buildPublicChatDeps.js";
import {
  getListingTrialFundedUsage,
  getListingTrialPreview,
  getListingTrialSettings,
  setListingTrialFundedCap,
} from "../services/marketplace.js";
import { TRY_IT_TURNSTILE_ACTION, verifyTurnstile } from "../services/turnstile.js";
import { createTryItRoutes, type TryItRouteDeps } from "./tryIt.js";
import { buildWebChannelGuards } from "./webChannelBindings.js";

/** Sessions one address, and one signed-in organization, may open an hour. */
export const TRIAL_SESSIONS_PER_IP_PER_HOUR = 10;
export const TRIAL_SESSIONS_PER_ORG_PER_HOUR = 30;

/** The hostname Turnstile tokens must have been solved on: the web app's. */
function webHostname(): string {
  return new URL(env.PUBLIC_WEB_URL ?? env.CORS_ORIGIN).hostname;
}

function turnstileFromEnv(): TryItRouteDeps["sessions"]["turnstile"] {
  const siteKey = env.TURNSTILE_SITE_KEY;
  const secret = env.TURNSTILE_SECRET_KEY;
  // validateEnv refuses one without the other.
  if (!siteKey || !secret) return null;
  return {
    siteKey,
    verify: ({ token, remoteIp, listingId }) =>
      verifyTurnstile(
        {
          token,
          remoteIp,
          expectedAction: TRY_IT_TURNSTILE_ACTION,
          expectedHostname: webHostname(),
          expectedCdata: listingId,
        },
        { secret },
      ),
  };
}

export function buildTryItRouteDeps(): TryItRouteDeps {
  return {
    chat: productionPublicChatDeps(),
    sessions: {
      limiter: publicChatLimiter,
      perIpPerHour: TRIAL_SESSIONS_PER_IP_PER_HOUR,
      perOrgPerHour: TRIAL_SESSIONS_PER_ORG_PER_HOUR,
      secret: env.JWT_SECRET,
      turnstile: turnstileFromEnv(),
    },
    listings: {
      loadPreview: async (slug) => {
        const preview = await getListingTrialPreview(slug);
        if (!preview) return null;
        return {
          id: preview.id,
          agentEntrypoint: preview.agentEntrypoint,
          // The rule agent chat itself resolves an agent's model with.
          agentModelId: resolveAgentModelId({
            override: null,
            modelConfig: preview.agentModelConfig,
            availableFreeModelIds: getAvailableFreeModels().map((model) => model.id),
          }),
          agentTools: preview.agentTools,
          agentKind: preview.agentKind,
          // A task agent's form as anyone may see it; no other kind has one.
          inputSchema: preview.agentKind === "task" ? publicTaskForm(preview.agentKindConfig).schema : null,
        };
      },
      // Asked of the registry that runs the tools, in the mode a preview
      // runs them in: the panel lists exactly what the chat withholds.
      disabledTools: async (toolNames) => {
        const registry = (await import("../services/skills/production.js")).getDefaultRegistry();
        return toolNames.filter((name) => {
          const skill = registry.get(name);
          return skill !== undefined && registry.modeBlock(skill, { mode: "public" }) !== null;
        });
      },
      modelLabel: (modelId) => getAllFreeModels().find((model) => model.id === modelId)?.displayName ?? modelId,
      getSettings: getListingTrialSettings,
      setFundedDailyCap: setListingTrialFundedCap,
      fundedToday: getListingTrialFundedUsage,
    },
    fundedMessageCents: env.TRIAL_FUNDED_MESSAGE_CENTS ?? null,
    guards: buildWebChannelGuards(),
  };
}

export function createTryItRoutesProduction(): FastifyPluginAsync {
  return createTryItRoutes(buildTryItRouteDeps());
}
