/**
 * The executor of a workflow's agent steps, watched.
 *
 * A workflow run on a stranger's input (a hired job, services/
 * buildJobRunnerDeps.ts; a paid run of a workflow on sale) sends every agent
 * step through the one shared executor. This wrapper changes nothing a step
 * does. It only watches two things the caller needs once the run is over:
 *
 *   confidential    the system prompt of every step agent that took part.
 *                   The answer must not repeat them (detectInstructionLeak).
 *                   A step's prompt template is NOT among them: a template
 *                   often holds the very words the answer is meant to repeat.
 *   platformUsage   the sum of what the steps used on the platform's own
 *                   model keys, which the creator repays from what the run
 *                   earned. null when no step ran on them.
 *
 * One watcher for one run: it is made new for each run and never shared.
 */

import type { ExecuteScheduledTaskDeps } from "./executeScheduledTask.js";
import type { TokenUsage } from "./jobRunner.js";

/** What a workflow's agent steps are run through. */
export type WorkflowStepExecutor = Pick<ExecuteScheduledTaskDeps, "loadAgent" | "runAgentChat">;

function readUsage(usage: unknown): TokenUsage | null {
  const u = usage as { inputTokens?: unknown; outputTokens?: unknown } | null | undefined;
  return typeof u?.inputTokens === "number" && typeof u?.outputTokens === "number"
    ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens }
    : null;
}

/**
 * What a call on the platform's keys used. A provider that reports no count
 * is estimated at four characters a token, the estimate the inference path
 * already uses for prompts: usage that was not reported was still used.
 */
export function platformUsageOf(
  result: { usage?: unknown; platformModel?: boolean; content: string },
  promptChars: number,
): TokenUsage | null {
  if (!result.platformModel) return null;
  return (
    readUsage(result.usage) ?? {
      inputTokens: Math.max(1, Math.ceil(promptChars / 4)),
      outputTokens: Math.max(1, Math.ceil(result.content.length / 4)),
    }
  );
}

export interface WatchedWorkflowExecutor {
  /** Handed to the engine in place of the executor it wraps. */
  executor: WorkflowStepExecutor;
  /** The system prompts of the step agents loaded so far, in the order they were loaded. */
  confidential(): Array<string | null>;
  /** What the steps have used on the platform's keys so far; null when none ran on them. */
  platformUsage(): TokenUsage | null;
}

/** Wrap `executor` for one run. Every call goes through to it unchanged. */
export function watchWorkflowExecutor(executor: WorkflowStepExecutor): WatchedWorkflowExecutor {
  const confidential: Array<string | null> = [];
  const used: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let usedPlatform = false;
  return {
    executor: {
      loadAgent: async (agentId, agentOrgId) => {
        const agent = await executor.loadAgent(agentId, agentOrgId);
        if (agent) confidential.push(agent.systemPrompt);
        return agent;
      },
      runAgentChat: async (chat) => {
        const result = await executor.runAgentChat(chat);
        const usage = platformUsageOf(result, chat.prompt.length + (chat.systemAddendum?.length ?? 0));
        if (usage) {
          usedPlatform = true;
          used.inputTokens += usage.inputTokens;
          used.outputTokens += usage.outputTokens;
        }
        return result;
      },
    },
    confidential: () => confidential,
    platformUsage: () => (usedPlatform ? used : null),
  };
}
