import { prisma } from "@wheelsai/db";

// ============================================
// Cron Parser (simplified MVP)
// ============================================

function parseCronField(field: string, now: number, max: number): number[] {
  if (field === "*") return Array.from({ length: max }, (_, i) => i);
  if (field.startsWith("*/")) {
    const step = parseInt(field.substring(2));
    return Array.from({ length: Math.ceil(max / step) }, (_, i) => i * step);
  }
  if (field.includes(",")) return field.split(",").map(Number);
  if (field.includes("-")) {
    const parts = field.split("-").map(Number);
    const start = parts[0]!;
    const end = parts[1]!;
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  }
  return [parseInt(field)];
}

export function calculateNextRun(
  scheduleType: string,
  cronExpression?: string | null,
  intervalSeconds?: number | null,
  scheduledAt?: Date | null,
  _timezone: string = "UTC"
): Date | null {
  const now = new Date();

  if (scheduleType === "once") {
    if (!scheduledAt) return null;
    const d = new Date(scheduledAt);
    return d > now ? d : null;
  }

  if (scheduleType === "interval") {
    if (!intervalSeconds) return null;
    return new Date(now.getTime() + intervalSeconds * 1000);
  }

  if (scheduleType === "cron" && cronExpression) {
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const minutes = parseCronField(parts[0]!, now.getMinutes(), 60);
    const hours = parseCronField(parts[1]!, now.getHours(), 24);

    // Find next valid minute/hour from now
    const next = new Date(now);
    next.setSeconds(0);
    next.setMilliseconds(0);

    for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
      for (const h of hours) {
        for (const m of minutes) {
          const candidate = new Date(next);
          candidate.setDate(candidate.getDate() + dayOffset);
          candidate.setHours(h, m, 0, 0);
          if (candidate > now) return candidate;
        }
      }
    }
    // Fallback: tomorrow at first valid time
    const fallback = new Date(now);
    fallback.setDate(fallback.getDate() + 1);
    fallback.setHours(hours[0] || 0, minutes[0] || 0, 0, 0);
    return fallback;
  }

  return null;
}

// ============================================
// CRUD
// ============================================

export async function createScheduledTask(orgId: string, input: {
  agentId: string; name: string; description?: string;
  scheduleType: string; cronExpression?: string; intervalSeconds?: number;
  scheduledAt?: string; timezone?: string; taskType: string;
  payload?: Record<string, any>; timeout?: number; maxRetries?: number;
}) {
  const nextRunAt = calculateNextRun(
    input.scheduleType, input.cronExpression, input.intervalSeconds,
    input.scheduledAt ? new Date(input.scheduledAt) : null, input.timezone
  );

  return prisma.scheduledTask.create({
    data: {
      orgId, agentId: input.agentId, name: input.name,
      description: input.description, scheduleType: input.scheduleType,
      cronExpression: input.cronExpression, intervalSeconds: input.intervalSeconds,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
      timezone: input.timezone || "UTC", taskType: input.taskType,
      payload: input.payload || {}, timeout: input.timeout ?? 300000,
      maxRetries: input.maxRetries ?? 3, nextRunAt,
    },
  });
}

export async function getScheduledTasks(orgId: string, options: {
  agentId?: string; status?: string; isEnabled?: boolean; limit?: number; offset?: number;
} = {}) {
  const { agentId, status, isEnabled, limit = 20, offset = 0 } = options;
  const where: any = { orgId };
  if (agentId) where.agentId = agentId;
  if (status) where.status = status;
  if (isEnabled !== undefined) where.isEnabled = isEnabled;

  const [tasks, total] = await Promise.all([
    prisma.scheduledTask.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.scheduledTask.count({ where }),
  ]);
  return { tasks, total };
}

export async function getScheduledTask(id: string, orgId: string) {
  const task = await prisma.scheduledTask.findFirst({
    where: { id, orgId },
    include: { executions: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!task) throw new Error("Task not found");
  return task;
}

export async function updateScheduledTask(id: string, orgId: string, updates: {
  name?: string; description?: string; scheduleType?: string;
  cronExpression?: string; intervalSeconds?: number; scheduledAt?: string;
  timezone?: string; taskType?: string; payload?: Record<string, any>;
  timeout?: number; maxRetries?: number; isEnabled?: boolean;
}) {
  const task = await prisma.scheduledTask.findFirst({ where: { id, orgId } });
  if (!task) throw new Error("Task not found");

  let nextRunAt: Date | null | undefined;
  if (updates.scheduleType || updates.cronExpression !== undefined || updates.intervalSeconds !== undefined) {
    nextRunAt = calculateNextRun(
      updates.scheduleType || task.scheduleType,
      updates.cronExpression ?? task.cronExpression,
      updates.intervalSeconds ?? task.intervalSeconds,
      updates.scheduledAt ? new Date(updates.scheduledAt) : task.scheduledAt,
      updates.timezone || task.timezone
    );
  }

  const data: Record<string, any> = {};
  if (updates.name !== undefined) data.name = updates.name;
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.scheduleType !== undefined) data.scheduleType = updates.scheduleType;
  if (updates.cronExpression !== undefined) data.cronExpression = updates.cronExpression;
  if (updates.intervalSeconds !== undefined) data.intervalSeconds = updates.intervalSeconds;
  if (updates.scheduledAt !== undefined) data.scheduledAt = new Date(updates.scheduledAt);
  if (updates.timezone !== undefined) data.timezone = updates.timezone;
  if (updates.taskType !== undefined) data.taskType = updates.taskType;
  if (updates.payload !== undefined) data.payload = updates.payload;
  if (updates.timeout !== undefined) data.timeout = updates.timeout;
  if (updates.maxRetries !== undefined) data.maxRetries = updates.maxRetries;
  if (updates.isEnabled !== undefined) data.isEnabled = updates.isEnabled;
  if (nextRunAt !== undefined) data.nextRunAt = nextRunAt;

  return prisma.scheduledTask.update({ where: { id }, data });
}

export async function deleteScheduledTask(id: string, orgId: string) {
  const task = await prisma.scheduledTask.findFirst({ where: { id, orgId } });
  if (!task) throw new Error("Task not found");
  await prisma.scheduledTask.delete({ where: { id } });
  return { success: true };
}

export async function toggleScheduledTask(id: string, orgId: string, isEnabled: boolean) {
  const task = await prisma.scheduledTask.findFirst({ where: { id, orgId } });
  if (!task) throw new Error("Task not found");
  return prisma.scheduledTask.update({
    where: { id }, data: { isEnabled, status: isEnabled ? "active" : "paused" },
  });
}

export async function triggerTask(id: string, orgId: string) {
  const task = await prisma.scheduledTask.findFirst({ where: { id, orgId } });
  if (!task) throw new Error("Task not found");

  // The execution engine does not exist yet (match-up roadmap, Wave 1:
  // a BullMQ worker consuming nextRunAt and invoking the real agent).
  // Until it does, refuse honestly — the previous behavior here wrote a
  // fabricated "Task executed successfully" row on a random-delay timer,
  // which poisoned every success-rate stat on the page.
  throw new Error(
    "Task execution is not live yet — the scheduler currently manages task definitions only. Execution ships with the scheduler worker.",
  );
}

export async function getTaskExecutions(taskId: string, orgId: string, options: {
  status?: string; limit?: number; offset?: number;
} = {}) {
  const task = await prisma.scheduledTask.findFirst({ where: { id: taskId, orgId } });
  if (!task) throw new Error("Task not found");
  const { status, limit = 20, offset = 0 } = options;
  const where: any = { taskId };
  if (status) where.status = status;
  const [executions, total] = await Promise.all([
    prisma.taskExecution.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.taskExecution.count({ where }),
  ]);
  return { executions, total };
}

export async function cancelExecution(executionId: string, taskId: string, orgId: string) {
  const task = await prisma.scheduledTask.findFirst({ where: { id: taskId, orgId } });
  if (!task) throw new Error("Task not found");
  return prisma.taskExecution.update({ where: { id: executionId }, data: { status: "cancelled", completedAt: new Date() } });
}

export async function getSchedulerStats(orgId: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [totalTasks, activeTasks, pausedTasks, runsToday, successToday, failedToday] = await Promise.all([
    prisma.scheduledTask.count({ where: { orgId } }),
    prisma.scheduledTask.count({ where: { orgId, isEnabled: true, status: "active" } }),
    prisma.scheduledTask.count({ where: { orgId, status: "paused" } }),
    prisma.taskExecution.count({ where: { task: { orgId }, createdAt: { gte: today } } }),
    prisma.taskExecution.count({ where: { task: { orgId }, createdAt: { gte: today }, status: "success" } }),
    prisma.taskExecution.count({ where: { task: { orgId }, createdAt: { gte: today }, status: "failed" } }),
  ]);

  const upcoming = await prisma.scheduledTask.findMany({
    where: { orgId, isEnabled: true, nextRunAt: { gt: new Date() } },
    orderBy: { nextRunAt: "asc" }, take: 5,
    select: { id: true, name: true, nextRunAt: true },
  });

  return {
    totalTasks, activeTasks, pausedTasks, totalRunsToday: runsToday,
    successRateToday: runsToday > 0 ? (successToday / runsToday) * 100 : 0,
    failedRunsToday: failedToday,
    upcomingRuns: upcoming.map(t => ({ taskId: t.id, taskName: t.name, nextRunAt: t.nextRunAt!.toISOString() })),
  };
}
