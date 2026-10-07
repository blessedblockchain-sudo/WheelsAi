/**
 * Which tool mode a run executes in.
 *
 * Callers know their own context (playground, graph, scheduler), but not
 * whether the agent being run is a marketplace BUYER's copy of someone else's
 * agent. That agent's system prompt and tool choices were written by a
 * publisher, so its runs get `trial` restrictions: money-moving skills are
 * withheld, however the run was started.
 *
 * `trial`, `test`, `hired` and `public` are never loosened: each is at least
 * as restrictive as what the install check could turn a run into. (`hired`
 * and `public` refuse state-writing skills as well as money-moving ones;
 * replacing either with `trial` would hand file_write back to a stranger's
 * input.) If the install
 * lookup itself fails, the run is restricted too: not knowing whether an agent
 * is someone else's is not a reason to let it spend.
 */

import { createLogger } from "../../utils/logger.js";
import type { ToolMode } from "./types.js";

const logger = createLogger("tool-mode");

export interface RunModeDeps {
  /** True when `agentId` is an installed marketplace copy owned by `orgId`. */
  isMarketplaceInstall?: (args: { agentId: string; orgId: string }) => Promise<boolean>;
}

async function defaultIsMarketplaceInstall(args: {
  agentId: string;
  orgId: string;
}): Promise<boolean> {
  const { prisma } = await import("../../lib/prisma.js");
  // Any install row counts, whatever the listing's price or the install's
  // billing state: the agent is still someone else's work.
  const install = await prisma.agentInstall.findFirst({
    where: { clonedAgentId: args.agentId, buyerId: args.orgId },
    select: { id: true },
  });
  return install !== null;
}

export async function resolveToolMode(
  args: { agentId: string; orgId: string; base: ToolMode },
  deps: RunModeDeps = {},
): Promise<ToolMode> {
  if (args.base === "trial" || args.base === "test" || args.base === "hired" || args.base === "public") {
    return args.base;
  }
  try {
    const isInstall = await (deps.isMarketplaceInstall ?? defaultIsMarketplaceInstall)({
      agentId: args.agentId,
      orgId: args.orgId,
    });
    return isInstall ? "trial" : args.base;
  } catch (err) {
    logger.warn({ err, agentId: args.agentId }, "install lookup failed; restricting the run");
    return "trial";
  }
}
