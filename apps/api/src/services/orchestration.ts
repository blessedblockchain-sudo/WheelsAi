import { prisma } from "@wheelsai/db";

import { buildOrchestrationExecutorDeps } from "./buildOrchestrationExecutorDeps.js";
import { runOrchestrationExecution } from "./runOrchestrationExecution.js";

// ============================================
// Orchestration CRUD
// ============================================

export async function createOrchestration(orgId: string, input: {
  name: string;
  description?: string;
  executionMode: string;
  maxConcurrency?: number;
  timeout?: number;
  retryPolicy?: Record<string, any>;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
  steps: Array<{
    name: string;
    agentId: string;
    inputMapping?: Record<string, any>;
    outputMapping?: Record<string, any>;
    condition?: Record<string, any>;
    onError?: string;
    fallbackAgentId?: string;
    maxRetries?: number;
    timeoutMs?: number;
    dependsOn?: string[];
  }>;
}) {
  return prisma.orchestration.create({
    data: {
      orgId,
      name: input.name,
      description: input.description,
      executionMode: input.executionMode,
      maxConcurrency: input.maxConcurrency ?? 5,
      timeout: input.timeout ?? 600000,
      retryPolicy: input.retryPolicy || {},
      inputSchema: input.inputSchema || {},
      outputSchema: input.outputSchema || {},
      steps: {
        create: input.steps.map((step, index) => ({
          name: step.name,
          stepOrder: index,
          agentId: step.agentId,
          inputMapping: step.inputMapping || {},
          outputMapping: step.outputMapping || {},
          condition: step.condition,
          onError: step.onError || "fail",
          fallbackAgentId: step.fallbackAgentId,
          maxRetries: step.maxRetries ?? 0,
          timeoutMs: step.timeoutMs,
          dependsOn: step.dependsOn || [],
        })),
      },
    },
    include: { steps: { orderBy: { stepOrder: "asc" } } },
  });
}

export async function getOrchestrations(orgId: string, options: {
  limit?: number;
  offset?: number;
  isEnabled?: boolean;
} = {}) {
  const { limit = 20, offset = 0, isEnabled } = options;
  const where: any = { orgId };
  if (isEnabled !== undefined) where.isEnabled = isEnabled;

  const [orchestrations, total] = await Promise.all([
    prisma.orchestration.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: { _count: { select: { steps: true, executions: true } } },
    }),
    prisma.orchestration.count({ where }),
  ]);
  return { orchestrations, total };
}

export async function getOrchestration(id: string, orgId: string) {
  const orch = await prisma.orchestration.findFirst({
    where: { id, orgId },
    include: {
      steps: { orderBy: { stepOrder: "asc" } },
      executions: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });
  if (!orch) throw new Error("Orchestration not found");
  return orch;
}

export async function updateOrchestration(id: string, orgId: string, updates: {
  name?: string;
  description?: string;
  executionMode?: string;
  maxConcurrency?: number;
  timeout?: number;
  retryPolicy?: Record<string, any>;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
  isEnabled?: boolean;
}) {
  const orch = await prisma.orchestration.findFirst({ where: { id, orgId } });
  if (!orch) throw new Error("Orchestration not found");
  return prisma.orchestration.update({ where: { id }, data: updates });
}

export async function deleteOrchestration(id: string, orgId: string) {
  const orch = await prisma.orchestration.findFirst({ where: { id, orgId } });
  if (!orch) throw new Error("Orchestration not found");
  await prisma.orchestration.delete({ where: { id } });
  return { success: true };
}

// ============================================
// Execution
// ============================================

export async function executeOrchestration(id: string, orgId: string, input: {
  input?: Record<string, any>;
  triggeredBy?: string;
}) {
  const orch = await prisma.orchestration.findFirst({
    where: { id, orgId },
    include: { steps: { orderBy: { stepOrder: "asc" } } },
  });
  if (!orch) throw new Error("Orchestration not found");
  if (!orch.isEnabled) throw new Error("Orchestration is disabled");

  // Live engine (W2) — replaces the Wave-0 honest refusal, which itself
  // replaced a setTimeout that fabricated per-step "success" rows on
  // random delays and made every success-rate and duration stat fiction.
  // Everything below is observed: real agent invocations through the
  // shared playground-parity path, real timings, real failures.
  const startedAt = new Date();
  const execution = await prisma.orchestrationExecution.create({
    data: {
      orchestrationId: orch.id,
      status: "running",
      input: (input.input ?? {}) as never,
      triggeredBy: input.triggeredBy || "manual",
      startedAt,
    },
  });

  const definition = {
    id: orch.id,
    orgId,
    executionMode: orch.executionMode,
    maxConcurrency: orch.maxConcurrency,
    timeout: orch.timeout,
    steps: orch.steps.map((s) => ({
      id: s.id,
      name: s.name,
      stepOrder: s.stepOrder,
      dependsOn: s.dependsOn,
      agentId: s.agentId,
      inputMapping: s.inputMapping,
      outputMapping: s.outputMapping,
      condition: s.condition,
      onError: s.onError,
      fallbackAgentId: s.fallbackAgentId,
      maxRetries: s.maxRetries,
      timeoutMs: s.timeoutMs,
    })),
  };

  let result: Awaited<ReturnType<typeof runOrchestrationExecution>>;
  try {
    // The orchestration-level timeout bounds the WHOLE run, on top of any
    // per-step timeout — a workflow of individually-fast steps can still
    // run away.
    result = await Promise.race([
      runOrchestrationExecution(
        definition,
        (input.input ?? {}) as Record<string, unknown>,
        buildOrchestrationExecutorDeps(execution.id),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`orchestration timed out after ${orch.timeout}ms`)),
          orch.timeout,
        ),
      ),
    ]);
  } catch (err) {
    // A plan error (cycle, unknown dependency) or the run timeout. The
    // execution row records it rather than leaving a row stuck "running".
    const message = err instanceof Error ? err.message : String(err);
    const completedAt = new Date();
    const failed = await prisma.orchestrationExecution.update({
      where: { id: execution.id },
      data: {
        status: "failed",
        error: message,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      },
    });
    await recordRunStats(orch.id, false, completedAt.getTime() - startedAt.getTime());
    return failed;
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();
  const finished = await prisma.orchestrationExecution.update({
    where: { id: execution.id },
    data: {
      status: result.status,
      progress: 100,
      output: result.output as never,
      context: result.context as never,
      error: result.error,
      failedStepId: result.failedStepId,
      completedAt,
      durationMs,
    },
    include: { stepResults: { orderBy: { createdAt: "asc" } } },
  });

  await recordRunStats(orch.id, result.status === "completed", durationMs);
  return finished;
}

/**
 * Rolls the orchestration's run counters forward. avgDurationMs is a
 * running mean over totalRuns, so it stays correct without storing every
 * duration.
 */
async function recordRunStats(
  orchestrationId: string,
  success: boolean,
  durationMs: number,
): Promise<void> {
  const current = await prisma.orchestration.findUnique({
    where: { id: orchestrationId },
    select: { totalRuns: true, avgDurationMs: true },
  });
  const priorRuns = current?.totalRuns ?? 0;
  const priorAvg = current?.avgDurationMs ?? 0;
  const nextAvg = Math.round(
    (priorAvg * priorRuns + durationMs) / (priorRuns + 1),
  );

  await prisma.orchestration.update({
    where: { id: orchestrationId },
    data: {
      totalRuns: { increment: 1 },
      ...(success
        ? { successfulRuns: { increment: 1 } }
        : { failedRuns: { increment: 1 } }),
      avgDurationMs: nextAvg,
      lastRunAt: new Date(),
    },
  });
}

export async function getExecution(executionId: string, orchestrationId: string, orgId: string) {
  const orch = await prisma.orchestration.findFirst({ where: { id: orchestrationId, orgId } });
  if (!orch) throw new Error("Orchestration not found");

  const execution = await prisma.orchestrationExecution.findFirst({
    where: { id: executionId, orchestrationId },
    include: { stepResults: { orderBy: { createdAt: "asc" } } },
  });
  if (!execution) throw new Error("Execution not found");
  return execution;
}

export async function getExecutions(orchestrationId: string, orgId: string, options: {
  status?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const orch = await prisma.orchestration.findFirst({ where: { id: orchestrationId, orgId } });
  if (!orch) throw new Error("Orchestration not found");

  const { status, limit = 20, offset = 0 } = options;
  const where: any = { orchestrationId };
  if (status) where.status = status;

  const [executions, total] = await Promise.all([
    prisma.orchestrationExecution.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.orchestrationExecution.count({ where }),
  ]);
  return { executions, total };
}

export async function cancelExecution(executionId: string, orchestrationId: string, orgId: string) {
  const orch = await prisma.orchestration.findFirst({ where: { id: orchestrationId, orgId } });
  if (!orch) throw new Error("Orchestration not found");
  // Same child-scoping rule as the scheduler: the orchestration is
  // verified above, so the execution must be constrained to it.
  const cancelled = await prisma.orchestrationExecution.updateMany({
    where: { id: executionId, orchestrationId },
    data: { status: "cancelled", completedAt: new Date() },
  });
  if (cancelled.count === 0) {
    throw new Error("Execution not found for this orchestration");
  }
  return prisma.orchestrationExecution.findFirstOrThrow({
    where: { id: executionId, orchestrationId },
  });
}

export async function getOrchestrationStats(orgId: string) {
  const [total, active, totalRuns] = await Promise.all([
    prisma.orchestration.count({ where: { orgId } }),
    prisma.orchestration.count({ where: { orgId, isEnabled: true } }),
    prisma.orchestrationExecution.count({ where: { orchestration: { orgId } } }),
  ]);
  return { totalOrchestrations: total, activeOrchestrations: active, totalExecutions: totalRuns };
}
