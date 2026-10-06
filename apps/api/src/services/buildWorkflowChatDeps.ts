/**
 * Composition root for workflows through /v1: binds the pure
 * services/workflowChat.ts to Prisma and to the workflow service.
 *
 * Every read is scoped to the caller's organization through the run's
 * workflow, and the two writes are the service's own: startOrchestrationRun
 * (the one entry point for every trigger) and cancelExecution (compare-and-
 * set on the run's status).
 */

import { prisma as defaultPrisma } from "../lib/prisma.js";
import type { WorkflowChatDeps, WorkflowRunSnapshot } from "./workflowChat.js";
import { WorkflowError } from "./workflowErrors.js";

interface WorkflowChatPrisma {
  orchestration: {
    findUnique: (args: {
      where: { orgId_slug: { orgId: string; slug: string } };
      select: Record<string, true>;
    }) => Promise<unknown>;
  };
  orchestrationExecution: {
    findFirst: (args: {
      where: { id: string; orchestrationId: string; orchestration: { orgId: string } };
      select: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

type OrchestrationService = Pick<
  typeof import("./orchestration.js"),
  "startOrchestrationRun" | "cancelExecution"
>;

export interface WorkflowChatOverrides {
  prisma?: WorkflowChatPrisma;
  /** Defaults to services/orchestration.ts, loaded on first use. */
  service?: OrchestrationService;
  now?: () => number;
  pollMs?: number;
  graceMs?: number;
}

interface StoredRun {
  id: string;
  status: string;
  output: unknown;
  context: unknown;
  error: string | null;
  durationMs: number | null;
  failedStepId: string | null;
  orchestration: { steps: Array<{ id: string; name: string }> };
  stepResults: Array<{
    stepName: string;
    stepType: string;
    status: string;
    iteration: number | null;
    durationMs: number | null;
    error: string | null;
    usage: unknown;
  }>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function buildWorkflowChatDeps(overrides: WorkflowChatOverrides = {}): WorkflowChatDeps {
  const prisma = overrides.prisma ?? (defaultPrisma as unknown as WorkflowChatPrisma);
  let loaded: OrchestrationService | null = overrides.service ?? null;
  // Lazily: the service's queue import opens a Redis connection.
  const service = async () => (loaded ??= await import("./orchestration.js"));
  const scope = (executionId: string, orchestrationId: string, orgId: string) => ({
    id: executionId,
    orchestrationId,
    orchestration: { orgId },
  });

  return {
    findWorkflow: async (orgId, slug) =>
      (await prisma.orchestration.findUnique({
        where: { orgId_slug: { orgId, slug } },
        select: {
          id: true,
          slug: true,
          name: true,
          isEnabled: true,
          timeout: true,
          inputSchema: true,
          createdAt: true,
        },
      })) as Awaited<ReturnType<WorkflowChatDeps["findWorkflow"]>>,

    startRun: async ({ orchestrationId, orgId, prompt, input, triggeredById }) =>
      (await service()).startOrchestrationRun({
        orchestrationId,
        orgId,
        prompt,
        input,
        // Whoever authenticated, the run was asked for through the API.
        triggeredBy: "api",
        triggeredById,
      }),

    runStatus: async (executionId, orchestrationId, orgId) => {
      const row = (await prisma.orchestrationExecution.findFirst({
        where: scope(executionId, orchestrationId, orgId),
        select: { status: true },
      })) as { status: string } | null;
      return row?.status ?? null;
    },

    loadRun: async (executionId, orchestrationId, orgId): Promise<WorkflowRunSnapshot | null> => {
      const row = (await prisma.orchestrationExecution.findFirst({
        where: scope(executionId, orchestrationId, orgId),
        select: {
          id: true,
          status: true,
          output: true,
          context: true,
          error: true,
          durationMs: true,
          failedStepId: true,
          orchestration: {
            select: { steps: { orderBy: { stepOrder: "asc" }, select: { id: true, name: true } } },
          },
          stepResults: {
            orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }],
            select: {
              stepName: true,
              stepType: true,
              status: true,
              iteration: true,
              durationMs: true,
              error: true,
              usage: true,
            },
          },
        },
      })) as StoredRun | null;
      if (!row) return null;
      const { steps } = row.orchestration;
      return {
        id: row.id,
        status: row.status,
        output: row.output,
        context: row.context,
        error: row.error,
        durationMs: row.durationMs,
        stepOrder: steps.map((step) => step.name),
        failedStepName: steps.find((step) => step.id === row.failedStepId)?.name ?? null,
        steps: row.stepResults,
      };
    },

    cancelRun: async (executionId, orchestrationId, orgId) => {
      try {
        await (await service()).cancelExecution(executionId, orchestrationId, orgId);
      } catch (err) {
        // Already finished, or deleted with its workflow: nothing left to stop.
        if (err instanceof WorkflowError && (err.code === "execution_finished" || err.code === "not_found")) {
          return;
        }
        throw err;
      }
    },

    sleep,
    now: overrides.now ?? Date.now,
    pollMs: overrides.pollMs,
    graceMs: overrides.graceMs,
  };
}
