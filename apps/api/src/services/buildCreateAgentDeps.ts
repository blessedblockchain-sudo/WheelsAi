/**
 * Composition root for the create path (services/createAgent.ts): binds it
 * to Prisma, the plan limit, the secrets key, the free-model catalog and the
 * `agent.created` webhook.
 *
 * Delegates are read from the client per call, not captured at build time.
 */

import { Prisma, prisma as defaultPrisma, type PrismaClient } from "@wheelsai/db";

import { getAvailableFreeModels } from "../config/free-models.js";
import { createLogger } from "../utils/logger.js";
import { openAgentEnv, sealAgentEnv } from "./agentSecrets.js";
import type { AgentTemplateSource, CreateAgentDeps } from "./createAgent.js";
import { assertCanCreateAgent } from "./orgPlan.js";
import { triggerWebhook } from "./webhooks.js";

const logger = createLogger("create-agent");

type CreateAgentPrisma = Pick<PrismaClient, "agent" | "agentTemplate" | "knowledgeBase" | "$transaction">;

/** What the agent's transaction can reach. A later batch writes a schedule through it. */
export type CreateAgentTx = Prisma.TransactionClient;

/** P2002 on the (org, slug) pair: another create took the slug first. */
export function isAgentSlugConflict(err: unknown): boolean {
  const known = err as { code?: unknown; meta?: { target?: unknown } } | null;
  if (known?.code !== "P2002") return false;
  const target = known.meta?.target;
  if (target === undefined || target === null) return true;
  return (Array.isArray(target) ? target.join(",") : String(target)).includes("slug");
}

export function buildCreateAgentDeps(
  prisma: CreateAgentPrisma = defaultPrisma,
): CreateAgentDeps<CreateAgentTx> {
  return {
    findTemplate: (templateId) =>
      prisma.agentTemplate.findFirst({
        where: { id: templateId, isPublished: true },
      }) as Promise<AgentTemplateSource | null>,

    availableFreeModelIds: () => getAvailableFreeModels().map((model) => model.id),

    openEnv: (stored) => openAgentEnv(stored),
    sealEnv: (env) => sealAgentEnv(env),

    // A knowledge base may only be bound by the org that owns it. Without
    // this check any authenticated user could point their agent at another
    // tenant's knowledge base and read its documents back out through chat
    // grounding - the retrieval path trusts the binding.
    knowledgeBaseOwned: async (knowledgeBaseId, orgId) =>
      (await prisma.knowledgeBase.findFirst({
        where: { id: knowledgeBaseId, orgId },
        select: { id: true },
      })) !== null,

    assertCanCreateAgent: (orgId) => assertCanCreateAgent(orgId),

    slugTaken: async (orgId, slug) =>
      (await prisma.agent.findUnique({ where: { orgId_slug: { orgId, slug } } })) !== null,

    transaction: (fn) => prisma.$transaction((tx) => fn(tx)),

    insertAgent: (tx, row) =>
      tx.agent.create({
        data: {
          orgId: row.orgId,
          name: row.name,
          slug: row.slug,
          description: row.description,
          framework: row.framework,
          systemPrompt: row.systemPrompt,
          tools: row.tools as Prisma.InputJsonValue,
          modelConfig: row.modelConfig as Prisma.InputJsonValue,
          sourceType: row.sourceType,
          sourceUrl: row.sourceUrl,
          sourceCode: row.sourceCode,
          env: row.env as Prisma.InputJsonValue,
          tags: row.tags,
          isPublic: row.isPublic,
          knowledgeBaseId: row.knowledgeBaseId,
          agentKind: row.agentKind,
          kindConfig: row.kindConfig ?? Prisma.DbNull,
        },
      }),

    insertGraph: async (tx, agentId, nodes, edges) => {
      await tx.agentGraph.create({
        data: {
          agentId,
          nodes: nodes as Prisma.InputJsonValue,
          edges: edges as Prisma.InputJsonValue,
          isValid: true,
        },
      });
    },

    countTemplateUse: async (tx, templateId) => {
      await tx.agentTemplate.update({
        where: { id: templateId },
        data: { usageCount: { increment: 1 } },
      });
    },

    isSlugConflict: isAgentSlugConflict,

    announce: (orgId, agent) => {
      logger.info({ agentId: agent.id, orgId }, "Agent created");
      // Webhook emission (Wave 1): fire-and-forget, house pattern.
      triggerWebhook(
        orgId,
        "agent.created",
        { agentId: agent.id, name: agent.name, slug: agent.slug },
        "agent",
        agent.id,
      ).catch((err) => logger.error({ err }, "webhook agent.created failed"));
    },
  };
}
