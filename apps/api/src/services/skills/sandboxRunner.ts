/**
 * Code-execution sandbox client.
 *
 * THE API PROCESS NEVER EXECUTES USER OR MODEL CODE, in any form. (A
 * previous `new Function()` in the test runner was a remote-code-execution
 * hole.) Code execution is a call to an EXTERNAL runner - an isolated
 * container on infrastructure the platform does not trust the code with -
 * made through the SSRF guard. With no runner configured every caller gets an
 * honest "unavailable", never a pretend result.
 *
 * ---------------------------------------------------------------------------
 * Runner HTTP contract  (build a Nosana-hosted runner to this)
 * ---------------------------------------------------------------------------
 *
 *   POST <SANDBOX_RUNNER_URL>                      (the URL is used as given)
 *   Content-Type: application/json
 *   Accept: application/json
 *   Authorization: Bearer <SANDBOX_RUNNER_TOKEN>   (only when a token is set)
 *
 *   Request body
 *     {
 *       "language": "python" | "javascript" | ...,  // one of SANDBOX_LANGUAGES
 *       "code":     "print(1 + 1)",                 // UTF-8 source, <= 64 KiB
 *       "stdin":    "optional text fed to stdin",   // omitted when empty
 *       "limits": {
 *         "timeoutMs":      15000,   // wall clock; runner MUST kill at this
 *         "maxOutputBytes": 65536    // per stream; runner MUST truncate here
 *       }
 *     }
 *
 *   Response: 200 with application/json
 *     {
 *       "exitCode":   0,            // integer; null when killed / timed out
 *       "stdout":     "2\n",        // string
 *       "stderr":     "",           // string
 *       "timedOut":   false,        // optional, default false
 *       "truncated":  false,        // optional: output was cut at the limit
 *       "durationMs": 41            // optional
 *     }
 *   Any other status is treated as a runner failure (the body, clipped, goes
 *   into the error). A user-program failure is NOT an HTTP error: a script
 *   that raises returns 200 with a non-zero exitCode and its stderr.
 *
 *   Runner obligations (the API cannot enforce these - it only calls you):
 *     - a FRESH, isolated sandbox per request; nothing persists between runs
 *     - no network egress (or a strict allowlist) and no route to cloud
 *       metadata, the API, Postgres or Redis
 *     - read-only root filesystem, small writable tmpfs, unprivileged user
 *     - CPU, memory and process-count limits; kill the whole tree on timeout
 *     - never echo the bearer token into the sandbox
 *
 *   The API side: the call goes through safeFetch (public addresses only,
 *   redirects NOT followed so the bearer token cannot be bounced to a third
 *   party), has a timeout of limits.timeoutMs + 5 s, caps the response size,
 *   and re-truncates stdout/stderr to maxOutputBytes whatever the runner sent.
 */

import { z } from "zod";

import type { SandboxConfig } from "../../config/skills.js";
import { safeFetch, type UrlGuardDeps } from "../../lib/ssrfGuard.js";
import { clipText, readBodyCapped } from "./httpLimits.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("sandbox-runner");

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SandboxRunOptions {
  stdin?: string;
  signal?: AbortSignal;
}

export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number | null;
}

export interface SandboxRunner {
  /** Languages the runner accepts (from SANDBOX_LANGUAGES). */
  readonly languages: readonly string[];
  /** The operator's ceiling; per-call limits are clamped to it. */
  readonly limits: SandboxLimits;
  run(
    language: string,
    code: string,
    limits: SandboxLimits,
    options?: SandboxRunOptions,
  ): Promise<SandboxResult>;
}

/** The runner could not be reached, refused, or broke the contract. */
export class SandboxError extends Error {}

/** Largest source the API will send to a runner. */
export const MAX_SANDBOX_CODE_BYTES = 64 * 1024;

/** Extra time on top of the run budget for the network round trip. */
const NETWORK_GRACE_MS = 5_000;

const responseSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  timedOut: z.boolean().default(false),
  truncated: z.boolean().default(false),
  durationMs: z.number().nullable().optional(),
});

function truncateUtf8(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, cut: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), cut: true };
}

export interface HttpSandboxRunnerDeps {
  /** Injected for tests; defaults to the real SSRF-guarded fetch. */
  fetchImpl?: typeof fetch;
  guardDeps?: UrlGuardDeps;
}

export class HttpSandboxRunner implements SandboxRunner {
  readonly languages: readonly string[];
  readonly limits: SandboxLimits;

  constructor(
    private readonly config: SandboxConfig,
    private readonly deps: HttpSandboxRunnerDeps = {},
  ) {
    this.languages = config.languages;
    this.limits = { timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes };
  }

  async run(
    language: string,
    code: string,
    limits: SandboxLimits,
    options: SandboxRunOptions = {},
  ): Promise<SandboxResult> {
    const lang = language.trim().toLowerCase();
    if (!this.languages.includes(lang)) {
      throw new SandboxError(
        `language "${language}" is not enabled on this sandbox (enabled: ${this.languages.join(", ")})`,
      );
    }
    if (code.trim().length === 0) {
      throw new SandboxError("no code to run");
    }
    if (Buffer.byteLength(code, "utf8") > MAX_SANDBOX_CODE_BYTES) {
      throw new SandboxError(`code is larger than ${MAX_SANDBOX_CODE_BYTES} bytes`);
    }

    // The operator's configuration is a ceiling, never a floor a caller can
    // raise by asking.
    const effective: SandboxLimits = {
      timeoutMs: Math.max(1_000, Math.min(limits.timeoutMs, this.limits.timeoutMs)),
      maxOutputBytes: Math.max(
        1_024,
        Math.min(limits.maxOutputBytes, this.limits.maxOutputBytes),
      ),
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;

    const payload: Record<string, unknown> = {
      language: lang,
      code,
      limits: effective,
    };
    if (options.stdin) payload.stdin = options.stdin;

    let res: Response;
    try {
      res = await safeFetch(this.config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        timeoutMs: effective.timeoutMs + NETWORK_GRACE_MS,
        // The bearer token must not follow a redirect to another host.
        maxRedirects: 0,
        signal: options.signal,
        fetchImpl: this.deps.fetchImpl,
        guardDeps: this.deps.guardDeps,
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      // The detail (which address the URL resolved to, why it was refused)
      // describes the operator's infrastructure; it is logged, not returned.
      logger.warn({ err }, "sandbox runner unreachable");
      throw new SandboxError("sandbox runner unreachable");
    }

    const body = await readBodyCapped(res, {
      maxBytes: effective.maxOutputBytes * 8 + 16_384,
      timeoutMs: effective.timeoutMs + NETWORK_GRACE_MS,
      signal: options.signal,
    });

    if (!res.ok) {
      // The runner's error body can carry stack traces and host details.
      logger.warn(
        { status: res.status, body: clipText(body.text, 500) },
        "sandbox runner returned an error status",
      );
      throw new SandboxError(`sandbox runner returned HTTP ${res.status}`);
    }
    if (body.truncated) {
      throw new SandboxError("sandbox runner response exceeded the size limit");
    }

    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      throw new SandboxError("sandbox runner returned a response that is not JSON");
    }
    const parsed = responseSchema.safeParse(json);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "sandbox runner response violates the contract");
      throw new SandboxError("sandbox runner response does not match the contract");
    }

    const stdout = truncateUtf8(parsed.data.stdout, effective.maxOutputBytes);
    const stderr = truncateUtf8(parsed.data.stderr, effective.maxOutputBytes);
    return {
      exitCode: parsed.data.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut: parsed.data.timedOut,
      truncated: parsed.data.truncated || stdout.cut || stderr.cut,
      durationMs: parsed.data.durationMs ?? null,
    };
  }
}

/** The configured runner, or null when code execution is not configured. */
export function createSandboxRunner(
  config: SandboxConfig | null,
  deps: HttpSandboxRunnerDeps = {},
): SandboxRunner | null {
  return config ? new HttpSandboxRunner(config, deps) : null;
}
