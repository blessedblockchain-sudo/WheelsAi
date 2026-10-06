/**
 * Errors a workflow request can end in, each with the HTTP status and the
 * machine-readable code the API contract names. Services throw these;
 * the route turns one into `{ error: code, message, ...extra }`. Anything
 * else a service throws is unexpected and goes to the global handler as
 * a logged 500.
 */

export type WorkflowErrorCode =
  | "not_found"
  | "invalid_workflow"
  | "name_taken"
  | "stale_definition"
  | "workflow_disabled"
  | "input_schema_mismatch"
  | "workflow_run_limit"
  | "workflow_runner_disabled"
  | "workflow_queue_unavailable"
  | "execution_finished";

const STATUS: Record<WorkflowErrorCode, number> = {
  not_found: 404,
  invalid_workflow: 400,
  name_taken: 409,
  stale_definition: 409,
  workflow_disabled: 409,
  input_schema_mismatch: 400,
  workflow_run_limit: 429,
  workflow_runner_disabled: 501,
  workflow_queue_unavailable: 503,
  execution_finished: 409,
};

export class WorkflowError extends Error {
  readonly status: number;

  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
    /** Extra fields for the response body (step, field, limit, ...). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkflowError";
    this.status = STATUS[code];
  }
}

/** A Prisma unique-constraint violation, recognised without importing Prisma. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}
