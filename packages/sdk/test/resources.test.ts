/**
 * Pins the HTTP contract of every SDK method: verb, path, query, body and the
 * Authorization header. The expected values are a table written by hand from the routes
 * in apps/api (nothing here reads the API's code), so it catches an SDK change made by
 * accident, not an API route that moved: a change to either has to be made here on purpose.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENT_KINDS,
  WheelsAI,
  WheelsAIError,
  isTopupFinal,
  type CreditedDeposit,
  type Deposit,
  type DepositAddress,
  type DepositAddressAsset,
  type DepositAsset,
  type DepositCheck,
  type DepositStatus,
  type PreparedDepositAddress,
  type UseAccessState,
  type UseRefusal,
  type WaitingDeposit,
} from "../src/index.js";
import { API_KEY, BASE_URL, jsonResponse, recordingFetch, type RecordedCall } from "./helpers.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const DEP = "22222222-2222-4222-8222-222222222222";
const LISTING = "33333333-3333-4333-8333-333333333333";
const OFFERING = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const PLACE = "66666666-6666-4666-8666-666666666666";
const RUN = "77777777-7777-4777-8777-777777777777";
const PAYOUT = "88888888-8888-4888-8888-888888888888";
const TOPUP = "99999999-9999-4999-8999-999999999999";
/** A Solana address in the shape the API takes (base58); nothing here checks it. */
const PAYER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

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
  { name: "agents.run", run: (w) => w.agents.run(AGENT, { topic: "Refund policy", keywords: ["refund", "returns"] }), method: "POST", path: `/api/agents/${AGENT}/run`, body: { input: { topic: "Refund policy", keywords: ["refund", "returns"] }, stream: false } },
  { name: "agents.publicLink.get", run: (w) => w.agents.publicLink.get(AGENT), method: "GET", path: `/api/agents/${AGENT}/public-link` },
  { name: "agents.publicLink.set", run: (w) => w.agents.publicLink.set(AGENT, { state: "on", dailyCap: 50, handle: "refund-helper", showResults: true }), method: "PUT", path: `/api/agents/${AGENT}/public-link`, body: { state: "on", dailyCap: 50, handle: "refund-helper", showResults: true } },
  { name: "agents.schedule.get", run: (w) => w.agents.schedule.get(AGENT), method: "GET", path: `/api/agents/${AGENT}/schedule` },
  { name: "agents.schedule.set", run: (w) => w.agents.schedule.set(AGENT, { enabled: true, cronExpression: "0 9 * * 1-5", timezone: "Europe/Berlin", prompt: "Summarize the news.", stampTime: true, deliver: { channelId: PLACE }, timeoutSeconds: 120, maxRetries: 2 }), method: "PUT", path: `/api/agents/${AGENT}/schedule`, body: { enabled: true, cronExpression: "0 9 * * 1-5", timezone: "Europe/Berlin", prompt: "Summarize the news.", stampTime: true, deliver: { channelId: PLACE }, timeoutSeconds: 120, maxRetries: 2 } },
  { name: "agents.schedule.runNow", run: (w) => w.agents.schedule.runNow(AGENT), method: "POST", path: `/api/agents/${AGENT}/schedule/run` },
  { name: "agents.runs.list", run: (w) => w.agents.runs.list(AGENT, { limit: 10, before: RUN }), method: "GET", path: `/api/agents/${AGENT}/runs`, query: { limit: "10", before: RUN } },
  { name: "agents.runs.resend", run: (w) => w.agents.runs.resend(AGENT, RUN), method: "POST", path: `/api/agents/${AGENT}/runs/${RUN}/deliver` },
  { name: "agents.playgroundModels", run: (w) => w.agents.playgroundModels(AGENT), method: "GET", path: `/api/agents/${AGENT}/playground/models` },
  { name: "agents.getGraph", run: (w) => w.agents.getGraph(AGENT), method: "GET", path: `/api/agents/${AGENT}/graph` },
  { name: "agents.saveGraph", run: (w) => w.agents.saveGraph(AGENT, graph), method: "PUT", path: `/api/agents/${AGENT}/graph`, body: graph },
  { name: "agents.validateGraph", run: (w) => w.agents.validateGraph(AGENT, graph), method: "POST", path: `/api/agents/${AGENT}/graph/validate`, body: graph },

  // ---- destinations (where a schedule's results go) ----
  { name: "destinations.list", run: (w) => w.destinations.list(), method: "GET", path: "/api/destinations" },
  { name: "destinations.create", run: (w) => w.destinations.create({ type: "slack", link: "https://hooks.slack.com/services/T000/B000/XXXX", name: "Team Slack" }), method: "POST", path: "/api/destinations", body: { type: "slack", link: "https://hooks.slack.com/services/T000/B000/XXXX", name: "Team Slack" } },
  { name: "destinations.test", run: (w) => w.destinations.test(PLACE), method: "POST", path: `/api/destinations/${PLACE}/test` },

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
  { name: "billing.topups.prepare", run: (w) => w.billing.topups.prepare({ amountUsd: 50, asset: "SOL", payerAddress: PAYER }), method: "POST", path: "/api/billing/topups/prepare", body: { amountUsd: 50, asset: "SOL", payerAddress: PAYER } },
  { name: "billing.topups.submit", run: (w) => w.billing.topups.submit(TOPUP, "c2lnbmVk"), method: "POST", path: `/api/billing/topups/${TOPUP}/submit`, body: { signedTxBase64: "c2lnbmVk" } },
  { name: "billing.topups.reconcile", run: (w) => w.billing.topups.reconcile(TOPUP), method: "POST", path: `/api/billing/topups/${TOPUP}/reconcile`, body: {} },
  { name: "billing.topups.get", run: (w) => w.billing.topups.get(TOPUP), method: "GET", path: `/api/billing/topups/${TOPUP}` },
  { name: "billing.topups.list", run: (w) => w.billing.topups.list(), method: "GET", path: "/api/billing/topups" },
  { name: "billing.depositAddress.get", run: (w) => w.billing.depositAddress.get(), method: "GET", path: "/api/billing/deposit-address" },
  { name: "billing.depositAddress.issue", run: (w) => w.billing.depositAddress.issue(), method: "POST", path: "/api/billing/deposit-address" },
  { name: "billing.depositAddress.prepareUsdc", run: (w) => w.billing.depositAddress.prepareUsdc(), method: "POST", path: "/api/billing/deposit-address/usdc-account" },
  { name: "billing.depositAddress.check", run: (w) => w.billing.depositAddress.check(), method: "POST", path: "/api/billing/deposit-address/check" },
  { name: "billing.deposits.list", run: (w) => w.billing.deposits.list(), method: "GET", path: "/api/billing/deposits" },

  // ---- use of an agent you pay for ----
  { name: "use.access", run: (w) => w.use.access("refund-helper"), method: "GET", path: "/api/a/refund-helper/access" },
  { name: "use.chat", run: (w) => w.use.chat("refund-helper", { messages: [{ role: "user", content: "Hi" }], sessionId: "s1" }), method: "POST", path: "/api/a/refund-helper/chat", body: { messages: [{ role: "user", content: "Hi" }], sessionId: "s1", stream: false } },
  { name: "use.run", run: (w) => w.use.run("brief-writer", { input: { topic: "x" } }), method: "POST", path: "/api/a/brief-writer/run", body: { input: { topic: "x" }, stream: false } },
  { name: "use.results", run: (w) => w.use.results("daily-brief"), method: "GET", path: "/api/a/daily-brief/results" },
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
  { name: "marketplace.startUsing", run: (w) => w.marketplace.startUsing(LISTING, { expected: { pricingModel: "per_request", pricePerRequestCents: 5 } }), method: "POST", path: `/api/marketplace/listings/${LISTING}/use`, body: { expected: { pricingModel: "per_request", pricePerRequestCents: 5 } } },
  { name: "marketplace.stopUsing", run: (w) => w.marketplace.stopUsing(LISTING), method: "POST", path: `/api/marketplace/listings/${LISTING}/uninstall` },
  { name: "marketplace.uninstall", run: (w) => w.marketplace.uninstall(LISTING), method: "POST", path: `/api/marketplace/listings/${LISTING}/uninstall` },
  { name: "marketplace.installStatus", run: (w) => w.marketplace.installStatus(LISTING), method: "GET", path: `/api/marketplace/listings/${LISTING}/install-status` },
  { name: "marketplace.myInstalls", run: (w) => w.marketplace.myInstalls(), method: "GET", path: "/api/marketplace/my-installs" },
  { name: "marketplace.addReview", run: (w) => w.marketplace.addReview(LISTING, { rating: 5, title: "Great", content: "Works." }), method: "POST", path: `/api/marketplace/listings/${LISTING}/reviews`, body: { rating: 5, title: "Great", content: "Works." } },
  { name: "marketplace.subscriptions", run: (w) => w.marketplace.subscriptions(), method: "GET", path: "/api/marketplace/subscriptions" },
  { name: "marketplace.cancelSubscription", run: (w) => w.marketplace.cancelSubscription(LISTING), method: "POST", path: `/api/marketplace/subscriptions/${LISTING}/cancel` },
  { name: "marketplace.resumeSubscription", run: (w) => w.marketplace.resumeSubscription(LISTING), method: "POST", path: `/api/marketplace/subscriptions/${LISTING}/resume` },
  { name: "marketplace.revenue", run: (w) => w.marketplace.revenue(), method: "GET", path: "/api/marketplace/revenue" },
  { name: "marketplace.requestPayout", run: (w) => w.marketplace.requestPayout({ payoutMethod: "crypto_usdc", payoutAddress: PAYER, amountCents: 4120 }), method: "POST", path: "/api/marketplace/payouts", body: { payoutMethod: "crypto_usdc", payoutAddress: PAYER, amountCents: 4120 } },
  { name: "marketplace.payouts", run: (w) => w.marketplace.payouts(), method: "GET", path: "/api/marketplace/payouts" },
  { name: "marketplace.cancelPayout", run: (w) => w.marketplace.cancelPayout(PAYOUT), method: "POST", path: `/api/marketplace/payouts/${PAYOUT}/cancel` },

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
    // A group of methods (`agents.publicLink`) is covered by a case for each method in it.
    const check = (prefix: string, methods: Record<string, unknown>) => {
      for (const [method, member] of Object.entries(methods)) {
        if (typeof member === "object" && member !== null) check(`${prefix}.${method}`, member as Record<string, unknown>);
        else if (!pinned.has(`${prefix}.${method}`)) missing.push(`${prefix}.${method}`);
      }
    };
    for (const [resource, methods] of resources) check(resource, methods);
    assert.deepEqual(missing, [], "add a case for each new method");
  });

  it("does not pin methods that no longer exist", () => {
    const wheels = new WheelsAI({ baseUrl: BASE_URL }) as unknown as Record<string, Record<string, unknown>>;
    const stale = cases
      .map((c) => c.name)
      .filter((name) => {
        let member: unknown = wheels;
        for (const part of name.split(".")) member = (member as Record<string, unknown> | undefined)?.[part];
        return typeof member !== "function";
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

describe("running a task agent", () => {
  const client = (respond: Parameters<typeof recordingFetch>[0]) => {
    const recorded = recordingFetch(respond);
    return { wheels: new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recorded.fetch }), calls: recorded.calls };
  };
  const failing = (status: number, body: unknown) => client(() => jsonResponse(body, status)).wheels;

  it("asks for the JSON answer and returns the result as the API sent it", async () => {
    const answer = {
      output: { format: "text", text: "Refunds take 5 days." },
      toolCalls: [{ round: 1, name: "lookup", status: "ok", detail: null }],
      durationMs: 1840,
      billing: { listingTitle: "Support Pro", chargedCents: 25, creatorCents: 20 },
    };
    const { wheels, calls } = client(() => jsonResponse(answer));
    const result = await wheels.agents.run(AGENT, { topic: "Refunds" });
    assert.deepEqual(result, answer);
    assert.deepEqual(calls[0]!.body, { input: { topic: "Refunds" }, stream: false });
  });

  it("a form that does not fit answers 422 input_invalid and keeps each answer to fix", async () => {
    const body = {
      error: "input_invalid",
      message: "Some answers need another look.",
      details: [{ path: "/topic", field: "topic", label: "Topic", message: "This question needs an answer." }],
    };
    await assert.rejects(failing(422, body).agents.run(AGENT, {}), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 422);
      assert.equal(err.code, "input_invalid");
      assert.equal(err.message, body.message);
      assert.deepEqual((err.data as { details: unknown }).details, body.details);
      return true;
    });
  });

  it("an agent that is not a task agent answers 409 not_a_task_agent", async () => {
    const body = { error: "not_a_task_agent", message: "This agent is not set up to run tasks. Chat with it instead." };
    await assert.rejects(failing(409, body).agents.run(AGENT, { topic: "x" }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "not_a_task_agent");
      return true;
    });
  });

  it("waits longer than an ordinary call by default, and options.timeoutMs replaces it", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const wheels = new WheelsAI({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 30_000,
      fetch: async (_input, init) => {
        seen.push(init?.signal);
        return jsonResponse({ output: { format: "text", text: "ok" }, toolCalls: [], durationMs: 1, billing: null });
      },
    });
    await wheels.agents.run(AGENT, { topic: "x" });
    await wheels.agents.run(AGENT, { topic: "x" }, { timeoutMs: 0 });
    assert.ok(seen[0], "the default run call has a timeout");
    assert.equal(seen[1], undefined, "timeoutMs 0 disables it");
  });
});

describe("the public link", () => {
  const link = {
    state: "on",
    handle: "refund-helper",
    url: "https://wheelsai.example/a/refund-helper",
    dailyCap: 100,
    usedToday: 3,
    showResults: false,
    toolsOffForVisitors: true,
  };

  it("set sends the switch and returns the link as the API sent it", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(link));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    assert.deepEqual(await wheels.agents.publicLink.set(AGENT, { state: "paused" }), link);
    assert.deepEqual(calls[0]!.body, { state: "paused" });
  });

  it("an address another agent has answers 409 handle_taken", async () => {
    const body = { error: "handle_taken", message: "That address is already in use. Choose another." };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(body, 409)).fetch });
    await assert.rejects(wheels.agents.publicLink.set(AGENT, { state: "on", handle: "taken" }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "handle_taken");
      return true;
    });
  });
});

describe("an agent's schedule and its runs", () => {
  it("create sends the schedule as given and returns the schedule the API made", async () => {
    const made = { id: RUN, enabled: true, cronExpression: "0 9 * * *", timezone: "UTC", nextRunAt: "2026-10-09T09:00:00.000Z" };
    const { fetch, calls } = recordingFetch(() => jsonResponse({ agent: { id: AGENT }, schedule: made, message: "Agent created successfully" }, 201));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    const input = { name: "Morning brief", agentKind: "scheduled" as const, schedule: { cronExpression: "0 9 * * *", deliver: { channelId: PLACE } } };
    const answer = await wheels.agents.create(input);
    assert.deepEqual(calls[0]!.body, input);
    assert.deepEqual(answer.schedule, made);
  });

  it("update returns schedulePaused when the answer carries it", async () => {
    const { fetch } = recordingFetch(() => jsonResponse({ agent: { id: AGENT }, schedulePaused: true }));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    assert.equal((await wheels.agents.update(AGENT, { agentKind: "conversation" })).schedulePaused, true);
  });

  it("a schedule changed somewhere else answers 409 schedule_changed", async () => {
    const body = { error: "schedule_changed", message: "This schedule was changed somewhere else. Reload it and try again." };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(body, 409)).fetch });
    await assert.rejects(wheels.agents.schedule.set(AGENT, { enabled: true, cronExpression: "0 9 * * *" }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "schedule_changed");
      return true;
    });
  });

  it("a place that did not take a result answers 502 delivery_failed and keeps the run", async () => {
    const run = { id: RUN, status: "finished", delivery: [{ channelId: PLACE, name: "Team Slack", type: "slack", status: "failed", reason: "it did not accept the message", at: "2026-10-08T09:00:00.000Z" }] };
    const body = { error: "delivery_failed", message: "Not sent to Team Slack: it did not accept the message. The result is saved here.", run };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(body, 502)).fetch });
    await assert.rejects(wheels.agents.runs.resend(AGENT, RUN), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 502);
      assert.equal(err.code, "delivery_failed");
      assert.deepEqual((err.data as { run: unknown }).run, run);
      return true;
    });
  });

  it("a run already in flight answers 409 already_running", async () => {
    const body = { error: "already_running", message: "This agent is already running. Wait for it to finish." };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(body, 409)).fetch });
    await assert.rejects(wheels.agents.schedule.runNow(AGENT), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.code, "already_running");
      return true;
    });
  });

  it("an email place sends no address", async () => {
    const place = { channelId: PLACE, name: "Email to Ada", type: "email", mine: true };
    const { fetch, calls } = recordingFetch(() => jsonResponse(place, 201));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    assert.deepEqual(await wheels.destinations.create({ type: "email" }), place);
    assert.deepEqual(calls[0]!.body, { type: "email" });
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

describe("selling and using an agent", () => {
  const expected = { pricingModel: "monthly" as const, monthlyPriceCents: 900 };

  it("create and update send what the listing sells, its tools and publish", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    const input = { ...listingInput, sells: "copies" as const, allowedTools: ["http_request"], publish: true };
    await wheels.marketplace.createListing(input);
    await wheels.marketplace.updateListing(LISTING, { sells: "use", allowedTools: [] });
    assert.deepEqual(calls[0]!.body, input);
    assert.deepEqual(calls[1]!.body, { sells: "use", allowedTools: [] });
  });

  it("startUsing sends the price it was shown, and acceptNewPricing only when asked", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    await wheels.marketplace.startUsing(LISTING, { expected, acceptNewPricing: true });
    await wheels.marketplace.startUsing(LISTING, { expected });
    assert.deepEqual(calls[0]!.body, { expected, acceptNewPricing: true });
    assert.deepEqual(calls[1]!.body, { expected });
  });

  it("keeps the pricing a changed listing answers with", async () => {
    const body = {
      error: "pricing_changed",
      message: "The price changed.",
      pricing: { pricingModel: "monthly", pricePerRequestCents: null, monthlyPriceCents: 1200 },
    };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(body, 409)).fetch });
    await assert.rejects(wheels.marketplace.startUsing(LISTING, { expected }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "pricing_changed");
      assert.equal((err.data as { pricing: { monthlyPriceCents: number } }).pricing.monthlyPriceCents, 1200);
      return true;
    });
  });

  it("keeps the date a copy blocks starting to use until", async () => {
    const body = {
      error: "copy_subscription_active",
      message: "You hold a copy of this agent with a month paid for.",
      until: "2026-11-01T00:00:00.000Z",
    };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(body, 409)).fetch });
    await assert.rejects(wheels.marketplace.startUsing(LISTING, { expected }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "copy_subscription_active");
      assert.equal((err.data as UseRefusal).until, "2026-11-01T00:00:00.000Z");
      return true;
    });
  });

  it("the access answer carries startBlocked, and a person who left the organization is refused", async () => {
    const access: UseAccessState = {
      access: "none",
      listingId: "l1",
      terms: null,
      accepted: null,
      subscription: null,
      balanceCents: 0,
      canAccept: false,
      startBlocked: { code: "copy_subscription_active", message: "A copy is paid for.", until: "2026-11-01T00:00:00.000Z" },
    };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(access)).fetch });
    assert.deepEqual(await wheels.use.access("refund-helper"), access);
    const refusal = { error: "not_a_member", message: "You are no longer a member of the organization that pays for this." };
    const refused = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(refusal, 403)).fetch });
    await assert.rejects(refused.use.chat("refund-helper", { messages: [{ role: "user", content: "Hi" }] }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 403);
      assert.equal(err.code, "not_a_member");
      return true;
    });
  });

  it("a handle is one path segment", async () => {
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch().fetch });
    assert.throws(() => wheels.use.access(".."), WheelsAIError);
    assert.throws(() => wheels.use.chat("", { messages: [] }), WheelsAIError);
  });

  it("chat and run give the whole answer and the receipt as the API sent them", async () => {
    const answer = {
      message: { role: "assistant", content: "Hello." },
      toolCalls: [],
      billing: { chargedCents: 5, balanceCents: 495, access: "listing_pricing" },
    };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(answer)).fetch });
    assert.deepEqual(await wheels.use.chat("refund-helper", { messages: [{ role: "user", content: "Hi" }] }), answer);
  });

  it("a refusal keeps its body, so the message can be shown as it comes", async () => {
    const body = {
      error: "insufficient_credits",
      message: "You do not have enough credits for this message ($0.05). Nothing was charged. Add credits to continue.",
      priceCents: 5,
      balanceCents: 2,
    };
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch: recordingFetch(() => jsonResponse(body, 402)).fetch });
    await assert.rejects(wheels.use.chat("refund-helper", { messages: [{ role: "user", content: "Hi" }] }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 402);
      assert.equal(err.code, "insufficient_credits");
      assert.equal((err.data as { priceCents: number }).priceCents, 5);
      return true;
    });
  });

  it("createApiKey sends the cap for one use with the scope", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    await wheels.auth.createApiKey({ name: "buyer", scopes: ["agents:use"], maxUsePriceCents: 50, dailySpendCapCents: 2000 });
    assert.deepEqual(calls[0]!.body, { name: "buyer", scopes: ["agents:use"], maxUsePriceCents: 50, dailySpendCapCents: 2000 });
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

describe("payouts and an offering's form", () => {
  it("cancelPayout answers the cancelled payout and sends no body", async () => {
    const payout = {
      id: PAYOUT,
      amountCents: 1200,
      payoutMethod: "credits",
      payoutAddress: null,
      status: "cancelled",
      txSignature: null,
      grossRevenueCents: 1334,
      platformFeeCents: 134,
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-10-09T00:00:00.000Z",
      requestedAt: "2026-10-09T10:00:00.000Z",
      processedAt: null,
      failureReason: null,
      cancellable: false,
    };
    const { fetch, calls } = recordingFetch(() => jsonResponse({ payout }));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    const result = await wheels.marketplace.cancelPayout(PAYOUT);
    assert.deepEqual(result, { payout });
    assert.equal(result.payout.status, "cancelled");
    assert.equal(result.payout.cancellable, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url.pathname, `/api/marketplace/payouts/${PAYOUT}/cancel`);
    assert.equal(calls[0]!.rawBody, undefined);
  });

  it("cancelPayout keeps the 409 of a payout that is already being sent", async () => {
    const body = {
      error: "payout_not_cancellable",
      message: "This payout is already being sent and can no longer be cancelled.",
    };
    const { fetch } = recordingFetch(() => jsonResponse(body, 409));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    await assert.rejects(wheels.marketplace.cancelPayout(PAYOUT), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "payout_not_cancellable");
      assert.equal(err.message, body.message);
      return true;
    });
  });

  it("cancelPayout escapes the id it is given", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    await wheels.marketplace.cancelPayout("a/b?c");
    assert.equal(calls[0]!.url.pathname, "/api/marketplace/payouts/a%2Fb%3Fc/cancel");
    assert.equal(calls[0]!.url.search, "");
  });

  it("payouts lists each payout with cancellable and its failure sentence", async () => {
    const payouts = [
      { id: PAYOUT, status: "pending", cancellable: true, failureReason: null },
      {
        id: RUN,
        status: "failed",
        cancellable: false,
        failureReason: "This payout could not be sent. The amount is back in your earnings. You can request it again.",
      },
    ];
    const { fetch } = recordingFetch(() => jsonResponse({ payouts }));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    const result = await wheels.marketplace.payouts();
    assert.equal(result.payouts[0]!.cancellable, true);
    assert.equal(result.payouts[1]!.failureReason, payouts[1]!.failureReason);
  });

  it("payouts carries the sentence of a payout that is waiting to be sent", async () => {
    const waiting = "This payout is waiting to be sent. You can cancel it and keep your earnings.";
    const payouts = [
      { id: PAYOUT, status: "pending", cancellable: true, failureReason: null, message: waiting },
      { id: RUN, status: "completed", cancellable: false, failureReason: null, message: null },
    ];
    const { fetch } = recordingFetch(() => jsonResponse({ payouts }));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    const result = await wheels.marketplace.payouts();
    assert.equal(result.payouts[0]!.message, waiting);
    assert.equal(result.payouts[1]!.message, null);
  });

  it("requestPayout sends the amount asked for and answers the payout, what remains and a sentence", async () => {
    const answer = {
      payout: {
        id: PAYOUT,
        amountCents: 4120,
        payoutMethod: "crypto_usdc",
        payoutAddress: PAYER,
        status: "pending",
        txSignature: null,
        grossRevenueCents: 4578,
        platformFeeCents: 458,
        periodStart: "2026-10-01T00:00:00.000Z",
        periodEnd: "2026-10-09T00:00:00.000Z",
        requestedAt: "2026-10-09T10:00:00.000Z",
        processedAt: null,
        failureReason: null,
        message: null,
        cancellable: true,
      },
      remainingCents: 0,
      message: "Payout of $41.20 requested. It is usually sent within a few minutes.",
    };
    const { fetch, calls } = recordingFetch(() => jsonResponse(answer, 201));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, token: "session-token", fetch });
    const result = await wheels.marketplace.requestPayout({
      payoutMethod: "crypto_usdc",
      payoutAddress: PAYER,
      amountCents: 4120,
    });
    assert.deepEqual(result, answer);
    assert.equal(result.payout.cancellable, true);
    assert.equal(result.remainingCents, 0);
    assert.equal(result.message, answer.message);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url.pathname, "/api/marketplace/payouts");
    assert.deepEqual(calls[0]!.body, { payoutMethod: "crypto_usdc", payoutAddress: PAYER, amountCents: 4120 });
  });

  it("requestPayout with no amount sends none, so the API takes the largest allowed", async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse({ payout: { id: PAYOUT }, remainingCents: 0, message: "Payout of $41.20 requested as credits." }, 201),
    );
    const wheels = new WheelsAI({ baseUrl: BASE_URL, token: "session-token", fetch });
    const result = await wheels.marketplace.requestPayout({ payoutMethod: "credits" });
    assert.deepEqual(calls[0]!.body, { payoutMethod: "credits" });
    assert.equal("amountCents" in (calls[0]!.body as object), false);
    assert.equal("payoutAddress" in (calls[0]!.body as object), false);
    assert.equal(result.message, "Payout of $41.20 requested as credits.");
  });

  it("requestPayout keeps the code, the status and the sentence of each refusal", async () => {
    const refusals = [
      { status: 503, error: "payouts_unavailable", message: "Payouts are temporarily unavailable. Nothing was reserved and your earnings are unchanged. Try again later." },
      { status: 400, error: "invalid_payload", message: "We could not read that request. Check the amount and try again." },
      { status: 400, error: "payout_method_unavailable", message: "SOL payouts are not available right now. Choose USDC or credits." },
      { status: 409, error: "payout_in_progress", message: "You already have a payout in progress. Wait for it to finish, or cancel it if it has not been sent." },
      { status: 400, error: "payout_below_minimum", message: "The smallest payout is $5.00. You have $3.10 available." },
      { status: 400, error: "payout_above_balance", message: "You have $41.20 available. Request that amount or less." },
      { status: 400, error: "payout_above_limit", message: "The most for one payout to a wallet is $500.00. Request that amount or less; the rest stays in your earnings." },
      { status: 409, error: "payout_daily_limit", message: "You have reached today's limit for payouts to a wallet. You can request more after midnight UTC, or take a payout as credits now." },
      { status: 400, error: "payout_address_required", message: "Enter the wallet address to send this payout to." },
      { status: 400, error: "invalid_payout_address", message: "That is not a Solana wallet address. Check it and try again." },
      { status: 503, error: "payout_check_unavailable", message: "Payouts to a wallet are paused for a moment. Nothing was reserved and your earnings are unchanged. Try again shortly." },
      { status: 409, error: "payout_reservation_conflict", message: "Your payout balance changed while this request was processing. Please try again." },
    ];
    assert.equal(new Set(refusals.map((refusal) => refusal.error)).size, 12);
    for (const refusal of refusals) {
      const { fetch } = recordingFetch(() => jsonResponse({ error: refusal.error, message: refusal.message }, refusal.status));
      const wheels = new WheelsAI({ baseUrl: BASE_URL, token: "session-token", fetch });
      await assert.rejects(
        wheels.marketplace.requestPayout({ payoutMethod: "crypto_sol", payoutAddress: PAYER, amountCents: 4120 }),
        (err: unknown) => {
          assert.ok(err instanceof WheelsAIError, refusal.error);
          assert.equal(err.status, refusal.status, refusal.error);
          assert.equal(err.code, refusal.error);
          assert.equal(err.message, refusal.message);
          return true;
        },
      );
    }
  });

  it("revenue answers payoutLimits beside the earnings", async () => {
    const answer = {
      totalRevenueCents: 90000,
      pendingPayoutCents: 74000,
      totalListings: 2,
      totalInstalls: 31,
      revenueByListing: [],
      recentTransactions: [],
      payoutLimits: {
        minimumCents: 500,
        perPayoutCents: 50000,
        perDayCents: 100000,
        usedTodayCents: 12000,
        largestNowCents: { credits: 74000, wallet: 50000 },
        methods: ["credits", "crypto_usdc", "crypto_sol"],
      },
    };
    const { fetch, calls } = recordingFetch(() => jsonResponse(answer));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    const revenue = await wheels.marketplace.revenue();
    assert.deepEqual(revenue, answer);
    assert.equal(revenue.payoutLimits.minimumCents, 500);
    assert.equal(revenue.payoutLimits.largestNowCents.wallet, 50000);
    assert.equal(revenue.payoutLimits.largestNowCents.credits, revenue.pendingPayoutCents);
    assert.equal(revenue.payoutLimits.methods.includes("crypto_sol"), true);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.url.pathname, "/api/marketplace/revenue");
  });

  it("create and update send fromAgentForm, and the offering answers formInSync", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse({ offering: { id: OFFERING, formInSync: true } }, 201));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    const input = { ...offeringInput, fromAgentForm: true };
    const created = await wheels.offerings.create(input);
    const updated = await wheels.offerings.update(OFFERING, { fromAgentForm: true });
    assert.deepEqual(calls[0]!.body, input);
    assert.equal("inputSchema" in (calls[0]!.body as object), false);
    assert.deepEqual(calls[1]!.body, { fromAgentForm: true });
    assert.equal(created.offering.formInSync, true);
    assert.equal(updated.offering.formInSync, true);
  });

  it("keeps the 409 of an agent that is not a task agent", async () => {
    const body = { error: "not_a_task_agent", message: "Only a task agent has a form to take." };
    const { fetch } = recordingFetch(() => jsonResponse(body, 409));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    await assert.rejects(wheels.offerings.update(OFFERING, { fromAgentForm: true }), (err: unknown) => {
      assert.ok(err instanceof WheelsAIError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "not_a_task_agent");
      return true;
    });
  });
});

describe("adding credits from a wallet", () => {
  const prepared = {
    topupId: TOPUP,
    unsignedTxBase64: "dW5zaWduZWQ=",
    depositAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    payerAddress: PAYER,
    asset: "SOL",
    amountUsd: 50,
    bonusUsd: 5,
    amountRaw: "453514740",
    quotedSolPriceUsd: 110.25,
    quote: { solPriceUsd: 110.25, validUntil: "2026-10-10T12:01:00.000Z" },
    opensUsdcAccount: false,
    expiresAt: "2026-10-10T12:01:00.000Z",
    message: "1 SOL = $110.25. This price holds for 60 seconds. Confirm the transfer in your wallet.",
  };

  it("prepare sends the payer only when one is given, and answers the transfer to sign", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(prepared));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    const result = await wheels.billing.topups.prepare({ amountUsd: 50, asset: "SOL" });
    assert.deepEqual(calls[0]!.body, { amountUsd: 50, asset: "SOL" });
    assert.equal("payerAddress" in (calls[0]!.body as object), false);
    assert.deepEqual(result, prepared);
    assert.equal(typeof result.amountRaw, "string", "base units stay a string");
    assert.equal(result.quote?.solPriceUsd, 110.25);
  });

  it("a USDC top-up has no quote", async () => {
    const usdc = { ...prepared, asset: "USDC", amountRaw: "50000000", quote: null, opensUsdcAccount: true, message: "Confirm the transfer in your wallet." };
    delete (usdc as { quotedSolPriceUsd?: number }).quotedSolPriceUsd;
    const { fetch } = recordingFetch(() => jsonResponse(usdc));
    const result = await new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }).billing.topups.prepare({ amountUsd: 50, asset: "USDC", payerAddress: PAYER });
    assert.equal(result.quote, null);
    assert.equal(result.quotedSolPriceUsd, undefined);
    assert.equal(result.opensUsdcAccount, true);
  });

  it("submit answers a confirmed top-up with what was added", async () => {
    const credited = {
      status: "credited",
      message: "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
      txSignature: "5sig",
      grantedUsd: 55,
      balanceUsd: 67.5,
    };
    const { fetch } = recordingFetch(() => jsonResponse(credited));
    const result = await new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }).billing.topups.submit(TOPUP, "c2lnbmVk");
    assert.deepEqual(result, credited);
    assert.equal(isTopupFinal(result.status), true);
  });

  it("submit answers 202 as a result, not an error, while the transfer is being confirmed", async () => {
    const pending = {
      status: "submitted",
      message: "Your transfer was sent and is being confirmed. Your credits appear as soon as it is, usually within a minute. You can leave this page.",
      txSignature: "5sig",
      pendingConfirmation: true,
    };
    const { fetch } = recordingFetch(() => jsonResponse(pending, 202));
    const result = await new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }).billing.topups.submit(TOPUP, "c2lnbmVk");
    assert.deepEqual(result, pending);
    assert.equal(result.pendingConfirmation, true);
    assert.equal(isTopupFinal(result.status), false);
  });

  it("reconcile sends an empty object and answers where the top-up stands", async () => {
    const expired = {
      status: "expired",
      message: "The network did not take this transfer, so nothing was taken. Check your wallet balance and start the top-up again.",
    };
    const { fetch, calls } = recordingFetch(() => jsonResponse(expired));
    const result = await new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }).billing.topups.reconcile(TOPUP);
    assert.equal(calls[0]!.rawBody, "{}");
    assert.deepEqual(result, expired);
    assert.equal(isTopupFinal(result.status), true);
  });

  it("get and list answer top-ups with a sentence and no raw failure text", async () => {
    const topup = {
      id: TOPUP,
      status: "failed",
      message: "This transfer failed on the network, so no payment was taken. Check your wallet balance and start the top-up again.",
      asset: "USDC",
      amountUsd: 10,
      bonusUsd: 0,
      txSignature: "5sig",
      depositAddress: prepared.depositAddress,
      payerAddress: PAYER,
      createdAt: "2026-10-10T12:00:00.000Z",
      expiresAt: "2026-10-10T12:02:00.000Z",
    };
    const { fetch } = recordingFetch((call) => jsonResponse(call.url.pathname.endsWith("/topups") ? { topups: [topup] } : topup));
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    assert.deepEqual(await wheels.billing.topups.get(TOPUP), topup);
    const listed = await wheels.billing.topups.list();
    assert.deepEqual(listed, { topups: [topup] });
    assert.equal(listed.topups[0]!.message, topup.message);
  });

  it("isTopupFinal is true only for a top-up that will not change again", () => {
    assert.deepEqual(
      ["prepared", "submitting", "submitted", "credited", "failed", "expired"].map((s) => [s, isTopupFinal(s)]),
      [["prepared", false], ["submitting", false], ["submitted", false], ["credited", true], ["failed", true], ["expired", true]],
    );
  });

  const refusals: Array<{ call: string; status: number; error: string; message: string; run: (w: WheelsAI) => Promise<unknown> }> = [
    { call: "prepare", status: 400, error: "wallet_required", message: "Connect a Solana wallet to pay. The wallet you connect signs the transfer.", run: (w) => w.billing.topups.prepare({ amountUsd: 50, asset: "USDC" }) },
    { call: "prepare", status: 400, error: "invalid_payer_address", message: "That is not a Solana wallet address. Connect a wallet and try again.", run: (w) => w.billing.topups.prepare({ amountUsd: 50, asset: "USDC", payerAddress: "nope" }) },
    { call: "prepare", status: 400, error: "invalid_amount", message: "Choose an amount between $5 and $10,000.", run: (w) => w.billing.topups.prepare({ amountUsd: 1, asset: "USDC", payerAddress: PAYER }) },
    { call: "prepare", status: 400, error: "asset_unavailable", message: "SOL is not available here right now. Pay with USDC.", run: (w) => w.billing.topups.prepare({ amountUsd: 50, asset: "SOL", payerAddress: PAYER }) },
    { call: "prepare", status: 503, error: "price_unavailable", message: "We could not get a current SOL price, so nothing was prepared. Pay with USDC, or try again in a minute.", run: (w) => w.billing.topups.prepare({ amountUsd: 50, asset: "SOL", payerAddress: PAYER }) },
    { call: "prepare", status: 409, error: "wallet_balance_short", message: "This wallet holds 3.20 USDC, which is less than this top-up needs. Choose a smaller amount or another wallet.", run: (w) => w.billing.topups.prepare({ amountUsd: 50, asset: "USDC", payerAddress: PAYER }) },
    { call: "prepare", status: 501, error: "wallet_topups_not_enabled", message: "Wallet payments are paused for a moment. Nothing was taken. Try again shortly.", run: (w) => w.billing.topups.prepare({ amountUsd: 50, asset: "USDC", payerAddress: PAYER }) },
    { call: "submit", status: 400, error: "message_mismatch", message: "The signed transfer does not match the one we prepared, so it was not sent. Nothing was taken. Start the top-up again.", run: (w) => w.billing.topups.submit(TOPUP, "b3RoZXI=") },
    { call: "submit", status: 409, error: "in_flight", message: "This top-up is already being confirmed. You do not need to send it again.", run: (w) => w.billing.topups.submit(TOPUP, "b3RoZXI=") },
    { call: "submit", status: 410, error: "topup_expired", message: "This top-up ran out of time before it was sent. Nothing was taken. Start it again.", run: (w) => w.billing.topups.submit(TOPUP, "c2lnbmVk") },
    { call: "submit", status: 503, error: "chain_unavailable", message: "Wallet payments are paused for a moment. Nothing was taken. Try again shortly.", run: (w) => w.billing.topups.submit(TOPUP, "c2lnbmVk") },
  ];
  for (const refusal of refusals) {
    it(`${refusal.call} keeps the ${refusal.status} ${refusal.error} and its sentence`, async () => {
      const { fetch } = recordingFetch(() => jsonResponse({ error: refusal.error, message: refusal.message }, refusal.status));
      const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
      await assert.rejects(refusal.run(wheels), (err: unknown) => {
        assert.ok(err instanceof WheelsAIError);
        assert.equal(err.status, refusal.status);
        assert.equal(err.code, refusal.error);
        assert.equal(err.message, refusal.message);
        return true;
      });
    });
  }

  it("refuses an empty top-up id before anything is sent", async () => {
    const { fetch, calls } = recordingFetch();
    const wheels = new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
    assert.throws(() => wheels.billing.topups.get(""), WheelsAIError);
    assert.throws(() => wheels.billing.topups.submit("..", "c2lnbmVk"), WheelsAIError);
    assert.equal(calls.length, 0);
  });
});

describe("adding credits by sending to the organization's address", () => {
  const ADDRESS = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  const SHOWN = "Send USDC or SOL on Solana to this address. It belongs to your organization only.";
  const HOW = "USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes.";
  const NOT_ISSUED = "Your organization has no deposit address yet.";
  const PAUSED = "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly.";
  const WAITING = "We have seen your transfer of 0.5 SOL. It is credited as soon as we can get a current SOL price.";

  const issued: DepositAddress = {
    address: ADDRESS,
    network: "mainnet-beta",
    assets: [
      { asset: "USDC", accountOpen: false },
      { asset: "SOL", offered: true },
    ],
    message: `${SHOWN} ${HOW}`,
  };

  const client = (respond: (call: RecordedCall) => Response) => {
    const { fetch, calls } = recordingFetch(respond);
    return { wheels: new WheelsAI({ baseUrl: BASE_URL, apiKey: API_KEY, fetch }), calls };
  };

  it("get answers no address before one is issued, and sends no body", async () => {
    const none: DepositAddress = {
      address: null,
      network: "devnet",
      assets: [
        { asset: "USDC", accountOpen: false },
        { asset: "SOL", offered: false },
      ],
      message: NOT_ISSUED,
    };
    const { wheels, calls } = client(() => jsonResponse(none));
    const result = await wheels.billing.depositAddress.get();
    assert.deepEqual(result, none);
    assert.equal(result.address, null);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.rawBody, undefined);
  });

  it("issue answers the address with what it can receive, and sends no body", async () => {
    const { wheels, calls } = client(() => jsonResponse(issued));
    const result = await wheels.billing.depositAddress.issue();
    assert.deepEqual(result, issued);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.rawBody, undefined);

    // Each entry reads by its asset: USDC says whether its account is open, SOL whether it is offered.
    const read = (entry: DepositAddressAsset) => (entry.asset === "USDC" ? entry.accountOpen : entry.offered);
    assert.deepEqual(result.assets.map((entry) => [entry.asset, read(entry)]), [["USDC", false], ["SOL", true]]);
  });

  it("prepareUsdc answers that the account is open, and sends no body", async () => {
    const prepared: PreparedDepositAddress = { accountOpen: true, message: "Your address can now receive USDC." };
    const { wheels, calls } = client(() => jsonResponse(prepared));
    const result = await wheels.billing.depositAddress.prepareUsdc();
    assert.deepEqual(result, prepared);
    assert.equal(calls[0]!.rawBody, undefined);
  });

  it("prepareUsdc waits longer than an ordinary call by default, and options.timeoutMs replaces it", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const wheels = new WheelsAI({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 0,
      fetch: async (_input, init) => {
        seen.push(init?.signal);
        return jsonResponse({ accountOpen: true, message: "Your address can now receive USDC." });
      },
    });
    await wheels.billing.depositAddress.prepareUsdc();
    await wheels.billing.depositAddress.prepareUsdc({ timeoutMs: 0 });
    await wheels.billing.depositAddress.check();
    assert.ok(seen[0], "the call has a timeout of its own, whatever the client's is");
    assert.equal(seen[1], undefined, "timeoutMs 0 disables it");
    assert.equal(seen[2], undefined, "check waits as the client is set to");
  });

  it("prepareUsdc waits 90 seconds, longer than the API looks for the account, unless a timeout is given", async () => {
    // The API can look for the account for 45 seconds; the client's ordinary wait is 30.
    const asked: number[] = [];
    const original = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => {
      asked.push(ms);
      return original.call(AbortSignal, ms);
    };
    try {
      const { wheels } = client(() => jsonResponse({ accountOpen: true, message: "Your address can now receive USDC." }));
      await wheels.billing.depositAddress.prepareUsdc();
      await wheels.billing.depositAddress.prepareUsdc({ headers: { "x-trace": "1" } });
      await wheels.billing.depositAddress.prepareUsdc({ timeoutMs: undefined });
      await wheels.billing.depositAddress.prepareUsdc({ timeoutMs: 120_000 });
      await wheels.billing.depositAddress.check();
    } finally {
      AbortSignal.timeout = original;
    }
    assert.deepEqual(asked, [90_000, 90_000, 90_000, 120_000, 30_000]);
    assert.ok(asked[0]! > 45_000);
  });

  it("check answers what it credited, as amounts in whole units and dollars", async () => {
    const credited: CreditedDeposit[] = [
      { asset: "USDC", amount: "50.00", creditedUsd: 50, bonusUsd: 5, txSignature: "5usdc" },
      { asset: "SOL", amount: "0.05", creditedUsd: 7.4, bonusUsd: 0, txSignature: "5sol" },
    ];
    const answer: DepositCheck = { credited, waiting: [], message: "Credited $62.40 from 2 transfers." };
    const { wheels, calls } = client(() => jsonResponse(answer));
    const result = await wheels.billing.depositAddress.check();
    assert.deepEqual(result, answer);
    assert.equal(typeof result.credited[0]!.amount, "string", "an amount stays a string");
    assert.equal(result.credited[0]!.creditedUsd + result.credited[0]!.bonusUsd, 55);
    assert.equal(calls[0]!.rawBody, undefined);
  });

  it("check answers a transfer that waits for a price, and nothing new as an empty answer", async () => {
    const waiting: WaitingDeposit[] = [{ asset: "SOL", amount: "0.5", txSignature: "5sol" }];
    const answers: DepositCheck[] = [
      { credited: [], waiting, message: WAITING },
      { credited: [], waiting: [], message: "No new transfer yet. Transfers usually arrive within a few minutes." },
    ];
    let next = 0;
    const { wheels } = client(() => jsonResponse(answers[next++]));
    assert.deepEqual(await wheels.billing.depositAddress.check(), answers[0]);
    assert.deepEqual(await wheels.billing.depositAddress.check(), answers[1]);
  });

  it("deposits.list answers each transfer with its status and its sentence", async () => {
    const deposits: Deposit[] = [
      { id: "d3", asset: "SOL", amount: "0.5", status: "waiting", creditedUsd: null, bonusUsd: null, txSignature: "5c", createdAt: "2026-10-11T12:02:00.000Z", creditedAt: null, message: WAITING },
      { id: "d2", asset: "USDC", amount: "0.000001", status: "ignored", creditedUsd: null, bonusUsd: null, txSignature: "5b", createdAt: "2026-10-11T12:01:00.000Z", creditedAt: null, message: "This transfer was too small to credit." },
      { id: "d1", asset: "USDC", amount: "50.00", status: "credited", creditedUsd: 50, bonusUsd: 5, txSignature: "5a", createdAt: "2026-10-11T12:00:00.000Z", creditedAt: "2026-10-11T12:00:40.000Z", message: "Credited $55.00: $50.00 sent and a $5.00 bonus." },
    ];
    const { wheels } = client(() => jsonResponse({ deposits }));
    const result = await wheels.billing.deposits.list();
    assert.deepEqual(result, { deposits });
    const statuses: DepositStatus[] = result.deposits.map((d) => d.status);
    assert.deepEqual(statuses, ["waiting", "ignored", "credited"]);
    const assets: DepositAsset[] = result.deposits.map((d) => d.asset);
    assert.deepEqual(assets, ["SOL", "USDC", "USDC"]);
    assert.equal(result.deposits[0]!.creditedUsd, null, "nothing is credited until it is");
  });

  const refusals: Array<{ call: string; status: number; error: string; message: string; run: (w: WheelsAI) => Promise<unknown> }> = [
    { call: "get", status: 501, error: "deposits_not_enabled", message: PAUSED, run: (w) => w.billing.depositAddress.get() },
    { call: "get", status: 503, error: "deposit_address_unavailable", message: PAUSED, run: (w) => w.billing.depositAddress.get() },
    { call: "issue", status: 501, error: "deposits_not_enabled", message: PAUSED, run: (w) => w.billing.depositAddress.issue() },
    { call: "issue", status: 503, error: "deposit_address_unavailable", message: PAUSED, run: (w) => w.billing.depositAddress.issue() },
    { call: "prepareUsdc", status: 404, error: "deposit_address_not_issued", message: NOT_ISSUED, run: (w) => w.billing.depositAddress.prepareUsdc() },
    { call: "prepareUsdc", status: 403, error: "not_eligible", message: "Verify your email or make one purchase first, then prepare the address.", run: (w) => w.billing.depositAddress.prepareUsdc() },
    { call: "prepareUsdc", status: 429, error: "daily_limit", message: "The address cannot be prepared right now. Send SOL, or try again later.", run: (w) => w.billing.depositAddress.prepareUsdc() },
    { call: "prepareUsdc", status: 503, error: "unavailable", message: "The address cannot be prepared right now. Try again later.", run: (w) => w.billing.depositAddress.prepareUsdc() },
    { call: "prepareUsdc", status: 501, error: "deposits_not_enabled", message: PAUSED, run: (w) => w.billing.depositAddress.prepareUsdc() },
    { call: "check", status: 404, error: "deposit_address_not_issued", message: NOT_ISSUED, run: (w) => w.billing.depositAddress.check() },
    { call: "check", status: 503, error: "chain_unavailable", message: PAUSED, run: (w) => w.billing.depositAddress.check() },
    { call: "check", status: 501, error: "deposits_not_enabled", message: PAUSED, run: (w) => w.billing.depositAddress.check() },
    { call: "deposits.list", status: 501, error: "deposits_not_enabled", message: PAUSED, run: (w) => w.billing.deposits.list() },
    { call: "deposits.list", status: 503, error: "deposit_address_unavailable", message: PAUSED, run: (w) => w.billing.deposits.list() },
  ];
  for (const refusal of refusals) {
    it(`${refusal.call} keeps the ${refusal.status} ${refusal.error} and its sentence`, async () => {
      const { wheels } = client(() => jsonResponse({ error: refusal.error, message: refusal.message }, refusal.status));
      await assert.rejects(refusal.run(wheels), (err: unknown) => {
        assert.ok(err instanceof WheelsAIError);
        assert.equal(err.status, refusal.status);
        assert.equal(err.code, refusal.error);
        assert.equal(err.message, refusal.message);
        return true;
      });
    });
  }
});
