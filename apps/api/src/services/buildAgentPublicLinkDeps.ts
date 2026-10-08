/**
 * Composition root for an agent's public link (services/agentPublicLink.ts):
 * binds it to Prisma, the public chat's counters, this server's web address
 * and the skills registry.
 *
 *   usedToday            read from the limiter the public chat and run count
 *                        on (services/buildPublicChatDeps.ts), never written
 *   url                  PUBLIC_WEB_URL, else CORS_ORIGIN, plus /a/<handle>
 *   toolsOffForVisitors  the registry's own rule for the `public` tool mode
 *                        (SkillRegistry.modeBlock): the one the chat runtime
 *                        applies when it builds a visitor's tool list, so
 *                        there is no second list of tools to keep in step
 *
 * Delegates are read from the client per call, not captured at build time.
 */

import { prisma as defaultPrisma, type PrismaClient } from "@wheelsai/db";

import { env } from "../config/env.js";
import type { AgentPublicLinkDeps, PublicLinkTx } from "./agentPublicLink.js";
import { publicChatLimiter } from "./buildPublicChatDeps.js";
import { agentPageUrl } from "./publicEndpoints.js";
import { getDefaultRegistry } from "./skills/production.js";
import type { SkillRegistry } from "./skills/registry.js";

type PublicLinkPrisma = Pick<PrismaClient, "agent" | "widgetKey" | "$transaction">;

/**
 * Whether a visitor's chat or run is denied the tool of this name. A name
 * the registry does not know is not a tool anybody gets, so it is not one
 * that visitors lose.
 */
export function toolOffForVisitors(toolName: string, registry: Pick<SkillRegistry, "get" | "modeBlock">): boolean {
  const skill = registry.get(toolName);
  return skill !== undefined && registry.modeBlock(skill, { mode: "public" }) !== null;
}

export interface BuildAgentPublicLinkDepsOptions {
  prisma?: PublicLinkPrisma;
  limiter?: AgentPublicLinkDeps["limiter"];
  registry?: () => Pick<SkillRegistry, "get" | "modeBlock">;
  /** PUBLIC_WEB_URL and CORS_ORIGIN; a function so a test can vary them. */
  webAddresses?: () => { publicWebUrl: string | null | undefined; corsOrigin: string | null | undefined };
  keyDefaultDailyCap?: number;
}

export function buildAgentPublicLinkDeps(options: BuildAgentPublicLinkDepsOptions = {}): AgentPublicLinkDeps {
  const prisma = options.prisma ?? defaultPrisma;
  const registry = options.registry ?? getDefaultRegistry;
  const webAddresses =
    options.webAddresses ?? (() => ({ publicWebUrl: env.PUBLIC_WEB_URL, corsOrigin: env.CORS_ORIGIN }));
  return {
    db: {
      agent: {
        findFirst: (args) => prisma.agent.findFirst(args),
        updateMany: (args) => prisma.agent.updateMany(args),
      },
      widgetKey: {
        findFirst: (args) => prisma.widgetKey.findFirst(args),
        createMany: (args) => prisma.widgetKey.createMany(args),
        updateMany: (args) => prisma.widgetKey.updateMany(args),
      },
    },
    transaction: (fn) => prisma.$transaction((tx) => fn(tx as unknown as PublicLinkTx)),
    limiter: options.limiter ?? publicChatLimiter,
    pageUrl: (handle) => {
      const { publicWebUrl, corsOrigin } = webAddresses();
      return agentPageUrl(handle, publicWebUrl, corsOrigin);
    },
    toolOffForVisitors: (toolName) => toolOffForVisitors(toolName, registry()),
    keyDefaultDailyCap: options.keyDefaultDailyCap ?? env.WIDGET_DEFAULT_DAILY_CAP,
  };
}
