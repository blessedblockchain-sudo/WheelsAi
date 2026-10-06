/**
 * Production deps for the scheduled-task executor — shared by the
 * scheduler BullMQ worker, the manual "trigger now" route, workflow
 * steps and the test runner, so every path runs the identical engine.
 *
 * agent_run inference is playground-parity by construction: the same
 * model resolution (free-tier keys or the agent's own) and the same
 * runChat the interactive playground uses. The call itself, with its
 * free-tier and marketplace cost controls, is sharedAgentChat.ts; this
 * file only binds it to the real model, limiter and database.
 */

import { isFreeModel } from "../config/free-models.js";
import { prisma } from "../lib/prisma.js";
import { checkFreeTierLimit } from "../middleware/free-tier-limit.js";
import { openAgentEnv } from "./agentSecrets.js";
import { withMarketplaceMetering } from "./marketplaceMeteringProduction.js";
import { resolveToolMode } from "./skills/runMode.js";
import {
  resolveModelForPlayground,
  runChat,
  type ChatMessage,
} from "./mastra-runtime.js";
import { createRunAgentChat } from "./sharedAgentChat.js";
import type { ExecuteScheduledTaskDeps } from "./executeScheduledTask.js";
import { buildScheduledTaskTypeDeps } from "./scheduledTasks/buildScheduledTaskTypeDeps.js";

/**
 * One FreeTierUsage row per org, model and day — the same row the
 * playground increments, so the usage page counts every free-model call
 * whichever surface made it.
 */
async function recordFreeTierUsage(usage: {
  orgId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const provider =
    usage.modelId.split("/")[1] ?? usage.modelId.split("/")[0] ?? "unknown";
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await prisma.freeTierUsage.upsert({
    where: {
      orgId_model_date: { orgId: usage.orgId, model: usage.modelId, date: today },
    },
    update: {
      inputTokens: { increment: usage.inputTokens },
      outputTokens: { increment: usage.outputTokens },
      requestCount: { increment: 1 },
    },
    create: {
      orgId: usage.orgId,
      model: usage.modelId,
      provider,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      requestCount: 1,
      date: today,
    },
  });
}

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

    runAgentChat: createRunAgentChat({
      isFreeModel,
      checkFreeTierLimit,
      recordFreeTierUsage,
      openAgentEnv: (env) => openAgentEnv(env as never),
      resolveModel: resolveModelForPlayground,
      resolveToolMode,
      withMetering: withMarketplaceMetering,
      runChat: (resolved, config, prompt, options) =>
        runChat(
          resolved,
          config,
          [{ role: "user", content: prompt }] as ChatMessage[],
          false,
          options,
        ),
    }),

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
