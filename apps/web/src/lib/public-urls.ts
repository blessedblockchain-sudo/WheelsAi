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

/** The environment variable every snippet of a listing's API page reads the key from. A key is never written into a snippet. */
export const API_KEY_ENV = "WHEELSAI_API_KEY";

/** The three snippets of a listing's API page, and the address they post to. */
export interface PaidAgentSnippets {
  /** The full address a request is posted to. */
  endpointUrl: string;
  curl: string;
  javascript: string;
  python: string;
}

export interface PaidAgentChatSnippetInput {
  /** The base address of the API, as the API page's data gave it or as this app reaches it. */
  baseUrl: string;
  /** The model id the API page's data gave: `a/<handle>`. */
  model: string;
}

/**
 * Copy-paste examples for a paid agent that answers messages: OpenAI's chat
 * completions on the unified /v1 base, with the listing's own model id. Built
 * from the API page's data and nothing else: the owner's own card names the
 * agent another way, which a buyer's key cannot call.
 *
 * curl prints the answer's headers too (-i), where what the use cost and
 * what is left are told.
 */
export function paidAgentChatSnippets(input: PaidAgentChatSnippetInput): PaidAgentSnippets {
  const baseUrl = unifiedOpenAiBase(input.baseUrl);
  const endpointUrl = `${baseUrl}/chat/completions`;

  const curl = `curl -i ${endpointUrl} \\
  -H "Authorization: Bearer $${API_KEY_ENV}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${input.model}",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;

  const javascript = `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: process.env.${API_KEY_ENV},
});

const reply = await client.chat.completions.create({
  model: "${input.model}",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(reply.choices[0].message.content);`;

  const python = `import os
from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key=os.environ["${API_KEY_ENV}"],
)

reply = client.chat.completions.create(
    model="${input.model}",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(reply.choices[0].message.content)`;

  return { endpointUrl, curl, javascript, python };
}

export interface PaidAgentRunSnippetInput {
  /** The base address of the API, as the API page's data gave it or as this app reaches it. */
  baseUrl: string;
  /** The run address under the base, as the API page's data gave it: `/api/a/<handle>/run` or `/api/w/<slug>/run`. */
  path: string;
  /**
   * What is run: an agent unless it says. A workflow on sale is run at its own address
   * (`/api/w/<slug>/run`), whose body is the input and nothing else: it always answers one JSON
   * body and refuses any other field, `stream` included. Its comment speaks of the workflow's form.
   */
  subject?: "agent" | "workflow";
}

/**
 * Copy-paste examples for a paid agent that does one task from a form: its
 * own run address, sent the form's answers as `input`. The API page's data
 * does not carry the form, so the answers are a placeholder the caller fills
 * in from the agent's page.
 *
 * A run streams its answer unless it is told not to, so every snippet sends
 * `stream: false` and reads one JSON answer.
 */
export function paidAgentRunSnippets(input: PaidAgentRunSnippetInput): PaidAgentSnippets {
  const endpointUrl = resolveAgainst(input.baseUrl, input.path);
  if (input.subject === "workflow") return paidWorkflowRunSnippets(endpointUrl);

  const curl = `curl -i ${endpointUrl} \\
  -H "Authorization: Bearer $${API_KEY_ENV}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "input": {"field_name": "Your answer"},
    "stream": false
  }'`;

  const javascript = `const response = await fetch("${endpointUrl}", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.${API_KEY_ENV},
    "Content-Type": "application/json",
  },
  // One answer for each question of the agent's form, by the question's name.
  body: JSON.stringify({ input: { field_name: "Your answer" }, stream: false }),
});

const result = await response.json();
console.log(result.output);`;

  const python = `import json
import os
import urllib.request

request = urllib.request.Request(
    "${endpointUrl}",
    method="POST",
    headers={
        "Authorization": "Bearer " + os.environ["${API_KEY_ENV}"],
        "Content-Type": "application/json",
    },
    # One answer for each question of the agent's form, by the question's name.
    data=json.dumps({"input": {"field_name": "Your answer"}, "stream": False}).encode(),
)

with urllib.request.urlopen(request) as response:
    result = json.load(response)
print(result["output"])`;

  return { endpointUrl, curl, javascript, python };
}

/** The same for a workflow on sale: the body is `input` alone, and the answer is always one JSON body. */
function paidWorkflowRunSnippets(endpointUrl: string): PaidAgentSnippets {
  const curl = `curl -i ${endpointUrl} \\
  -H "Authorization: Bearer $${API_KEY_ENV}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "input": {"field_name": "Your answer"}
  }'`;

  const javascript = `const response = await fetch("${endpointUrl}", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.${API_KEY_ENV},
    "Content-Type": "application/json",
  },
  // One answer for each question of the workflow's form, by the question's name.
  body: JSON.stringify({ input: { field_name: "Your answer" } }),
});

const result = await response.json();
console.log(result.output);`;

  const python = `import json
import os
import urllib.request

request = urllib.request.Request(
    "${endpointUrl}",
    method="POST",
    headers={
        "Authorization": "Bearer " + os.environ["${API_KEY_ENV}"],
        "Content-Type": "application/json",
    },
    # One answer for each question of the workflow's form, by the question's name.
    data=json.dumps({"input": {"field_name": "Your answer"}}).encode(),
)

with urllib.request.urlopen(request) as response:
    result = json.load(response)
print(result["output"])`;

  return { endpointUrl, curl, javascript, python };
}

export interface X402ChallengeSnippetInput {
  /** The full address the request is posted to: the one the key's snippets call. */
  endpointUrl: string;
  /** The JSON body, the one the key's snippets send. */
  body: Record<string, unknown>;
}

/**
 * The first call of a use paid from a Solana wallet, with no key: a curl
 * with no Authorization header that prints the answer's headers (-i), so the
 * 402 and its PAYMENT-REQUIRED header show. Paying and sending the same
 * request again with PAYMENT-SIGNATURE is the work of an x402 client
 * library: a payment is never signed by hand in a snippet.
 *
 * The body is written as JSON a terminal takes: ASCII only, and a single
 * quote closed and reopened around, so the shell's quoting holds.
 */
export function x402ChallengeSnippet(input: X402ChallengeSnippetInput): string {
  const json = JSON.stringify(input.body, null, 2)
    .replace(/[^\x20-\x7e\n]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/'/g, "'\\''")
    .replace(/\n/g, "\n  ");
  return `curl -i ${input.endpointUrl} \\
  -H "Content-Type: application/json" \\
  -d '${json}'`;
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
