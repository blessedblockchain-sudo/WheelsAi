/**
 * GET /metrics — Prometheus exposition endpoint (H1).
 *
 * Mounted at the root, not under /api, because both fly tomls already point
 * their scraper at `path = "/metrics"`.
 *
 * Auth is opt-in via METRICS_TOKEN. Fly's built-in scraper reaches the app
 * over the private 6PN network and cannot attach an Authorization header, so
 * requiring a token unconditionally would break the very config this route
 * exists to satisfy. Unset => open (Fly's intended model); set => Bearer
 * required, compared in constant time.
 */

import { timingSafeEqual } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import type { Registry } from "prom-client";

export interface MetricsRouteOptions {
  registry: Registry;
  /** When set, requests must present `Authorization: Bearer <token>`. */
  token?: string;
}

/** Constant-time compare that does not leak length via early return. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so timing does not distinguish
    // "wrong length" from "right length, wrong bytes".
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function createMetricsRoutes(
  options: MetricsRouteOptions,
): FastifyPluginAsync {
  return async (app) => {
    app.get("/metrics", async (request, reply) => {
      if (options.token) {
        const header = request.headers.authorization ?? "";
        const provided = header.startsWith("Bearer ")
          ? header.slice("Bearer ".length)
          : "";

        if (!provided || !tokenMatches(provided, options.token)) {
          // 404 rather than 401: an unauthenticated prober learns nothing
          // about whether this deployment exposes metrics at all.
          return reply.status(404).send({ error: "not_found" });
        }
      }

      const body = await options.registry.metrics();
      return reply
        .header("Content-Type", options.registry.contentType)
        .header("Cache-Control", "no-store")
        .send(body);
    });
  };
}
