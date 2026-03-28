import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth.js";
import {
  getTemplates,
  getTemplate,
  getTemplateCategories,
  useTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getTemplateStats,
} from "../services/templates.js";

// ============================================
// Agent Templates / Starter Kits Routes
// ============================================

export async function templateRoutes(app: FastifyInstance) {
  // Public routes (no auth required for browsing)

  // List templates
  app.get<{
    Querystring: {
      category?: string;
      framework?: string;
      difficulty?: string;
      isFeatured?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>("/", { schema: { tags: ["Templates"], description: "List agent templates" } }, async (request, reply) => {
    try {
      const { category, framework, difficulty, isFeatured, search, limit, offset } = request.query;
      const result = await getTemplates({
        category,
        framework,
        difficulty,
        isFeatured: isFeatured === "true" ? true : isFeatured === "false" ? false : undefined,
        search,
        limit: limit ? parseInt(limit) : undefined,
        offset: offset ? parseInt(offset) : undefined,
      });
      return reply.send(result);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get template categories
  app.get("/categories", async (request, reply) => {
    try {
      const categories = await getTemplateCategories();
      return reply.send({ categories });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get template stats
  app.get("/stats", async (request, reply) => {
    try {
      const stats = await getTemplateStats();
      return reply.send(stats);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Get template detail
  app.get<{ Params: { idOrSlug: string } }>("/:idOrSlug", async (request, reply) => {
    try {
      const template = await getTemplate(request.params.idOrSlug);
      return reply.send(template);
    } catch (error: any) {
      return reply.status(404).send({ error: error.message });
    }
  });

  // Authenticated routes

  // Use a template to create an agent
  app.post<{
    Params: { templateId: string };
    Body: { name: string; slug: string; description?: string };
  }>("/:templateId/use", { preHandler: requireAuth, schema: { tags: ["Templates"], description: "Create agent from template" } }, async (request, reply) => {
    try {
      const agent = await useTemplate(request.params.templateId, request.auth!.orgId, request.body);
      return reply.status(201).send(agent);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Admin: Create template
  app.post<{
    Body: {
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
      sourceCode?: string;
      authorName: string;
      authorUrl?: string;
      isPublished?: boolean;
      isFeatured?: boolean;
    };
  }>("/", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const template = await createTemplate(request.body);
      return reply.status(201).send(template);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Admin: Update template
  app.patch<{
    Params: { templateId: string };
    Body: Record<string, any>;
  }>("/:templateId", { preHandler: requireAuth }, async (request, reply) => {
    try {
      const template = await updateTemplate(request.params.templateId, request.body);
      return reply.send(template);
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });

  // Admin: Delete template
  app.delete<{ Params: { templateId: string } }>(
    "/:templateId",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        await deleteTemplate(request.params.templateId);
        return reply.status(204).send();
      } catch (error: any) {
        return reply.status(400).send({ error: error.message });
      }
    }
  );
}
