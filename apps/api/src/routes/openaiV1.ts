/**
 * The unified OpenAI base URL: `<api>/v1`.
 *
 *   POST /v1/chat/completions   routed on `model`
 *   GET  /v1/models             everything this caller can name as `model`
 *
 * An OpenAI client is configured with ONE base URL and picks what it talks to
 * with `model`. Here that is:
 *
 *   agent/<slug>      an agent of the caller's organization
 *                     (routes/agentCompletions.ts)
 *   workflow/<slug>   a workflow of the caller's organization: one request
 *                     is one run (routes/workflowCompletions.ts)
 *   a/<handle>        an agent the caller PAYS to use, by the handle on its
 *                     page: the creator's own agent, never a copy
 *                     (routes/paidCompletions.ts)
 *   <deployment slug> a running model deployment of the caller's organization
 *                     (routes/inference.ts), billed exactly as on its own URL
 *
 * This plugin is registered with the prefix /v1 and owns that prefix's error
 * and not-found handlers, so every failure under it that Fastify or a plugin
 * produces - a body that is too large, the rate limiter's 429, a path that
 * does not exist - is answered in OpenAI's shape.
 *
 * The per-deployment route (POST /v1/:deploymentSlug/chat/completions) is
 * registered by routes/inference.ts and runs the same handler as the
 * deployment branch here, so both speak the same wire format.
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";

import { prisma } from "../lib/prisma.js";
import {
  AGENTS_INVOKE_SCOPE,
  createOpenAiAuth,
  openAiErrorHandler,
  openAiNotFoundHandler,
  principalHasScope,
  replyOpenAiError,
  sendOpenAiError,
  WORKFLOWS_INVOKE_SCOPE,
} from "../middleware/openaiAuth.js";
import { parseChatCompletionRequest } from "../services/openaiCompat.js";
import { useAccess } from "../services/useAccess.js";
import {
  agentModelEntry,
  createAgentCompletionHandler,
  createAgentCompletionRoutes,
  V1_BODY_LIMIT_BYTES,
  type AgentCompletionDeps,
} from "./agentCompletions.js";
import {
  createDeploymentCompletionHandler,
  type DeploymentCompletionHandler,
} from "./inference.js";
import {
  AGENTS_USE_SCOPE,
  createPaidCompletionHandler,
  PAID_MODEL_PREFIX,
  paidModelEntry,
  type PaidCompletionDeps,
} from "./paidCompletions.js";
import {
  createWorkflowCompletionHandler,
  createWorkflowCompletionRoutes,
  workflowModelEntry,
  type WorkflowCompletionDeps,
} from "./workflowCompletions.js";

export const AGENT_MODEL_PREFIX = "agent/";
export const WORKFLOW_MODEL_PREFIX = "workflow/";

/** How many agents, and how many workflows, one /v1/models answer lists. */
const MAX_LISTED_AGENTS = 500;
const MAX_LISTED_WORKFLOWS = 500;

export interface ListedModels {
  deployments: Array<{
    slug: string;
    createdAt: Date;
    /** Hugging Face id of the (base) model the deployment runs. */
    hfId: string;
    /** Slug of the fine-tuned model it serves on top of that base, if any. */
    fineTunedModel?: string | null;
  }>;
  agents: Array<{ slug: string; createdAt: Date }>;
  /** Enabled workflows only: a disabled one cannot be run. */
  workflows: Array<{ slug: string; createdAt: Date }>;
  /** Other people's agents this organization pays to use, and may use right now. */
  used?: Array<{ handle: string; createdAt: Date }>;
}

export interface OpenAiV1Deps extends AgentCompletionDeps, WorkflowCompletionDeps, PaidCompletionDeps {
  /**
   * The guard for the unified routes. It does NOT check a scope: which scope
   * a request needs depends on what its `model` names.
   */
  unifiedAuth?: preHandlerHookHandler;
  deploymentCompletion?: DeploymentCompletionHandler;
  /** Running deployments, agents and enabled workflows of ONE organization. */
  listModels?: (orgId: string) => Promise<ListedModels>;
}

/** A use licence as /v1/models reads it. */
export interface UsedAgentRow {
  kind: string;
  status: string;
  installedAt: Date;
  acceptedPricingModel: string | null;
  acceptedPricePerRequestCents: bigint | null;
  listingId: string;
  listing: {
    status: string;
    sells: string;
    pricingModel: string;
    pricePerRequestCents: bigint | null;
    agent: { publicHandle: string | null };
  };
}

export interface UsedSubscriptionRow {
  listingId: string;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  endReason: string | null;
}

/**
 * The agents an organization may use right now, from its use licences: a
 * listing that still gives access at the price agreed, or a paid month
 * (services/useAccess.ts). A licence that would be refused is not listed: a
 * model a client can name and not call is worse than one it cannot see.
 * Pure.
 */
export function usedAgentsOf(
  licences: UsedAgentRow[],
  subscriptions: UsedSubscriptionRow[],
  now: Date = new Date(),
): Array<{ handle: string; createdAt: Date }> {
  const subs = new Map(subscriptions.map((sub) => [sub.listingId, sub]));
  const used: Array<{ handle: string; createdAt: Date }> = [];
  for (const licence of licences) {
    const handle = licence.listing.agent.publicHandle;
    if (!handle) continue;
    const access = useAccess(
      {
        licence: {
          kind: licence.kind,
          status: licence.status,
          accepted: {
            pricingModel: licence.acceptedPricingModel,
            pricePerRequestCents: licence.acceptedPricePerRequestCents,
          },
        },
        listing: licence.listing,
        sub: subs.get(licence.listingId) ?? null,
      },
      now,
    );
    if (access === "subscribed" || access === "listing_pricing") used.push({ handle, createdAt: licence.installedAt });
  }
  return used;
}

async function usedAgentsFromDb(orgId: string): Promise<Array<{ handle: string; createdAt: Date }>> {
  const licences = await prisma.agentInstall.findMany({
    where: { buyerId: orgId, kind: "use", status: { in: ["active", "suspended"] } },
    select: {
      kind: true,
      status: true,
      installedAt: true,
      acceptedPricingModel: true,
      acceptedPricePerRequestCents: true,
      listingId: true,
      listing: {
        select: {
          status: true,
          sells: true,
          pricingModel: true,
          pricePerRequestCents: true,
          agent: { select: { publicHandle: true } },
        },
      },
    },
    orderBy: { installedAt: "asc" },
    take: MAX_LISTED_AGENTS,
  });
  if (licences.length === 0) return [];
  const subscriptions = await prisma.agentSubscription.findMany({
    where: { subscriberId: orgId, listingId: { in: licences.map((licence) => licence.listingId) } },
    select: { listingId: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, endReason: true },
  });
  return usedAgentsOf(licences, subscriptions);
}

async function listModelsFromDb(orgId: string): Promise<ListedModels> {
  const [deployments, agents, workflows, used] = await Promise.all([
    prisma.deployment.findMany({
      where: { orgId, status: "running" },
      select: {
        slug: true,
        createdAt: true,
        model: { select: { hfId: true } },
        fineTunedModel: { select: { slug: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.agent.findMany({
      where: { orgId },
      select: { slug: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: MAX_LISTED_AGENTS,
    }),
    prisma.orchestration.findMany({
      where: { orgId, isEnabled: true },
      select: { slug: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: MAX_LISTED_WORKFLOWS,
    }),
    usedAgentsFromDb(orgId),
  ]);
  return {
    deployments: deployments.map((d) => ({
      slug: d.slug,
      createdAt: d.createdAt,
      hfId: d.model.hfId,
      fineTunedModel: d.fineTunedModel?.slug ?? null,
    })),
    agents,
    workflows,
    used,
  };
}

export type ModelTarget =
  | { kind: "agent"; slug: string }
  | { kind: "workflow"; slug: string }
  | { kind: "paid"; handle: string }
  | { kind: "deployment"; slug: string };

/** What a `model` value names. Pure. */
export function routeModel(model: string): ModelTarget {
  if (model.startsWith(AGENT_MODEL_PREFIX)) {
    return { kind: "agent", slug: model.slice(AGENT_MODEL_PREFIX.length) };
  }
  if (model.startsWith(WORKFLOW_MODEL_PREFIX)) {
    return { kind: "workflow", slug: model.slice(WORKFLOW_MODEL_PREFIX.length) };
  }
  // A deployment's slug has no "/", so this prefix cannot shadow one.
  if (model.startsWith(PAID_MODEL_PREFIX)) {
    return { kind: "paid", handle: model.slice(PAID_MODEL_PREFIX.length) };
  }
  return { kind: "deployment", slug: model };
}

export function createOpenAiV1Routes(deps: OpenAiV1Deps = {}): FastifyPluginAsync {
  const unifiedAuth = deps.unifiedAuth ?? createOpenAiAuth();
  const completeAgent = createAgentCompletionHandler(deps);
  const completeWorkflow = createWorkflowCompletionHandler(deps);
  const completePaid = createPaidCompletionHandler(deps);
  const listModels = deps.listModels ?? listModelsFromDb;
  let completeDeployment = deps.deploymentCompletion ?? null;

  return async (app) => {
    app.setErrorHandler(openAiErrorHandler);
    app.setNotFoundHandler(openAiNotFoundHandler);

    await app.register(createAgentCompletionRoutes(deps));
    await app.register(createWorkflowCompletionRoutes(deps));

    app.post(
      "/chat/completions",
      {
        preHandler: [unifiedAuth],
        bodyLimit: V1_BODY_LIMIT_BYTES,
        schema: {
          tags: ["OpenAI-compatible"],
          description:
            "OpenAI chat completions on the unified base URL. `model` is 'agent/<slug>', 'workflow/<slug>', 'a/<handle>' for an agent you pay to use, or the slug of a running model deployment.",
          security: [{ bearerAuth: [] }],
        },
      },
      async (request, reply) => {
        const body = request.body as { model?: unknown } | null | undefined;
        const model = typeof body?.model === "string" ? body.model.trim() : "";
        if (model.length === 0) {
          return replyOpenAiError(reply, "validation_failed", {
            param: "model",
            message:
              "model is required: 'agent/<slug>' for an agent, 'workflow/<slug>' for a workflow, or the slug of a running model deployment. GET /v1/models lists them.",
          });
        }

        const target = routeModel(model);
        if (target.kind === "agent") {
          if (!principalHasScope(request.auth!, AGENTS_INVOKE_SCOPE)) {
            return replyOpenAiError(reply, "insufficient_scope", {
              message: `This API key does not have the "${AGENTS_INVOKE_SCOPE}" scope.`,
            });
          }
          const parsed = parseChatCompletionRequest(request.body);
          if (!parsed.ok) return sendOpenAiError(reply, parsed.error);
          return completeAgent(request, reply, { agentSlug: target.slug, chat: parsed.request });
        }

        if (target.kind === "workflow") {
          if (!principalHasScope(request.auth!, WORKFLOWS_INVOKE_SCOPE)) {
            return replyOpenAiError(reply, "insufficient_scope", {
              message: `This API key does not have the "${WORKFLOWS_INVOKE_SCOPE}" scope.`,
            });
          }
          const parsed = parseChatCompletionRequest(request.body);
          if (!parsed.ok) return sendOpenAiError(reply, parsed.error);
          return completeWorkflow(request, reply, { workflowSlug: target.slug, chat: parsed.request });
        }

        if (target.kind === "paid") {
          // A spend scope: held only by a key that lists it by name. A
          // session is not scoped.
          if (!principalHasScope(request.auth!, AGENTS_USE_SCOPE)) {
            return replyOpenAiError(reply, "insufficient_scope", {
              message: `This API key does not have the "${AGENTS_USE_SCOPE}" scope. Create a key with it and both spend caps to pay for agents.`,
            });
          }
          const parsed = parseChatCompletionRequest(request.body);
          if (!parsed.ok) return sendOpenAiError(reply, parsed.error);
          return completePaid(request, reply, { handle: target.handle, chat: parsed.request });
        }

        completeDeployment ??= createDeploymentCompletionHandler();
        return completeDeployment(request, reply, { deploymentSlug: target.slug });
      },
    );

    app.get(
      "/models",
      {
        preHandler: [unifiedAuth],
        schema: {
          tags: ["OpenAI-compatible"],
          description:
            "Running model deployments, agents and enabled workflows, as OpenAI model objects. ?deployment=<slug> lists that deployment only.",
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => {
        const listed = await listModels(request.auth!.orgId);
        // ?deployment=<slug> narrows the list to that one deployment. A custom
        // domain that points at a deployment lists its models this way, so its
        // base URL names the one model it serves.
        const only = (request.query as { deployment?: unknown } | undefined)?.deployment;
        const { deployments, agents, workflows, used } =
          typeof only === "string" && only.length > 0
            ? { deployments: listed.deployments.filter((d) => d.slug === only), agents: [], workflows: [], used: [] }
            : listed;
        return {
          object: "list",
          data: [
            ...deployments.map((d) => ({
              id: d.slug,
              object: "model",
              created: Math.floor(d.createdAt.getTime() / 1000),
              owned_by: "wheelsai",
              permission: [],
              // The base model. The id stays the deployment's slug whether or
              // not an adapter is served on top of it.
              root: d.hfId,
              parent: null,
              wheelsai: {
                kind: "deployment",
                baseModel: d.hfId,
                ...(d.fineTunedModel ? { fineTunedModel: d.fineTunedModel } : {}),
              },
            })),
            ...agents.map(agentModelEntry),
            ...workflows.map(workflowModelEntry),
            ...(used ?? []).map(paidModelEntry),
          ],
        };
      },
    );
  };
}

export const openAiV1Routes: FastifyPluginAsync = createOpenAiV1Routes();
