/**
 * The operator's money report.
 *
 *   GET /api/platform/money?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   (mounted with prefix "/api/platform")
 *
 * Gated exactly as GET /api/platform/compute is: PLATFORM_ADMIN_KEY through
 * the x-admin-key header, read at request time, compared in constant time,
 * 503 when no key is set. Nothing is read before the gate passes.
 *
 * `from` defaults to the first day of the current UTC month and `to` to now;
 * a `to` that is given covers that whole day. A date that cannot be read is
 * 400 `invalid_range`.
 *
 * READ-ONLY. The report itself is services/platformMoney.ts; production
 * wiring is in platformMoneyBindings.ts.
 */

import type { FastifyPluginAsync } from "fastify";

import {
  computePlatformMoney,
  resolveMoneyRange,
  type PlatformMoneyDeps,
} from "../services/platformMoney.js";
import { adminKeyMatches } from "./platformCompute.js";

export function createPlatformMoneyRoutes(deps: PlatformMoneyDeps): FastifyPluginAsync {
  return async (app) => {
    app.get(
      "/money",
      {
        schema: {
          tags: ["Platform"],
          description:
            "Operator money report: balances, earnings owed, income, on-chain holdings, sweeps and reconciliation (x-admin-key). Read-only.",
        },
      },
      async (request, reply) => {
        const adminKey = deps.adminKey();
        if (!adminKey) {
          return reply.status(503).send({
            error: "platform_admin_not_configured",
            message: "PLATFORM_ADMIN_KEY is not set on this deployment.",
          });
        }
        if (!adminKeyMatches(request.headers["x-admin-key"], adminKey)) {
          return reply.status(401).send({ error: "invalid_admin_key" });
        }
        reply.header("Cache-Control", "no-store");

        const query = (request.query ?? {}) as Record<string, unknown>;
        const resolved = resolveMoneyRange({ from: query.from, to: query.to }, deps.now());
        if (!resolved.ok) {
          return reply.status(400).send({
            error: "invalid_range",
            message: "from and to are dates written YYYY-MM-DD, and from is not after to.",
          });
        }
        return computePlatformMoney(deps, resolved.range);
      },
    );
  };
}
