import type { FastifyPluginAsync } from "fastify";
import { assertFeature } from "../services/orgPlan.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createCustomDomain,
  getCustomDomains,
  getCustomDomain,
  updateCustomDomain,
  deleteCustomDomain,
  verifyDomain,
  toggleDomain,
  getDomainEvents,
  getDomainStats,
  reverifyDomain,
  checkSslStatus,
  renewSsl,
} from "../services/domains.js";

export const domainsRoutes: FastifyPluginAsync = async (app) => {
  // Get domain statistics
  app.get("/stats", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const stats = await getDomainStats(request.auth!.orgId);
      return { success: true, data: stats };
    },
  });

  // List custom domains
  app.get("/", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const query = request.query as {
        targetType?: string;
        targetId?: string;
        isActive?: string;
        limit?: string;
        offset?: string;
      };

      const result = await getCustomDomains(request.auth!.orgId, {
        targetType: query.targetType,
        targetId: query.targetId,
        isActive:
          query.isActive === "true" ? true : query.isActive === "false" ? false : undefined,
        limit: query.limit ? parseInt(query.limit) : undefined,
        offset: query.offset ? parseInt(query.offset) : undefined,
      });

      return { success: true, data: result };
    },
  });

  // Create custom domain
  app.post("/", {
    preHandler: [requireAuth, requireRole("owner", "admin")],
    handler: async (request) => {
      const body = request.body as {
        domain: string;
        targetType: "agent" | "deployment";
        targetId: string;
        forceHttps?: boolean;
        headers?: Record<string, string>;
      };

      // Custom domains are a Pro feature (throws PlanLimitError -> 403).
      await assertFeature(request.auth!.orgId, "customDomains", "Custom domains");

      try {
        const domain = await createCustomDomain(request.auth!.orgId, body);
        return { success: true, data: domain, message: "Domain created successfully" };
      } catch (error) {
        const msg = (error as Error).message;
        if (
          msg === "Invalid domain format" ||
          msg === "Domain already registered" ||
          msg === "Agent not found" ||
          msg === "Deployment not found"
        ) {
          return app.httpErrors.badRequest(msg);
        }
        throw error;
      }
    },
  });

  // Get single domain
  app.get("/:id", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };

      try {
        const domain = await getCustomDomain(id, request.auth!.orgId);
        return { success: true, data: domain };
      } catch (error) {
        if ((error as Error).message === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        throw error;
      }
    },
  });

  // Update domain
  app.patch("/:id", {
    preHandler: [requireAuth, requireRole("owner", "admin")],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as {
        forceHttps?: boolean;
        headers?: Record<string, string>;
        isPrimary?: boolean;
      };

      try {
        const domain = await updateCustomDomain(id, request.auth!.orgId, body);
        return { success: true, data: domain, message: "Domain updated successfully" };
      } catch (error) {
        if ((error as Error).message === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        throw error;
      }
    },
  });

  // Delete domain
  app.delete("/:id", {
    preHandler: [requireAuth, requireRole("owner", "admin")],
    handler: async (request) => {
      const { id } = request.params as { id: string };

      try {
        await deleteCustomDomain(id, request.auth!.orgId);
        return { success: true, message: "Domain deleted successfully" };
      } catch (error) {
        if ((error as Error).message === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        throw error;
      }
    },
  });

  // Verify domain ownership
  app.post("/:id/verify", {
    preHandler: [requireAuth, requireRole("owner", "admin")],
    handler: async (request) => {
      const { id } = request.params as { id: string };

      try {
        const result = await verifyDomain(id, request.auth!.orgId);
        return { success: true, data: result };
      } catch (error) {
        if ((error as Error).message === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        throw error;
      }
    },
  });

  // Re-verify domain (get new token)
  app.post("/:id/reverify", {
    preHandler: [requireAuth, requireRole("owner", "admin")],
    handler: async (request) => {
      const { id } = request.params as { id: string };

      try {
        const result = await reverifyDomain(id, request.auth!.orgId);
        return {
          success: true,
          data: result,
          message: "New verification token generated",
        };
      } catch (error) {
        if ((error as Error).message === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        throw error;
      }
    },
  });

  // Toggle domain active status
  app.post("/:id/toggle", {
    preHandler: [requireAuth, requireRole("owner", "admin")],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { isActive: boolean };

      try {
        const domain = await toggleDomain(id, request.auth!.orgId, body.isActive);
        return {
          success: true,
          data: domain,
          message: body.isActive ? "Domain activated" : "Domain deactivated",
        };
      } catch (error) {
        const msg = (error as Error).message;
        if (msg === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        if (
          msg === "Domain must be verified before activation" ||
          msg === "SSL certificate must be active before activation"
        ) {
          return app.httpErrors.badRequest(msg);
        }
        throw error;
      }
    },
  });

  // Get SSL status
  app.get("/:id/ssl", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };

      try {
        const status = await checkSslStatus(id, request.auth!.orgId);
        return { success: true, data: status };
      } catch (error) {
        if ((error as Error).message === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        throw error;
      }
    },
  });

  // Renew SSL certificate
  app.post("/:id/ssl/renew", {
    preHandler: [requireAuth, requireRole("owner", "admin")],
    handler: async (request) => {
      const { id } = request.params as { id: string };

      try {
        const result = await renewSsl(id, request.auth!.orgId);
        return { success: true, data: result };
      } catch (error) {
        const msg = (error as Error).message;
        if (msg === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        if (msg === "Domain must be verified before SSL renewal") {
          return app.httpErrors.badRequest(msg);
        }
        throw error;
      }
    },
  });

  // Get domain events
  app.get("/:id/events", {
    preHandler: [requireAuth],
    handler: async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as {
        limit?: string;
        offset?: string;
      };

      try {
        const result = await getDomainEvents(id, request.auth!.orgId, {
          limit: query.limit ? parseInt(query.limit) : undefined,
          offset: query.offset ? parseInt(query.offset) : undefined,
        });
        return { success: true, data: result };
      } catch (error) {
        if ((error as Error).message === "Domain not found") {
          return app.httpErrors.notFound("Domain not found");
        }
        throw error;
      }
    },
  });
};
