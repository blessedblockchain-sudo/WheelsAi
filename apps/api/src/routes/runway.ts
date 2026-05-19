/**
 * GET /agents/:slug/runway — runway dashboard data feed (plan A8).
 *
 * Composes the deployment + treasury + usage record snapshot into the
 * numbers the runway card renders: total cost, burn rate, runway seconds,
 * alert level, desired replicas. BigInt lamport values are serialized as
 * strings so they survive JSON; Infinity is serialized as the literal
 * string "infinity" so the UI can branch on it.
 *
 * Persistence (`loadAgentSnapshot`) and the SOL/USD oracle (`getSolPriceUsd`)
 * are dependency-injected so this route is unit-testable without Prisma or
 * a price feed.
 */

import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

import { computeDeploymentRunway, type UsageRecordInput } from "../services/runway.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("runway-route");

const DEFAULT_LOOKBACK_SECONDS = 7 * 86_400;

// ============================================
// DI surface
// ============================================

export interface AgentRunwaySnapshot {
  agent: { id: string; name: string; slug: string };
  treasuryBalanceLamports: bigint;
  treasuryAddress: string | null;
  usageRecords: UsageRecordInput[];
  currentReplicas: number;
  maxReplicas: number;
}

export interface RunwayRouteDeps {
  loadAgentSnapshot: (args: {
    slug: string;
    orgId: string;
    lookbackSeconds: number;
    now: Date;
  }) => Promise<AgentRunwaySnapshot | null>;
  getSolPriceUsd: () => Promise<number>;
}

// ============================================
// Query schema
// ============================================

const querySchema = z.object({
  lookbackSeconds: z.coerce.number().int().positive().optional(),
});

// ============================================
// Plugin
// ============================================

function serializeRunway(r: ReturnType<typeof computeDeploymentRunway>) {
  return {
    totalCostCents: r.totalCostCents,
    lookbackSeconds: r.lookbackSeconds,
    burnRateLamportsPerSecond: r.burnRateLamportsPerSecond.toString(),
    burnLamportsPerDay: r.burnLamportsPerDay.toString(),
    runwaySeconds:
      r.runwaySeconds === Number.POSITIVE_INFINITY ? "infinity" : r.runwaySeconds,
    alertLevel: r.alertLevel,
    desiredReplicas: r.desiredReplicas,
  };
}

export function createRunwayRoutes(deps: RunwayRouteDeps): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { slug: string }; Querystring: { lookbackSeconds?: string } }>(
      "/agents/:slug/runway",
      async (request, reply) => {
        if (!request.auth) {
          return reply.status(401).send({ error: "unauthenticated" });
        }
        const { orgId } = request.auth;
        const { slug } = request.params;

        const queryParsed = querySchema.safeParse(request.query);
        if (!queryParsed.success) {
          return reply.status(400).send({ error: "invalid_query" });
        }
        const lookbackSeconds =
          queryParsed.data.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS;

        const now = new Date();
        const snapshot = await deps.loadAgentSnapshot({
          slug,
          orgId,
          lookbackSeconds,
          now,
        });
        if (!snapshot) {
          return reply.status(404).send({ error: "agent_not_found" });
        }

        let solPriceUsd: number;
        try {
          solPriceUsd = await deps.getSolPriceUsd();
        } catch (err) {
          logger.error({ err }, "sol price oracle failed");
          return reply.status(502).send({ error: "sol_price_unavailable" });
        }

        const runway = computeDeploymentRunway({
          now,
          treasuryBalanceLamports: snapshot.treasuryBalanceLamports,
          usageRecords: snapshot.usageRecords,
          solPriceUsd,
          currentReplicas: snapshot.currentReplicas,
          maxReplicas: snapshot.maxReplicas,
          lookbackSeconds,
        });

        return reply.status(200).send({
          agent: snapshot.agent,
          treasuryAddress: snapshot.treasuryAddress,
          treasuryBalanceLamports: snapshot.treasuryBalanceLamports.toString(),
          solPriceUsd,
          runway: serializeRunway(runway),
        });
      },
    );
  };
}
