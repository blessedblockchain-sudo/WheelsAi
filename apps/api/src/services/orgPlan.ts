/**
 * Plan lookups and enforcement against the database and Redis.
 */
import { Redis } from "ioredis";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { effectivePlan, limitsFor, PlanLimitError, usageMonth, type PlanId, type PlanLimits } from "./plans.js";

const logger = createLogger("org-plan");

export async function getOrgPlan(orgId: string): Promise<{ plan: PlanId; limits: PlanLimits }> {
  const sub = await prisma.orgSubscription.findUnique({ where: { orgId } });
  const plan = effectivePlan(sub);
  return { plan, limits: limitsFor(plan) };
}

/**
 * Agents that count toward the plan: the org's own, not copies installed
 * from the marketplace.
 */
export async function countOwnAgents(orgId: string): Promise<number> {
  const installed = await prisma.agentInstall.findMany({
    where: { buyerId: orgId, status: "active" },
    select: { clonedAgentId: true },
  });
  const clonedIds = installed.map((i) => i.clonedAgentId).filter((id): id is string => !!id);
  return prisma.agent.count({
    where: { orgId, ...(clonedIds.length ? { id: { notIn: clonedIds } } : {}) },
  });
}

/** Throws PlanLimitError when creating one more agent would exceed the plan. */
export async function assertCanCreateAgent(orgId: string): Promise<void> {
  const { plan, limits } = await getOrgPlan(orgId);
  if (limits.maxAgents === null) return;
  const count = await countOwnAgents(orgId);
  if (count >= limits.maxAgents) {
    throw new PlanLimitError(
      `The ${limits.name} plan includes up to ${limits.maxAgents} agents. Upgrade to Pro for unlimited agents.`,
      plan,
      "maxAgents",
    );
  }
}

export async function assertFeature(
  orgId: string,
  feature: keyof Pick<PlanLimits, "customDomains" | "advancedAnalytics" | "sso" | "whiteLabel">,
  label: string,
): Promise<void> {
  const { plan, limits } = await getOrgPlan(orgId);
  if (!limits[feature]) {
    throw new PlanLimitError(`${label} is included in the Pro plan and above.`, plan, feature);
  }
}

// ============================================
// Monthly API-call metering
// ============================================

let redis: Redis | null = null;
function client(): Redis {
  // Give up after a few reconnect attempts instead of retrying forever
  // (which also kept test processes alive); the next call starts a fresh
  // client, so a Redis restart is picked up without an API restart.
  if (!redis || redis.status === "end") {
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (times) => (times > 3 ? null : 200 * times),
    });
    redis.on("error", () => undefined);
  }
  return redis;
}

export function disconnectPlanUsage(): void {
  redis?.disconnect();
  redis = null;
}

const key = (orgId: string, month: string) => `apicalls:${orgId}:${month}`;

export interface ApiCallCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/**
 * Count one API call against the org's monthly allowance. Throws
 * PlanLimitError when the call would exceed it. Counter errors fail open
 * (logged): a Redis blip must not take every customer's API down.
 */
export async function meterApiCall(
  orgId: string,
  opts: { counter?: ApiCallCounter; plan?: { plan: PlanId; limits: PlanLimits }; now?: Date } = {},
): Promise<{ used: number; limit: number | null }> {
  let resolved: { plan: PlanId; limits: PlanLimits };
  try {
    resolved = opts.plan ?? (await getOrgPlan(orgId));
  } catch (err) {
    logger.error({ err, orgId }, "Plan lookup failed; allowing the call");
    return { used: 0, limit: null };
  }
  const { plan, limits } = resolved;
  if (limits.monthlyApiCalls === null) return { used: 0, limit: null };
  const counter = opts.counter ?? client();
  const k = key(orgId, usageMonth(opts.now));
  let used: number;
  try {
    used = await counter.incr(k);
    if (used === 1) await counter.expire(k, 40 * 24 * 3600);
  } catch (err) {
    logger.error({ err, orgId }, "API-call counter unavailable; allowing the call");
    return { used: 0, limit: limits.monthlyApiCalls };
  }
  if (used > limits.monthlyApiCalls) {
    throw new PlanLimitError(
      `The ${limits.name} plan includes ${limits.monthlyApiCalls.toLocaleString("en-US")} API calls per month, and this month's are used up. Upgrade for more.`,
      plan,
      "monthlyApiCalls",
    );
  }
  return { used, limit: limits.monthlyApiCalls };
}

export async function getApiCallsThisMonth(
  orgId: string,
  counter: Pick<ApiCallCounter, "get"> = client(),
): Promise<number> {
  try {
    return Number((await counter.get(key(orgId, usageMonth()))) ?? 0);
  } catch {
    return 0;
  }
}
