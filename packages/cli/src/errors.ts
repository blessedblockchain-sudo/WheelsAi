import { WheelsAIError } from "@wheelsai/sdk";

import { clean } from "./lib/terminal.js";

/** A failure with a message meant for the terminal. `hint` says what to do next. */
export class CliError extends Error {
  /** Dim technical detail under the message, e.g. `HTTP 400 validation_failed`. */
  readonly detail?: string;
  readonly hint?: string;
  readonly exitCode: number;

  constructor(message: string, options: { hint?: string; detail?: string; exitCode?: number } = {}) {
    super(message);
    this.name = "CliError";
    this.hint = options.hint;
    this.detail = options.detail;
    this.exitCode = options.exitCode ?? 1;
  }
}

export interface DescribedError {
  message: string;
  /** Dim technical detail: HTTP status and the API's error code. */
  detail?: string;
  hint?: string;
}

export interface ErrorContext {
  webUrl?: string;
  /** Where the credential in use came from, to point a 401 at the right place to fix it. */
  credentialSource?: "env" | "config" | "none";
}

/** What to do about a 429: the API uses it for two quotas as well as for its rate limit. */
function tooManyRequestsHint(err: WheelsAIError, context: ErrorContext): string {
  if (err.code === "plan_limit_reached") {
    const upgradeUrl = (err.data as { upgradeUrl?: unknown } | null)?.upgradeUrl;
    const where =
      context.webUrl && typeof upgradeUrl === "string" && upgradeUrl.startsWith("/") ? ` Upgrade at ${context.webUrl}${upgradeUrl}` : "";
    return `Your plan's monthly allowance is used up, so retrying will not help until it resets.${where}`;
  }
  if (err.code === "deployment_quota_exceeded") {
    return "Your organization is at its limit of active deployments. Stop one you no longer need, then retry.";
  }
  return "The API is rate limiting requests. Wait a minute, then retry.";
}

/**
 * A 400 `validation_failed` names each field that needs another look in `fields` (field name to a
 * plain sentence). The first problem is already the message; the others follow it, one line each.
 */
function fieldLines(err: WheelsAIError): string[] {
  const fields = (err.data as { fields?: unknown } | null)?.fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return [];
  const lines: string[] = [];
  for (const [name, sentence] of Object.entries(fields)) {
    if (typeof sentence !== "string" || sentence === "" || sentence === err.message) continue;
    lines.push(`  ${clean(name)}: ${clean(sentence)}`);
  }
  return lines;
}

/** Turn anything thrown into terminal text. API messages are passed through, minus control characters. */
export function describeError(err: unknown, context: ErrorContext = {}): DescribedError {
  if (err instanceof CliError) {
    return { message: err.message, ...(err.detail && { detail: err.detail }), hint: err.hint };
  }

  if (err instanceof WheelsAIError) {
    const detail =
      err.status > 0 ? [`HTTP ${err.status}`, clean(err.code)].filter(Boolean).join(" ") : undefined;
    let hint: string | undefined;
    if (err.status === 401) {
      hint =
        context.credentialSource === "env"
          ? "The credential comes from WHEELSAI_API_KEY / WHEELSAI_TOKEN in your environment, and the API rejected it."
          : "Your credentials were rejected or have expired. Run `wheelsai login`.";
    } else if (err.status === 402 && context.webUrl) {
      hint = `Add credits at ${context.webUrl}/dashboard/billing`;
    } else if (err.status === 429) {
      hint = tooManyRequestsHint(err, context);
    } else if (err.status === 0) {
      hint = "Check the API URL with `wheelsai config show`.";
    }
    return { message: [clean(err.message), ...fieldLines(err)].join("\n"), detail, hint };
  }

  return { message: clean(err instanceof Error ? err.message : String(err)) };
}
