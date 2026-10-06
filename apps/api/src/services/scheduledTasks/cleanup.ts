/**
 * cleanup: housekeeping for one organization, and one agent when the
 * task names one.
 *
 * Operations (any combination; at least one):
 *   archive conversations   active conversations with no message for N
 *                           days (N >= 1) become 'archived'
 *   delete archived         conversations archived for N days (N >= 7)
 *                           are deleted with their messages and memories
 *   memory decay            memories not read for a week lose importance
 *                           (never below the floor); optionally those
 *                           under a threshold are deactivated
 *   prune run history       finished task executions, workflow runs and
 *                           agent graph runs older than N days (N >= 7)
 *
 * Every operation is limited to the task's organization, and to the
 * task's agent when it has one. A dry run calls the same scoped
 * operations in counting mode and changes nothing.
 *
 * Pure: each operation is an injected function taking the scope, a
 * cutoff and `dryRun`, and returning how many rows it touched (or would).
 */

import { cleanupOperations, type CleanupPayload } from "../scheduledTaskTypes.js";
import type { ScheduledTaskForExecution, TaskResult, TaskRunContext } from "./context.js";
import { permanentFailure } from "./taskError.js";

/** Memories read within this window are left alone by decay. */
export const MEMORY_STALE_AFTER_DAYS = 7;

export interface CleanupScope {
  orgId: string;
  /** Null: the whole organization. */
  agentId: string | null;
}

export interface CleanupDeps {
  /** Org-scoped; null when the agent is not this organization's. */
  loadAgent: (agentId: string, orgId: string) => Promise<{ id: string } | null>;
  archiveConversations: (args: {
    scope: CleanupScope;
    idleBefore: Date;
    dryRun: boolean;
  }) => Promise<number>;
  deleteArchivedConversations: (args: {
    scope: CleanupScope;
    archivedBefore: Date;
    dryRun: boolean;
  }) => Promise<number>;
  decayMemory: (args: {
    scope: CleanupScope;
    staleBefore: Date;
    factor: number;
    minImportance: number;
    deactivateBelow: number | null;
    dryRun: boolean;
  }) => Promise<{ decayed: number; deactivated: number }>;
  pruneRunHistory: (args: {
    scope: CleanupScope;
    finishedBefore: Date;
    dryRun: boolean;
  }) => Promise<{ taskExecutions: number; workflowRuns: number; graphRuns: number }>;
}

const DAY_MS = 86_400_000;

export async function runCleanup(
  task: ScheduledTaskForExecution,
  payload: CleanupPayload,
  ctx: TaskRunContext,
  deps: CleanupDeps,
): Promise<TaskResult> {
  if (cleanupOperations(payload).length === 0) {
    throw permanentFailure("cleanup has no operation configured; nothing was changed");
  }
  // The agent is re-checked at run time: a task that outlived its agent
  // must not widen to the whole organization.
  if (task.agentId && !(await deps.loadAgent(task.agentId, task.orgId))) {
    throw permanentFailure("agent not found in this organization; nothing was changed");
  }

  const scope: CleanupScope = { orgId: task.orgId, agentId: task.agentId };
  const dryRun = payload.dryRun === true;
  const daysAgo = (days: number) => new Date(ctx.now.getTime() - days * DAY_MS);
  const stopIfAborted = () => {
    if (ctx.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  };

  const operations: Record<string, unknown> = {};

  if (payload.archiveConversationsOlderThanDays !== undefined) {
    stopIfAborted();
    operations.archiveConversations = {
      olderThanDays: payload.archiveConversationsOlderThanDays,
      count: await deps.archiveConversations({
        scope,
        idleBefore: daysAgo(payload.archiveConversationsOlderThanDays),
        dryRun,
      }),
    };
  }
  if (payload.deleteArchivedOlderThanDays !== undefined) {
    stopIfAborted();
    operations.deleteArchivedConversations = {
      olderThanDays: payload.deleteArchivedOlderThanDays,
      count: await deps.deleteArchivedConversations({
        scope,
        archivedBefore: daysAgo(payload.deleteArchivedOlderThanDays),
        dryRun,
      }),
    };
  }
  if (payload.memoryDecay !== undefined) {
    stopIfAborted();
    operations.memoryDecay = {
      factor: payload.memoryDecay.factor,
      minImportance: payload.memoryDecay.minImportance,
      ...(await deps.decayMemory({
        scope,
        staleBefore: daysAgo(MEMORY_STALE_AFTER_DAYS),
        factor: payload.memoryDecay.factor,
        minImportance: payload.memoryDecay.minImportance,
        deactivateBelow: payload.memoryDecay.deactivateBelow ?? null,
        dryRun,
      })),
    };
  }
  if (payload.pruneRunHistoryOlderThanDays !== undefined) {
    stopIfAborted();
    operations.pruneRunHistory = {
      olderThanDays: payload.pruneRunHistoryOlderThanDays,
      ...(await deps.pruneRunHistory({
        scope,
        finishedBefore: daysAgo(payload.pruneRunHistoryOlderThanDays),
        dryRun,
      })),
    };
  }

  return { output: { dryRun, scope: { agentId: scope.agentId }, operations } };
}
