/**
 * What the API says to the custom-domain edge proxy.
 *
 *   GET /internal/edge/ask?domain=<host>&token=<ask token>
 *     Asked by the edge before it obtains a certificate for a hostname. 200
 *     only for a verified, enabled, routed domain of an organization whose
 *     plan includes custom domains and whose target still exists, and, for a
 *     name with no observed certificate, only while the name, its organization
 *     and the platform have issuance budget left (429 otherwise). Every other
 *     status is a refusal to the edge, so every failure here refuses: an
 *     unconfigured server (501), a lookup error (503), anything thrown (503).
 *
 *   /__edge/respond
 *     Where services/customDomainRouteTable.ts sends a request on a customer
 *     hostname that is not forwarded to a canonical route: the prober's proof,
 *     the HTTPS redirect, "this domain is not active", "not found on this
 *     domain", "routing unavailable". A request that did not come through the
 *     rewrite gets a plain 404, so the path means nothing on the API's own host.
 *
 *   installCustomDomainEdgeHooks(app, ...)
 *     Root hooks for requests that came through the edge. A forwarded request
 *     is held to the organization that owns the hostname: an API key of any
 *     other organization is refused before its body is read or its call is
 *     counted. Edge responses carry an HSTS header that pins the one hostname
 *     (never its subdomains) and the response headers the owner configured.
 */

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { CustomDomainConfig } from "../config/customDomains.js";
import type { AskDomainRow } from "../services/buildCustomDomainEdgeDeps.js";
import {
  computeDomainProof,
  decideCertificateIssuance,
  EDGE_ENDPOINTS,
  needsIssuanceBudget,
  EDGE_HSTS_VALUE,
  normalizeDomainInput,
  type IssuanceBudgetDecision,
} from "../services/customDomainRules.js";
import {
  constantTimeEqual,
  EDGE_RESPOND_PATH,
  getEdgeContext,
  type DomainRequestCounter,
} from "../services/customDomainRouteTable.js";

export const EDGE_ASK_PATH = "/internal/edge/ask";

/** How long "nobody has verified this name" is remembered. */
const UNKNOWN_DOMAIN_TTL_MS = 60_000;
const UNKNOWN_DOMAIN_CACHE_SIZE = 5_000;


export interface CustomDomainEdgeRouteDeps {
  getConfig: () => Pick<CustomDomainConfig, "edge" | "unavailableReason">;
  /** The row holding the verified claim on `domain`, read from the database now. */
  findVerifiedDomain: (domain: string) => Promise<AskDomainRow | null>;
  /** Whether the organization's plan includes custom domains. Throws when unknown. */
  isEntitled: (orgId: string) => Promise<boolean>;
  targetExists: (row: AskDomainRow) => Promise<boolean>;
  /**
   * Takes one unit of the issuance budget for a name with no certificate, or
   * says whose budget is spent. Throws when it could not be counted.
   */
  grantIssuance: (input: { orgId: string; domain: string; now: Date }) => Promise<IssuanceBudgetDecision>;
  now?: () => number;
}

export function createCustomDomainEdgeRoutes(deps: CustomDomainEdgeRouteDeps): FastifyPluginAsync {
  const now = deps.now ?? Date.now;
  // Any TLS handshake with an unknown name makes the edge ask. Remembering
  // "unknown" briefly keeps a scan of random names from being one database
  // query each. Only that answer is remembered; a refusal about a known domain
  // is always read fresh, so fixing DNS or the plan takes effect at once.
  const unknown = new Map<string, number>();

  const notConfigured = (reason: string | null) => ({
    error: "custom_domains_not_configured",
    message: reason ?? "Custom domains are not configured on this server.",
  });

  return async (app) => {
    app.get(
      EDGE_ASK_PATH,
      {
        // The edge asks once per unknown name per handshake, from one address;
        // the shared per-IP limit would refuse certificates under load.
        config: { rateLimit: false },
        // The token travels in the query string. At 'warn' the request and
        // response lines, which carry the URL, are not written.
        logLevel: "warn",
        schema: { hide: true },
      },
      async (request, reply) => {
        const config = deps.getConfig();
        if (!config.edge) return reply.status(501).send(notConfigured(config.unavailableReason));

        const query = request.query as { domain?: unknown; token?: unknown };
        const token = typeof query.token === "string" ? query.token : "";
        if (!constantTimeEqual(token, config.edge.askToken)) {
          return reply.status(403).send({ error: "forbidden" });
        }

        const normalized = normalizeDomainInput(query.domain);
        if (!normalized.ok) return reply.status(400).send({ error: "invalid_domain" });
        const domain = normalized.domain;

        const at = now();
        const remembered = unknown.get(domain);
        if (remembered !== undefined && remembered > at) {
          return reply.status(404).send({ allowed: false, reason: "unknown_domain" });
        }

        try {
          const row = await deps.findVerifiedDomain(domain);
          if (!row) {
            if (unknown.size >= UNKNOWN_DOMAIN_CACHE_SIZE) unknown.clear();
            unknown.set(domain, at + UNKNOWN_DOMAIN_TTL_MS);
            return reply.status(404).send({ allowed: false, reason: "unknown_domain" });
          }
          unknown.delete(domain);

          const [entitled, targetExists] = await Promise.all([
            deps.isEntitled(row.orgId),
            deps.targetExists(row),
          ]);
          const decision = decideCertificateIssuance({
            verificationStatus: row.verificationStatus,
            enabled: row.enabled,
            routingStatus: row.routingStatus,
            entitled,
            targetExists,
          });
          if (!decision.allowed) {
            return reply.status(403).send({ allowed: false, reason: decision.reason });
          }

          // A "yes" for a name without a certificate is an order on the one
          // account every organization shares with the certificate authority.
          if (needsIssuanceBudget(row)) {
            const budget = await deps.grantIssuance({ orgId: row.orgId, domain, now: new Date(at) });
            if (!budget.granted) {
              // The platform's budget running out stops every new certificate.
              const level = budget.reason === "issuance_budget_platform" ? "error" : "warn";
              request.log[level](
                { domain, orgId: row.orgId, reason: budget.reason },
                "Certificate refused: issuance budget spent",
              );
              return reply.status(429).send({ allowed: false, reason: budget.reason });
            }
          }
          return reply.status(200).send({ allowed: true });
        } catch (error) {
          // Not knowing is a refusal. Only the error is logged: the request
          // line would carry the token.
          request.log.error({ err: error, domain }, "Certificate question failed");
          return reply.status(503).send({ allowed: false, reason: "lookup_failed" });
        }
      },
    );

    app.all(
      EDGE_RESPOND_PATH,
      {
        // These answers cost a map lookup. The prober's proof must not be
        // refused because a customer's traffic used up a shared budget.
        config: { rateLimit: false },
        schema: { hide: true },
      },
      async (request, reply) => {
        const context = getEdgeContext(request.raw);
        if (!context) return reply.status(404).send({ error: "not_found", message: "Not found" });

        const { action, route } = context;
        switch (action.kind) {
          case "proof": {
            const config = deps.getConfig();
            if (!config.edge || !route) {
              return reply.status(503).send({ error: "custom_domain_unavailable" });
            }
            return reply
              .header("cache-control", "no-store")
              .send({ domain: route.domain, proof: computeDomainProof(config.edge.edgeSecret, route.domainId) });
          }
          case "redirect":
            return reply.status(308).header("location", action.location).send();
          case "not_found":
            return reply.status(404).send({
              error: "not_found",
              message: `This domain serves ${EDGE_ENDPOINTS.join(" and ")}.`,
            });
          case "unavailable":
            return reply.status(503).header("retry-after", "5").send({
              error: "custom_domain_unavailable",
              message: "Requests for this domain cannot be routed right now. Try again shortly.",
            });
          default:
            // "unrouted", and "forward" which never reaches this path.
            return reply.status(404).send({
              error: "custom_domain_not_active",
              message: "This domain is not serving requests.",
            });
        }
      },
    );
  };
}

export interface CustomDomainEdgeHookDeps {
  counter?: Pick<DomainRequestCounter, "record">;
  now?: () => Date;
}

/**
 * Installs the root hooks for requests that came through the edge. Call it on
 * the ROOT instance, after the authentication plugin (the guard reads
 * request.auth) and before any route plugin is registered (a plugin only
 * inherits the hooks that exist when it is registered).
 */
export function installCustomDomainEdgeHooks(app: FastifyInstance, deps: CustomDomainEdgeHookDeps = {}): void {
  const now = deps.now ?? (() => new Date());

  app.addHook("onRequest", async (request, reply) => {
    const context = getEdgeContext(request.raw);
    if (!context) return;

    // Replaces the platform default (which includes subdomains). Set here,
    // not in onSend, because streamed answers copy the headers present when
    // the stream starts and never pass through onSend.
    reply.raw.removeHeader("strict-transport-security");
    reply.header("strict-transport-security", EDGE_HSTS_VALUE);
    if (context.route && context.action.kind !== "proof" && context.action.kind !== "redirect") {
      for (const [name, value] of Object.entries(context.route.headers)) reply.header(name, value);
    }

    if (context.action.kind !== "forward" || !context.route) return;

    // A custom domain serves its owner's agent or deployment and nothing
    // else. Slugs are unique per organization only, so without this a key of
    // another organization would reach THAT organization's resource of the
    // same slug through this hostname. No credentials at all is the canonical
    // route's own 401.
    const auth = request.auth;
    if (auth && auth.orgId !== context.route.orgId) {
      return reply.status(403).send({
        error: {
          message: "This API key does not belong to the organization that owns this domain.",
          type: "invalid_request_error",
          param: null,
          code: "wrong_organization",
        },
      });
    }
  });

  app.addHook("onResponse", async (request) => {
    const context = getEdgeContext(request.raw);
    // Counted: requests the owner's credentials made through the hostname.
    // A refused key or a missing one never reached the target.
    if (
      context?.action.kind === "forward" &&
      context.route &&
      request.auth?.orgId === context.route.orgId
    ) {
      deps.counter?.record(context.route.domainId, now());
    }
  });
}
