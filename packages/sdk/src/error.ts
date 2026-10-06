/**
 * Thrown for every failed request: a non-2xx response (status is the HTTP
 * status), a network failure or a timeout (status is 0).
 */
export class WheelsAIError extends Error {
  /** HTTP status, or 0 when no response was received (network error, timeout). */
  status: number;
  /** The parsed response body (JSON object, text, or null). */
  data: unknown;
  /** The API's machine-readable `error` code when it sent one, e.g. `insufficient_credits`. */
  code?: string;

  constructor(status: number, message: string, data?: unknown, code?: string) {
    super(message);
    this.name = "WheelsAIError";
    this.status = status;
    this.data = data;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten zod's `{ fieldErrors, formErrors }` (sent with `validation_failed`) into one line. */
function describeDetails(details: unknown): string | null {
  if (!isRecord(details)) return null;
  const parts: string[] = [];
  const formErrors = details.formErrors;
  if (Array.isArray(formErrors)) {
    for (const message of formErrors) if (typeof message === "string") parts.push(message);
  }
  const fieldErrors = details.fieldErrors;
  if (isRecord(fieldErrors)) {
    for (const [field, messages] of Object.entries(fieldErrors)) {
      if (Array.isArray(messages) && messages.length > 0) {
        parts.push(`${field}: ${messages.filter((m) => typeof m === "string").join(", ")}`);
      }
    }
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * The API answers errors in a few shapes: `{ error, message }`, `{ error }`,
 * `{ success: false, error }` (graph routes) and zod's
 * `{ error: "validation_failed", details }`. Pick the most useful text.
 */
export function extractErrorInfo(
  data: unknown,
  fallback: string,
): { message: string; code?: string } {
  if (typeof data === "string") {
    const text = data.trim();
    return { message: text && text.length <= 300 && !text.startsWith("<") ? text : fallback };
  }
  if (!isRecord(data)) return { message: fallback };

  const apiError = data.error;
  const apiMessage = data.message;
  const detail = describeDetails(data.details);

  if (typeof apiMessage === "string" && apiMessage) {
    return { message: apiMessage, code: typeof apiError === "string" ? apiError : undefined };
  }
  if (typeof apiError === "string" && apiError) {
    return { message: detail ? `${apiError}: ${detail}` : apiError, code: apiError };
  }
  if (isRecord(apiError) && typeof apiError.message === "string") {
    return { message: apiError.message };
  }
  return { message: detail ?? fallback };
}
