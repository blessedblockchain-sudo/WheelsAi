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
