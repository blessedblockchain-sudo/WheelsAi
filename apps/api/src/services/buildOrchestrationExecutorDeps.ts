/**
 * Composition root for the orchestration engine (W2): binds the pure
 * runOrchestrationExecution to Prisma and to the real step invocations.
 *
 * Each step type goes through the path that already carries its billing,
 * so a workflow cannot become a cheaper way to do the same work:
 *
 *   agent     — the SAME buildProductionExecutorDeps().runAgentChat the
 *               scheduler, the test runner, and "trigger now" use, which
 *               is itself the playground's model resolution and runChat.
 *               That path charges marketplace installs per request
 *               (refunding on failure or abort) and counts free models
 *               against the organization's free-tier limits. One
 *               inference path for every non-interactive caller means
 *               orchestration cannot drift into a second, differently
 *               behaving engine.
 *   model     — the deployment chat service (deploymentChat.ts), which
 *               admits and bills a deployment by the rules /v1 uses: a
 *               GPU-billed deployment is included in its GPU time, a
 *               per-request one holds credits before the call, settles on
 *               the answer and releases on failure.
 *   retrieval — searchKnowledgeBase, which is not billed anywhere.
 *
 * Every lookup is org-scoped: a step referencing an agent or knowledge
 * base outside the orchestration's org fails with "not found" rather than
 * touching another tenant's data.
 *
 * The run's abort signal is handed to every invocation, so a cancelled or
 * timed-out run stops its in-flight model call.
 */

import { prisma as defaultPrisma } from "../lib/prisma.js";
import { chatWithDeployment as defaultChatWithDeployment } from "./buildDeploymentChatDeps.js";
import type { ExecuteScheduledTaskDeps } from "./executeScheduledTask.js";
import { searchKnowledgeBase } from "./knowledge.js";
import { buildProductionExecutorDeps } from "./scheduledTaskExecutorProduction.js";
import type {
  OrchestrationRunDeps,
  StepRecord,
} from "./runOrchestrationExecution.js";

type InvokeModel = NonNullable<OrchestrationRunDeps["invokeModel"]>;
type SearchKnowledge = NonNullable<OrchestrationRunDeps["searchKnowledge"]>;

/**
 * Whether model steps can run here; reported in plan previews. They always
 * can: the deployment chat service is part of this server. What a particular
 * deployment cannot do (not running, unpaid GPU time, no credits) is that
 * step's own named failure when the run reaches it.
 */
export function modelStepCapability(): { available: boolean; reason?: string } {
  return { available: true };
}

interface StepResultPrisma {
  orchestrationStepResult: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
  orchestrationExecution: {
    updateMany: (args: {
      where: { id: string; status: "running" };
      data: { progress: number };
    }) => Promise<unknown>;
  };
}

export interface OrchestrationExecutorOverrides {
  prisma?: StepResultPrisma;
  executor?: Pick<ExecuteScheduledTaskDeps, "loadAgent" | "runAgentChat">;
  invokeModel?: InvokeModel;
  /** The service behind the default model invoker. */
  chatWithDeployment?: typeof defaultChatWithDeployment;
  searchKnowledge?: SearchKnowledge;
}

/** What a step row stores as `output`. */
function storedOutput(record: StepRecord): Record<string, unknown> | undefined {
  if (record.output === null || record.output === undefined) return undefined;
  const isText = typeof record.output === "string";
  return {
    content: isText ? record.output : JSON.stringify(record.output),
    // Structured outputs (JSON steps, retrieval) keep their shape too.
    ...(isText ? {} : { value: record.output }),
    ...(record.truncated ? { truncated: true } : {}),
  };
}

export function buildOrchestrationExecutorDeps(
  executionId: string,
  overrides: OrchestrationExecutorOverrides = {},
): Pick<
  OrchestrationRunDeps,
  "invokeAgent" | "invokeModel" | "searchKnowledge" | "recordStepResult" | "reportProgress"
> {
  const prisma = overrides.prisma ?? (defaultPrisma as unknown as StepResultPrisma);
  const executor = overrides.executor ?? buildProductionExecutorDeps();
  const chatWithDeployment = overrides.chatWithDeployment ?? defaultChatWithDeployment;

  return {
    invokeAgent: async ({ agentId, orgId, prompt, signal }) => {
      const agent = await executor.loadAgent(agentId, orgId);
      if (!agent) {
        throw new Error(`agent ${agentId} not found in this organization`);
      }
      return executor.runAgentChat({ agent, prompt, mode: "job", signal });
    },

    invokeModel:
      overrides.invokeModel ??
      (async ({ deploymentId, modelId, orgId, prompt, signal }) => {
        // Org-scoped inside: another tenant's deployment is "not running or
        // does not exist". A refusal throws with its reason, which is what
        // the step row records.
        const result = await chatWithDeployment({
          orgId,
          deploymentId,
          modelId,
          messages: [{ role: "user", content: prompt }],
          signal,
        });
        return { content: result.content, ...(result.usage && { usage: result.usage }) };
      }),

    searchKnowledge:
      overrides.searchKnowledge ??
      (async ({ knowledgeBaseId, orgId, query, limit }) => {
        // Org-scoped inside: another tenant's knowledge base is "not found".
        const found = await searchKnowledgeBase(knowledgeBaseId, orgId, { query, limit });
        return {
          passages: found.results.map((r) => ({
            content: r.content,
            documentTitle: r.documentTitle,
            score: r.score,
          })),
          mode: found.mode,
          fallbackReason: "fallbackReason" in found ? (found.fallbackReason ?? null) : null,
        };
      }),

    recordStepResult: async (record: StepRecord) => {
      await prisma.orchestrationStepResult.create({
        data: {
          executionId,
          stepId: record.stepId,
          stepName: record.stepName,
          stepType: record.stepType,
          agentId: record.agentId,
          resourceId: record.resourceId,
          iteration: record.iteration,
          status: record.status,
          input: record.input === null ? undefined : record.input,
          output: storedOutput(record),
          error: record.error,
          startedAt: record.startedAt,
          completedAt: record.completedAt,
          durationMs: record.durationMs,
          attempt: record.attempt,
        },
      });
    },

    // Only while the run is still running: progress arriving after a
    // cancel or a reap must not touch a finished row.
    reportProgress: async (progress: number) => {
      await prisma.orchestrationExecution.updateMany({
        where: { id: executionId, status: "running" },
        data: { progress },
      });
    },
  };
}
