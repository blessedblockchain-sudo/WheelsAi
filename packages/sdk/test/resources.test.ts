/**
 * Pins the HTTP contract of every SDK method: verb, path, query, body and the
 * Authorization header. The expected values are a table written by hand from the routes
 * in apps/api (nothing here reads the API's code), so it catches an SDK change made by
 * accident, not an API route that moved: a change to either has to be made here on purpose.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AGENT_KINDS, WheelsAI, WheelsAIError } from "../src/index.js";
import { API_KEY, BASE_URL, jsonResponse, recordingFetch, type RecordedCall } from "./helpers.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const DEP = "22222222-2222-4222-8222-222222222222";
const LISTING = "33333333-3333-4333-8333-333333333333";
const OFFERING = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";

interface Case {
  /** `resource.method`: must match a method on the client. */
  name: string;
  run: (w: WheelsAI) => Promise<unknown>;
  method: string;
  path: string;
  query?: Record<string, string>;
  /** Expected JSON body; omit for "no body". */
  body?: unknown;
}

const graph = { nodes: [], edges: [] };
const listingInput = {
  agentId: AGENT,
  title: "My Bot",
  shortDescription: "Answers support questions.",
  category: "customer-support" as const,
  pricingModel: "per_request" as const,
  pricePerRequestCents: 5,
};

const offeringInput = {
  productKind: "agent" as const,
  agentId: AGENT,
  title: "Market brief",
  description: "One paragraph on a topic you send.",
  priceCents: 200,
  slaSeconds: 600,
};

const cases: Case[] = [
  // ---- auth ----
  { name: "auth.register", run: (w) => w.auth.register("a@b.co", "password1"), method: "POST", path: "/api/auth/register", body: { email: "a@b.co", password: "password1" } },
  { name: "auth.login", run: (w) => w.auth.login("a@b.co", "password1"), method: "POST", path: "/api/auth/login", body: { email: "a@b.co", password: "password1" } },
  { name: "auth.login2fa", run: (w) => w.auth.login2fa("challenge", "123456"), method: "POST", path: "/api/auth/login/2fa", body: { challengeToken: "challenge", token: "123456" } },
  { name: "auth.logout", run: (w) => w.auth.logout(), method: "POST", path: "/api/auth/logout" },
  { name: "auth.me", run: (w) => w.auth.me(), method: "GET", path: "/api/auth/me" },
  { name: "auth.refresh", run: (w) => w.auth.refresh(), method: "POST", path: "/api/auth/refresh" },
  { name: "auth.organizations", run: (w) => w.auth.organizations(), method: "GET", path: "/api/auth/orgs" },
  { name: "auth.switchOrg", run: (w) => w.auth.switchOrg(AGENT), method: "POST", path: "/api/auth/switch-org", body: { orgId: AGENT } },
  { name: "auth.walletNonce", run: (w) => w.auth.walletNonce("Wallet1111"), method: "POST", path: "/api/auth/wallet/nonce", body: { walletAddress: "Wallet1111" } },
  { name: "auth.walletVerify", run: (w) => w.auth.walletVerify("Wallet1111", "sig", "nonce"), method: "POST", path: "/api/auth/wallet/verify", body: { walletAddress: "Wallet1111", signature: "sig", nonce: "nonce" } },
  { name: "auth.listApiKeys", run: (w) => w.auth.listApiKeys(), method: "GET", path: "/api/auth/keys" },
  { name: "auth.createApiKey", run: (w) => w.auth.createApiKey({ name: "ci", scopes: ["*"] }), method: "POST", path: "/api/auth/keys", body: { name: "ci", scopes: ["*"] } },
  { name: "auth.revokeApiKey", run: (w) => w.auth.revokeApiKey("key-1"), method: "DELETE", path: "/api/auth/keys/key-1" },

  // ---- agents ----
  { name: "agents.list", run: (w) => w.agents.list(), method: "GET", path: "/api/agents" },
  { name: "agents.findBySlug", run: (w) => w.agents.findBySlug("my-bot"), method: "GET", path: "/api/agents" },
  { name: "agents.resolve", run: (w) => w.agents.resolve("my-bot"), method: "GET", path: "/api/agents" },
  { name: "agents.get", run: (w) => w.agents.get(AGENT), method: "GET", path: `/api/agents/${AGENT}` },
  { name: "agents.create", run: (w) => w.agents.create({ name: "My Bot", framework: "custom", sourceType: "inline", sourceCode: "x", modelConfig: {} }), method: "POST", path: "/api/agents", body: { name: "My Bot", framework: "custom", sourceType: "inline", sourceCode: "x", modelConfig: {} } },
  { name: "agents.update", run: (w) => w.agents.update(AGENT, { description: "new", env: { KEY: null }, entrypoint: "graph", agentKind: "scheduled", kindConfig: { scheduled: { schedule: { cronExpression: "0 9 * * *", timezone: "UTC" } }, task: null } }), method: "PATCH", path: `/api/agents/${AGENT}`, body: { description: "new", env: { KEY: null }, entrypoint: "graph", agentKind: "scheduled", kindConfig: { scheduled: { schedule: { cronExpression: "0 9 * * *", timezone: "UTC" } }, task: null } } },
  { name: "agents.delete", run: (w) => w.agents.delete(AGENT), method: "DELETE", path: `/api/agents/${AGENT}` },
  { name: "agents.usage", run: (w) => w.agents.usage(AGENT, "7d"), method: "GET", path: `/api/agents/${AGENT}/usage`, query: { period: "7d" } },
  { name: "agents.deploy", run: (w) => w.agents.deploy(AGENT, { gpuTier: "3060", replicas: 2 }), method: "POST", path: `/api/agents/${AGENT}/deploy`, body: { gpuTier: "3060", replicas: 2 } },
  { name: "agents.getDeployment", run: (w) => w.agents.getDeployment(AGENT, DEP), method: "GET", path: `/api/agents/${AGENT}/deployments/${DEP}` },
  { name: "agents.stopDeployment", run: (w) => w.agents.stopDeployment(AGENT, DEP), method: "POST", path: `/api/agents/${AGENT}/deployments/${DEP}/stop` },
  { name: "agents.deploymentLogs", run: (w) => w.agents.deploymentLogs(AGENT, DEP), method: "GET", path: `/api/agents/${AGENT}/deployments/${DEP}/logs` },
  { name: "agents.playgroundChat", run: (w) => w.agents.playgroundChat(AGENT, { messages: [{ role: "user", content: "hi" }], model: "free/groq/llama-3.3-70b" }), method: "POST", path: `/api/agents/${AGENT}/playground/chat`, body: { messages: [{ role: "user", content: "hi" }], model: "free/groq/llama-3.3-70b" } },
  { name: "agents.chatCompletion", run: (w) => w.agents.chatCompletion("support-bot", { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "get_weather" } }] }), method: "POST", path: "/v1/agents/support-bot/chat/completions", body: { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "get_weather" } }] } },
  { name: "agents.playgroundModels", run: (w) => w.agents.playgroundModels(AGENT), method: "GET", path: `/api/agents/${AGENT}/playground/models` },
  { name: "agents.getGraph", run: (w) => w.agents.getGraph(AGENT), method: "GET", path: `/api/agents/${AGENT}/graph` },
  { name: "agents.saveGraph", run: (w) => w.agents.saveGraph(AGENT, graph), method: "PUT", path: `/api/agents/${AGENT}/graph`, body: graph },
  { name: "agents.validateGraph", run: (w) => w.agents.validateGraph(AGENT, graph), method: "POST", path: `/api/agents/${AGENT}/graph/validate`, body: graph },

  // ---- deployments (model deployments) ----
  { name: "deployments.list", run: (w) => w.deployments.list(), method: "GET", path: "/api/deployments" },
  { name: "deployments.get", run: (w) => w.deployments.get(DEP), method: "GET", path: `/api/deployments/${DEP}` },
  { name: "deployments.create", run: (w) => w.deployments.create({ name: "chat", modelId: "llama-3.1-8b", gpuTier: "3060" }), method: "POST", path: "/api/deployments", body: { name: "chat", modelId: "llama-3.1-8b", gpuTier: "3060" } },
  { name: "deployments.update", run: (w) => w.deployments.update(DEP, { replicas: 2 }), method: "PATCH", path: `/api/deployments/${DEP}`, body: { replicas: 2 } },
  { name: "deployments.delete", run: (w) => w.deployments.delete(DEP), method: "DELETE", path: `/api/deployments/${DEP}` },
  { name: "deployments.restart", run: (w) => w.deployments.restart(DEP), method: "POST", path: `/api/deployments/${DEP}/restart` },
  { name: "deployments.logs", run: (w) => w.deployments.logs(DEP, { lines: 50 }), method: "GET", path: `/api/deployments/${DEP}/logs`, query: { lines: "50" } },
  { name: "deployments.metrics", run: (w) => w.deployments.metrics(DEP), method: "GET", path: `/api/deployments/${DEP}/metrics` },

  // ---- models ----
  { name: "models.list", run: (w) => w.models.list({ tier: "gpu", search: "llama" }), method: "GET", path: "/api/models", query: { tier: "gpu", search: "llama" } },
  { name: "models.gpuTiers", run: (w) => w.models.gpuTiers(), method: "GET", path: "/api/models", query: { tier: "gpu" } },
  { name: "models.get", run: (w) => w.models.get("llama-3.1-8b"), method: "GET", path: "/api/models/llama-3.1-8b" },
  { name: "models.free", run: (w) => w.models.free(), method: "GET", path: "/api/models/free" },
  { name: "models.engines", run: (w) => w.models.engines("llama-3.1-8b"), method: "GET", path: "/api/models/llama-3.1-8b/engines" },
  { name: "models.estimate", run: (w) => w.models.estimate("llama-3.1-8b", "3060", 2, 100), method: "POST", path: "/api/models/llama-3.1-8b/estimate", body: { gpuTier: "3060", replicas: 2, hoursPerMonth: 100 } },

  // ---- billing ----
  { name: "billing.getBalance", run: (w) => w.billing.getBalance(), method: "GET", path: "/api/billing/balance" },
  { name: "billing.getTransactions", run: (w) => w.billing.getTransactions(), method: "GET", path: "/api/billing/transactions" },
  { name: "billing.getUsage", run: (w) => w.billing.getUsage(), method: "GET", path: "/api/billing/usage" },
  { name: "billing.plan", run: (w) => w.billing.plan(), method: "GET", path: "/api/billing/plan" },
  { name: "billing.packages", run: (w) => w.billing.packages(), method: "GET", path: "/api/billing/packages" },
  { name: "billing.checkout", run: (w) => w.billing.checkout(25), method: "POST", path: "/api/billing/checkout", body: { amount: 25 } },
  { name: "billing.subscriptionCheckout", run: (w) => w.billing.subscriptionCheckout(), method: "POST", path: "/api/billing/subscription/checkout", body: { plan: "pro" } },
  { name: "billing.portal", run: (w) => w.billing.portal(), method: "POST", path: "/api/billing/portal" },

  // ---- marketplace ----
  { name: "marketplace.search", run: (w) => w.marketplace.search({ query: "support", sortBy: "newest", limit: 10 }), method: "GET", path: "/api/marketplace/listings", query: { query: "support", sortBy: "newest", limit: "10" } },
  { name: "marketplace.get", run: (w) => w.marketplace.get("my-bot"), method: "GET", path: "/api/marketplace/listings/my-bot" },
  { name: "marketplace.featured", run: (w) => w.marketplace.featured(3), method: "GET", path: "/api/marketplace/featured", query: { limit: "3" } },
  { name: "marketplace.categories", run: (w) => w.marketplace.categories(), method: "GET", path: "/api/marketplace/categories" },
  { name: "marketplace.pricingModels", run: (w) => w.marketplace.pricingModels(), method: "GET", path: "/api/marketplace/pricing-models" },
  { name: "marketplace.publisher", run: (w) => w.marketplace.publisher("acme"), method: "GET", path: "/api/marketplace/publishers/acme" },
  { name: "marketplace.reviews", run: (w) => w.marketplace.reviews(LISTING, { page: 2 }), method: "GET", path: `/api/marketplace/listings/${LISTING}/reviews`, query: { page: "2" } },
  { name: "marketplace.myListings", run: (w) => w.marketplace.myListings(), method: "GET", path: "/api/marketplace/my-listings" },
  { name: "marketplace.createListing", run: (w) => w.marketplace.createListing(listingInput), method: "POST", path: "/api/marketplace/listings", body: listingInput },
  { name: "marketplace.updateListing", run: (w) => w.marketplace.updateListing(LISTING, { pricingModel: "free" }), method: "PATCH", path: `/api/marketplace/listings/${LISTING}`, body: { pricingModel: "free" } },
  { name: "marketplace.publishListing", run: (w) => w.marketplace.publishListing(LISTING), method: "POST", path: `/api/marketplace/listings/${LISTING}/publish` },
  { name: "marketplace.archiveListing", run: (w) => w.marketplace.archiveListing(LISTING), method: "POST", path: `/api/marketplace/listings/${LISTING}/archive` },
  { name: "marketplace.install", run: (w) => w.marketplace.install(LISTING), method: "POST", path: `/api/marketplace/listings/${LISTING}/install` },
  { name: "marketplace.uninstall", run: (w) => w.marketplace.uninstall(LISTING), method: "POST", path: `/api/marketplace/listings/${LISTING}/uninstall` },
  { name: "marketplace.installStatus", run: (w) => w.marketplace.installStatus(LISTING), method: "GET", path: `/api/marketplace/listings/${LISTING}/install-status` },
  { name: "marketplace.myInstalls", run: (w) => w.marketplace.myInstalls(), method: "GET", path: "/api/marketplace/my-installs" },
  { name: "marketplace.addReview", run: (w) => w.marketplace.addReview(LISTING, { rating: 5, title: "Great", content: "Works." }), method: "POST", path: `/api/marketplace/listings/${LISTING}/reviews`, body: { rating: 5, title: "Great", content: "Works." } },
  { name: "marketplace.subscriptions", run: (w) => w.marketplace.subscriptions(), method: "GET", path: "/api/marketplace/subscriptions" },
  { name: "marketplace.cancelSubscription", run: (w) => w.marketplace.cancelSubscription(LISTING), method: "POST", path: `/api/marketplace/subscriptions/${LISTING}/cancel` },
  { name: "marketplace.resumeSubscription", run: (w) => w.marketplace.resumeSubscription(LISTING), method: "POST", path: `/api/marketplace/subscriptions/${LISTING}/resume` },
  { name: "marketplace.revenue", run: (w) => w.marketplace.revenue(), method: "GET", path: "/api/marketplace/revenue" },
  { name: "marketplace.payouts", run: (w) => w.marketplace.payouts(), method: "GET", path: "/api/marketplace/payouts" },

  // ---- inference (OpenAI-compatible) ----
  { name: "inference.chatCompletion", run: (w) => w.inference.chatCompletion("my-chat", { messages: [{ role: "user", content: "hi" }], max_tokens: 64 }), method: "POST", path: "/v1/my-chat/chat/completions", body: { messages: [{ role: "user", content: "hi" }], max_tokens: 64 } },
  { name: "inference.chat", run: (w) => w.inference.chat({ model: "agent/support-bot", messages: [{ role: "user", content: "hi" }] }), method: "POST", path: "/v1/chat/completions", body: { model: "agent/support-bot", messages: [{ role: "user", content: "hi" }] } },
  { name: "inference.listModels", run: (w) => w.inference.listModels(), method: "GET", path: "/v1/models" },

  // ---- workflows ----
  { name: "workflows.list", run: (w) => w.workflows.list({ isEnabled: true, limit: 10 }), method: "GET", path: "/api/orchestrations", query: { isEnabled: "true", limit: "10" } },
  { name: "workflows.get", run: (w) => w.workflows.get(AGENT), method: "GET", path: `/api/orchestrations/${AGENT}` },
  { name: "workflows.run", run: (w) => w.workflows.run(AGENT, { prompt: "go", input: { topic: "pricing" } }), method: "POST", path: `/api/orchestrations/${AGENT}/execute`, body: { prompt: "go", input: { topic: "pricing" } } },
  { name: "workflows.getRun", run: (w) => w.workflows.getRun(AGENT, DEP), method: "GET", path: `/api/orchestrations/${AGENT}/executions/${DEP}` },
  { name: "workflows.cancelRun", run: (w) => w.workflows.cancelRun(AGENT, DEP), method: "POST", path: `/api/orchestrations/${AGENT}/executions/${DEP}/cancel` },
  { name: "workflows.chatCompletion", run: (w) => w.workflows.chatCompletion("weekly-release-pipeline", { messages: [{ role: "user", content: "hi" }] }), method: "POST", path: "/v1/workflows/weekly-release-pipeline/chat/completions", body: { messages: [{ role: "user", content: "hi" }] } },

  // ---- offerings and jobs ----
  { name: "offerings.search", run: (w) => w.offerings.search({ productKind: "workflow", sort: "price_low", limit: 5 }), method: "GET", path: "/api/offerings", query: { productKind: "workflow", sort: "price_low", limit: "5" } },
  { name: "offerings.get", run: (w) => w.offerings.get("market-brief"), method: "GET", path: "/api/offerings/market-brief" },
  { name: "offerings.listMine", run: (w) => w.offerings.listMine({ status: "active" }), method: "GET", path: "/api/offerings/mine", query: { status: "active" } },
  { name: "offerings.getMine", run: (w) => w.offerings.getMine(OFFERING), method: "GET", path: `/api/offerings/mine/${OFFERING}` },
  { name: "offerings.create", run: (w) => w.offerings.create(offeringInput), method: "POST", path: "/api/offerings", body: offeringInput },
  { name: "offerings.update", run: (w) => w.offerings.update(OFFERING, { priceCents: 300 }), method: "PATCH", path: `/api/offerings/${OFFERING}`, body: { priceCents: 300 } },
  { name: "offerings.activate", run: (w) => w.offerings.activate(OFFERING), method: "POST", path: `/api/offerings/${OFFERING}/activate` },
  { name: "offerings.pause", run: (w) => w.offerings.pause(OFFERING), method: "POST", path: `/api/offerings/${OFFERING}/pause` },
  { name: "offerings.archive", run: (w) => w.offerings.archive(OFFERING), method: "POST", path: `/api/offerings/${OFFERING}/archive` },
  { name: "offerings.validate", run: (w) => w.offerings.validate({ inputSchema: { type: "object" }, deliverableChecks: [{ type: "min_length", value: 10 }] }), method: "POST", path: "/api/offerings/validate", body: { inputSchema: { type: "object" }, deliverableChecks: [{ type: "min_length", value: 10 }] } },
  { name: "offerings.testRun", run: (w) => w.offerings.testRun(OFFERING, { topic: "gpu" }), method: "POST", path: `/api/offerings/${OFFERING}/test-run`, body: { input: { topic: "gpu" } } },
  { name: "offerings.hire", run: (w) => w.offerings.hire(OFFERING, { topic: "gpu" }), method: "POST", path: `/api/offerings/${OFFERING}/hire`, body: { input: { topic: "gpu" } } },
  { name: "jobs.list", run: (w) => w.jobs.list({ role: "publisher", status: "submitted", page: 2 }), method: "GET", path: "/api/jobs", query: { role: "publisher", status: "submitted", page: "2" } },
  { name: "jobs.summary", run: (w) => w.jobs.summary(), method: "GET", path: "/api/jobs/summary" },
  { name: "jobs.get", run: (w) => w.jobs.get(JOB), method: "GET", path: `/api/jobs/${JOB}` },
  { name: "jobs.accept", run: (w) => w.jobs.accept(JOB, { rating: 5 }), method: "POST", path: `/api/jobs/${JOB}/accept`, body: { rating: 5 } },
  { name: "jobs.reject", run: (w) => w.jobs.reject(JOB, "Not what was asked"), method: "POST", path: `/api/jobs/${JOB}/reject`, body: { reason: "Not what was asked" } },
  { name: "jobs.cancel", run: (w) => w.jobs.cancel(JOB), method: "POST", path: `/api/jobs/${JOB}/cancel`, body: {} },
  { name: "jobs.rate", run: (w) => w.jobs.rate(JOB, 4, "Good"), method: "POST", path: `/api/jobs/${JOB}/rate`, body: { rating: 4, review: "Good" } },

  // ---- versioning ----
  { name: "versioning.list", run: (w) => w.versioning.list(AGENT, { limit: 5 }), method: "GET", path: `/api/versioning/agents/${AGENT}/versions`, query: { limit: "5" } },
  { name: "versioning.latest", run: (w) => w.versioning.latest(AGENT), method: "GET", path: `/api/versioning/agents/${AGENT}/versions/latest` },
  { name: "versioning.get", run: (w) => w.versioning.get(AGENT, "1.0.1"), method: "GET", path: `/api/versioning/agents/${AGENT}/versions/1.0.1` },
  { name: "versioning.create", run: (w) => w.versioning.create(AGENT, { changeLog: "tweak", changeType: "patch" }), method: "POST", path: `/api/versioning/agents/${AGENT}/versions`, body: { changeLog: "tweak", changeType: "patch" } },
  { name: "versioning.compare", run: (w) => w.versioning.compare(AGENT, "1.0.0", "1.0.1"), method: "GET", path: `/api/versioning/agents/${AGENT}/compare`, query: { from: "1.0.0", to: "1.0.1" } },
  { name: "versioning.history", run: (w) => w.versioning.history(AGENT, { limit: 3 }), method: "GET", path: `/api/versioning/agents/${AGENT}/history`, query: { limit: "3" } },
  { name: "versioning.rollback", run: (w) => w.versioning.rollback(AGENT, "1.0.0"), method: "POST", path: `/api/versioning/agents/${AGENT}/versions/1.0.0/rollback` },
  { name: "versioning.tag", run: (w) => w.versioning.tag(AGENT, "1.0.0", ["stable"]), method: "POST", path: `/api/versioning/agents/${AGENT}/versions/1.0.0/tag`, body: { tags: ["stable"] } },
  { name: "versioning.publish", run: (w) => w.versioning.publish(AGENT, "1.0.0"), method: "POST", path: `/api/versioning/agents/${AGENT}/versions/1.0.0/publish` },
  { name: "versioning.delete", run: (w) => w.versioning.delete(AGENT, "1.0.0"), method: "DELETE", path: `/api/versioning/agents/${AGENT}/versions/1.0.0` },

  // ---- openclaw (chat channels) ----
  { name: "openclaw.list", run: (w) => w.openclaw.list(), method: "GET", path: "/api/openclaw" },
  { name: "openclaw.get", run: (w) => w.openclaw.get(DEP), method: "GET", path: `/api/openclaw/${DEP}` },

  // ---- platform and skills ----
  { name: "platform.status", run: (w) => w.platform.status(), method: "GET", path: "/api/status" },
  { name: "platform.stats", run: (w) => w.platform.stats(), method: "GET", path: "/api/public/stats" },
  { name: "platform.capabilities", run: (w) => w.platform.capabilities(), method: "GET", path: "/api/capabilities" },
  { name: "skills.list", run: (w) => w.skills.list({ agentId: AGENT }), method: "GET", path: "/api/skills", query: { agentId: AGENT } },
];

/** Answers every request with `{}`, except the agent list, which gets one agent. */
function respond(call: RecordedCall): Response {
  if (call.method === "GET" && call.url.pathname === "/api/agents") {
    return jsonResponse({ agents: [{ id: AGENT, slug: "my-bot", name: "My Bot" }], total: 1 });
  }
  if (call.method === "DELETE" && call.url.pathname.includes("/versions/")) {
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ ok: true });
}

describe("every SDK method hits the route the API serves", () => {
  for (const c of cases) {
    it(`${c.name}: ${c.method} ${c.path}`, async () => {
      const { fetch, calls } = recordingFetch(respond);
      const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
      await c.run(wheels);

      assert.equal(calls.length, 1, "exactly one request");
      const call = calls[0]!;
      assert.equal(call.method, c.method);
      assert.equal(call.url.pathname, c.path);
      assert.deepEqual(Object.fromEntries(call.url.searchParams), c.query ?? {});
      assert.deepEqual(call.body, c.body);
      assert.equal(call.headers.get("authorization"), `Bearer ${API_KEY}`);
      assert.equal(call.headers.has("x-api-key"), false);
    });
  }
});

describe("coverage", () => {
  it("has a pinned case for every resource method", () => {
    // Read the resources off the client itself, so a resource added to WheelsAI is covered too.
    const wheels = new WheelsAI({ baseUrl: BASE_URL }) as unknown as Record<string, unknown>;
    const resources = Object.entries(wheels).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        entry[0] !== "client" && typeof entry[1] === "object" && entry[1] !== null,
    );
    assert.ok(resources.length >= 13, "the client exposes its resources as own properties");
    const pinned = new Set(cases.map((c) => c.name));
    const missing: string[] = [];
    for (const [resource, methods] of resources) {
      for (const method of Object.keys(methods)) {
        if (!pinned.has(`${resource}.${method}`)) missing.push(`${resource}.${method}`);
      }
    }
    assert.deepEqual(missing, [], "add a case for each new method");
  });

  it("does not pin methods that no longer exist", () => {
    const wheels = new WheelsAI({ baseUrl: BASE_URL }) as unknown as Record<string, Record<string, unknown>>;
    const stale = cases
      .map((c) => c.name)
      .filter((name) => {
        const [resource, method] = name.split(".") as [string, string];
        return typeof wheels[resource]?.[method] !== "function";
      });
    assert.deepEqual(stale, []);
  });
});

describe("methods that were wrong before", () => {
  it("agents.update uses PATCH, not PUT", async () => {
    const { fetch, calls } = recordingFetch();
    await new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }).agents.update(AGENT, { name: "Renamed" });
    assert.equal(calls[0]?.method, "PATCH");
  });

  it("the removed methods stay removed", () => {
    const wheels = new WheelsAI({ baseUrl: BASE_URL }) as unknown as Record<string, Record<string, unknown>>;
    assert.equal(wheels.agents?.stop, undefined, "agents.stop hit a path the API does not serve");
    assert.equal(wheels.billing?.addCredits, undefined, "billing.addCredits hit a path the API does not serve");
  });
});

describe("creating an agent", () => {
  it("needs only a name, and sends nothing the caller did not", async () => {
    const { fetch, calls } = recordingFetch();
    await new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }).agents.create({ name: "My Bot" });
    assert.deepEqual(calls[0]?.body, { name: "My Bot" });
  });

  it("sends the kind, its settings, the template and the slug as given", async () => {
    const input = {
      name: "Code review",
      agentKind: "task" as const,
      kindConfig: { task: { fields: [{ label: "Code to review", type: "long_text" as const, required: true }] } },
      templateId: LISTING,
      slug: "code-review",
    };
    const { fetch, calls } = recordingFetch();
    await new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }).agents.create(input);
    assert.deepEqual(calls[0]?.body, input);
  });

  it("returns the created agent with its kind and where its API is", async () => {
    const agent = {
      id: AGENT,
      name: "My Bot",
      slug: "my-bot",
      framework: "custom",
      agentKind: "conversation",
      apiEndpoint: `${BASE_URL}/v1/agents/my-bot/chat/completions`,
      openaiBaseUrl: `${BASE_URL}/v1/agents/my-bot`,
      openaiModel: "agent/my-bot",
    };
    const wheels = new WheelsAI({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: recordingFetch(() => jsonResponse({ agent, message: "Agent created successfully" }, 201)).fetch,
    });
    const created = await wheels.agents.create({ name: "My Bot" });
    assert.equal(created.agent.agentKind, "conversation");
    assert.equal(created.agent.openaiModel, "agent/my-bot");
  });

  it("the kinds are the three the API stores", () => {
    assert.deepEqual([...AGENT_KINDS], ["conversation", "task", "scheduled"]);
  });
});

describe("errors the API documents for agents", () => {
  const failing = (status: number, body: unknown) =>
    new WheelsAI({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: recordingFetch(() => jsonResponse(body, status)).fetch,
    });

  it("a refused create reads as the API's sentence and keeps the sentence of each field", async () => {
    const body = {
      error: "validation_failed",
      message: "Give your agent a name of at least 3 characters.",
      fields: { name: "Give your agent a name of at least 3 characters.", "kindConfig.task.fields[0].label": "Give this question a label." },
      details: { formErrors: [], fieldErrors: { name: ["Give your agent a name of at least 3 characters."], kindConfig: ["Give this question a label."] } },
    };
    await assert.rejects(failing(400, body).agents.create({ name: "ab" }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 400);
      assert.equal(err.code, "validation_failed");
      assert.equal(err.message, "Give your agent a name of at least 3 characters.");
      assert.equal(
        (err.data as { fields: Record<string, string> }).fields["kindConfig.task.fields[0].label"],
        "Give this question a label.",
      );
      return true;
    });
  });

  it("a template that is gone answers 404 template_not_found", async () => {
    const body = { error: "template_not_found", message: "This template is no longer available. Choose another one." };
    await assert.rejects(failing(404, body).agents.create({ name: "My Bot", templateId: LISTING }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.code, "template_not_found");
      assert.equal(err.message, body.message);
      return true;
    });
  });

  it("a GPU deploy the server cannot start answers 501 agent_gpu_unavailable with its message", async () => {
    const body = {
      error: "agent_gpu_unavailable",
      message: "Dedicated GPUs for agents are being built. Nothing was reserved or charged. Your agent keeps answering on WheelsAI.",
    };
    await assert.rejects(failing(501, body).agents.deploy(AGENT, { gpuTier: "3060" }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 501);
      assert.equal(err.code, "agent_gpu_unavailable");
      assert.equal(err.message, body.message);
      return true;
    });
  });
});

describe("errors the API documents for install", () => {
  const failing = (status: number, body: unknown) =>
    new WheelsAI({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: recordingFetch(() => jsonResponse(body, status)).fetch,
    });

  it("keeps the 402 body of a monthly listing the buyer cannot afford", async () => {
    const body = { error: "insufficient_credits", message: "Needs $9.00 in credits.", requiredCents: 900 };
    await assert.rejects(failing(402, body).marketplace.install(LISTING), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 402);
      assert.equal(err.code, "insufficient_credits");
      assert.equal((err.data as { requiredCents: number }).requiredCents, 900);
      return true;
    });
  });

  it("keeps the 403 body of a token-gated listing", async () => {
    const body = {
      error: "token_required",
      message: "Hold 100 AGENT to install.",
      tokenSymbol: "AGENT",
      mintAddress: "Mint1111",
      requiredBalance: 100,
    };
    await assert.rejects(failing(403, body).marketplace.install(LISTING), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 403);
      assert.equal(err.code, "token_required");
      assert.equal((err.data as { tokenSymbol: string }).tokenSymbol, "AGENT");
      return true;
    });
  });
});

describe("agents.resolve and agents.findBySlug", () => {
  const agents = [
    { id: AGENT, slug: "my-bot", name: "My Bot" },
    { id: DEP, slug: "other", name: "Other" },
  ];
  const client = () =>
    new WheelsAI({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      fetch: recordingFetch(() => jsonResponse({ agents, total: agents.length })).fetch,
    });

  it("finds by slug", async () => {
    assert.equal((await client().agents.findBySlug("other"))?.id, DEP);
    assert.equal((await client().agents.resolve("my-bot"))?.id, AGENT);
  });

  it("finds by id", async () => {
    assert.equal((await client().agents.resolve(DEP))?.slug, "other");
  });

  it("matches slugs case-insensitively and returns null for unknown agents", async () => {
    assert.equal((await client().agents.resolve("MY-BOT"))?.id, AGENT);
    assert.equal(await client().agents.resolve("nope"), null);
    assert.equal(await client().agents.findBySlug("nope"), null);
  });
});
