/**
 * Every URL the web prints for a customer to copy, built from what the API
 * returned or from this build's own configuration - never from a hostname
 * written into a component. Pure: the callers pass the env values in, so the
 * unconfigured cases are testable.
 */

function trimBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

/** An API-returned endpoint as a pasteable URL; a host-relative one resolves against `apiBase`. */
function resolveAgainst(apiBase: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${trimBase(apiBase)}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

export interface DeploymentSnippetInput {
  /** `Deployment.endpoint` exactly as the API returned it: the full chat-completions URL, or null when not running. */
  endpoint: string | null;
  slug: string;
  /** The API origin this app talks to (API_BASE_URL). */
  apiBase: string;
  temperature: number;
  maxTokens: number;
}

export interface DeploymentSnippets {
  /** POST target: `<api>/v1/<slug>/chat/completions`. */
  endpointUrl: string;
  /** `base_url` for an OpenAI client: `<api>/v1`, with the slug as `model`. */
  baseUrl: string;
  model: string;
  curl: string;
  python: string;
  javascript: string;
}

/**
 * Copy-paste examples for a model deployment. The API's `endpoint` already
 * ends in /chat/completions, so curl posts to it as is; an OpenAI client
 * appends /chat/completions itself, so it gets the unified /v1 base and names
 * the deployment by slug in `model` (routes/openaiV1.ts). Returns null when
 * the deployment has no endpoint: nothing is served, so nothing is shown.
 */
export function deploymentSnippets(input: DeploymentSnippetInput): DeploymentSnippets | null {
  if (!input.endpoint) return null;

  const endpointUrl = resolveAgainst(input.apiBase, input.endpoint);
  const suffix = /\/[^/]+\/chat\/completions\/?$/;
  const baseUrl = suffix.test(endpointUrl)
    ? endpointUrl.replace(suffix, "")
    : `${trimBase(input.apiBase)}/v1`;
  const model = input.slug;

  const curl = `curl ${endpointUrl} \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "messages": [
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": ${input.temperature},
  "max_tokens": ${input.maxTokens}
}'`;

  const python = `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="YOUR_API_KEY"
)

response = client.chat.completions.create(
    model="${model}",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
    temperature=${input.temperature},
    max_tokens=${input.maxTokens}
)`;

  const javascript = `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${baseUrl}',
  apiKey: 'YOUR_API_KEY'
});

const response = await client.chat.completions.create({
  model: '${model}',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  temperature: ${input.temperature},
  max_tokens: ${input.maxTokens}
});`;

  return { endpointUrl, baseUrl, model, curl, python, javascript };
}

/**
 * A deployment's chat-completions URL for display: the one the API returned
 * (absolute when the API knows its public address, host-relative otherwise),
 * or, for a row that carries none, the path on the API host this app talks to.
 */
export function deploymentEndpointUrl(apiBase: string, endpoint: string | null | undefined, slug: string): string {
  return resolveAgainst(apiBase, endpoint || `/v1/${encodeURIComponent(slug)}/chat/completions`);
}

/** The unified OpenAI base of the API this app talks to: `<api>/v1`. */
export function unifiedOpenAiBase(apiBase: string): string {
  return `${trimBase(apiBase)}/v1`;
}

/**
 * The API-keys page's usage example: the unified base, where `model` picks
 * an agent, a workflow or a model deployment.
 */
export function unifiedApiSnippets(apiBase: string): { curl: string; python: string } {
  const baseUrl = unifiedOpenAiBase(apiBase);
  return {
    curl: `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "agent/your-agent",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
    python: `from openai import OpenAI

client = OpenAI(base_url="${baseUrl}", api_key="YOUR_API_KEY")

print([m.id for m in client.models.list()])   # your agents, workflows and running deployments

reply = client.chat.completions.create(
    model="agent/your-agent",                 # or workflow/<slug>, or a deployment slug
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)`,
  };
}

export interface WorkflowSnippetInput {
  /** `Orchestration.apiEndpoint` as the API returned it; null when PUBLIC_API_URL is unset. */
  apiEndpoint: string | null;
  /** `Orchestration.openaiBaseUrl`: `<api>/v1/workflows/<slug>`. */
  openaiBaseUrl: string | null;
  /** `Orchestration.openaiModel`: `workflow/<slug>`. */
  openaiModel: string;
  /** The workflow's time limit, ms: a client must be willing to wait this long. */
  timeoutMs: number;
}

export interface WorkflowSnippets {
  curl: string;
  node: string;
  python: string;
  /** Seconds a client should allow: the time limit plus the queue allowance. */
  clientTimeoutSeconds: number;
}

/**
 * Copy-paste examples for a workflow's OpenAI-compatible endpoint, built
 * from what the API returned. Null when the API returned no endpoint: the
 * page then says the address is not configured instead of guessing one.
 *
 * A client's own timeout is set past the workflow's time limit, because a
 * client that gives up first disconnects, and a disconnect cancels the run.
 */
export function workflowSnippets(input: WorkflowSnippetInput): WorkflowSnippets | null {
  if (!input.apiEndpoint || !input.openaiBaseUrl) return null;
  const clientTimeoutSeconds = Math.ceil(input.timeoutMs / 1000) + 60;

  const curl = `curl ${input.apiEndpoint} \\
  --max-time ${clientTimeoutSeconds} \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages": [{"role": "user", "content": "Your input for this run"}]
  }'`;

  const node = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${input.openaiBaseUrl}",
  apiKey: process.env.WHEELSAI_API_KEY,
  timeout: ${clientTimeoutSeconds} * 1000, // past the workflow's time limit
  maxRetries: 0,                 // a repeat is a new run
});

// One request is one run. With stream: true the connection stays open while
// the run works, and the answer arrives as chunks when it finishes.
const stream = await client.chat.completions.create({
  model: "${input.openaiModel}",
  messages: [{ role: "user", content: "Your input for this run" }],
  stream: true,
  stream_options: { include_usage: true },
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}`;

  const python = `import os
from openai import OpenAI

client = OpenAI(
    base_url="${input.openaiBaseUrl}",
    api_key=os.environ["WHEELSAI_API_KEY"],
    timeout=${clientTimeoutSeconds},  # past the workflow's time limit
    max_retries=0,   # a repeat is a new run
)

reply = client.chat.completions.create(
    model="${input.openaiModel}",
    messages=[{"role": "user", "content": "Your input for this run"}],
)
print(reply.choices[0].message.content)
print(reply.usage)  # summed over the steps; None when a step reported none`;

  return { curl, node, python, clientTimeoutSeconds };
}

/**
 * The shape of a deployment's endpoint before it exists. The slug is derived
 * by the server on create (and made unique per organization), so a preview
 * can only show where it goes, not guess it from the typed name.
 */
export function deploymentEndpointPattern(apiBase: string): string {
  return `${trimBase(apiBase)}/v1/<slug>/chat/completions`;
}

/** Shown on the public landing page when the build has no NEXT_PUBLIC_API_URL: a placeholder, not a developer's localhost. */
export const UNCONFIGURED_API_HOST = "https://<your-api-host>";

/**
 * The endpoint line of the landing page's `wheelsai deploy` mock: the real
 * /v1 agent shape on the API this site is configured against.
 */
export function landingAgentEndpoint(apiUrl: string | undefined, agentSlug: string): string {
  const base = apiUrl && apiUrl.trim().length > 0 ? trimBase(apiUrl) : UNCONFIGURED_API_HOST;
  return `${base}/v1/agents/${agentSlug}/chat/completions`;
}

/**
 * Where a listing lives on this site: its own origin when the build knows it
 * (NEXT_PUBLIC_APP_URL), otherwise the path alone. Never a domain this
 * deployment may not own.
 */
export function landingMarketplaceUrl(appUrl: string | undefined, listingSlug: string): string {
  const path = `/marketplace/${listingSlug}`;
  if (!appUrl || appUrl.trim().length === 0) return path;
  return `${trimBase(appUrl)}${path}`;
}

/**
 * metadataBase for the root layout. Undefined when NEXT_PUBLIC_APP_URL is
 * unset or not a URL: Next then resolves Open Graph URLs against the host it
 * is served from, which is true, where a hardcoded fallback domain is not.
 */
export function siteMetadataBase(appUrl: string | undefined): URL | undefined {
  if (!appUrl || appUrl.trim().length === 0) return undefined;
  try {
    return new URL(appUrl.trim());
  } catch {
    return undefined;
  }
}
