/**
 * The URLs a customer calls, built from PUBLIC_API_URL and nothing else.
 *
 * Pure: every builder takes the configured base as an argument, so the rule
 * "an endpoint is our own API host or it is not shown" is testable without
 * the environment.
 *
 * An agent's endpoint used to be `https://agents.wheelsai.io/<slug>`, a host
 * nothing serves, written at Nosana submit time. Agents are served by this
 * API at /v1/agents/<slug>, so their endpoint is computed on read from the
 * configured base. When PUBLIC_API_URL is not set there is no honest absolute
 * URL to print: the agent builders return null and the UI says the endpoint
 * is not configured.
 */

/** PUBLIC_API_URL without trailing slashes, or null when it is not set. */
export function apiBase(publicApiUrl: string | null | undefined): string | null {
  const base = (publicApiUrl ?? "").trim().replace(/\/+$/, "");
  return base.length > 0 ? base : null;
}

const segment = (slug: string) => encodeURIComponent(slug);

/**
 * A model deployment's OpenAI-compatible endpoint (routes/inference.ts).
 * Host-relative when PUBLIC_API_URL is unset: the shape the deployment routes
 * have always returned, kept so clients can resolve it against the API host
 * they already talk to.
 */
export function deploymentEndpoint(slug: string, publicApiUrl: string | null | undefined): string {
  return `${apiBase(publicApiUrl) ?? ""}/v1/${segment(slug)}/chat/completions`;
}

/** The one base URL an OpenAI client can be pointed at: `<api>/v1`. */
export function openAiBaseUrl(publicApiUrl: string | null | undefined): string | null {
  const base = apiBase(publicApiUrl);
  return base === null ? null : `${base}/v1`;
}

/** An OpenAI client's base URL for ONE agent: `<api>/v1/agents/<slug>`. */
export function agentOpenAiBaseUrl(
  slug: string,
  publicApiUrl: string | null | undefined,
): string | null {
  const base = openAiBaseUrl(publicApiUrl);
  return base === null ? null : `${base}/agents/${segment(slug)}`;
}

/** The agent's chat-completions URL: `<api>/v1/agents/<slug>/chat/completions`. */
export function agentEndpoint(slug: string, publicApiUrl: string | null | undefined): string | null {
  const base = agentOpenAiBaseUrl(slug, publicApiUrl);
  return base === null ? null : `${base}/chat/completions`;
}

/** The `model` id that selects this agent on the unified `<api>/v1` base. */
export function agentOpenAiModel(slug: string): string {
  return `agent/${slug}`;
}

/** An OpenAI client's base URL for ONE workflow: `<api>/v1/workflows/<slug>`. */
export function workflowOpenAiBaseUrl(
  slug: string,
  publicApiUrl: string | null | undefined,
): string | null {
  const base = openAiBaseUrl(publicApiUrl);
  return base === null ? null : `${base}/workflows/${segment(slug)}`;
}

/** A workflow's chat-completions URL: `<api>/v1/workflows/<slug>/chat/completions`. */
export function workflowEndpoint(
  slug: string,
  publicApiUrl: string | null | undefined,
): string | null {
  const base = workflowOpenAiBaseUrl(slug, publicApiUrl);
  return base === null ? null : `${base}/chat/completions`;
}

/** The `model` id that selects this workflow on the unified `<api>/v1` base. */
export function workflowOpenAiModel(slug: string): string {
  return `workflow/${slug}`;
}

export interface WorkflowApiEndpoints {
  /** null when PUBLIC_API_URL is not configured. */
  apiEndpoint: string | null;
  openaiBaseUrl: string | null;
  openaiModel: string;
}

/** The API fields every workflow read carries. */
export function workflowApiEndpoints(
  slug: string,
  publicApiUrl: string | null | undefined,
): WorkflowApiEndpoints {
  return {
    apiEndpoint: workflowEndpoint(slug, publicApiUrl),
    openaiBaseUrl: workflowOpenAiBaseUrl(slug, publicApiUrl),
    openaiModel: workflowOpenAiModel(slug),
  };
}

export interface AgentApiEndpoints {
  /** null when PUBLIC_API_URL is not configured. */
  apiEndpoint: string | null;
  openaiBaseUrl: string | null;
  openaiModel: string;
}

/** The API fields every agent read carries. */
export function agentApiEndpoints(
  slug: string,
  publicApiUrl: string | null | undefined,
): AgentApiEndpoints {
  return {
    apiEndpoint: agentEndpoint(slug, publicApiUrl),
    openaiBaseUrl: agentOpenAiBaseUrl(slug, publicApiUrl),
    openaiModel: agentOpenAiModel(slug),
  };
}

/**
 * An agent deployment as the API returns it. `endpoint` is never the stored
 * column (old rows held the fabricated host) and never a raw node URL: a
 * running deployment shows the agent's /v1 endpoint, anything else shows none.
 */
export function serializeAgentDeployment<T extends { status: string; endpoint?: unknown }>(
  row: T,
  slug: string,
  publicApiUrl: string | null | undefined,
): Omit<T, "endpoint"> & { endpoint: string | null } {
  return {
    ...row,
    endpoint: row.status === "running" ? agentEndpoint(slug, publicApiUrl) : null,
  };
}
