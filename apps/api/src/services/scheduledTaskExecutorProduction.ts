/**
 * Production deps for the scheduled-task executor — shared by the
 * scheduler BullMQ worker and the manual "trigger now" route so both
 * paths run the identical engine.
 *
 * agent_run inference is playground-parity by construction: the same
 * model resolution (free-tier keys or the agent's own) and the same
 * runChat the interactive playground uses.
 */

import { prisma } from "../lib/prisma.js";
import { withMarketplaceMetering } from "./marketplaceMeteringProduction.js";
import {
  resolveModelForPlayground,
  runChat,
  type ChatMessage,
} from "./mastra-runtime.js";
import type {
  AgentForExecution,
  ExecuteScheduledTaskDeps,
} from "./executeScheduledTask.js";

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

    runAgentChat: async ({ agent, prompt }) => {
      const modelConfig =
        (agent.modelConfig as Record<string, unknown> | null) ?? {};
      const agentEnv = (agent.env as Record<string, string> | null) ?? {};
      const modelId =
        typeof modelConfig.externalModel === "string"
          ? modelConfig.externalModel
          : typeof modelConfig.model === "string"
            ? modelConfig.model
            : null;
      if (!modelId) {
        throw new Error(
          `agent ${agent.id} has no model configured for scheduled runs`,
        );
      }

      const resolved = resolveModelForPlayground(modelId, agentEnv);
      // Every non-interactive invocation of an installed marketplace
      // agent is billable: charge the buyer before the model runs, refund
      // if it throws. Agents that are not per-request installs pass
      // straight through.
      const result = await withMarketplaceMetering(
        { agentId: agent.id, orgId: agent.orgId },
        () =>
          runChat(
            resolved,
            {
              name: (agent as AgentForExecution).name,
              systemPrompt: agent.systemPrompt ?? undefined,
              tools: (agent.tools as never[]) ?? [],
              modelConfig: {
                externalModel: modelId,
                temperature:
                  typeof modelConfig.temperature === "number"
                    ? modelConfig.temperature
                    : 0.7,
                maxTokens:
                  typeof modelConfig.maxTokens === "number"
                    ? modelConfig.maxTokens
                    : 4096,
              },
            },
            [{ role: "user", content: prompt }] as ChatMessage[],
            false,
          ),
      );
      return { content: result.content, usage: result.usage };
    },

    fetchFn: fetch,
  };
}
