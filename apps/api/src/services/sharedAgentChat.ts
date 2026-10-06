/**
 * The one agent-chat call every non-interactive caller shares: scheduled
 * tasks, "trigger now", workflow steps, the test runner.
 *
 * It is playground-parity by construction — the same model resolution
 * (free-tier keys or the agent's own) and the same runChat — and it
 * applies the same two cost controls the playground does, in this order:
 *
 *   1. Free-tier limits. A free model runs on the platform's provider
 *      key. The playground has always rate-limited that per organization;
 *      scheduled, workflow and test runs did not, so a loop inside a
 *      parallel workflow on a one-minute schedule was an unmetered way to
 *      spend the platform's quota. Over the limit, the call is refused
 *      with a clear message and NO model call is made. An agent on its
 *      own provider key is not a free model and skips the limiter.
 *   2. Marketplace metering. A per-request install is charged before the
 *      model runs and refunded if the run throws, which includes an
 *      abort.
 *
 * The caller's abort signal reaches runChat, so a timeout or a cancel
 * stops the model call instead of merely abandoning it.
 *
 * Pure: the model, the limiter, metering and the usage write are seams.
 */

import type { AgentForExecution, ExecuteScheduledTaskDeps } from "./executeScheduledTask.js";
import type { ToolMode } from "./skills/types.js";

export const FREE_TIER_LIMIT_MESSAGE =
  "free-model limit reached for this org; retry later or use your own provider key";

export interface SharedChatConfig {
  name: string;
  systemPrompt?: string;
  tools: never[];
  modelConfig: { externalModel: string; temperature: number; maxTokens: number };
}

export interface SharedAgentChatSeams<Resolved> {
  isFreeModel: (modelId: string) => boolean;
  /** Counts one request against the org's free-tier limits. */
  checkFreeTierLimit: (orgId: string) => Promise<{ allowed: boolean }>;
  /** Best-effort usage row for a completed free-model call. */
  recordFreeTierUsage: (usage: {
    orgId: string;
    modelId: string;
    inputTokens: number;
    outputTokens: number;
  }) => Promise<void>;
  openAgentEnv: (env: unknown) => Record<string, string>;
  resolveModel: (modelId: string, agentEnv: Record<string, string>) => Resolved;
  resolveToolMode: (args: { agentId: string; orgId: string; base: ToolMode }) => Promise<ToolMode>;
  withMetering: <T>(args: { agentId: string; orgId: string }, run: () => Promise<T>) => Promise<T>;
  runChat: (
    resolved: Resolved,
    config: SharedChatConfig,
    prompt: string,
    options: { agentId: string; orgId: string; mode: ToolMode; signal?: AbortSignal },
  ) => Promise<{ content: string; usage?: { inputTokens: number; outputTokens: number } }>;
}

export function createRunAgentChat<Resolved>(
  seams: SharedAgentChatSeams<Resolved>,
): ExecuteScheduledTaskDeps["runAgentChat"] {
  return async ({ agent, prompt, mode, signal }) => {
    const modelConfig = (agent.modelConfig as Record<string, unknown> | null) ?? {};
    const agentEnv = seams.openAgentEnv(agent.env);
    const modelId =
      typeof modelConfig.externalModel === "string"
        ? modelConfig.externalModel
        : typeof modelConfig.model === "string"
          ? modelConfig.model
          : null;
    if (!modelId) {
      throw new Error(`agent ${agent.id} has no model configured for scheduled runs`);
    }

    const resolved = seams.resolveModel(modelId, agentEnv);
    const freeModel = seams.isFreeModel(modelId);
    if (freeModel) {
      const limit = await seams.checkFreeTierLimit(agent.orgId);
      if (!limit.allowed) throw new Error(FREE_TIER_LIMIT_MESSAGE);
    }

    // A marketplace buyer's copy of someone else's agent runs restricted
    // (money-moving tools withheld) however the run was triggered.
    const toolMode = await seams.resolveToolMode({
      agentId: agent.id,
      orgId: agent.orgId,
      base: mode ?? "scheduled",
    });
    // Every non-interactive invocation of an installed marketplace
    // agent is billable: charge the buyer before the model runs, refund
    // if it throws. Agents that are not per-request installs pass
    // straight through.
    const result = await seams.withMetering({ agentId: agent.id, orgId: agent.orgId }, () =>
      seams.runChat(
        resolved,
        {
          name: (agent as AgentForExecution).name,
          systemPrompt: agent.systemPrompt ?? undefined,
          tools: (agent.tools as never[]) ?? [],
          modelConfig: {
            externalModel: modelId,
            temperature:
              typeof modelConfig.temperature === "number" ? modelConfig.temperature : 0.7,
            maxTokens: typeof modelConfig.maxTokens === "number" ? modelConfig.maxTokens : 4096,
          },
        },
        prompt,
        // The agent's enabled tools really run here (files and the
        // knowledge base are scoped to THIS agent and org).
        { agentId: agent.id, orgId: agent.orgId, mode: toolMode, signal },
      ),
    );

    if (freeModel) {
      await seams
        .recordFreeTierUsage({
          orgId: agent.orgId,
          modelId,
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
        })
        .catch(() => {
          // Usage tracking is best-effort; it never fails a finished run.
        });
    }
    return { content: result.content, usage: result.usage };
  };
}
