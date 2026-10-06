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
  deploymentSnippets,
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
