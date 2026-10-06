/**
 * The URLs the web prints for a customer to copy. Run with:
 *   cd apps/web && npx tsx --test src/lib/public-urls.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  UNCONFIGURED_API_HOST,
  deploymentEndpointPattern,
  deploymentEndpointUrl,
  deploymentSnippets,
  unifiedApiSnippets,
  unifiedOpenAiBase,
  workflowSnippets,
  landingAgentEndpoint,
  landingMarketplaceUrl,
  siteMetadataBase,
} from "./public-urls";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const base = { slug: "llama-8b", apiBase: "http://localhost:4000", temperature: 0.7, maxTokens: 512 };

test("deployment snippets post to the endpoint the API returned, once", () => {
  const s = deploymentSnippets({
    ...base,
    endpoint: "https://api.example.com/v1/llama-8b/chat/completions",
  });
  assert.ok(s);
  assert.equal(s.endpointUrl, "https://api.example.com/v1/llama-8b/chat/completions");
  assert.match(s.curl, /^curl https:\/\/api\.example\.com\/v1\/llama-8b\/chat\/completions \\\n/);
  for (const text of [s.curl, s.python, s.javascript]) {
    assert.ok(!text.includes("chat/completions/chat/completions"), text);
  }
});

test("OpenAI clients get the unified /v1 base and the slug as model", () => {
  const s = deploymentSnippets({
    ...base,
    endpoint: "https://api.example.com/v1/llama-8b/chat/completions",
  });
  assert.ok(s);
  // The SDK appends /chat/completions itself: base + that must be a served route.
  assert.equal(s.baseUrl, "https://api.example.com/v1");
  assert.equal(s.model, "llama-8b");
  assert.ok(s.python.includes('base_url="https://api.example.com/v1"'));
  assert.ok(s.python.includes('model="llama-8b"'));
  assert.ok(s.javascript.includes("baseURL: 'https://api.example.com/v1'"));
  assert.ok(s.javascript.includes("model: 'llama-8b'"));
  assert.ok(s.python.includes("temperature=0.7") && s.python.includes("max_tokens=512"));
});

test("a host-relative endpoint (PUBLIC_API_URL unset) resolves against the API origin", () => {
  const s = deploymentSnippets({ ...base, apiBase: "http://localhost:4000/", endpoint: "/v1/llama-8b/chat/completions" });
  assert.ok(s);
  assert.equal(s.endpointUrl, "http://localhost:4000/v1/llama-8b/chat/completions");
  assert.equal(s.baseUrl, "http://localhost:4000/v1");
  assert.match(s.curl, /^curl http:\/\/localhost:4000\/v1\//);
});

test("a public URL with a path prefix keeps it in the SDK base", () => {
  const s = deploymentSnippets({ ...base, endpoint: "https://example.com/api/v1/llama-8b/chat/completions" });
  assert.equal(s?.baseUrl, "https://example.com/api/v1");
});

test("no endpoint, no snippets", () => {
  assert.equal(deploymentSnippets({ ...base, endpoint: null }), null);
  assert.equal(deploymentSnippets({ ...base, endpoint: "" }), null);
});

test("the pre-create preview shows the served shape with a slug placeholder", () => {
  assert.equal(
    deploymentEndpointPattern("https://api.example.com/"),
    "https://api.example.com/v1/<slug>/chat/completions"
  );
});

test("landing endpoint: real shape on the configured API, a placeholder host otherwise", () => {
  assert.equal(
    landingAgentEndpoint("https://api.example.com/", "my-support-bot"),
    "https://api.example.com/v1/agents/my-support-bot/chat/completions"
  );
  for (const unset of [undefined, "", "  "]) {
    const line = landingAgentEndpoint(unset, "my-support-bot");
    assert.equal(line, `${UNCONFIGURED_API_HOST}/v1/agents/my-support-bot/chat/completions`);
    assert.ok(!line.includes("localhost"));
  }
});

test("landing marketplace line is on the site's own origin, or the path alone", () => {
  assert.equal(
    landingMarketplaceUrl("https://app.example.com/", "my-support-bot"),
    "https://app.example.com/marketplace/my-support-bot"
  );
  assert.equal(landingMarketplaceUrl(undefined, "my-support-bot"), "/marketplace/my-support-bot");
  assert.equal(landingMarketplaceUrl("", "my-support-bot"), "/marketplace/my-support-bot");
});

test("metadataBase has no fallback domain", () => {
  assert.equal(siteMetadataBase(undefined), undefined);
  assert.equal(siteMetadataBase(""), undefined);
  assert.equal(siteMetadataBase("not a url"), undefined);
  assert.equal(siteMetadataBase("https://app.example.com")?.origin, "https://app.example.com");
});

// Source pins: the pages must go through the helpers, not rebuild the URL.

test("the dashboard playground builds its examples from deploymentSnippets", () => {
  const page = source("app/(dashboard)/dashboard/playground/page.tsx");
  assert.ok(page.includes("deploymentSnippets({"));
  assert.ok(!page.includes(".endpoint}/chat/completions"));
  assert.ok(!/base_?[uU][rR][lL][:=]\s*['"]\$\{/.test(page));
  assert.ok(!page.includes("selectedDeploymentData.model"));
});

test("the new-deployment preview does not build a URL from the typed name", () => {
  const page = source("app/(dashboard)/dashboard/deployments/new/page.tsx");
  assert.ok(page.includes("deploymentEndpointPattern(API_BASE_URL)"));
  assert.ok(!page.includes("/v1/{name}"));
});

test("no hardcoded wheelsai domain is printed by the web", () => {
  const preview = source("components/landing/code-preview.tsx");
  assert.ok(preview.includes("landingAgentEndpoint(process.env.NEXT_PUBLIC_API_URL"));
  assert.ok(preview.includes("landingMarketplaceUrl(process.env.NEXT_PUBLIC_APP_URL"));
  // lib/api's API_BASE_URL falls back to localhost, which a public page must not print.
  assert.ok(!preview.includes("API_BASE_URL"));
  const layout = source("app/layout.tsx");
  assert.ok(layout.includes("siteMetadataBase(process.env.NEXT_PUBLIC_APP_URL)"));
  for (const text of [preview, layout]) {
    assert.ok(!/wheelsai\.(io|com)/.test(text));
  }
});

// ---------------------------------------------------------------------------
// Workflows, the unified base, and the last pages that built a URL by hand
// ---------------------------------------------------------------------------

const wf = {
  apiEndpoint: "https://api.example.com/v1/workflows/weekly-release-pipeline/chat/completions",
  openaiBaseUrl: "https://api.example.com/v1/workflows/weekly-release-pipeline",
  openaiModel: "workflow/weekly-release-pipeline",
  timeoutMs: 600_000,
};

test("workflow snippets use the endpoint, base URL and model id the API returned", () => {
  const s = workflowSnippets(wf);
  assert.ok(s);
  assert.ok(s.curl.startsWith(`curl ${wf.apiEndpoint} \\\n`));
  assert.ok(s.node.includes(`baseURL: "${wf.openaiBaseUrl}"`));
  assert.ok(s.node.includes(`model: "${wf.openaiModel}"`));
  assert.ok(s.python.includes(`base_url="${wf.openaiBaseUrl}"`));
  assert.ok(s.python.includes(`model="${wf.openaiModel}"`));
  // An OpenAI client appends /chat/completions itself.
  assert.ok(!s.node.includes("chat/completions"));
  assert.ok(!s.python.includes("chat/completions"));
});

test("workflow snippets wait past the workflow's time limit and do not retry", () => {
  const s = workflowSnippets(wf);
  assert.ok(s);
  // A client that times out first disconnects, and a disconnect cancels the run.
  assert.equal(s.clientTimeoutSeconds, 660);
  assert.ok(s.curl.includes("--max-time 660"));
  assert.ok(s.node.includes("timeout: 660 * 1000"));
  assert.ok(s.python.includes("timeout=660"));
  // A repeat is a whole new run.
  assert.ok(s.node.includes("maxRetries: 0"));
  assert.ok(s.python.includes("max_retries=0"));
});

test("a workflow with no endpoint from the API gets no examples, never a guessed host", () => {
  assert.equal(workflowSnippets({ ...wf, apiEndpoint: null, openaiBaseUrl: null }), null);
  assert.equal(workflowSnippets({ ...wf, openaiBaseUrl: null }), null);
});

test("the unified base and its examples come from the API origin, trailing slash or not", () => {
  assert.equal(unifiedOpenAiBase("http://localhost:4000/"), "http://localhost:4000/v1");
  const s = unifiedApiSnippets("https://api.example.com/");
  assert.ok(s.curl.startsWith("curl https://api.example.com/v1/chat/completions "));
  assert.ok(s.python.includes('base_url="https://api.example.com/v1"'));
  assert.ok(s.python.includes("workflow/<slug>"));
});

test("a deployment's endpoint is the API's, resolved against the API origin when relative", () => {
  assert.equal(
    deploymentEndpointUrl("http://localhost:4000", "https://api.example.com/v1/llama/chat/completions", "llama"),
    "https://api.example.com/v1/llama/chat/completions",
  );
  assert.equal(
    deploymentEndpointUrl("http://localhost:4000/", "/v1/llama/chat/completions", "llama"),
    "http://localhost:4000/v1/llama/chat/completions",
  );
  assert.equal(
    deploymentEndpointUrl("http://localhost:4000", null, "my model"),
    "http://localhost:4000/v1/my%20model/chat/completions",
  );
});

test("the keys page, the deployment page and the workflow page build no URL by hand", () => {
  const keys = source("app/(dashboard)/dashboard/keys/page.tsx");
  assert.ok(keys.includes("unifiedApiSnippets(API_BASE_URL)"));
  assert.ok(!keys.includes("${API_BASE_URL}"));

  const deployment = source("app/(dashboard)/dashboard/deployments/[id]/page.tsx");
  assert.ok(deployment.includes("deploymentEndpointUrl(API_BASE_URL, deployment.endpoint, deployment.slug)"));
  assert.ok(!deployment.includes("/chat/completions`"));

  const workflowTab = source("components/dashboard/workflows/workflow-api-tab.tsx");
  assert.ok(workflowTab.includes("workflowSnippets({"));
  assert.ok(!workflowTab.includes("API_BASE_URL"));
  assert.ok(!/https?:\/\//.test(workflowTab));
});

test("the agent playground and the agent API tab print only what the API returned", () => {
  // The agent playground has no endpoint snippets of its own; the API tab
  // takes the endpoint, base URL and model id from the agent the API returned.
  const playground = source("app/(dashboard)/dashboard/agents/[id]/playground/page.tsx");
  assert.ok(!playground.includes("API_BASE_URL"));
  assert.ok(!playground.includes("chat/completions"));
  const apiTab = source("components/dashboard/agent-tabs/api-tab.tsx");
  assert.ok(apiTab.includes("const { apiEndpoint, openaiBaseUrl, openaiModel } = agent;"));
  assert.ok(!apiTab.includes("API_BASE_URL"));
});
