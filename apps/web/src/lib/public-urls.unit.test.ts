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
  API_KEY_ENV,
  paidAgentChatSnippets,
  paidAgentRunSnippets,
  landingAgentEndpoint,
  landingMarketplaceUrl,
  siteMetadataBase,
  x402ChallengeSnippet,
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

// ============================================
// A listing's API page
// ============================================

const paidChat = () => paidAgentChatSnippets({ baseUrl: "https://api.example.com", model: "a/translator" });
const paidRun = () => paidAgentRunSnippets({ baseUrl: "https://api.example.com", path: "/api/a/form-filler/run" });
const all = (s: { curl: string; javascript: string; python: string }) => [s.curl, s.javascript, s.python];

test("a paid agent's snippets post a chat completion with the listing's own model id", () => {
  const s = paidChat();
  assert.equal(s.endpointUrl, "https://api.example.com/v1/chat/completions");
  assert.match(s.curl, /^curl -i https:\/\/api\.example\.com\/v1\/chat\/completions \\\n/);
  assert.ok(s.curl.includes('"model": "a/translator"'));
  // An OpenAI client appends /chat/completions itself, so it gets the /v1 base.
  assert.ok(s.javascript.includes('baseURL: "https://api.example.com/v1"'));
  assert.ok(s.javascript.includes('model: "a/translator"'));
  assert.ok(s.python.includes('base_url="https://api.example.com/v1"'));
  assert.ok(s.python.includes('model="a/translator"'));
  for (const text of all(s)) assert.ok(!text.includes("chat/completions/chat/completions"), text);
});

test("no snippet of the API page names the owner's own model id", () => {
  // agent/<slug> is the owner's card: a buyer's key cannot call it.
  for (const text of [...all(paidChat()), ...all(paidRun())]) {
    assert.ok(!text.includes("agent/"), text);
    assert.ok(!text.includes("/v1/agents/"), text);
  }
});

test("every snippet of the API page reads the key from the environment, and none carries one", () => {
  assert.equal(API_KEY_ENV, "WHEELSAI_API_KEY");
  for (const s of [paidChat(), paidRun()]) {
    assert.ok(s.curl.includes('-H "Authorization: Bearer $WHEELSAI_API_KEY"'));
    assert.ok(s.javascript.includes("process.env.WHEELSAI_API_KEY"));
    assert.ok(s.python.includes('os.environ["WHEELSAI_API_KEY"]'));
    for (const text of all(s)) {
      assert.ok(!/YOUR_API_KEY|wheels_live_|sk-/.test(text), text);
      assert.ok(!text.includes("undefined") && !text.includes("null"), text);
    }
  }
});

test("a task's snippets post the form's answers to its run address, never a chat completion", () => {
  const s = paidRun();
  assert.equal(s.endpointUrl, "https://api.example.com/api/a/form-filler/run");
  assert.match(s.curl, /^curl -i https:\/\/api\.example\.com\/api\/a\/form-filler\/run \\\n/);
  for (const text of all(s)) {
    assert.ok(text.includes("https://api.example.com/api/a/form-filler/run"), text);
    assert.ok(text.includes("input"), text);
    assert.ok(!text.includes("chat/completions") && !text.includes("messages") && !text.includes("model"), text);
  }
  assert.ok(s.javascript.includes('method: "POST"'));
  assert.ok(s.python.includes('method="POST"'));
});

/** The JSON a curl snippet sends: what stands between -d ' and the closing '. */
function curlBody(curl: string): Record<string, unknown> {
  const found = /-d '([\s\S]*)'$/.exec(curl);
  assert.ok(found, curl);
  return JSON.parse(found[1] ?? "") as Record<string, unknown>;
}

test("a task's snippets ask for one whole answer, which is what they read", () => {
  // A run streams unless it is told not to, and a stream is not the JSON these snippets read.
  const s = paidRun();
  for (const text of all(s)) {
    assert.match(text, /"stream": false|stream: false|"stream": False/, text);
  }
  assert.ok(s.javascript.includes("await response.json()"));
  assert.ok(s.python.includes("json.load(response)"));
});

test("the body a curl snippet sends is JSON with the keys its address takes, and no other", () => {
  // The run address refuses a key it does not know.
  const run = curlBody(paidRun().curl);
  assert.deepEqual(Object.keys(run).sort(), ["input", "stream"]);
  assert.equal(run.stream, false);
  assert.ok(typeof run.input === "object" && run.input !== null && !Array.isArray(run.input));

  const chat = curlBody(paidChat().curl);
  assert.deepEqual(Object.keys(chat).sort(), ["messages", "model"]);
  assert.equal(chat.model, "a/translator");
  assert.ok(Array.isArray(chat.messages) && chat.messages.length === 1);
});

test("the API page's snippets take the base address with or without a slash at its end", () => {
  assert.equal(paidAgentChatSnippets({ baseUrl: "http://localhost:4000/", model: "a/x" }).endpointUrl, "http://localhost:4000/v1/chat/completions");
  assert.equal(paidAgentRunSnippets({ baseUrl: "http://localhost:4000/", path: "/api/a/x/run" }).endpointUrl, "http://localhost:4000/api/a/x/run");
});

test("the API page's snippets are plain text a terminal takes", () => {
  for (const text of [...all(paidChat()), ...all(paidRun())]) {
    assert.ok(/^[\x20-\x7e\n]*$/.test(text), text);
    assert.ok(!/[ \t]+\n/.test(text), "no space at a line's end, which breaks a curl continuation");
  }
});

// ============================================
// A workflow on sale: its run address
// ============================================

const paidWorkflowRun = () =>
  paidAgentRunSnippets({ baseUrl: "https://api.example.com", path: "/api/w/pdf-summary/run", subject: "workflow" });

test("a workflow's snippets post the input alone to its run address, which always answers one JSON body", () => {
  const s = paidWorkflowRun();
  assert.equal(s.endpointUrl, "https://api.example.com/api/w/pdf-summary/run");
  // The run address of a workflow takes the input and nothing else: `stream` would be refused.
  assert.deepEqual(Object.keys(curlBody(s.curl)), ["input"]);
  for (const text of all(s)) {
    assert.ok(text.includes("https://api.example.com/api/w/pdf-summary/run"), text);
    assert.ok(!/stream/i.test(text), text);
    assert.ok(!text.includes("agent"), text);
    assert.ok(!text.includes("workflow/"), text);
    assert.ok(/^[\x20-\x7e\n]*$/.test(text), text);
    assert.ok(!/[ \t]+\n/.test(text), "no space at a line's end");
  }
  assert.ok(s.javascript.includes("// One answer for each question of the workflow's form, by the question's name."));
  assert.ok(s.python.includes("# One answer for each question of the workflow's form, by the question's name."));
  assert.ok(s.curl.includes('-H "Authorization: Bearer $WHEELSAI_API_KEY"'));
  assert.ok(s.javascript.includes("await response.json()"));
  assert.ok(s.python.includes("json.load(response)"));
  // An agent's run is what it was, with the option or without it.
  assert.deepEqual(
    paidAgentRunSnippets({ baseUrl: "https://api.example.com", path: "/api/a/form-filler/run", subject: "agent" }),
    paidRun(),
  );
});

// ============================================
// Paying one use from a wallet, with no key
// ============================================

const challenge = (endpointUrl: string, body: Record<string, unknown>) => x402ChallengeSnippet({ endpointUrl, body });

test("the first call of a use paid from a wallet is a curl with no key, that prints the answer's headers", () => {
  const body = { model: "a/translator", messages: [{ role: "user", content: "Hello!" }] };
  const curl = challenge("https://api.example.com/v1/chat/completions", body);
  // -i, so the 402 and its PAYMENT-REQUIRED header show.
  assert.match(curl, /^curl -i https:\/\/api\.example\.com\/v1\/chat\/completions \\\n/);
  assert.ok(curl.includes('-H "Content-Type: application/json"'));
  // No key of any kind, and no payment signed by hand: that is the x402 client's.
  assert.ok(!/Authorization|Bearer|WHEELSAI_API_KEY|PAYMENT-SIGNATURE/i.test(curl), curl);
  assert.equal(curl.match(/-H /g)?.length, 1);
});

test("the wallet's first call sends the same body as the key's snippet, to the same address", () => {
  const chat = paidChat();
  const chatCall = challenge(chat.endpointUrl, { model: "a/translator", messages: [{ role: "user", content: "Hello!" }] });
  assert.deepEqual(curlBody(chatCall), curlBody(chat.curl));
  assert.ok(chatCall.startsWith(`curl -i ${chat.endpointUrl} \\\n`));

  const run = paidRun();
  const runCall = challenge(run.endpointUrl, { input: { field_name: "Your answer" }, stream: false });
  assert.deepEqual(curlBody(runCall), curlBody(run.curl));
  assert.ok(runCall.startsWith(`curl -i ${run.endpointUrl} \\\n`));
});

test("the wallet's first call is plain text a terminal takes, whatever the body holds", () => {
  const odd = { input: { note: "it's caf\u00e9" }, stream: false };
  const curl = challenge("https://api.example.com/api/a/x/run", odd);
  assert.ok(/^[\x20-\x7e\n]*$/.test(curl), curl);
  assert.ok(!/[ \t]+\n/.test(curl), "no space at a line's end, which breaks a curl continuation");
  // The shell's quoting holds: the quote is closed, escaped and reopened, and the JSON reads back whole.
  assert.ok(curl.includes("it'\\''s"));
  const unquoted = /-d '([\s\S]*)'$/.exec(curl)?.[1]?.replace(/'\\''/g, "'");
  assert.deepEqual(JSON.parse(unquoted ?? ""), odd);
});
