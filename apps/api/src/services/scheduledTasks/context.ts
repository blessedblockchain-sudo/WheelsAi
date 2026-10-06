/**
 * What every scheduled-task executor is handed: the task being run and
 * the circumstances of this run.
 */

export interface ScheduledTaskForExecution {
  id: string;
  orgId: string;
  /** Null for task types that need no agent. */
  agentId: string | null;
  /** The workflow a workflow_run task starts. */
  orchestrationId?: string | null;
  name: string;
  taskType: string;
  payload: unknown;
  timeout: number;
}

export interface TaskRunContext {
  /** The TaskExecution row recording this attempt, when there is one. */
  executionId: string | null;
  /** 1 for the first attempt of a firing. */
  attempt: number;
  /** Aborted on the task's timeout or when the execution is cancelled. */
  signal?: AbortSignal;
  triggeredBy: "schedule" | "manual";
  now: Date;
}

export interface TaskResult {
  output: unknown;
  /**
   * The work continues elsewhere (a queued workflow run) and that worker
   * finishes the execution; the scheduler must leave the row running.
   */
  deferred?: true;
}
