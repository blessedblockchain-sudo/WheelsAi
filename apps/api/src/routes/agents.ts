import { FastifyPluginAsync, type preHandlerHookHandler } from "fastify";
import { z } from "zod";

import { requireAuth as defaultRequireAuth } from "../middleware/auth.js";
import { createLogger } from "../utils/logger.js";
import { Prisma, prisma } from "@wheelsai/db";
import { triggerWebhook } from "../services/webhooks.js";
import { env } from "../config/env.js";
import { rowAccessMode } from "../config/nosanaAccess.js";
import { generateAgentJobDefinition } from "../services/agent-runtime.js";
import { mergeAgentEnv, redactAgentEnv } from "../services/agentSecrets.js";
import { agentFieldsSchema } from "../services/agentCreateInput.js";
import { resolveKindConfig } from "../services/agentKind.js";
import { setOwnScheduleEnabled, type OwnScheduleDb } from "../services/agentOwnSchedule.js";
import { assignPublicHandle, setPageUse, type PublicLinkTx } from "../services/agentPublicLink.js";
import { buildCreateAgentDeps } from "../services/buildCreateAgentDeps.js";
import { createAgent, createAgentAnswer, type CreateAgentResult } from "../services/createAgent.js";
import { findUseListing, isPaidUse, ON_SALE_FOR_USE_MESSAGES, type UseListingDb } from "../services/useListing.js";
import { validationFailureFromFields } from "../lib/validationFailure.js";
import { DEFAULT_AGENT_KIND, isAgentKind } from "@wheelsai/shared/agent-kind";
import {
  MarketNotConfiguredError,
  NosanaNotConfiguredError,
  getNosanaClient,
  wheelsaiDeploymentName,
} from "../services/nosana.js";
import { NosanaLifecycleError } from "../services/nosanaDeploymentLifecycle.js";
import { recordNosanaOrphan } from "../services/nosanaOrphans.js";
import {
  COMPUTE_UNAVAILABLE_MESSAGE,
  computeRefusal,
  GPU_TIER_UNAVAILABLE_MESSAGE,
  isAccessModeUnavailable,
  runDeployPreflight,
} from "../services/nosanaPreflight.js";
import { listHostedModelChoices, type HostedModelChoice } from "../services/hostedModelChoices.js";
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
import {
  agentApiEndpoints,
  serializeAgentDeployment,
} from "../services/publicEndpoints.js";
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

// What a create accepts is in services/agentCreateInput.ts: only a name is
// needed there. An update accepts any part of the same fields.
const updateAgentSchema = agentFieldsSchema.partial().extend({
  // Secrets are write-only: clients never see values, so a PATCH merges.
  // A string sets or replaces a variable; null deletes it.
  env: z.record(z.string().max(8192).nullable()).optional(),
  // What answers a chat (playground and /v1): the agent's prompt, model and
  // tools, or the graph saved in the builder.
  entrypoint: z.enum(["chat", "graph"]).optional(),
  // How people use the agent, and that kind's settings. Read by
  // resolveKindConfig, which answers in plain words by field. Inside
  // kindConfig a key that is sent replaces that key and the others stay.
  agentKind: z.unknown().optional(),
  kindConfig: z.unknown().optional(),
});

/** What a GPU click on an agent is answered with (501) while AGENT_GPU_ENABLED is off. */
export const AGENT_GPU_UNAVAILABLE_MESSAGE =
  "Dedicated GPUs for agents are being built. Nothing was reserved or charged. Your agent keeps answering on WheelsAI.";

// What changing an agent is answered with (409 on_sale_for_use) while a
// published listing sells use of it. Kept with the listing's own rules,
// which a version rollback follows too (services/versioning.ts).
export { ON_SALE_FOR_USE_MESSAGES };

/** What deleting an agent is answered with (409 agent_has_buyers) while its listing has buyers. */
export const AGENT_HAS_BUYERS_MESSAGE =
  "People have paid for this agent, so it cannot be deleted. Stop selling it instead: it leaves the marketplace, and subscribers keep access until the month they paid for ends.";

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
  /** The create path behind POST / (services/createAgent.ts). */
  createAgent?: (args: { orgId: string; body: unknown }) => Promise<CreateAgentResult>;
  /** AGENT_GPU_ENABLED; a function so a test can vary it per app. */
  agentGpuEnabled?: () => boolean;
  /** The list behind GET /hosted-models (services/hostedModelChoices.ts). */
  hostedModels?: (orgId: string) => Promise<HostedModelChoice[]>;
}

export function createAgentRoutes(deps: AgentRouteDeps = {}): FastifyPluginAsync {
  const requireAuth = deps.requireAuth ?? defaultRequireAuth;
  const reads = deps.prisma ?? prisma;
  const publicApiUrl = deps.publicApiUrl ?? (() => env.PUBLIC_API_URL);
  const agentUsage =
    deps.agentUsage ??
    ((orgId: string, agentId: string, period: AgentUsagePeriod) => getAgentChatUsage(orgId, agentId, period));
  const createAgentWith =
    deps.createAgent ?? ((args: { orgId: string; body: unknown }) => createAgent(buildCreateAgentDeps(), args));
  const agentGpuEnabled = deps.agentGpuEnabled ?? (() => env.AGENT_GPU_ENABLED);
  const hostedModelsOf = deps.hostedModels ?? ((orgId: string) => listHostedModelChoices({ orgId }));

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
        // The name in its public address, /a/<handle>; null until it has been public.
        publicHandle: agent.publicHandle ?? null,
        // How people use it: conversation, task or scheduled.
        agentKind: isAgentKind(agent.agentKind) ? agent.agentKind : DEFAULT_AGENT_KIND,
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
   * The models the caller's organization runs itself, as an agent's model
   * choices. The same list the playground models route carries, for screens
   * that have no agent yet. A static path: it is matched before /:agentId.
   */
  app.get(
    "/hosted-models",
    {
      preHandler: [requireAuth],
      schema: {
        tags: ["Agents"],
        description: "List the models your organization runs on its own deployments, as an agent's model choices",
      },
    },
    async (request) => {
      const { orgId } = request.auth!;
      return { hostedModels: await hostedModelsOf(orgId) };
    },
  );

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

    // One create path for this route and for "use this template": only a
    // name is needed, `templateId` starts the agent from a template, and a
    // refusal names the field in plain words.
    const result = await createAgentWith({ orgId, body: request.body });
    const answer = createAgentAnswer(result, publicApiUrl());
    return reply.status(answer.status).send(answer.body);
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

    // The kind and its settings, only when one of them is sent. What is not
    // sent stays as stored.
    const { agentKind: sentKind, kindConfig: sentKindConfig, ...sentFields } = updates;
    const kind =
      sentKind !== undefined || sentKindConfig !== undefined
        ? resolveKindConfig({ agentKind: sentKind, kindConfig: sentKindConfig }, { current: agent })
        : null;
    if (kind && !kind.ok) {
      return reply.status(400).send(validationFailureFromFields(kind.fields, kind.message));
    }

    // An agent whose use is on sale keeps what its buyers rely on: its page,
    // answers from its instructions, and, at a price per use, a kind that
    // is used by a person. Decided here, before anything is written (the
    // address below is the first write). The listing is read only when the
    // change touches one of the three, and a read that fails fails the
    // change.
    const closesSoldPage = updates.isPublic === false && agent.isPublic;
    const switchesToGraph = updates.entrypoint === "graph" && agent.entrypoint !== "graph";
    const becomesScheduled = kind?.agentKind === "scheduled" && agent.agentKind !== "scheduled";
    if (closesSoldPage || switchesToGraph || becomesScheduled) {
      const useListing = await findUseListing(prisma as unknown as UseListingDb, agentId);
      const refusal = !useListing
        ? null
        : closesSoldPage
          ? ON_SALE_FOR_USE_MESSAGES.page
          : switchesToGraph
            ? ON_SALE_FOR_USE_MESSAGES.graph
            : becomesScheduled && useListing.pricingModel === "per_request" && isPaidUse(useListing)
              ? ON_SALE_FOR_USE_MESSAGES.scheduled
              : null;
      if (refusal) {
        return reply.status(409).send({ error: "on_sale_for_use", message: refusal });
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
      differs("entrypoint") ||
      kind?.changed
    ) {
      const [major = 1, minor = 0, patch = 0] = agent.version.split(".").map(Number);
      newVersion = `${major}.${minor}.${patch + 1}`;
    }

    // A page that becomes public needs an address. Given before the write
    // that publishes it, so a public agent is never left without one; an
    // agent that has a handle keeps it, and making it private again clears
    // nothing. No page key is made here: an agent made public this way is
    // view-only until its owner turns the public link on.
    if (updates.isPublic === true && !agent.publicHandle) {
      await assignPublicHandle(prisma as unknown as Pick<PublicLinkTx, "agent">, agent);
    }

    const { env: envPatch, ...fieldUpdates } = sentFields;
    const writeAgent = (db: Pick<typeof prisma, "agent">) =>
      db.agent.update({
        where: { id: agentId },
        data: {
          ...fieldUpdates,
          ...(kind && { agentKind: kind.agentKind, kindConfig: kind.kindConfig ?? Prisma.DbNull }),
          env: envPatch ? mergeAgentEnv(agent.env, envPatch) : undefined,
          version: newVersion,
          modelConfig: updates.modelConfig
            ? { ...(agent.modelConfig as any), ...updates.modelConfig }
            : undefined,
        },
      });
    // A page that stops being public takes its page key off with it, in the
    // same transaction, as turning the public link off does
    // (closePublicPage): the key cannot be used while the page is off, and
    // making the page public again never reopens public use by itself. The
    // link then reads "paused" until its owner turns it on. An agent with no
    // page key has nothing to move, which is not an error.
    const closesPage = updates.isPublic === false && agent.isPublic;
    // An agent whose kind leaves "scheduled" stops running on its own: its
    // own schedule is turned off in the same transaction (a compare-and-set
    // on its enabled column). The task and its history stay, and setting the
    // kind back turns nothing on. An agent with no schedule, or one that is
    // already off, has nothing to move, which is not an error.
    const leavesScheduled = Boolean(kind) && agent.agentKind === "scheduled" && kind?.agentKind !== "scheduled";
    let schedulePaused = false;
    // Both rules in one transaction when a PATCH needs both; none is opened
    // when it needs neither.
    const updatedAgent =
      closesPage || leavesScheduled
        ? await prisma.$transaction(async (tx) => {
            const updated = await writeAgent(tx);
            if (closesPage) {
              await setPageUse(tx as unknown as PublicLinkTx, { orgId, agentId, enabled: false });
            }
            if (leavesScheduled) {
              const turnedOff = await setOwnScheduleEnabled(tx as unknown as Pick<OwnScheduleDb, "scheduledTask">, {
                orgId,
                agentId,
                enabled: false,
              });
              schedulePaused = turnedOff.changed;
            }
            return updated;
          })
        : await writeAgent(prisma);

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
      // Only when this change turned the agent's own schedule off.
      ...(schedulePaused ? { schedulePaused: true } : {}),
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

    // First, before anything is stopped or deleted: an agent people have
    // paid for stays. Its listing (whatever it sells, published or not)
    // holds their install and subscription rows, so the delete below would
    // fail in the database after the GPUs were already stopped.
    const soldListing = await prisma.agentListing.findFirst({
      where: { agentId },
      select: { id: true, _count: { select: { installs: true, subscriptions: true } } },
    });
    // A use paid from a wallet through the x402 door has no install and no
    // subscription: its sale row, which names the paying wallet, is what
    // says someone paid. A payment that never became a sale (held, or
    // failed) has no such row and does not hold the delete.
    const hasBuyers =
      soldListing !== null &&
      (soldListing._count.installs + soldListing._count.subscriptions > 0 ||
        (await prisma.marketplaceRevenue.findFirst({
          where: { listingId: soldListing.id, payerWallet: { not: null } },
          select: { id: true },
        })) !== null);
    if (hasBuyers) {
      return reply.status(409).send({ error: "agent_has_buyers", message: AGENT_HAS_BUYERS_MESSAGE });
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
        // Each id is stopped through the credential that created it.
        const accessMode = rowAccessMode(deployment.nosanaAccessMode);
        for (const jobId of deployment.nosanaJobIds) {
          let settled = false;
          try {
            settled = (await nosana.stopDeployment(jobId, accessMode)).reclaimed;
          } catch (err) {
            logger.error({ err, jobId }, "Failed to stop agent deployment");
          }
          if (settled) continue;
          const recorded = await recordNosanaOrphan(prisma, {
            nosanaDeploymentId: jobId,
            sourceKind: "agent",
            sourceId: deployment.id,
            reason: "agent_deleted",
            accessMode,
          });
          if (!recorded) {
            return reply.status(502).send({
              error: "nosana_stop_failed",
              message:
                "We could not confirm that this agent's deployment stopped, so the agent was not deleted. Try again in a moment.",
            });
          }
        }
      }
    }

    // The agent's channels go with it (cascade), so read their Telegram bots
    // first and release the webhooks once the rows are gone.
    const telegram = await collectAgentTelegramWebhooks(agentId);
    // One statement, and the database does the rest: every scheduled task of
    // the agent goes with it, and each task's saved runs with the task (the
    // cascade on scheduled_tasks.agent_id). Nothing is switched off or
    // deleted by hand first, so no task is ever left without its agent, and
    // a delete that is refused above leaves the schedule as it was.
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
    // First, before anything is read, checked or reserved: while the runtime
    // images for agents are not built, a GPU click has nothing to start.
    if (!agentGpuEnabled()) {
      return reply.status(501).send({
        error: "agent_gpu_unavailable",
        message: AGENT_GPU_UNAVAILABLE_MESSAGE,
      });
    }

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
      // Refused before anything is reserved or created. The only address of
      // a model deployment a Nosana node can reach is this API's /v1 route,
      // which needs an API key of the organization, and no key is delivered
      // to the agent's container: it would start, hold its reservation and be
      // billed while every call to its model answered 401.
      logger.warn({ agentId, modelDeploymentId: body.modelDeploymentId }, "Agent deploy on a model deployment refused");
      return reply.status(501).send({
        error: "agent_model_deployment_unavailable",
        message: AGENT_ON_MODEL_DEPLOYMENT_MESSAGE,
      });
    }

    // Pre-flight BEFORE any credits are reserved (as POST /deployments does):
    // an unconfigured platform (no Nosana credential, or no market for this
    // GPU tier on this network) answers 501 here, and a platform that cannot
    // pay for the GPU right now answers 503. It used to answer 201, take the
    // reservation, and only then fail in the background submit.
    try {
      await runDeployPreflight(await getNosanaClient(), body.gpuTier, body.replicas);
    } catch (err) {
      if (err instanceof NosanaNotConfiguredError) {
        logger.warn({ code: err.code, agentId }, `Agent deploy refused: ${err.message}`);
        return reply.status(501).send({ error: err.code, message: COMPUTE_UNAVAILABLE_MESSAGE });
      }
      if (err instanceof MarketNotConfiguredError) {
        if (err.code === "unknown_tier") {
          return reply.status(400).send({ error: "unknown_gpu_tier", message: err.message });
        }
        logger.warn({ tier: err.tier, network: err.network, agentId }, `Agent deploy refused: ${err.message}`);
        return reply.status(501).send({ error: "gpu_market_not_configured", message: GPU_TIER_UNAVAILABLE_MESSAGE });
      }
      // The platform's own funding refused (credits, key, price below cost).
      const refusal = computeRefusal(err);
      if (refusal) return reply.status(refusal.status).send(refusal.body);
      // The client could not be built at all (bad wallet key, RPC setup).
      logger.error({ err, agentId }, "Nosana client unavailable for agent deploy");
      return reply.status(503).send({
        error: "nosana_unavailable",
        message: "New GPU deployments are temporarily unavailable. Nothing was reserved or charged. Try again in a few minutes.",
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
      const accessMode = rowAccessMode(deployment.nosanaAccessMode);
      for (const jobId of deployment.nosanaJobIds) {
        let reclaimed: boolean;
        try {
          reclaimed = (await nosana.stopDeployment(jobId, accessMode)).reclaimed;
        } catch (err) {
          logger.error({ err, jobId }, "Failed to stop Nosana job");
          if (isAccessModeUnavailable(err)) {
            // No retry from this process can reach it, and the owner must
            // still be able to end their deployment. A stopped agent row is
            // never looked at again, so the id goes to the orphan sweep with
            // its account: that stops it once the credential is back, and the
            // operator view lists it meanwhile. Only if even that cannot be
            // recorded is the stop refused.
            const recorded = await recordNosanaOrphan(prisma, {
              nosanaDeploymentId: jobId,
              sourceKind: "agent",
              sourceId: deploymentId,
              reason: "agent_stop_account_unavailable",
              accessMode,
            });
            if (recorded) continue;
            return reply.status(409).send({
              error: "nosana_access_mode_unavailable",
              message:
                "This deployment cannot be stopped right now. Contact support.",
            });
          }
          return reply.status(502).send({
            error: "nosana_stop_failed",
            message:
              "We could not confirm the stop, so the deployment may still be running. Try again in a moment.",
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
            accessMode,
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

/** What a deploy naming a model deployment is answered with (501). */
const AGENT_ON_MODEL_DEPLOYMENT_MESSAGE =
  "An agent cannot be deployed on a model deployment. Deploy it with externalModelUrl, or with an external model in the agent's modelConfig. Nothing was reserved or charged.";

// ============================================
// Helper Functions
// ============================================

async function submitAgentToNosana(
  deploymentId: string,
  agent: any,
  config: z.infer<typeof deployAgentSchema>,
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
      config.replicas,
      // Deterministic: a deployment whose create call threw can be found by it.
      { name: wheelsaiDeploymentName("agent", deploymentId) }
    );

    // Update with Nosana job IDs - only while the row is still being
    // submitted. A stop that landed during createDeployment found no id to
    // stop; writing the id onto the stopped row now would leave the deployment
    // running with nothing polling it.
    const stored = await prisma.agentDeployment.updateMany({
      where: { id: deploymentId, status: { in: ["pending", "building", "deploying"] } },
      // No endpoint is stored: the agent's endpoint is this API's
      // /v1/agents/<slug>, computed on read (services/publicEndpoints.ts).
      // The access mode in the same statement as the id it describes.
      data: {
        nosanaJobIds: [nosanaDeployment.id],
        nosanaAccessMode: nosanaDeployment.accessMode ?? null,
      },
    });
    if (stored.count === 0) {
      logger.warn(
        { deploymentId, nosanaId: nosanaDeployment.id },
        "Agent deployment was stopped during submit; stopping the Nosana deployment just created",
      );
      const settled = await nosana
        .stopDeployment(nosanaDeployment.id, nosanaDeployment.accessMode)
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
          accessMode: nosanaDeployment.accessMode,
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
        accessMode: error.accessMode,
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
