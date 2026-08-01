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

  // The execution engine does not exist yet (match-up roadmap, Wave 2:
  // sequential/parallel/conditional/pipeline over the real agent
  // invocation paths). Until it does, refuse honestly — the previous
  // behavior wrote fabricated per-step "success" results on random-delay
  // timers, which made every success-rate and duration stat fiction.
  throw new Error(
    "Orchestration execution is not live yet — workflows can be defined but not run. Execution ships with the orchestration engine.",
  );
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
