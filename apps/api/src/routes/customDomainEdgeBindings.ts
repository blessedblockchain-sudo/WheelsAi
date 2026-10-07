/**
 * Production wiring for custom-domain host routing and the edge's routes.
 *
 * Always present, like the Slack and wallet-topup bindings: with no edge
 * configured the certificate question answers 501 with the reason, no table is
 * loaded, no timer runs, and a request that claims to come from an edge routes
 * nowhere. A request without the edge's header is never touched.
 *
 * index.ts uses the one object this returns:
 *
 *   rewriteUrl   passed to Fastify({ rewriteUrl })
 *   install(app) root hooks; after the auth plugin, before the route plugins
 *   routes       the certificate question and the /__edge answers
 *   start()      first table load and the refresh / counter timers
 *
 * Nothing is forwarded to a canonical route until install() has run: the hook
 * it adds is what holds a forwarded request to the domain's own organization.
 */

import type { IncomingMessage } from "node:http";

import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import { getCustomDomainConfig, type CustomDomainConfig } from "../config/customDomains.js";
import { prisma } from "../lib/prisma.js";
import {
  buildCustomDomainEdgeDeps,
  type CustomDomainEdgeDeps,
  type CustomDomainEdgePrisma,
} from "../services/buildCustomDomainEdgeDeps.js";
import {
  createCustomDomainRouteTable,
  createDomainRequestCounter,
  createEdgeRewriteUrl,
} from "../services/customDomainRouteTable.js";
import { connectDomainRoutes } from "../services/domains.js";
import { createLogger } from "../utils/logger.js";
import { createCustomDomainEdgeRoutes, installCustomDomainEdgeHooks } from "./customDomainEdge.js";

/** How often buffered request counts are written. */
const COUNTER_FLUSH_MS = 10_000;

export interface CustomDomainEdgeRuntime {
  rewriteUrl: (req: IncomingMessage) => string;
  install: (app: FastifyInstance) => void;
  routes: FastifyPluginAsync;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createCustomDomainEdgeRuntime(input: {
  config: CustomDomainConfig;
  /** Built on first use, so creating the runtime opens no database connection. */
  deps: () => CustomDomainEdgeDeps;
  log?: Pick<ReturnType<typeof createLogger>, "info" | "warn" | "error">;
}): CustomDomainEdgeRuntime {
  const { config } = input;
  const log = input.log ?? createLogger("custom-domain-edge");

  let resolved: CustomDomainEdgeDeps | null = null;
  const deps = () => (resolved ??= input.deps());

  const table = createCustomDomainRouteTable({
    load: () => deps().loadRoutes(),
    onRefreshError: (error) => log.warn({ err: error }, "Custom domain route table refresh failed"),
  });
  const counter = createDomainRequestCounter({
    increment: (entry) => deps().increment(entry),
    onError: (error) => log.warn({ err: error }, "Custom domain request counts were not written; kept for the next flush"),
  });

  let installed = false;
  let timers: NodeJS.Timeout[] = [];

  async function stop() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
    await counter.flush();
  }

  return {
    rewriteUrl: createEdgeRewriteUrl({
      table,
      edgeSecret: config.edge?.edgeSecret ?? null,
      guardInstalled: () => installed,
    }),

    install(app) {
      installCustomDomainEdgeHooks(app, { counter });
      installed = true;
      app.addHook("onClose", stop);
    },

    routes: createCustomDomainEdgeRoutes({
      getConfig: () => config,
      findVerifiedDomain: (domain) => deps().findVerifiedDomain(domain),
      isEntitled: (orgId) => deps().isEntitled(orgId),
      targetExists: (row) => deps().targetExists(row),
      grantIssuance: (grant) => deps().grantIssuance(grant),
    }),

    async start() {
      if (!config.edge) {
        log.info({ reason: config.unavailableReason }, "Custom domain routing disabled (custom domains are not configured)");
        return;
      }
      if (timers.length > 0) return;
      // Owner actions (disable, new token, delete) stop routing here at once.
      connectDomainRoutes({ drop: (domain) => table.drop(domain), refresh: () => void table.refresh() });
      const loaded = await table.refresh();
      // Not loaded is not fatal: custom hostnames answer 503 until a refresh succeeds.
      log[loaded ? "info" : "warn"]({ domains: table.size(), edge: config.edge.hostname }, "Custom domain route table loaded");
      const refresher = setInterval(() => void table.refresh(), config.routeRefreshMs);
      const flusher = setInterval(() => void counter.flush(), COUNTER_FLUSH_MS);
      refresher.unref();
      flusher.unref();
      timers = [refresher, flusher];
    },

    stop,
  };
}

/** The runtime over the real database and this process's configuration. */
export function createCustomDomainEdgeProduction(): CustomDomainEdgeRuntime {
  const config = getCustomDomainConfig();
  return createCustomDomainEdgeRuntime({
    config,
    deps: () =>
      buildCustomDomainEdgeDeps({ prisma: prisma as unknown as CustomDomainEdgePrisma, limits: config.limits }),
  });
}

/** The edge's own routes for the production runtime (always mounted). */
export function createCustomDomainEdgeRoutesProduction(runtime: CustomDomainEdgeRuntime): FastifyPluginAsync {
  return runtime.routes;
}
