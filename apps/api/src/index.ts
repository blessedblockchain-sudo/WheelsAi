import "dotenv/config";
import { Redis } from "ioredis";
import { syncModelCatalog, type ModelCatalogDb } from "./services/syncModelCatalog.js";
import { emailAuthRoutes } from "./routes/emailAuth.js";
import { stripeWebhookRoutes } from "./routes/stripeWebhook.js";
import { contactRoutes } from "./routes/contact.js";
import { disconnectPlanUsage } from "./services/orgPlan.js";
import { prisma } from "./lib/prisma.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { installBigIntJsonSerializer } from "./lib/bigintJson.js";
import { corsOptionsFor } from "./lib/corsPolicy.js";
import { globalErrorHandler } from "./lib/errorHandler.js";
import { sanitizeErrorPayloadHook } from "./lib/sanitizeErrorPayload.js";

// Precision-safe BigInt JSON serialization (Prisma surfaces BigInt columns
// API-wide) — installed before any route can serialize a response. The
// naive `Number(bigint)` corrupts values above 2^53; see the module (D9).
installBigIntJsonSerializer();

import { env } from "./config/env.js";
import { createLogger, logger } from "./utils/logger.js";
import { initSentry, registerSentryErrorCapture } from "./lib/sentry.js";
import { BAGS_ADAPTER_IMPLEMENTED } from "./services/launchpad/bagsAdapter.js";
import { registerAuthPlugins } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { modelRoutes } from "./routes/models.js";
import { healthRoutes } from "./routes/health.js";
import { createMetricsRoutes } from "./routes/metrics.js";
import { buildMetricsRuntime } from "./services/buildMetricsDeps.js";
import { cancelInFlightGraphRuns } from "./services/runAgentGraph.js";
import { inferenceRoutes } from "./routes/inference.js";
import { openAiV1Routes } from "./routes/openaiV1.js";
import { billingRoutes } from "./routes/billing.js";
import { settingsRoutes } from "./routes/settings.js";
import { agentRoutes } from "./routes/agents.js";
import { trainingRoutes } from "./routes/training.js";
import { logTrainingReadiness } from "./services/buildTrainingDeps.js";
import { logOperatorReadiness } from "./services/operatorReadiness.js";
import { createStorageTransferRoutesProduction } from "./routes/storageTransfer.js";
import { createFineTunedModelRoutesProduction } from "./routes/fineTunedModels.js";
import { FINE_TUNED_MODELS_PREFIX } from "./services/fineTunedModels.js";
import { STORAGE_TRANSFER_PREFIX } from "./services/objectStore.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import {
  createJobRoutesProduction,
  createOfferingRoutesProduction,
} from "./routes/jobBindings.js";
import { reputationRoutes } from "./routes/reputation.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { enterpriseRoutes } from "./routes/enterprise.js";
import { agentGraphRoutes } from "./routes/agentGraph.js";
import { monitoringRoutes } from "./routes/monitoring.js";
import { versioningRoutes } from "./routes/versioning.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { skillsRoutes } from "./routes/skills.js";
import { createPublicStatsRoutes } from "./routes/publicStats.js";
import { statusRoutes } from "./routes/status.js";
import { createCapabilitiesRoutesProduction } from "./routes/capabilitiesBindings.js";
import { createPlatformComputeRoutesProduction } from "./routes/platformComputeBindings.js";
import { testingRoutes } from "./routes/testing.js";
import { memoryRoutes } from "./routes/memory.js";
import { domainsRoutes } from "./routes/domains.js";
import {
  createCustomDomainEdgeProduction,
  createCustomDomainEdgeRoutesProduction,
} from "./routes/customDomainEdgeBindings.js";
import { schedulerRoutes } from "./routes/scheduler.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import { acceptEmptyJsonBody } from "./routes/emptyJsonBody.js";
import { templateRoutes } from "./routes/templates.js";
import { twoFactorRoutes } from "./routes/twoFactor.js";
import { x402Routes } from "./routes/x402.js";
import { openclawRoutes } from "./routes/openclaw.js";
import { tokenRoutes } from "./routes/tokens.js";
import { createPartialSignTokenRoutesProduction } from "./routes/tokenLaunchPartialSignBindings.js";
import { createWalletTopupRoutesProduction } from "./routes/walletTopupBindings.js";
import {
  createSlackOAuthRoutesProduction,
  createSlackEventsRoutesProduction,
} from "./routes/slackOAuthBindings.js";
import { createGitHubAppRoutesProduction } from "./routes/githubAppBindings.js";
import {
  createPublicAgentRoutesProduction,
  createAgentDetailRoutesProduction,
  createAgentListRoutesProduction,
} from "./routes/transparencyBindings.js";
import { playgroundRoutes } from "./routes/playground.js";
import { createAgentRunRoutesProduction } from "./routes/agentRunBindings.js";
import { createAgentPublicLinkRoutesProduction } from "./routes/agentPublicLinkBindings.js";
import { createAgentScheduleRoutesProduction } from "./routes/agentScheduleBindings.js";
import {
  cancelInFlightAgentChats,
  closeAgentChatConnections,
} from "./services/buildAgentChatDeps.js";
import { closeLatencySink } from "./services/buildLatencySampleDeps.js";
import { processPublicLatency } from "./services/buildPublicLatencyDeps.js";
import { collaborationRoutes } from "./routes/collaboration.js";
import { closePublicChatConnections, warmPublicChatLimiter } from "./services/buildPublicChatDeps.js";
import { createTryItRoutesProduction } from "./routes/tryItBindings.js";
import { createWebChannelRoutesProduction } from "./routes/webChannelBindings.js";
import { createWidgetRoutesProduction } from "./routes/widgetBindings.js";
import { createChannelWebhookRoutesProduction } from "./routes/channelWebhookBindings.js";
import {
  startX402Queue,
  stopX402Queue,
  startTokenIndexerQueue,
  stopTokenIndexerQueue,
  startTreasurySettlementQueue,
  stopTreasurySettlementQueue,
  startPaymentSubmitQueue,
  stopPaymentSubmitQueue,
  startPaymentPollQueue,
  stopPaymentPollQueue,
  startPaymentReapQueue,
  stopPaymentReapQueue,
  startFeeRouterQueue,
  stopFeeRouterQueue,
  startReputationAttestationQueue,
  stopReputationAttestationQueue,
  startDeploymentStatusQueue,
  stopDeploymentStatusQueue,
  startGpuBillingQueue,
  stopGpuBillingQueue,
  startTrainingPollerQueue,
  stopTrainingPollerQueue,
  startAgentMessageQueue,
  stopAgentMessageQueue,
  startSchedulerQueue,
  stopSchedulerQueue,
  startWorkflowRunQueue,
  stopWorkflowRunQueue,
  startJobRunnerQueue,
  stopJobRunnerQueue,
  startJobSweeperQueue,
  stopJobSweeperQueue,
  startTrialChargeReapQueue,
  stopTrialChargeReapQueue,
  startUptimeProberQueue,
  stopUptimeProberQueue,
  startCustomDomainCheckQueue,
  stopCustomDomainCheckQueue,
  startAlertEvaluatorQueue,
  stopAlertEvaluatorQueue,
  startAnalyticsSnapshotQueue,
  stopAnalyticsSnapshotQueue,
  startSubscriptionRenewalQueue,
  stopSubscriptionRenewalQueue,
  startPayoutExecutorQueue,
  stopPayoutExecutorQueue,
  startEmbeddingBackfillQueue,
  stopEmbeddingBackfillQueue,
  assertQueueRedisReady,
} from "./queues/index.js";

async function main() {
  // Fail-fast: the Bags adapter is mainnet-only and currently a scaffold.
  // Selecting it without a real implementation would boot "healthy" and
  // then throw on the first launch request — die on boot instead.
  if (env.LAUNCHPAD === "bags" && !BAGS_ADAPTER_IMPLEMENTED) {
    // Mirror the env.ts boot-fatal pattern (console.error + exit) — this
    // runs before the Fastify logger is set up.
    console.error(
      "LAUNCHPAD=bags is not yet supported (the Bags adapter is a scaffold). " +
        "Set LAUNCHPAD=pumpfun.",
    );
    process.exit(1);
  }

  // Error tracking (B7): a no-op without SENTRY_DSN. Init also installs
  // Sentry's default uncaught-exception/unhandled-rejection handlers,
  // which is what catches worker crashes outside the request path.
  const sentryEnabled = initSentry({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
  });
  createLogger("sentry").info(
    { sentry: sentryEnabled },
    sentryEnabled ? "Sentry error tracking enabled" : "Sentry disabled (no SENTRY_DSN)",
  );

  // Custom domains: requests the edge proxy forwards for a customer hostname
  // are routed by that hostname. A request without the edge's header is
  // untouched.
  const customDomainEdge = createCustomDomainEdgeProduction();

  const app = Fastify({
    logger: logger as any,
    rewriteUrl: customDomainEdge.rewriteUrl,
    // Trust exactly the proxies in front of us (Fly's edge = 1 hop). With
    // `true`, request.ip was the LEFTMOST X-Forwarded-For entry, which the
    // client writes, so every per-IP rate limit could be bypassed by
    // rotating that header.
    trustProxy: env.TRUST_PROXY_HOPS,
  });

  if (sentryEnabled) {
    // onError hook (not setErrorHandler) — composes with the
    // globalErrorHandler below and only reports 5xx-class errors.
    registerSentryErrorCapture(app);
  }

  // Register plugins
  // Two policies, chosen per request (lib/corsPolicy.ts): the web app's
  // origin with credentials everywhere, except the two public widget paths,
  // which answer any origin without credentials and check the key's own
  // allowed origins in the route.
  const corsConfig = { corsOrigin: env.CORS_ORIGIN, isDev: env.NODE_ENV === "development" };
  await app.register(cors, {
    delegator: (request, callback) => callback(null, corsOptionsFor(request, corsConfig)),
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  // Counters live in Redis so limits hold across machines (an in-memory
  // store gave each machine its own budget). If Redis is unreachable the
  // limiter lets requests through rather than taking the API down.
  const rateLimitRedis = new Redis(env.REDIS_URL, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  rateLimitRedis.on("error", (err) =>
    createLogger("rate-limit").warn({ err }, "rate-limit Redis error"),
  );
  app.addHook("onClose", async () => {
    rateLimitRedis.disconnect();
    disconnectPlanUsage();
    // Agent chat's tool-continuation Redis (opened on the first chat).
    await closeAgentChatConnections();
    // Writes the last interval of latency samples still held in memory.
    await closeLatencySink();
    // The fail-closed limiter of the web widget and Try it.
    await closePublicChatConnections();
  });
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX_PER_MINUTE ?? 100),
    timeWindow: "1 minute",
    redis: rateLimitRedis,
    nameSpace: "wheelsai-rl:",
    skipOnError: true,
    keyGenerator: (request) => request.ip,
  });

  await app.register(sensible);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "WheelsAI API",
        description: "Build, deploy, and monetize AI agents. API documentation for the WheelsAI platform.",
        version: "0.1.0",
      },
      servers: [
        { url: "http://localhost:4000", description: "Development" },
      ],
      tags: [
        { name: "Auth", description: "Authentication and authorization" },
        { name: "Agents", description: "Agent CRUD, deployment, and GitHub import" },
        { name: "Collaboration", description: "Agent contributors and revenue sharing" },
        { name: "Deployments", description: "Deployment management" },
        { name: "Models", description: "Model catalog and free models" },
        { name: "Playground", description: "Agent testing playground" },
        { name: "Marketplace", description: "Agent marketplace" },
        { name: "Tokens", description: "Agent token marketplace and bonding curves" },
        { name: "Templates", description: "Agent templates" },
        { name: "Billing", description: "Credits and billing" },
        { name: "Analytics", description: "Usage analytics and insights" },
        { name: "Training", description: "Model fine-tuning (LoRA/QLoRA)" },
        { name: "OpenClaw", description: "Managed OpenClaw deployments" },
        { name: "Knowledge", description: "RAG knowledge bases" },
        { name: "Monitoring", description: "Alerts and uptime monitoring" },
        { name: "OpenAI-compatible", description: "The /v1 API for agents, workflows and model deployments" },
      ],
      components: {
        securitySchemes: {
          // The one header authentication reads. An API key is sent the
          // same way as a session token; there is no X-API-Key header.
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "Authorization: Bearer <token>. The token is an API key (wheels_..., created in the dashboard under API Keys) or a session JWT. The dashboard itself authenticates with an httpOnly session cookie.",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // Register auth plugins (JWT, cookies)
  await registerAuthPlugins(app);

  // After the auth plugin (the guard reads request.auth) and before every
  // route plugin (a plugin inherits only the hooks present when it registers).
  customDomainEdge.install(app);

  // Prometheus metrics (H1). Registered before the feature routes so the
  // onResponse timing hook below sees every one of them. Both fly tomls have
  // pointed `[metrics] path = "/metrics"` at this app since the first deploy
  // config; until now that scrape returned 404.
  const metrics = buildMetricsRuntime();
  await app.register(
    createMetricsRoutes({ registry: metrics.registry, token: env.METRICS_TOKEN }),
  );
  app.addHook("onResponse", async (request, reply) => {
    // routeOptions.url is the PATTERN ("/api/agents/:agentId"), so ids never
    // become label values and cardinality stays bounded. Unmatched requests
    // collapse to a single "unmatched" series rather than one per 404 path,
    // which is what a scanner would otherwise blow the metric store up with.
    metrics.observeRequest({
      method: request.method,
      route: request.routeOptions?.url ?? "unmatched",
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / 1000,
    });
  });

  // Scrub internal detail from EVERY outgoing error body. ~109 route
  // handlers catch their own errors and echo `error.message`, which
  // bypasses the error handler below — and Prisma renders failed calls
  // with an absolute path, a source code frame, and the data payload
  // (secrets included). Registered here, before the routes, for the same
  // encapsulation reason as the error handler.
  app.addHook("onSend", sanitizeErrorPayloadHook as never);

  // Global error handler — maps ZodError (bare .parse() in routes) to 400,
  // Fastify schema-validation to 400, else statusCode-aware fallback (F1).
  //
  // MUST be installed BEFORE the route plugins below. `register()` creates
  // an encapsulated child context that captures the error handler present
  // at registration time, so setting it afterwards leaves every route on
  // Fastify's default handler — which returns 500 for a ZodError and
  // echoes internal error messages. That is exactly what was happening:
  // an invalid uuid path param answered 500 with the raw Zod issue list.
  app.setErrorHandler(globalErrorHandler);

  // A JSON content type with no body ("run now", "cancel", any client that
  // always sets the header) reaches its handler instead of Fastify's parser
  // 400. At the root, before the routes, so every plugin inherits it; the
  // webhook plugins that verify signatures over raw bytes replace it in
  // their own scope.
  acceptEmptyJsonBody(app);

  // Register routes
  await app.register(healthRoutes, { prefix: "/health" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(emailAuthRoutes, { prefix: "/api/auth" });
  await app.register(stripeWebhookRoutes, { prefix: "/api/billing/stripe" });
  await app.register(contactRoutes, { prefix: "/api" });
  await app.register(modelRoutes, { prefix: "/api/models" });
  await app.register(deploymentRoutes, { prefix: "/api/deployments" });
  await app.register(agentRoutes, { prefix: "/api/agents" });
  await app.register(trainingRoutes, { prefix: "/api/training" });
  // Bytes in and out of the development-only local object store; with the s3
  // driver (or no storage) both routes answer 404.
  await app.register(createStorageTransferRoutesProduction(), {
    prefix: STORAGE_TRANSFER_PREFIX,
  });
  // An organization's fine-tuned models, and the adapter archive a
  // deployment's container fetches with its signed URL (no session).
  await app.register(createFineTunedModelRoutesProduction(), {
    prefix: FINE_TUNED_MODELS_PREFIX,
  });
  await app.register(billingRoutes, { prefix: "/api/billing" });
  // Slack install + the distributed-app events endpoint (W2). Both are
  // ALWAYS mounted and answer 501 when Slack is unconfigured: Slack must
  // be able to probe the Events Request URL before any install exists,
  // and a 404 would make "not configured" look like "broken".
  await app.register(createSlackOAuthRoutesProduction(), {
    prefix: "/api/integrations",
  });
  await app.register(createSlackEventsRoutesProduction(), {
    prefix: "/api/channels",
  });

  // GitHub App: install/callback + the push webhook (W2). Always mounted
  // and 501 when unconfigured — GitHub must be able to reach the webhook
  // URL during App setup, before anything is installed.
  await app.register(createGitHubAppRoutesProduction(), {
    prefix: "/api/integrations",
  });

  // Wallet top-up rail (B2/T5): /api/billing/topups/*. Always mounted —
  // when WALLET_TOPUPS_ENABLED is false the routes answer 501 honestly
  // instead of 404ing.
  await app.register(createWalletTopupRoutesProduction(), {
    prefix: "/api/billing",
  });
  await app.register(settingsRoutes, { prefix: "/api/settings" });
  await app.register(marketplaceRoutes, { prefix: "/api/marketplace" });
  // Try it: /api/marketplace/listings/:slug/try (public, within limits that
  // fail closed) and the publisher's /listings/:id/trial.
  await app.register(createTryItRoutesProduction(), { prefix: "/api/marketplace" });
  // Offerings and Jobs: a publisher's product hired for a fixed task, paid
  // through escrow.
  await app.register(createOfferingRoutesProduction(), { prefix: "/api/offerings" });
  await app.register(createJobRoutesProduction(), { prefix: "/api/jobs" });
  await app.register(reputationRoutes, { prefix: "/api/reputation" });
  await app.register(analyticsRoutes, { prefix: "/api/analytics" });
  await app.register(enterpriseRoutes, { prefix: "/api/enterprise" });
  await app.register(agentGraphRoutes, { prefix: "/api" }); // Graph routes at /api/agents/:id/graph
  await app.register(monitoringRoutes, { prefix: "/api/monitoring" });
  await app.register(versioningRoutes, { prefix: "/api/versioning" });
  await app.register(webhooksRoutes, { prefix: "/api" });
  await app.register(testingRoutes, { prefix: "/api/testing" });
  await app.register(memoryRoutes, { prefix: "/api/memory" });
  await app.register(domainsRoutes, { prefix: "/api/domains" });
  // The edge's certificate question and the /__edge answers. Always mounted:
  // unconfigured, the question answers 501 with the reason.
  await app.register(createCustomDomainEdgeRoutesProduction(customDomainEdge));
  await app.register(schedulerRoutes, { prefix: "/api/scheduler" });
  await app.register(knowledgeRoutes, { prefix: "/api/knowledge" });
  await app.register(orchestrationRoutes, { prefix: "/api/orchestrations" });
  await app.register(templateRoutes, { prefix: "/api/templates" });
  await app.register(twoFactorRoutes, { prefix: "/api/2fa" });
  await app.register(x402Routes, { prefix: "/api/x402" });
  await app.register(openclawRoutes, { prefix: "/api/openclaw" });
  await app.register(tokenRoutes, { prefix: "/api/tokens" });
  // Browser-partial-sign launch path (POST /api/tokens/launch/prepare
  // and POST /api/tokens/launch/submit). The legacy /api/tokens/create
  // path (custodial) stays mounted under tokenRoutes during the
  // transition. Production wiring needs WALLET_MASTER_KEY; the
  // factory throws at boot if it's missing, which is the right behavior
  // (don't ship a launch surface that silently can't sign tokens).
  if (env.WALLET_MASTER_KEY) {
    await app.register(createPartialSignTokenRoutesProduction(), {
      prefix: "/api/tokens",
    });
  } else {
    app.log.warn(
      "WALLET_MASTER_KEY unset — /api/tokens/launch/{prepare,submit} disabled",
    );
  }
  // Transparency surfaces (remediation E1) — complete, tested route
  // factories that were never registered. publicAgent is the public
  // per-agent substance feed ("agents that pay for their own compute",
  // visible to holders/regulators); agentDetail/agentList are the
  // slug-keyed dashboard substance feeds. The authed feeds mount under
  // /api/feed because their /agents and /agents/:slug paths would collide
  // with the legacy id-keyed agentRoutes at /api/agents.
  await app.register(createPublicAgentRoutesProduction(), { prefix: "/api" });
  await app.register(createAgentListRoutesProduction(), { prefix: "/api/feed" });
  await app.register(createAgentDetailRoutesProduction(), { prefix: "/api/feed" });

  await app.register(playgroundRoutes, { prefix: "/api" });
  // A task agent's run, from the dashboard or from code: POST /api/agents/:agentId/run.
  await app.register(createAgentRunRoutesProduction(), { prefix: "/api" });
  // The owner's switch for an agent's public page: GET, PUT /api/agents/:agentId/public-link.
  await app.register(createAgentPublicLinkRoutesProduction(), { prefix: "/api/agents" });
  // An agent's own schedule and its runs: GET, PUT /api/agents/:agentId/schedule,
  // POST .../schedule/run, GET .../runs, POST .../runs/:runId/deliver.
  await app.register(createAgentScheduleRoutesProduction(), { prefix: "/api/agents" });
  await app.register(skillsRoutes, { prefix: "/api" }); // GET /api/skills
  await app.register(
    createPublicStatsRoutes({
      countPublishedListings: () => prisma.agentListing.count({ where: { status: "published" } }),
      latency: processPublicLatency(),
    }),
    { prefix: "/api" },
  ); // GET /api/public/stats
  await app.register(statusRoutes, { prefix: "/api/status" }); // public /status page
  // What works right now (chat models, payouts, email delivery, agent GPU,
  // paid tasks), for the web to draw only that. Signed-in session or API key.
  await app.register(createCapabilitiesRoutesProduction(), { prefix: "/api/capabilities" });
  // Operator view of the GPU compute account (x-admin-key, read-only).
  await app.register(createPlatformComputeRoutesProduction(), { prefix: "/api/platform" });
  await app.register(collaborationRoutes, { prefix: "/api/agents" });
  // Inbound chat-channel webhooks (plan A6) — the complete, tested stack
  // that was never mounted (Wave 0). Platform webhook URL:
  //   POST /api/channels/webhooks/:deploymentId/:platform
  await app.register(createChannelWebhookRoutesProduction(), {
    prefix: "/api/channels",
  });
  // The web chat channel. The owner's keys at /api/channels/web (a sibling
  // plugin, so the webhook plugin's raw-body parser does not reach it), and
  // what the widget on a customer's site calls at /api/widget/:publicKey.
  await app.register(createWebChannelRoutesProduction(), { prefix: "/api/channels/web" });
  await app.register(createWidgetRoutesProduction(), { prefix: "/api/widget" });
  // Its Redis connection, opened before traffic. If it cannot be opened the
  // server still starts; the widget and Try it answer 503 until it can.
  await warmPublicChatLimiter();
  // Treasury read routes — runway / payments / chart at /api/agents/:slug/*
  const { agentTreasuryRoutes } = await import("./routes/agent-treasury.js");
  await app.register(agentTreasuryRoutes, { prefix: "/api" });
  await app.register(inferenceRoutes); // POST /v1/:deploymentSlug/chat/completions
  // The rest of the OpenAI-compatible API: agents at /v1/agents/:slug, the
  // unified POST /v1/chat/completions (routed on `model`) and GET /v1/models.
  // Prefixed so its OpenAI-shaped error and not-found handlers cover /v1.
  await app.register(openAiV1Routes, { prefix: "/v1" });

  // The deployable model catalog lives in code; make sure the models table
  // matches it before accepting traffic (a fresh database has no rows).
  try {
    const synced = await syncModelCatalog(prisma as unknown as ModelCatalogDb);
    app.log.info({ models: synced }, "Model catalog synced");
  } catch (err) {
    app.log.error({ err }, "Model catalog sync failed; model deployments will 400 until it succeeds");
  }
  // One warning per fine-tuning setting that is missing, in operator terms.
  // Customers see only "Fine-tuning is temporarily unavailable".
  await logTrainingReadiness();
  // Likewise for optional settings that switch a customer-facing feature off
  // (funded Try it messages, web search, the code sandbox).
  logOperatorReadiness();

  // Start server
  try {
    await app.listen({
      port: env.API_PORT,
      host: env.API_HOST,
    });
    app.log.info(`Server running at http://${env.API_HOST}:${env.API_PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // B5: prove the queue Redis connection actually works before declaring
  // the worker fleet started. Without this, misconfigured credentials/TLS
  // leave every financial worker dead while /health stays green.
  await assertQueueRedisReady(app.log);

  await startX402Queue();
  await startTokenIndexerQueue();
  await startTreasurySettlementQueue();
  await startPaymentSubmitQueue();
  await startPaymentPollQueue();
  await startPaymentReapQueue();
  await startFeeRouterQueue();
  await startReputationAttestationQueue();
  await startDeploymentStatusQueue();
  await startGpuBillingQueue();
  await startTrainingPollerQueue();
  await startAgentMessageQueue();
  await startSchedulerQueue();
  await startWorkflowRunQueue();
  await startJobRunnerQueue();
  await startJobSweeperQueue();
  await startTrialChargeReapQueue();
  await startUptimeProberQueue();
  await startCustomDomainCheckQueue();
  await customDomainEdge.start();
  await startAlertEvaluatorQueue();
  await startAnalyticsSnapshotQueue();
  await startSubscriptionRenewalQueue();
  await startPayoutExecutorQueue();
  await startEmbeddingBackfillQueue();

  // Graceful shutdown
  // Well inside the platform's kill_timeout (60s on Fly), leaving the rest
  // for the queue drain below.
  const GRAPH_RUN_DRAIN_MS = 15_000;
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully`);
      // First, before the queue drain eats the kill window: a graph run may
      // have minutes left but the process has seconds. Cancelling lets each
      // run refund its marketplace charge and close its execution row; killed
      // mid-run it would leave the buyer debited for nothing. New runs are
      // refused (503) from here on.
      // Agent chats (playground and /v1) hold the same kind of charge and are
      // cancelled in the same window, not after it.
      const [graphRuns, agentChats] = await Promise.all([
        cancelInFlightGraphRuns(GRAPH_RUN_DRAIN_MS),
        cancelInFlightAgentChats(GRAPH_RUN_DRAIN_MS),
      ]);
      if (graphRuns.cancelled > 0) {
        app.log[graphRuns.unfinished > 0 ? "error" : "info"](
          graphRuns,
          "Cancelled in-flight graph runs for shutdown",
        );
      }
      if (agentChats.cancelled > 0) {
        app.log[agentChats.unfinished > 0 ? "error" : "info"](
          agentChats,
          "Cancelled in-flight agent chats for shutdown",
        );
      }
      await stopX402Queue();
      await stopTokenIndexerQueue();
      await stopTreasurySettlementQueue();
      await stopPaymentSubmitQueue();
      await stopPaymentPollQueue();
      await stopPaymentReapQueue();
      await stopFeeRouterQueue();
      await stopReputationAttestationQueue();
      await stopDeploymentStatusQueue();
      await stopGpuBillingQueue();
      await stopTrainingPollerQueue();
      await stopAgentMessageQueue();
      await stopSchedulerQueue();
      await stopWorkflowRunQueue();
      await stopJobRunnerQueue();
      await stopJobSweeperQueue();
      await stopTrialChargeReapQueue();
      await stopUptimeProberQueue();
      await stopCustomDomainCheckQueue();
      await stopAlertEvaluatorQueue();
      await stopAnalyticsSnapshotQueue();
      await stopSubscriptionRenewalQueue();
      await stopPayoutExecutorQueue();
      await stopEmbeddingBackfillQueue();
      await metrics.close();
      await app.close();
      process.exit(0);
    });
  }
}

main();
