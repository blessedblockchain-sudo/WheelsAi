import crypto from "node:crypto";
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

/**
 * Platform-admin gate for the GLOBAL template catalog (W2 security sweep).
 *
 * AgentTemplate rows are platform-wide, and `/:templateId/use` clones a
 * template's sourceCode into the calling org's agent. So write access to
 * this catalog is write access to code other organizations will run —
 * `requireAuth` (any signed-in user) was the wrong bar entirely, despite
 * the "Admin:" comments on these routes.
 *
 * Mirrors the marketplace curation gate: PLATFORM_ADMIN_KEY via
 * x-admin-key, read at request time so rotation needs no reboot,
 * constant-time compared, honest 503 when unset.
 */
function requirePlatformAdmin(
  request: { headers: Record<string, unknown> },
  reply: {
    status: (code: number) => { send: (body: unknown) => unknown };
  },
): boolean {
  const adminKey = process.env.PLATFORM_ADMIN_KEY;
  if (!adminKey) {
    reply.status(503).send({
      error: "template_admin_not_configured",
      message: "PLATFORM_ADMIN_KEY is not set on this deployment.",
    });
    return false;
  }
  const presented = request.headers["x-admin-key"];
  const presentedHash = crypto
    .createHash("sha256")
    .update(typeof presented === "string" ? presented : "")
    .digest();
  const expectedHash = crypto.createHash("sha256").update(adminKey).digest();
  if (!crypto.timingSafeEqual(presentedHash, expectedHash)) {
    reply.status(401).send({ error: "invalid_admin_key" });
    return false;
  }
  return true;
}


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
      if (!requirePlatformAdmin(request as never, reply as never)) return;
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
      if (!requirePlatformAdmin(request as never, reply as never)) return;
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
        if (!requirePlatformAdmin(request as never, reply as never)) return;
        await deleteTemplate(request.params.templateId);
        return reply.status(204).send();
      } catch (error: any) {
        return reply.status(400).send({ error: error.message });
      }
    }
  );
}
