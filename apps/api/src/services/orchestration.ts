import { prisma } from "@wheelsai/db";

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

  const execution = await prisma.orchestrationExecution.create({
    data: {
      orchestrationId: id,
      status: "running",
      input: input.input || {},
      context: {},
      startedAt: new Date(),
      triggeredBy: input.triggeredBy || "manual",
    },
  });

  // Simulate step-by-step execution asynchronously
  const totalSteps = orch.steps.length;
  let context: Record<string, any> = { input: input.input || {} };

  setTimeout(async () => {
    try {
      for (let i = 0; i < orch.steps.length; i++) {
        const step = orch.steps[i]!;
        const stepStart = Date.now();

        await prisma.orchestrationStepResult.create({
          data: {
            executionId: execution.id,
            stepId: step.id,
            stepName: step.name,
            agentId: step.agentId,
            status: "running",
            input: context,
            startedAt: new Date(),
          },
        });

        // Simulate step processing
        const durationMs = Math.floor(Math.random() * 1000) + 200;
        await new Promise((r) => setTimeout(r, durationMs));

        const stepOutput = { result: `Step ${step.name} completed`, data: {} };
        context[step.name] = stepOutput;

        await prisma.orchestrationStepResult.updateMany({
          where: { executionId: execution.id, stepId: step.id },
          data: {
            status: "success",
            output: stepOutput as any,
            completedAt: new Date(),
            durationMs,
          },
        });

        await prisma.orchestrationExecution.update({
          where: { id: execution.id },
          data: { progress: Math.round(((i + 1) / totalSteps) * 100), context: context as any },
        });
      }

      const totalDuration = Date.now() - execution.startedAt!.getTime();
      await prisma.orchestrationExecution.update({
        where: { id: execution.id },
        data: { status: "completed", output: context as any, completedAt: new Date(), durationMs: totalDuration },
      });

      // Compute rolling average duration
      const prevTotal = orch.totalRuns;
      const prevAvg = orch.avgDurationMs || 0;
      const newAvg = prevTotal > 0
        ? Math.floor((prevAvg * prevTotal + totalDuration) / (prevTotal + 1))
        : totalDuration;

      await prisma.orchestration.update({
        where: { id: orch.id },
        data: {
          totalRuns: { increment: 1 },
          successfulRuns: { increment: 1 },
          lastRunAt: new Date(),
          avgDurationMs: newAvg,
        },
      });
    } catch (err) {
      await prisma.orchestrationExecution.update({
        where: { id: execution.id },
        data: { status: "failed", error: String(err), completedAt: new Date() },
      });
      await prisma.orchestration.update({
        where: { id: orch.id },
        data: { totalRuns: { increment: 1 }, failedRuns: { increment: 1 }, lastRunAt: new Date() },
      });
    }
  }, 100);

  return execution;
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
  return prisma.orchestrationExecution.update({
    where: { id: executionId },
    data: { status: "cancelled", completedAt: new Date() },
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
