import { randomBytes } from "node:crypto";

import { FastifyPluginAsync, type preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { requireAuth as defaultRequireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import { prisma } from "@wheelsai/db";
import { triggerWebhook } from "../services/webhooks.js";
import { env } from "../config/env.js";
import { generateAgentJobDefinition } from "../services/agent-runtime.js";
import { mergeAgentEnv, redactAgentEnv, sealAgentEnv } from "../services/agentSecrets.js";
import { assertCanCreateAgent } from "../services/orgPlan.js";
import {
  MarketNotConfiguredError,
  NosanaNotConfiguredError,
  getNosanaClient,
} from "../services/nosana.js";
import { NosanaLifecycleError } from "../services/nosanaDeploymentLifecycle.js";
import { recordNosanaOrphan } from "../services/nosanaOrphans.js";
import { collectAgentTelegramWebhooks, releaseTelegramWebhooks } from "../services/openclaw.js";
import {
  parseGitHubUrl,
  detectFramework,
  GitHubRepoNotFoundError,
} from "../services/github-import.js";
import { getOrgInstallationToken } from "./githubAppBindings.js";
import {
  releaseDeploymentReservation,
  reserveDeploymentCredits,
} from "../services/deploymentCreditGate.js";
import { AGENT_FRAMEWORKS } from "../config/frameworks.js";
import { agentApiEndpoints, serializeAgentDeployment } from "../services/publicEndpoints.js";
import {
  getAgentChatUsage,
  type AgentChatUsage,
  type AgentUsagePeriod,
} from "../services/analytics.js";

const logger = createLogger("agent-routes");

/** Statuses in which an agent deployment may still be consuming a GPU. */
const AGENT_DEPLOYMENT_LIVE_STATUSES = ["pending", "building", "deploying", "running"];

/** Rolls the deployment row back with a failed credit admission. */
class InsufficientCreditsError extends Error {
  constructor(readonly requiredCents: bigint) {
    super("insufficient_credits");
  }
}

// ============================================
// Schemas
// ============================================

const toolSchema = z.object({
  name: z.string(),
  type: z.enum(["function", "api", "mcp"]),
  description: z.string().optional(),
  config: z.record(z.any()).optional(),
});

const createAgentSchema = z.object({
  name: z.string().min(3).max(100),
  description: z.string().max(500).optional(),
  framework: z.enum(AGENT_FRAMEWORKS),
  systemPrompt: z.string().max(10000).optional(),
  tools: z.array(toolSchema).default([]),
  modelConfig: z.object({
    modelId: z.string().optional(), // WheelsAI model ID
    externalModel: z.string().optional(), // e.g., "openai/gpt-4"
    temperature: z.number().min(0).max(2).default(0.7),
    maxTokens: z.number().int().min(1).max(32768).default(4096),
  }),
  sourceType: z.enum(["inline", "github", "ipfs"]),
  sourceUrl: z.string().url().optional(),
  sourceCode: z.string().max(100000).optional(),
  env: z.record(z.string()).default({}),
  tags: z.array(z.string()).default([]),
  isPublic: z.boolean().default(false),
  // Optional RAG grounding (W2): bind a knowledge base and the agent's
  // chat answers get grounded in retrieved passages. null unbinds.
  knowledgeBaseId: z.string().uuid().nullable().optional(),
});

const updateAgentSchema = createAgentSchema.partial().extend({
  // Secrets are write-only: clients never see values, so a PATCH merges.
  // A string sets or replaces a variable; null deletes it.
  env: z.record(z.string().max(8192).nullable()).optional(),
  // What answers a chat (playground and /v1): the agent's prompt, model and
  // tools, or the graph saved in the builder.
  entrypoint: z.enum(["chat", "graph"]).optional(),
});

/**
 * A knowledge base may only be bound by the org that owns it. Without
 * this check any authenticated user could point their agent at another
 * tenant's knowledge base and read its documents back out through chat
 * grounding — the retrieval path trusts the binding.
 */
async function assertKnowledgeBaseOwned(
  knowledgeBaseId: string,
  orgId: string,
): Promise<boolean> {
  const kb = await prisma.knowledgeBase.findFirst({
    where: { id: knowledgeBaseId, orgId },
    select: { id: true },
  });
  return kb !== null;
}

const deployAgentSchema = z.object({
  gpuTier: z.string(),
  replicas: z.number().int().min(1).max(5).default(1),
  modelDeploymentId: z.string().uuid().optional(),
  externalModelUrl: z.string().url().optional(),
  enableWallet: z.boolean().default(false),
  walletConfig: z.object({
    dailyLimitCents: z.number().int().min(0).optional(),
    perTxLimitCents: z.number().int().min(0).optional(),
    allowedDomains: z.array(z.string()).default([]),
  }).optional(),
});

// ============================================
// Routes
// ============================================

export interface AgentRouteDeps {
  requireAuth?: preHandlerHookHandler;
  /** The read routes' database handle (list, detail, deployment status). */
  prisma?: Pick<typeof prisma, "agent" | "agentDeployment">;
  /** PUBLIC_API_URL; a function so a test can vary it per app. */
  publicApiUrl?: () => string | undefined;
  /** The usage read behind GET /:agentId/usage. */
  agentUsage?: (orgId: string, agentId: string, period: AgentUsagePeriod) => Promise<AgentChatUsage>;
}

export function createAgentRoutes(deps: AgentRouteDeps = {}): FastifyPluginAsync {
  const requireAuth = deps.requireAuth ?? defaultRequireAuth;
  const reads = deps.prisma ?? prisma;
  const publicApiUrl = deps.publicApiUrl ?? (() => env.PUBLIC_API_URL);
  const agentUsage =
    deps.agentUsage ??
    ((orgId: string, agentId: string, period: AgentUsagePeriod) => getAgentChatUsage(orgId, agentId, period));

  return async (app) => {
  /**
   * Import agent from GitHub — detects framework and pre-fills config
   */
  app.post("/import-github", { preHandler: [requireAuth], schema: { tags: ["Agents"], description: "Import agent from GitHub repo" } }, async (request, reply) => {
    const { githubUrl } = z.object({ githubUrl: z.string().url() }).parse(request.body);

    try {
      const repoInfo = parseGitHubUrl(githubUrl);
      // Per-ORG installation token, or none. The previous implementation
      // attached the PLATFORM's GITHUB_TOKEN to every user's import,
      // which made this endpoint a confused deputy: any authenticated
      // user could probe — and read dependency files from — every
      // private repo that token could see. Scope now comes from GitHub:
      // an installation token only reaches its own installation's repos.
      const token = (await getOrgInstallationToken(request.auth!.orgId)) ?? undefined;
      const config = await detectFramework(repoInfo.owner, repoInfo.repo, {
        token,
        // Honour /tree/<branch> instead of silently reading the default.
        ref: repoInfo.branch,
      });
      return { config, repoInfo };
    } catch (err) {
      if (err instanceof GitHubRepoNotFoundError) {
        // GitHub returns 404 for "does not exist" and "private, and you
        // cannot see it" alike, so the useful thing is to say what to do
        // about it rather than guess which one happened.
        const hasInstall = Boolean(await getOrgInstallationToken(request.auth!.orgId));
        return reply.status(404).send(
          hasInstall
            ? {
                error: "repo_not_in_installation",
                message:
                  "That repository is not covered by your GitHub App installation. Add it under the installation's repository access, then try again.",
              }
            : {
                error: "github_app_not_connected",
                message:
                  "Repository not found, or it is private. Connect the WheelsAI GitHub App to import private repositories.",
              },
        );
      }
      return reply.badRequest(err instanceof Error ? err.message : "Failed to import from GitHub");
    }
  });

  /**
   * List all agents
   */
  app.get("/", { preHandler: [requireAuth], schema: { tags: ["Agents"], description: "List all agents", security: [{ bearerAuth: [] }] } }, async (request) => {
    const { orgId } = request.auth!;

    const agents = await reads.agent.findMany({
      where: { orgId },
      include: {
        deployments: {
          select: {
            id: true,
            status: true,
            endpoint: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        description: agent.description,
        framework: agent.framework,
        version: agent.version,
        tags: agent.tags,
        isPublic: agent.isPublic,
        // What answers a chat: the agent's prompt, or its saved graph.
        entrypoint: agent.entrypoint ?? "chat",
        // The agent is served by this API whether or not it has a GPU
        // deployment, so its endpoint does not depend on one.
        ...agentApiEndpoints(agent.slug, publicApiUrl()),
        latestDeployment: agent.deployments[0]
          ? serializeAgentDeployment(agent.deployments[0], agent.slug, publicApiUrl())
          : null,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      })),
      total: agents.length,
    };
  });

  /**
   * Get single agent
   */
  app.get("/:agentId", { preHandler: [requireAuth], schema: { tags: ["Agents"], description: "Get agent details" } }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);

    const agent = await reads.agent.findFirst({
      where: { id: agentId, orgId },
      include: {
        deployments: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!agent) {
      return reply.notFound("Agent not found");
    }

    return {
      agent: {
        ...agent,
        ...agentApiEndpoints(agent.slug, publicApiUrl()),
        deployments: agent.deployments.map((deployment) =>
          serializeAgentDeployment(deployment, agent.slug, publicApiUrl()),
        ),
        // Values never leave the API: only the names of set variables.
        env: redactAgentEnv(agent.env),
        secrets: undefined,
      },
    };
  });

  /**
   * Create new agent
   */
  app.post("/", { preHandler: [requireAuth], schema: { tags: ["Agents"], description: "Create a new agent", security: [{ bearerAuth: [] }] } }, async (request, reply) => {
    const { orgId } = request.auth!;
    const body = createAgentSchema.parse(request.body);

    // Validate source
    if (body.sourceType === "inline" && !body.sourceCode) {
      return reply.badRequest("Source code is required for inline agents");
    }
    if ((body.sourceType === "github" || body.sourceType === "ipfs") && !body.sourceUrl) {
      return reply.badRequest("Source URL is required for github/ipfs agents");
    }

    // Generate slug
    const baseSlug = body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // A name with no ASCII letters or digits slugifies to "", which gave the
    // agent an empty (then "-1") slug and so no addressable /v1 path.
    const rootSlug = baseSlug.length > 0 ? baseSlug : `agent-${randomBytes(3).toString("hex")}`;

    let slug = rootSlug;
    let counter = 0;
    while (await prisma.agent.findUnique({ where: { orgId_slug: { orgId, slug } } })) {
      counter++;
      slug = `${rootSlug}-${counter}`;
    }

    if (
      body.knowledgeBaseId &&
      !(await assertKnowledgeBaseOwned(body.knowledgeBaseId, orgId))
    ) {
      return reply.badRequest("Knowledge base not found");
    }

    // Starter includes up to 3 agents (marketplace installs don't count).
    await assertCanCreateAgent(orgId);

    const agent = await prisma.agent.create({
      data: {
        orgId,
        name: body.name,
        slug,
        description: body.description,
        framework: body.framework,
        systemPrompt: body.systemPrompt,
        tools: body.tools,
        modelConfig: body.modelConfig,
        sourceType: body.sourceType,
        sourceUrl: body.sourceUrl,
        sourceCode: body.sourceCode,
        env: sealAgentEnv(body.env),
        tags: body.tags,
        isPublic: body.isPublic,
        knowledgeBaseId: body.knowledgeBaseId ?? null,
      },
    });

    logger.info({ agentId: agent.id, orgId }, "Agent created");

    // Webhook emission (Wave 1) — the 16 subscribable events existed but
    // nothing ever fired one. Fire-and-forget, house pattern.
    triggerWebhook(
      orgId,
      "agent.created",
      { agentId: agent.id, name: agent.name, slug: agent.slug },
      "agent",
      agent.id,
    ).catch((err) => logger.error({ err }, "webhook agent.created failed"));

    reply.status(201);
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        framework: agent.framework,
        ...agentApiEndpoints(agent.slug, publicApiUrl()),
      },
      message: "Agent created successfully",
    };
  });

  /**
   * Update agent
   */
  app.patch("/:agentId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);
    const updates = updateAgentSchema.parse(request.body);

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, orgId },
    });

    if (!agent) {
      return reply.notFound("Agent not found");
    }

    if (
      updates.knowledgeBaseId &&
      !(await assertKnowledgeBaseOwned(updates.knowledgeBaseId, orgId))
    ) {
      return reply.badRequest("Knowledge base not found");
    }

    // An agent cannot be told to answer through a graph it does not have:
    // every chat would then fail. (Deleting the graph afterwards is answered
    // per chat, with a named 400.)
    if (updates.entrypoint === "graph" && agent.entrypoint !== "graph") {
      const graph = await prisma.agentGraph.findUnique({
        where: { agentId },
        select: { nodes: true },
      });
      if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
        return reply.status(400).send({
          error: "agent_graph_missing",
          message: "This agent has no saved graph. Build one in the graph builder before making it the entrypoint.",
        });
      }
    }

    // Increment version when behaviour actually changes (a settings save
    // that resends an unchanged prompt is not a new version).
    const differs = (key: "sourceCode" | "sourceUrl" | "systemPrompt" | "tools" | "entrypoint") =>
      updates[key] !== undefined &&
      JSON.stringify(updates[key]) !== JSON.stringify((agent as Record<string, unknown>)[key] ?? null);
    let newVersion = agent.version;
    if (
      differs("sourceCode") ||
      differs("sourceUrl") ||
      differs("systemPrompt") ||
      differs("tools") ||
      differs("entrypoint")
    ) {
      const [major = 1, minor = 0, patch = 0] = agent.version.split(".").map(Number);
      newVersion = `${major}.${minor}.${patch + 1}`;
    }

    const { env: envPatch, ...fieldUpdates } = updates;
    const updatedAgent = await prisma.agent.update({
      where: { id: agentId },
      data: {
        ...fieldUpdates,
        env: envPatch ? mergeAgentEnv(agent.env, envPatch) : undefined,
        version: newVersion,
        modelConfig: updates.modelConfig
          ? { ...(agent.modelConfig as any), ...updates.modelConfig }
          : undefined,
      },
    });

    triggerWebhook(
      orgId,
      "agent.updated",
      { agentId: updatedAgent.id, name: updatedAgent.name },
      "agent",
      updatedAgent.id,
    ).catch((err) => logger.error({ err }, "webhook agent.updated failed"));

    return {
      agent: {
        ...updatedAgent,
        ...agentApiEndpoints(updatedAgent.slug, publicApiUrl()),
        env: redactAgentEnv(updatedAgent.env),
        secrets: undefined,
      },
    };
  });

  /**
   * Chat traffic of one agent (playground and /v1): requests, errors, tokens
   * and latency over a period, from the hourly rollup.
   */
  app.get(
    "/:agentId/usage",
    { preHandler: [requireAuth], schema: { tags: ["Agents"], description: "Agent chat usage and latency" } },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);
      const { period } = z
        .object({ period: z.enum(["24h", "7d", "30d"]).default("24h") })
        .parse(request.query);

      const agent = await reads.agent.findFirst({ where: { id: agentId, orgId }, select: { id: true } });
      if (!agent) return reply.notFound("Agent not found");

      return { usage: await agentUsage(orgId, agentId, period) };
    },
  );

  /**
   * Delete agent
   */
  app.delete("/:agentId", { preHandler: [requireAuth] }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, orgId },
      include: { deployments: true },
    });

    if (!agent) {
      return reply.notFound("Agent not found");
    }

    // Stop every deployment that may still hold a GPU (a `deploying` one with
    // a Nosana id is as live as a `running` one). Deleting the agent deletes
    // its deployment rows, and with them the only record of their Nosana ids:
    // one that was not verified stopped AND drained is handed to the vault
    // sweep first. If even that cannot be recorded the delete is refused - a
    // deleted row must never leave a GPU running on platform funds.
    const liveDeployments = agent.deployments.filter(
      (d) => AGENT_DEPLOYMENT_LIVE_STATUSES.includes(d.status) && d.nosanaJobIds.length > 0,
    );
    if (liveDeployments.length > 0) {
      const nosana = await getNosanaClient();
      for (const deployment of liveDeployments) {
        for (const jobId of deployment.nosanaJobIds) {
          let settled = false;
          try {
            settled = (await nosana.stopDeployment(jobId)).reclaimed;
          } catch (err) {
            logger.error({ err, jobId }, "Failed to stop agent deployment");
          }
          if (settled) continue;
          const recorded = await recordNosanaOrphan(prisma, {
            nosanaDeploymentId: jobId,
            sourceKind: "agent",
            sourceId: deployment.id,
            reason: "agent_deleted",
          });
          if (!recorded) {
            return reply.status(502).send({
              error: "nosana_stop_failed",
              message:
                "Nosana did not confirm that the agent's deployment stopped. The agent was not deleted; retry shortly.",
            });
          }
        }
      }
    }

    // The agent's channels go with it (cascade), so read their Telegram bots
    // first and release the webhooks once the rows are gone.
    const telegram = await collectAgentTelegramWebhooks(agentId);
    await prisma.agent.delete({ where: { id: agentId } });
    await releaseTelegramWebhooks(telegram);

    logger.info({ agentId, orgId }, "Agent deleted");

    triggerWebhook(
      orgId,
      "agent.deleted",
      { agentId, name: agent.name },
      "agent",
      agentId,
    ).catch((err) => logger.error({ err }, "webhook agent.deleted failed"));

    return { message: "Agent deleted" };
  });

  /**
   * Deploy agent
   */
  app.post("/:agentId/deploy", { preHandler: [requireAuth], schema: { tags: ["Agents"], description: "Deploy agent to GPU" } }, async (request, reply) => {
    const { orgId } = request.auth!;
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(request.params);
    const body = deployAgentSchema.parse(request.body);

    const agent = await prisma.agent.findFirst({
      where: { id: agentId, orgId },
    });

    if (!agent) {
      return reply.notFound("Agent not found");
    }

    // Validate model configuration
    const modelConfig = agent.modelConfig as any;
    if (!body.modelDeploymentId && !body.externalModelUrl && !modelConfig.externalModel) {
      return reply.badRequest(
        "Either modelDeploymentId, externalModelUrl, or agent modelConfig.externalModel is required"
      );
    }

    // If using internal model deployment, verify it exists and is running
    if (body.modelDeploymentId) {
      const modelDeployment = await prisma.deployment.findFirst({
        where: { id: body.modelDeploymentId, orgId },
      });
      if (!modelDeployment) {
        return reply.badRequest("Model deployment not found");
      }
      if (modelDeployment.status !== "running") {
        return reply.badRequest("Model deployment is not running");
      }
    }

    // Pre-flight BEFORE any credits are reserved (as POST /deployments does):
    // an unconfigured platform (no Nosana wallet, or no market for this GPU
    // tier on this network) answers 501 here. It used to answer 201, take the
    // reservation, and only then fail in the background submit.
    try {
      (await getNosanaClient()).assertCanDeploy(body.gpuTier);
    } catch (err) {
      if (err instanceof NosanaNotConfiguredError) {
        return reply.status(501).send({ error: err.code, message: err.message });
      }
      if (err instanceof MarketNotConfiguredError) {
        return err.code === "unknown_tier"
          ? reply.status(400).send({ error: "unknown_gpu_tier", message: err.message })
          : reply.status(501).send({ error: "gpu_market_not_configured", message: err.message });
      }
      // The client could not be built at all (bad wallet key, RPC setup).
      logger.error({ err, agentId }, "Nosana client unavailable for agent deploy");
      return reply.status(503).send({
        error: "nosana_unavailable",
        message: "The compute backend is not available right now; nothing was reserved. Retry shortly.",
      });
    }

    // A4: Nosana jobs are platform-paid — gate admission on a per-org
    // active-deployment quota and a credit reservation.
    const activeCount = await prisma.agentDeployment.count({
      where: {
        agent: { orgId },
        status: { in: ["pending", "building", "deploying", "running"] },
      },
    });
    if (activeCount >= env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG) {
      return reply.status(429).send({
        error: "deployment_quota_exceeded",
        message: `Organization already has ${activeCount} active agent deployments (limit ${env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG}).`,
      });
    }

    // Deployment row + credit reservation in ONE transaction, referenced
    // by the deployment id. Reserving separately meant a failure before
    // the row existed charged the org for nothing, against a reference
    // (`agent-deploy:<agentId>:<timestamp>`) that could not be traced
    // back to any deployment.
    let deployment: { id: string; status: string; gpuTier: string; replicas: number };
    try {
      deployment = await prisma.$transaction(async (tx) => {
        const created = await tx.agentDeployment.create({
          data: {
            agentId,
            gpuTier: body.gpuTier,
            replicas: body.replicas,
            modelDeploymentId: body.modelDeploymentId,
            externalModelUrl: body.externalModelUrl,
            status: "pending",
            nosanaJobIds: [],
          },
        });

        const reservation = await reserveDeploymentCredits({
          tx: tx as never,
          orgId,
          gpuTier: body.gpuTier,
          replicas: body.replicas,
          referenceId: created.id,
        });
        if (!reservation.ok) {
          throw new InsufficientCreditsError(reservation.requiredCents);
        }

        await tx.agentDeployment.update({
          where: { id: created.id },
          data: { reservationCents: reservation.reservedCents },
        });
        return created;
      });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return reply.status(402).send({
          error: "insufficient_credits",
          message: `Deploying requires a reservation of $${(
            Number(err.requiredCents) / 100
          ).toFixed(2)} in credits. Add credits and retry.`,
        });
      }
      throw err;
    }

    logger.info({ agentId, deploymentId: deployment.id }, "Agent deployment created");

    // Submit to Nosana asynchronously
    submitAgentToNosana(deployment.id, agent, body).catch((err) => {
      logger.error({ err, deploymentId: deployment.id }, "Failed to deploy agent");
    });

    reply.status(201);
    return {
      deployment: {
        id: deployment.id,
        status: deployment.status,
      },
      message: "Agent deployment started",
    };
  });

  /**
   * Get agent deployment status
   */
  app.get(
    "/:agentId/deployments/:deploymentId",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { agentId, deploymentId } = z
        .object({ agentId: z.string().uuid(), deploymentId: z.string().uuid() })
        .parse(request.params);

      const agent = await reads.agent.findFirst({
        where: { id: agentId, orgId },
      });

      if (!agent) {
        return reply.notFound("Agent not found");
      }

      const deployment = await reads.agentDeployment.findFirst({
        where: { id: deploymentId, agentId },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      return {
        deployment: serializeAgentDeployment(deployment, agent.slug, publicApiUrl()),
      };
    }
  );

  /**
   * Stop agent deployment
   */
  app.post(
    "/:agentId/deployments/:deploymentId/stop",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { agentId, deploymentId } = z
        .object({ agentId: z.string().uuid(), deploymentId: z.string().uuid() })
        .parse(request.params);

      const agent = await prisma.agent.findFirst({
        where: { id: agentId, orgId },
      });

      if (!agent) {
        return reply.notFound("Agent not found");
      }

      const deployment = await prisma.agentDeployment.findFirst({
        where: { id: deploymentId, agentId },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      // Stop Nosana FIRST and fail closed, as the model stop route does: a row
      // marked `stopped` is never polled again, so marking it while the stop
      // did not land would leave the GPU running on platform funds unseen.
      const nosana = await getNosanaClient();
      for (const jobId of deployment.nosanaJobIds) {
        let reclaimed: boolean;
        try {
          reclaimed = (await nosana.stopDeployment(jobId)).reclaimed;
        } catch (err) {
          logger.error({ err, jobId }, "Failed to stop Nosana job");
          return reply.status(502).send({
            error: "nosana_stop_failed",
            message:
              "Nosana did not confirm the stop. The deployment was left as it was; retry shortly.",
          });
        }
        // AgentDeployment has no vault stamp: a withdraw that is still pending
        // (common right after a stop) is retried by the orphan sweep.
        if (!reclaimed) {
          await recordNosanaOrphan(prisma, {
            nosanaDeploymentId: jobId,
            sourceKind: "agent",
            sourceId: deploymentId,
            reason: "agent_stop_vault_pending",
          });
        }
      }

      await prisma.agentDeployment.update({
        where: { id: deploymentId },
        data: {
          status: "stopped",
          stoppedAt: new Date(),
        },
      });

      logger.info({ agentId, deploymentId }, "Agent deployment stopped");

      return { message: "Deployment stopped" };
    }
  );

  /**
   * Get agent deployment logs
   */
  app.get(
    "/:agentId/deployments/:deploymentId/logs",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { orgId } = request.auth!;
      const { agentId, deploymentId } = z
        .object({ agentId: z.string().uuid(), deploymentId: z.string().uuid() })
        .parse(request.params);

      const agent = await prisma.agent.findFirst({
        where: { id: agentId, orgId },
      });

      if (!agent) {
        return reply.notFound("Agent not found");
      }

      const deployment = await prisma.agentDeployment.findFirst({
        where: { id: deploymentId, agentId },
      });

      if (!deployment) {
        return reply.notFound("Deployment not found");
      }

      return {
        logs: deployment.buildLogs || "No logs available",
        error: deployment.lastError,
      };
    }
  );
  };
}

export const agentRoutes: FastifyPluginAsync = createAgentRoutes();

// ============================================
// Helper Functions
// ============================================

async function submitAgentToNosana(
  deploymentId: string,
  agent: any,
  config: z.infer<typeof deployAgentSchema>
): Promise<void> {
  try {
    // Update status to building
    await prisma.agentDeployment.update({
      where: { id: deploymentId },
      data: { status: "building" },
    });

    // Generate job definition
    // The agent's own secrets are deliberately NOT placed in the job
    // definition: Nosana pins job definitions to public IPFS. They reach
    // the runtime through confidential job delivery (claims ledger D1).
    const jobDefinition = generateAgentJobDefinition({
      agent: { ...agent, env: {} } as any,
      modelDeploymentId: config.modelDeploymentId,
      externalModelUrl: config.externalModelUrl,
    });

    // Update status to deploying
    await prisma.agentDeployment.update({
      where: { id: deploymentId },
      data: { status: "deploying" },
    });

    // Submit to Nosana
    const nosana = await getNosanaClient();
    const nosanaDeployment = await nosana.createDeployment(
      jobDefinition,
      config.gpuTier,
      config.replicas
    );

    // Update with Nosana job IDs - only while the row is still being
    // submitted. A stop that landed during createDeployment found no id to
    // stop; writing the id onto the stopped row now would leave the deployment
    // running with nothing polling it.
    const stored = await prisma.agentDeployment.updateMany({
      where: { id: deploymentId, status: { in: ["pending", "building", "deploying"] } },
      // No endpoint is stored: the agent's endpoint is this API's
      // /v1/agents/<slug>, computed on read (services/publicEndpoints.ts).
      data: { nosanaJobIds: [nosanaDeployment.id] },
    });
    if (stored.count === 0) {
      logger.warn(
        { deploymentId, nosanaId: nosanaDeployment.id },
        "Agent deployment was stopped during submit; stopping the Nosana deployment just created",
      );
      const settled = await nosana
        .stopDeployment(nosanaDeployment.id)
        .then((stop) => stop.reclaimed)
        .catch((err) => {
          logger.error({ err, deploymentId }, "Failed to stop an orphaned agent deployment");
          return false;
        });
      if (!settled) {
        await recordNosanaOrphan(prisma, {
          nosanaDeploymentId: nosanaDeployment.id,
          sourceKind: "agent",
          sourceId: deploymentId,
          reason: "stopped_during_submit",
        });
      }
      return;
    }

    // Status stays "deploying" until the deployment-status worker
    // (queues/deployment-status.queue.ts) OBSERVES the Nosana job
    // running — no fabricated timer flip (plan D8), and the transition
    // survives restarts because it is derived from chain state.

    logger.info({ deploymentId, nosanaId: nosanaDeployment.id }, "Agent submitted to Nosana");
  } catch (error: any) {
    logger.error({ error, deploymentId }, "Failed to submit agent to Nosana");

    // A failure after creation carries the Nosana id. Unless its cleanup
    // verified it stopped and drained, keep the id for the vault sweep: the
    // row is about to be `failed` with no id, and nothing else would stop it.
    if (
      error instanceof NosanaLifecycleError &&
      error.deploymentId &&
      !(error.cleanup?.stopped && error.cleanup.reclaimed)
    ) {
      await recordNosanaOrphan(prisma, {
        nosanaDeploymentId: error.deploymentId,
        sourceKind: "agent",
        sourceId: deploymentId,
        reason: "submit_failed",
      });
    }

    await prisma.agentDeployment.update({
      where: { id: deploymentId },
      data: {
        status: "failed",
        lastError: error.message || "Unknown error",
      },
    });

    // No submit, no capacity — release the admission hold. A row that
    // failed to submit carries no Nosana job ids, so the status worker
    // never polls it and would never release it.
    try {
      const row = await prisma.agentDeployment.findUnique({
        where: { id: deploymentId },
        select: { reservationCents: true, agent: { select: { orgId: true } } },
      });
      if (row?.reservationCents && row.reservationCents > 0n) {
        await prisma.$transaction((tx) =>
          releaseDeploymentReservation({
            tx: tx as never,
            kind: "agent",
            deploymentId,
            orgId: row.agent.orgId,
            reservationCents: row.reservationCents!,
            reason: "submit_failed",
          }),
        );
      }
    } catch (refundErr) {
      // Never mask the original submit error with a refund failure.
      logger.error({ refundErr, deploymentId }, "failed to release agent deployment reservation");
    }

    throw error;
  }
}
