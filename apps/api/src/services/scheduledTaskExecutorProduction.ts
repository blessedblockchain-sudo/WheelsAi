/**
 * Production deps for the scheduled-task executor — shared by the
 * scheduler BullMQ worker, the manual "trigger now" route, workflow
 * steps and the test runner, so every path runs the identical engine.
 *
 * agent_run inference is the playground's and /v1's, not a look-alike:
 * runAgentChat goes through the one agent-chat core (agentChat.ts, by way
 * of sharedAgentChat.ts) on the very deps those routes build
 * (buildAgentChatDeps). Model resolution, the free-tier limiter,
 * marketplace metering, tool mode, usage rows and shutdown registration
 * are therefore the same code and the same bindings on every path.
 */

import { prisma } from "../lib/prisma.js";
import { buildAgentChatDeps } from "./buildAgentChatDeps.js";
import { createRunAgentChat } from "./sharedAgentChat.js";
import type { ExecuteScheduledTaskDeps } from "./executeScheduledTask.js";
import { buildScheduledTaskTypeDeps } from "./scheduledTasks/buildScheduledTaskTypeDeps.js";

export function buildProductionExecutorDeps(): ExecuteScheduledTaskDeps {
  return {
    loadAgent: (agentId, orgId) =>
      prisma.agent.findFirst({
        where: { id: agentId, orgId },
        select: {
          id: true,
          orgId: true,
          name: true,
          systemPrompt: true,
          tools: true,
          modelConfig: true,
          env: true,
        },
      }),

    // No continuation store: these callers never offer functions of their
    // own, so there is no hand-back to resume.
    runAgentChat: createRunAgentChat(() => buildAgentChatDeps({ continuations: false })),

    fetchFn: fetch,
  };
}

/**
 * The executor deps the scheduler itself runs with (the worker and
 * "trigger now"): the shared agent chat plus the services behind every
 * other task type. Callers that only chat with an agent (workflow steps,
 * the test runner) keep using buildProductionExecutorDeps.
 */
export function buildSchedulerExecutorDeps(): ExecuteScheduledTaskDeps {
  const executor = buildProductionExecutorDeps();
  return { ...executor, taskTypes: buildScheduledTaskTypeDeps({ executor }) };
}
