/**
 * /api/domains - an organization's custom domains.
 *
 * Bodies, queries and ids are parsed by strict zod schemas (400
 * validation_failed through the global handler), so an unknown key or a
 * malformed id never reaches the service. What the service refuses comes back
 * with its own status and code:
 *
 *   501 custom_domains_not_configured   the edge proxy is not set up on this
 *                                       server (the message says what is missing)
 *   403 plan_limit_reached              the plan does not include custom
 *                                       domains (create, check, enable, re-check)
 *   403 domain_limit_reached            the organization already has as many
 *                                       domains as this server allows one
 *                                       organization (GET /config states it)
 *   400 invalid_domain | reserved_domain | invalid_headers | target_not_found
 *       | https_required | not_verified | dns_not_routed
 *   409 domain_exists | domain_claimed | domain_changed
 *   429 checked_recently | reverified_recently
 *   503 dns_unavailable | plan_unavailable
 *
 * Reads and switching a domain OFF work whatever the configuration or the
 * plan: an organization can always see and stop what it has.
 */

import type { FastifyPluginAsync, FastifyReply, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import {
  CUSTOM_DOMAINS_UNAVAILABLE_MESSAGE,
  getCustomDomainConfig,
  type CustomDomainConfig,
} from "../config/customDomains.js";
import { requireAuth, requireRole as requireRoleFromDb } from "../middleware/auth.js";
import {
  PENDING_EXPIRY_MS,
  VERIFICATION_GRACE_MS,
  VERIFICATION_RECORD_PREFIX,
} from "../services/customDomainRules.js";
import { DomainError, domainsService, type DomainsService } from "../services/domains.js";
import { limitsFor, PlanLimitError, PLANS, type PlanId, type PlanLimits } from "../services/plans.js";

const UPGRADE_URL = "/dashboard/billing?upgrade=pro";

export interface DomainsRouteDeps {
  /** Defaults to the service over the real database (built on first use). */
  service?: DomainsService;
  getConfig?: () => CustomDomainConfig;
  /** The organization's effective plan. Defaults to services/orgPlan.ts. */
  getPlan?: (orgId: string) => Promise<{ plan: PlanId; limits: PlanLimits }>;
  /** Defaults to the database-backed role guard. */
  requireRole?: (...roles: string[]) => preHandlerHookHandler;
}

const idParams = z.object({ id: z.string().uuid() }).strict();

const headersField = z.record(z.string());

const createBody = z
  .object({
    domain: z.string().min(1).max(260),
    targetType: z.enum(["agent", "deployment"]),
    targetId: z.string().uuid(),
    forceHttps: z.boolean().optional(),
    headers: headersField.optional(),
  })
  .strict();

const updateBody = z
  .object({
    forceHttps: z.boolean().optional(),
    headers: headersField.optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

const toggleBody = z.object({ isActive: z.boolean() }).strict();

const page = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
};

const listQuery = z
  .object({
    targetType: z.enum(["agent", "deployment"]).optional(),
    targetId: z.string().uuid().optional(),
    isActive: z.enum(["true", "false"]).optional(),
    ...page,
  })
  .strict();

const eventsQuery = z.object(page).strict();

function sendDomainError(reply: FastifyReply, error: DomainError): FastifyReply {
  if (typeof error.extra.retryAfterSeconds === "number") {
    reply.header("retry-after", String(error.extra.retryAfterSeconds));
  }
  return reply.status(error.status).send({ error: error.code, message: error.message, ...error.extra });
}

/** HTTPS is always enforced; a request to turn that off is refused, not ignored. */
function refusePlainHttp(reply: FastifyReply, forceHttps: boolean | undefined): FastifyReply | null {
  if (forceHttps !== false) return null;
  return reply.status(400).send({
    error: "https_required",
    message: "HTTPS is always enforced on a custom domain; it cannot be switched off.",
  });
}

export function createDomainsRoutes(deps: DomainsRouteDeps = {}): FastifyPluginAsync {
  const getConfig = deps.getConfig ?? getCustomDomainConfig;
  const requireRole = deps.requireRole ?? requireRoleFromDb;
  const service = async () => deps.service ?? (await domainsService());
  const getPlan =
    deps.getPlan ??
    (async (orgId: string) => (await import("../services/orgPlan.js")).getOrgPlan(orgId));

  const canWrite = [requireAuth, requireRole("owner", "admin")];

  /** Custom domains are a Pro feature (PlanLimitError -> 403 by the global handler). */
  async function assertEntitled(orgId: string): Promise<void> {
    const { plan, limits } = await getPlan(orgId);
    if (!limits.customDomains) {
      throw new PlanLimitError("Custom domains are included in the Pro plan and above.", plan, "customDomains");
    }
  }

  /** The house 501: named, and before anything else is looked at. */
  function refuseUnconfigured(reply: FastifyReply): FastifyReply | null {
    const config = getConfig();
    if (config.edge) return null;
    return reply.status(501).send({
      error: "custom_domains_not_configured",
      message: CUSTOM_DOMAINS_UNAVAILABLE_MESSAGE,
    });
  }

  return async (app) => {
    // A refusal by the service is an answer, not a failure; everything else
    // goes to the global handler this plugin inherited.
    const inherited = app.errorHandler;
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DomainError) return sendDomainError(reply, error);
      return inherited(error, request, reply);
    });

    // Whether custom domains work on this server and on this plan.
    app.get("/config", { preHandler: [requireAuth] }, async (request) => {
      const config = getConfig();
      const { plan, limits } = await getPlan(request.auth!.orgId);
      return {
        success: true,
        data: {
          configured: config.edge !== null,
          unavailableReason: config.edge ? null : CUSTOM_DOMAINS_UNAVAILABLE_MESSAGE,
          edge: config.edge
            ? { hostname: config.edge.hostname, ipv4: config.edge.ipv4, ipv6: config.edge.ipv6 }
            : null,
          verification: { recordPrefix: VERIFICATION_RECORD_PREFIX, type: "TXT" },
          plan: {
            plan,
            entitled: limits.customDomains,
            upgradeUrl: UPGRADE_URL,
            // What the plan table states: included or not, with no count.
            includedIn: (Object.keys(PLANS) as PlanId[]).filter((id) => limitsFor(id).customDomains),
          },
          // A platform safety limit, the same for every plan that includes
          // custom domains; every domain counts, whatever its state.
          limits: { maxDomainsPerOrganization: config.limits.maxDomainsPerOrg },
          policy: {
            httpsEnforced: true,
            verificationGraceHours: VERIFICATION_GRACE_MS / 3_600_000,
            pendingExpiryDays: PENDING_EXPIRY_MS / 86_400_000,
          },
        },
      };
    });

    app.get("/stats", { preHandler: [requireAuth] }, async (request) => {
      const stats = await (await service()).getDomainStats(request.auth!.orgId);
      return { success: true, data: stats };
    });

    app.get("/", { preHandler: [requireAuth] }, async (request) => {
      const query = listQuery.parse(request.query);
      const result = await (await service()).getCustomDomains(request.auth!.orgId, {
        targetType: query.targetType,
        targetId: query.targetId,
        isActive: query.isActive === undefined ? undefined : query.isActive === "true",
        limit: query.limit,
        offset: query.offset,
      });
      return { success: true, data: result };
    });

    app.post("/", { preHandler: canWrite }, async (request, reply) => {
      const unconfigured = refuseUnconfigured(reply);
      if (unconfigured) return unconfigured;
      await assertEntitled(request.auth!.orgId);

      const body = createBody.parse(request.body);
      const plainHttp = refusePlainHttp(reply, body.forceHttps);
      if (plainHttp) return plainHttp;

      const domain = await (await service()).createCustomDomain(request.auth!.orgId, {
        domain: body.domain,
        targetType: body.targetType,
        targetId: body.targetId,
        headers: body.headers,
      });
      return { success: true, data: domain, message: "Domain added. Publish the DNS records to verify it." };
    });

    app.get("/:id", { preHandler: [requireAuth] }, async (request) => {
      const { id } = idParams.parse(request.params);
      const domain = await (await service()).getCustomDomain(id, request.auth!.orgId);
      return { success: true, data: domain };
    });

    app.patch("/:id", { preHandler: canWrite }, async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = updateBody.parse(request.body);
      const plainHttp = refusePlainHttp(reply, body.forceHttps);
      if (plainHttp) return plainHttp;

      const domain = await (await service()).updateCustomDomain(id, request.auth!.orgId, {
        headers: body.headers,
        isPrimary: body.isPrimary,
      });
      return { success: true, data: domain, message: "Domain updated" };
    });

    app.delete("/:id", { preHandler: canWrite }, async (request) => {
      const { id } = idParams.parse(request.params);
      await (await service()).deleteCustomDomain(id, request.auth!.orgId);
      return { success: true, message: "Domain deleted" };
    });

    // "Check now": ownership record and addresses, as DNS answers right now.
    app.post("/:id/verify", { preHandler: canWrite }, async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const unconfigured = refuseUnconfigured(reply);
      if (unconfigured) return unconfigured;
      await assertEntitled(request.auth!.orgId);

      const result = await (await service()).verifyDomain(id, request.auth!.orgId);
      return { success: true, data: result };
    });

    // A new verification token; the previous proof stops counting.
    app.post("/:id/reverify", { preHandler: canWrite }, async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const unconfigured = refuseUnconfigured(reply);
      if (unconfigured) return unconfigured;

      const result = await (await service()).reverifyDomain(id, request.auth!.orgId);
      return {
        success: true,
        data: result,
        message: "New verification token generated. Publish the new TXT record and check the domain.",
      };
    });

    // The body keeps its historical name; it sets the owner's switch.
    app.post("/:id/toggle", { preHandler: canWrite }, async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { isActive: enable } = toggleBody.parse(request.body);
      if (enable) {
        const unconfigured = refuseUnconfigured(reply);
        if (unconfigured) return unconfigured;
        await assertEntitled(request.auth!.orgId);
      }

      const domain = await (await service()).toggleDomain(id, request.auth!.orgId, enable);
      let message = "Domain switched off; it stopped serving.";
      if (enable) {
        message = domain.isActive
          ? "Domain switched on; it is serving."
          : "Domain switched on. It serves as soon as ownership, DNS and the certificate are all observed.";
      }
      return { success: true, data: domain, message };
    });

    app.get("/:id/ssl", { preHandler: [requireAuth] }, async (request) => {
      const { id } = idParams.parse(request.params);
      const status = await (await service()).checkSslStatus(id, request.auth!.orgId);
      return { success: true, data: status };
    });

    // "Re-check the certificate now": one handshake with the edge.
    app.post("/:id/ssl/renew", { preHandler: canWrite }, async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const unconfigured = refuseUnconfigured(reply);
      if (unconfigured) return unconfigured;
      await assertEntitled(request.auth!.orgId);

      const result = await (await service()).renewSsl(id, request.auth!.orgId);
      return { success: true, data: result };
    });

    app.get("/:id/events", { preHandler: [requireAuth] }, async (request) => {
      const { id } = idParams.parse(request.params);
      const query = eventsQuery.parse(request.query);
      const result = await (await service()).getDomainEvents(id, request.auth!.orgId, query);
      return { success: true, data: result };
    });
  };
}

export const domainsRoutes: FastifyPluginAsync = createDomainsRoutes();
