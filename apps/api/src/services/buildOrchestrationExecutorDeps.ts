/**
 * Composition root for the orchestration engine (W2): binds the pure
 * runOrchestrationExecution to Prisma + real agent invocation.
 *
 * `invokeAgent` deliberately routes through the SAME
 * buildProductionExecutorDeps().runAgentChat that the scheduler, the test
 * runner, and "trigger now" use — which is itself the playground's model
 * resolution and runChat. One inference path for every non-interactive
 * caller means orchestration cannot drift into a second, differently
 * behaving engine.
 *
 * Agent lookup is org-scoped: a step referencing an agent outside the
 * orchestration's org fails with "not found" rather than executing
 * another tenant's agent.
 */

import { prisma } from "../lib/prisma.js";
import { buildProductionExecutorDeps } from "./scheduledTaskExecutorProduction.js";
import type {
  OrchestrationRunDeps,
  StepRecord,
} from "./runOrchestrationExecution.js";

export function buildOrchestrationExecutorDeps(
  executionId: string,
): OrchestrationRunDeps {
  const executor = buildProductionExecutorDeps();

  return {
    invokeAgent: async ({ agentId, orgId, prompt }) => {
      const agent = await executor.loadAgent(agentId, orgId);
      if (!agent) {
        throw new Error(`agent ${agentId} not found in this organization`);
      }
      return executor.runAgentChat({ agent, prompt });
    },

    recordStepResult: async (record: StepRecord) => {
      await prisma.orchestrationStepResult.create({
        data: {
          executionId,
          stepId: record.stepId,
          stepName: record.stepName,
          agentId: record.agentId,
          status: record.status,
          input: record.input === null ? undefined : (record.input as never),
          output:
            record.output === null || record.output === undefined
              ? undefined
              : ({ content: record.output } as never),
          error: record.error,
          startedAt: record.startedAt,
          completedAt: record.completedAt,
          durationMs: record.durationMs,
          attempt: record.attempt,
        },
      });
    },

    reportProgress: async (progress: number) => {
      await prisma.orchestrationExecution.update({
        where: { id: executionId },
        data: { progress },
      });
    },
  };
}
