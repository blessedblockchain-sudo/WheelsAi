import { prisma } from "@wheelsai/db";
import type { AgentKind } from "@wheelsai/shared/agent-kind";
import { buildCreateAgentDeps } from "./buildCreateAgentDeps.js";
import { createAgent, type CreateAgentResult } from "./createAgent.js";

// ============================================
// Agent Templates CRUD
// ============================================

export async function getTemplates(options: {
  category?: string;
  framework?: string;
  difficulty?: string;
  /** How the agents made from the template are used: conversation, task or scheduled. */
  agentKind?: AgentKind;
  isFeatured?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const { category, framework, difficulty, agentKind, isFeatured, search, limit = 20, offset = 0 } = options;
  const where: any = { isPublished: true };
  if (category) where.category = category;
  if (framework) where.framework = framework;
  if (agentKind) where.agentKind = agentKind;
  if (difficulty) where.difficulty = difficulty;
  if (isFeatured !== undefined) where.isFeatured = isFeatured;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { title: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  const [templates, total] = await Promise.all([
    prisma.agentTemplate.findMany({
      where,
      orderBy: [{ isFeatured: "desc" }, { usageCount: "desc" }],
      take: limit,
      skip: offset,
    }),
    prisma.agentTemplate.count({ where }),
  ]);
  return { templates, total };
}

export async function getTemplate(idOrSlug: string) {
  // UUID v4 regex to distinguish ID from slug
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const template = await prisma.agentTemplate.findFirst({
    where: {
      ...(isUuid ? { id: idOrSlug } : { slug: idOrSlug }),
      isPublished: true,
    },
  });
  if (!template) throw new Error("Template not found");
  return template;
}

export async function getTemplateCategories() {
  const templates = await prisma.agentTemplate.findMany({
    where: { isPublished: true },
    select: { category: true },
    distinct: ["category"],
  });
  return templates.map((t) => t.category);
}

/**
 * An agent made from a published template. It goes through the one create
 * path (services/createAgent.ts), as POST /api/agents does: only a name is
 * needed, the slug is made unique (so one template can be used twice), the
 * agent counts toward the plan, and it carries the template's kind and a copy
 * of that kind's settings. Anything else the caller sends replaces the
 * template's value for that field.
 */
export async function useTemplate(
  templateId: string,
  orgId: string,
  input: unknown,
): Promise<CreateAgentResult> {
  return createAgent(buildCreateAgentDeps(), { orgId, body: input, templateId });
}

// ============================================
// Admin: Create/Update Templates
// ============================================

export async function createTemplate(input: {
  name: string;
  slug: string;
  title: string;
  description: string;
  longDescription?: string;
  category: string;
  difficulty?: string;
  tags?: string[];
  framework: string;
  systemPrompt?: string;
  tools?: any;
  modelConfig: Record<string, any>;
  sourceType?: string;
  sourceCode?: string;
  sourceUrl?: string;
  env?: Record<string, any>;
  graphNodes?: any;
  graphEdges?: any;
  iconUrl?: string;
  screenshots?: string[];
  readme?: string;
  authorName: string;
  authorUrl?: string;
  isPublished?: boolean;
  isFeatured?: boolean;
}) {
  return prisma.agentTemplate.create({
    data: {
      name: input.name,
      slug: input.slug,
      title: input.title,
      description: input.description,
      longDescription: input.longDescription,
      category: input.category,
      difficulty: input.difficulty || "beginner",
      tags: input.tags || [],
      framework: input.framework,
      systemPrompt: input.systemPrompt,
      tools: input.tools || [],
      modelConfig: input.modelConfig,
      sourceType: input.sourceType || "inline",
      sourceCode: input.sourceCode,
      sourceUrl: input.sourceUrl,
      env: input.env || {},
      graphNodes: input.graphNodes,
      graphEdges: input.graphEdges,
      iconUrl: input.iconUrl,
      screenshots: input.screenshots || [],
      readme: input.readme,
      authorName: input.authorName,
      authorUrl: input.authorUrl,
      isPublished: input.isPublished ?? true,
      isFeatured: input.isFeatured ?? false,
    },
  });
}

export async function updateTemplate(id: string, updates: Record<string, any>) {
  const template = await prisma.agentTemplate.findUnique({ where: { id } });
  if (!template) throw new Error("Template not found");
  return prisma.agentTemplate.update({ where: { id }, data: updates });
}

export async function deleteTemplate(id: string) {
  const template = await prisma.agentTemplate.findUnique({ where: { id } });
  if (!template) throw new Error("Template not found");
  await prisma.agentTemplate.delete({ where: { id } });
  return { success: true };
}

export async function getTemplateStats() {
  const [total, published, featured, totalUsage] = await Promise.all([
    prisma.agentTemplate.count(),
    prisma.agentTemplate.count({ where: { isPublished: true } }),
    prisma.agentTemplate.count({ where: { isFeatured: true, isPublished: true } }),
    prisma.agentTemplate.aggregate({ _sum: { usageCount: true } }),
  ]);
  return { total, published, featured, totalUsage: totalUsage._sum.usageCount || 0 };
}
