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
 *   model     — must go through the deployment chat service, which holds
 *               credits before the call, settles on success and releases
 *               on failure. See PRODUCTION_MODEL_INVOKER below.
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
 * The function model steps call. It MUST be the deployment chat service
 * that applies the deployment's billing rules (credit hold, settle,
 * release; nothing charged for gpu_included). That logic currently lives
 * inside the /v1 route handler and is not exported, so there is nothing
 * safe to call yet: wiring a model step to anything else would run GPU
 * inference without charging for it. Until the service is extracted this
 * stays null and a model step fails with MODEL_STEPS_UNAVAILABLE_REASON.
 */
const PRODUCTION_MODEL_INVOKER: InvokeModel | null = null;

export const MODEL_STEPS_UNAVAILABLE_REASON =
  "the deployment chat service that bills model calls is not connected to the workflow engine on this server";

/** Whether model steps can run here; reported in plan previews. */
export function modelStepCapability(): { available: boolean; reason?: string } {
  return PRODUCTION_MODEL_INVOKER
    ? { available: true }
    : { available: false, reason: MODEL_STEPS_UNAVAILABLE_REASON };
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
  invokeModel?: InvokeModel | null;
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
  const invokeModel =
    overrides.invokeModel === undefined ? PRODUCTION_MODEL_INVOKER : overrides.invokeModel;

  return {
    invokeAgent: async ({ agentId, orgId, prompt, signal }) => {
      const agent = await executor.loadAgent(agentId, orgId);
      if (!agent) {
        throw new Error(`agent ${agentId} not found in this organization`);
      }
      return executor.runAgentChat({ agent, prompt, mode: "job", signal });
    },

    invokeModel:
      invokeModel ??
      (async () => {
        throw new Error(`model steps cannot run yet: ${MODEL_STEPS_UNAVAILABLE_REASON}`);
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
