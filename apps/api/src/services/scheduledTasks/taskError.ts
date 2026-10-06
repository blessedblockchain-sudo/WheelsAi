/**
 * How a scheduled task reports failure.
 *
 * Any throw fails the execution with its message. A TaskError adds two
 * things the scheduler needs to act honestly on that failure:
 *
 *   permanent  retrying cannot help (nothing is configured, the payload
 *              is wrong, the check ran and the target is down). The tick
 *              does not spend the task's retries on it.
 *   output     what the task did produce before failing (which sources
 *              synced, the probe result, the report that could not be
 *              delivered). Stored on the failed execution so the owner
 *              sees it next to the error.
 */
export class TaskError extends Error {
  readonly permanent: boolean;
  readonly output: unknown;

  constructor(message: string, options: { permanent?: boolean; output?: unknown } = {}) {
    super(message);
    this.name = "TaskError";
    this.permanent = options.permanent ?? false;
    this.output = options.output;
  }
}

/** A failure retrying cannot fix. */
export function permanentFailure(message: string, output?: unknown): TaskError {
  return new TaskError(message, { permanent: true, output });
}

/** Matched by shape so an error that crossed a module boundary still counts. */
export function isPermanentFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "TaskError" &&
    (err as { permanent?: unknown }).permanent === true
  );
}

export function failureOutput(err: unknown): unknown {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TaskError"
    ? (err as { output?: unknown }).output
    : undefined;
}

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}
