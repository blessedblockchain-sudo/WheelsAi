/**
 * Configuration for agent skills (tools): web search, the code sandbox and
 * per-agent file storage limits.
 *
 * This module parses its OWN environment variables (it deliberately does not
 * extend config/env.ts) so the skills can be configured, tested and reasoned
 * about on their own. Every variable is optional. A skill whose provider is
 * not configured is reported as UNAVAILABLE (with a reason) to the model and
 * to the UI - it never returns made-up output.
 *
 * Environment variables
 * ---------------------
 *
 * TAVILY_API_KEY                      (optional; enables `web_search`)
 *   API key for Tavily (https://tavily.com), the search API behind
 *   `web_search`. Tavily was picked over Brave Search because it returns
 *   LLM-ready page excerpts in one call (no second fetch per result) and has a
 *   free tier that covers development. Unset => `web_search` answers
 *   "unavailable: web search is not configured on this server".
 *
 * SANDBOX_RUNNER_URL                  (optional; enables `code_interpreter` and
 *                                      the graph `code` node)
 *   Full URL of an EXTERNAL code-execution runner (http/https). The API never
 *   executes user or model code itself. The runner must implement the HTTP
 *   contract documented in services/skills/sandboxRunner.ts. The call goes
 *   through the SSRF guard, so the runner must be reachable at a PUBLIC
 *   address (a Nosana-hosted job, for example); a loopback/private address is
 *   refused by design. Redirects are not followed. Unset => code execution is
 *   "unavailable: code execution sandbox is not configured".
 *
 * SANDBOX_RUNNER_TOKEN                (optional)
 *   Sent as `Authorization: Bearer <token>` to the runner. Strongly
 *   recommended whenever the runner is reachable from the internet.
 *
 * SANDBOX_LANGUAGES                   (default "python,javascript")
 *   Comma-separated languages the runner accepts. Anything else is refused
 *   before a request is made.
 *
 * SANDBOX_TIMEOUT_MS                  (default 15000, range 1000..120000)
 *   Wall-clock limit per run. Sent to the runner as `limits.timeoutMs`; the
 *   API also enforces it (plus a small network grace) on its own side.
 *
 * SANDBOX_MAX_OUTPUT_BYTES            (default 65536, range 1024..1048576)
 *   Cap on stdout and on stderr each. Sent to the runner as
 *   `limits.maxOutputBytes`; the API truncates anything the runner sends
 *   beyond it.
 *
 * AGENT_FILES_MAX_BYTES               (default 1048576 = 1 MiB, range 1..10485760)
 *   Largest single file `file_write` will store.
 *
 * AGENT_FILES_MAX_COUNT               (default 50, range 1..1000)
 *   Most files one agent may hold.
 *
 * File storage itself reuses the dataset object store, whose variables are
 * already declared in config/env.ts: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * DATASETS_BUCKET (and optionally AWS_REGION). Agent files live under the
 * key prefix `agent-files/<orgId>/<agentId>/`. With those unset, `file_read`
 * and `file_write` answer "unavailable" (services/dataset.ts
 * isDatasetStorageConfigured).
 */

import { z } from "zod";

export class SkillsConfigError extends Error {
  constructor(message: string) {
    super(`Invalid skills configuration: ${message}`);
    this.name = "SkillsConfigError";
  }
}

export interface SandboxConfig {
  url: string;
  token: string | undefined;
  languages: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SkillsConfig {
  /** Tavily key, or undefined when web search is not configured. */
  tavilyApiKey: string | undefined;
  /** Sandbox runner, or null when code execution is not configured. */
  sandbox: SandboxConfig | null;
  agentFiles: {
    maxBytes: number;
    maxCount: number;
  };
}

/** Empty strings in a .env file mean "unset", not "configured as empty". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed ? trimmed : undefined;
  });

const intFromEnv = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const rawSchema = z.object({
  TAVILY_API_KEY: optionalString,
  SANDBOX_RUNNER_URL: optionalString,
  SANDBOX_RUNNER_TOKEN: optionalString,
  SANDBOX_LANGUAGES: z.string().default("python,javascript"),
  SANDBOX_TIMEOUT_MS: intFromEnv(1_000, 120_000).default(15_000),
  SANDBOX_MAX_OUTPUT_BYTES: intFromEnv(1_024, 1_048_576).default(65_536),
  AGENT_FILES_MAX_BYTES: intFromEnv(1, 10_485_760).default(1_048_576),
  AGENT_FILES_MAX_COUNT: intFromEnv(1, 1_000).default(50),
});

const LANGUAGE = /^[a-z][a-z0-9+#-]{0,15}$/;

/**
 * Parses skills configuration from an environment map. Throws
 * SkillsConfigError naming the variable when a value is malformed.
 */
export function loadSkillsConfig(
  source: Record<string, string | undefined> = process.env,
): SkillsConfig {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SkillsConfigError(
      `${issue?.path.join(".") || "value"} ${issue?.message ?? "is invalid"}`,
    );
  }
  const raw = parsed.data;

  let sandbox: SandboxConfig | null = null;
  if (raw.SANDBOX_RUNNER_URL) {
    let url: URL;
    try {
      url = new URL(raw.SANDBOX_RUNNER_URL);
    } catch {
      throw new SkillsConfigError("SANDBOX_RUNNER_URL is not a valid URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SkillsConfigError("SANDBOX_RUNNER_URL must be http or https");
    }
    if (url.username || url.password) {
      throw new SkillsConfigError(
        "SANDBOX_RUNNER_URL must not embed credentials - use SANDBOX_RUNNER_TOKEN",
      );
    }

    const languages = [
      ...new Set(
        raw.SANDBOX_LANGUAGES.split(",")
          .map((l) => l.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (languages.length === 0) {
      throw new SkillsConfigError("SANDBOX_LANGUAGES must list at least one language");
    }
    for (const language of languages) {
      if (!LANGUAGE.test(language)) {
        throw new SkillsConfigError(
          `SANDBOX_LANGUAGES entry '${language}' is not a valid language id`,
        );
      }
    }

    sandbox = {
      url: url.toString(),
      token: raw.SANDBOX_RUNNER_TOKEN,
      languages,
      timeoutMs: raw.SANDBOX_TIMEOUT_MS,
      maxOutputBytes: raw.SANDBOX_MAX_OUTPUT_BYTES,
    };
  }

  return {
    tavilyApiKey: raw.TAVILY_API_KEY,
    sandbox,
    agentFiles: {
      maxBytes: raw.AGENT_FILES_MAX_BYTES,
      maxCount: raw.AGENT_FILES_MAX_COUNT,
    },
  };
}

export interface SkillsConfigState {
  config: SkillsConfig;
  /**
   * Set when the environment was malformed. Every provider is then treated as
   * unconfigured and the registry reports this as the reason: a typo in
   * SANDBOX_RUNNER_URL must read as "misconfigured", not silently work or
   * silently vanish.
   */
  error: string | null;
}

const UNCONFIGURED: SkillsConfig = {
  tavilyApiKey: undefined,
  sandbox: null,
  agentFiles: { maxBytes: 1_048_576, maxCount: 50 },
};

let cached: SkillsConfigState | null = null;

/** Memoised, never-throwing view of the process environment. */
export function getSkillsConfig(): SkillsConfigState {
  if (cached) return cached;
  try {
    cached = { config: loadSkillsConfig(process.env), error: null };
  } catch (err) {
    cached = {
      config: UNCONFIGURED,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return cached;
}

/** Test hook: forget the memoised configuration. */
export function resetSkillsConfigCache(): void {
  cached = null;
}
