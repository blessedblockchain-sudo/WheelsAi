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
  deployments: Array<{ slug: string; createdAt: Date; hfId: string }>;
  agents: Array<{ slug: string; createdAt: Date }>;
  /** Enabled workflows only: a disabled one cannot be run. */
  workflows: Array<{ slug: string; createdAt: Date }>;
}

export interface OpenAiV1Deps extends AgentCompletionDeps, WorkflowCompletionDeps {
  /**
   * The guard for the unified routes. It does NOT check a scope: which scope
   * a request needs depends on what its `model` names.
   */
  unifiedAuth?: preHandlerHookHandler;
  deploymentCompletion?: DeploymentCompletionHandler;
  /** Running deployments, agents and enabled workflows of ONE organization. */
  listModels?: (orgId: string) => Promise<ListedModels>;
}

async function listModelsFromDb(orgId: string): Promise<ListedModels> {
  const [deployments, agents, workflows] = await Promise.all([
    prisma.deployment.findMany({
      where: { orgId, status: "running" },
      select: { slug: true, createdAt: true, model: { select: { hfId: true } } },
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
  ]);
  return {
    deployments: deployments.map((d) => ({ slug: d.slug, createdAt: d.createdAt, hfId: d.model.hfId })),
    agents,
    workflows,
  };
}

export type ModelTarget =
  | { kind: "agent"; slug: string }
  | { kind: "workflow"; slug: string }
  | { kind: "deployment"; slug: string };

/** What a `model` value names. Pure. */
export function routeModel(model: string): ModelTarget {
  if (model.startsWith(AGENT_MODEL_PREFIX)) {
    return { kind: "agent", slug: model.slice(AGENT_MODEL_PREFIX.length) };
  }
  if (model.startsWith(WORKFLOW_MODEL_PREFIX)) {
    return { kind: "workflow", slug: model.slice(WORKFLOW_MODEL_PREFIX.length) };
  }
  return { kind: "deployment", slug: model };
}

export function createOpenAiV1Routes(deps: OpenAiV1Deps = {}): FastifyPluginAsync {
  const unifiedAuth = deps.unifiedAuth ?? createOpenAiAuth();
  const completeAgent = createAgentCompletionHandler(deps);
  const completeWorkflow = createWorkflowCompletionHandler(deps);
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
            "OpenAI chat completions on the unified base URL. `model` is 'agent/<slug>', 'workflow/<slug>' or the slug of a running model deployment.",
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
          description: "Running model deployments, agents and enabled workflows, as OpenAI model objects.",
          security: [{ bearerAuth: [] }],
        },
      },
      async (request) => {
        const { deployments, agents, workflows } = await listModels(request.auth!.orgId);
        return {
          object: "list",
          data: [
            ...deployments.map((d) => ({
              id: d.slug,
              object: "model",
              created: Math.floor(d.createdAt.getTime() / 1000),
              owned_by: "wheelsai",
              permission: [],
              root: d.hfId,
              parent: null,
              wheelsai: { kind: "deployment" },
            })),
            ...agents.map(agentModelEntry),
            ...workflows.map(workflowModelEntry),
          ],
        };
      },
    );
  };
}

export const openAiV1Routes: FastifyPluginAsync = createOpenAiV1Routes();
