/**
 * Composition root for an agent's own schedule and its runs
 * (services/agentSchedule.ts): binds them to Prisma, to the Scheduler's own
 * "run now" and to the senders a result is delivered with.
 *
 *   runNow            services/scheduler.ts, triggerTask: the firing the
 *                     scheduler worker uses. There is no second executor.
 *   schedulerRunning  the same answer the Scheduler page draws its "paused"
 *                     line from (getTaskTypes().schedulerEnabled)
 *   delivery          services/scheduledTasks/buildResultDeliveryDeps.ts,
 *                     as a timed run's result is delivered
 *
 * The Scheduler service is loaded on first use, as routes/scheduler.ts
 * loads it, so registering the routes opens nothing.
 */

import { Prisma, prisma as defaultPrisma, type PrismaClient } from "@wheelsai/db";

import type { AgentScheduleDeps, RunRow } from "./agentSchedule.js";
import type { OwnScheduleDb } from "./agentOwnSchedule.js";
import { isEmailConfigured } from "./email/emailService.js";
import { buildResultDeliveryDeps } from "./scheduledTasks/buildResultDeliveryDeps.js";
import type { ResultDeliveryDeps } from "./scheduledTasks/resultDelivery.js";

type AgentSchedulePrisma = Pick<
  PrismaClient,
  "agent" | "scheduledTask" | "alertChannel" | "taskExecution" | "$transaction" | "$executeRaw"
>;

/** What of services/scheduler.ts is used here. */
export interface SchedulerForAgent {
  triggerTask(taskId: string, orgId: string): Promise<{ execution: RunRow; deferred: boolean }>;
  getTaskTypes(): { schedulerEnabled: boolean };
}

export interface BuildAgentScheduleDepsOptions {
  prisma?: AgentSchedulePrisma;
  /** Defaults to services/scheduler.ts, loaded on first use. */
  scheduler?: () => Promise<SchedulerForAgent>;
  delivery?: () => ResultDeliveryDeps;
  emailConfigured?: () => boolean;
  now?: () => Date;
}

/** The columns of a run. Never the execution's input or its logs. */
export const RUN_COLUMNS = {
  id: true,
  status: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  triggeredBy: true,
  output: true,
  error: true,
  delivery: true,
  createdAt: true,
} as const;

export function buildAgentScheduleDeps(options: BuildAgentScheduleDepsOptions = {}): AgentScheduleDeps {
  const prisma = options.prisma ?? defaultPrisma;
  let loaded: Promise<SchedulerForAgent> | null = null;
  const scheduler =
    options.scheduler ??
    (() => (loaded ??= import("./scheduler.js") as unknown as Promise<SchedulerForAgent>));
  let delivery: ResultDeliveryDeps | null = null;

  return {
    db: prisma as unknown as OwnScheduleDb,
    transaction: (fn) => prisma.$transaction((tx) => fn(tx as unknown as OwnScheduleDb)),
    // `tx` is the transaction client handed out just above.
    lockAgent: async (tx, { orgId, agentId }) => {
      const rows = await (tx as unknown as Pick<Prisma.TransactionClient, "$queryRaw">).$queryRaw<
        Array<{ name: string }>
      >(Prisma.sql`
        SELECT "name" FROM "agents"
        WHERE "id" = ${agentId}::uuid AND "org_id" = ${orgId}::uuid
        FOR UPDATE`);
      return rows[0] ? { name: rows[0].name } : null;
    },
    loadAgent: ({ orgId, agentId }) =>
      prisma.agent.findFirst({ where: { id: agentId, orgId }, select: { id: true, name: true, kindConfig: true } }),
    // The config (the link, the addresses) is not selected.
    loadPlace: (channelId, orgId) =>
      prisma.alertChannel.findFirst({ where: { id: channelId, orgId }, select: { id: true, name: true, type: true } }),
    runs: {
      list: ({ taskId, limit, before }) =>
        prisma.taskExecution.findMany({
          where: { taskId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit,
          ...(before ? { cursor: { id: before }, skip: 1 } : {}),
          select: RUN_COLUMNS,
        }),
      find: ({ taskId, runId }) =>
        prisma.taskExecution.findFirst({ where: { id: runId, taskId }, select: RUN_COLUMNS }),
      // One statement, so two "Send again" at once both land on the list.
      appendDelivery: async ({ taskId, runId, records }) => {
        const added = JSON.stringify(records);
        const written = await prisma.$executeRaw(Prisma.sql`
          UPDATE "task_executions"
          SET "delivery" =
            (CASE WHEN jsonb_typeof("delivery") = 'array' THEN "delivery" ELSE '[]'::jsonb END) || ${added}::jsonb
          WHERE "id" = ${runId}::uuid AND "task_id" = ${taskId}::uuid AND "status" = 'success'`);
        return written > 0;
      },
    },
    runNow: async (taskId, orgId) => (await scheduler()).triggerTask(taskId, orgId),
    schedulerRunning: async () => (await scheduler()).getTaskTypes().schedulerEnabled === true,
    emailConfigured: options.emailConfigured ?? isEmailConfigured,
    delivery: options.delivery ?? (() => (delivery ??= buildResultDeliveryDeps({ now: options.now }))),
    now: options.now,
  };
}
