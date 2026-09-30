import { prisma } from "@wheelsai/db";
import { openAgentEnv, sealAgentEnv } from "./agentSecrets.js";
import { assertCanCreateAgent } from "./orgPlan.js";

// ============================================
// Agent Templates CRUD
// ============================================

export async function getTemplates(options: {
  category?: string;
  framework?: string;
  difficulty?: string;
  isFeatured?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const { category, framework, difficulty, isFeatured, search, limit = 20, offset = 0 } = options;
  const where: any = { isPublished: true };
  if (category) where.category = category;
  if (framework) where.framework = framework;
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

export async function useTemplate(templateId: string, orgId: string, input: {
  name: string;
  slug: string;
  description?: string;
}) {
  const template = await prisma.agentTemplate.findFirst({ where: { id: templateId, isPublished: true } });
  if (!template) throw new Error("Template not found");

  // Templates create agents too, so they count toward the plan.
  await assertCanCreateAgent(orgId);

  // Create agent from template
  const agent = await prisma.agent.create({
    data: {
      orgId,
      name: input.name,
      slug: input.slug,
      description: input.description || template.description,
      framework: template.framework,
      systemPrompt: template.systemPrompt,
      tools: template.tools as any,
      modelConfig: template.modelConfig as any,
      sourceType: template.sourceType,
      sourceCode: template.sourceCode,
      sourceUrl: template.sourceUrl,
      env: sealAgentEnv(openAgentEnv(template.env)),
      tags: template.tags,
    },
  });

  // Create visual graph if template has one
  if (template.graphNodes && template.graphEdges) {
    await prisma.agentGraph.create({
      data: {
        agentId: agent.id,
        nodes: template.graphNodes,
        edges: template.graphEdges,
        isValid: true,
      },
    });
  }

  // Increment usage count
  await prisma.agentTemplate.update({
    where: { id: templateId },
    data: { usageCount: { increment: 1 } },
  });

  return agent;
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
