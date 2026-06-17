import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { installBigIntJsonSerializer } from "./lib/bigintJson.js";
import { globalErrorHandler } from "./lib/errorHandler.js";

// Precision-safe BigInt JSON serialization (Prisma surfaces BigInt columns
// API-wide) — installed before any route can serialize a response. The
// naive `Number(bigint)` corrupts values above 2^53; see the module (D9).
installBigIntJsonSerializer();

import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { BAGS_ADAPTER_IMPLEMENTED } from "./services/launchpad/bagsAdapter.js";
import { registerAuthPlugins } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
import { deploymentRoutes } from "./routes/deployments.js";
import { modelRoutes } from "./routes/models.js";
import { healthRoutes } from "./routes/health.js";
import { inferenceRoutes } from "./routes/inference.js";
import { billingRoutes } from "./routes/billing.js";
import { settingsRoutes } from "./routes/settings.js";
import { agentRoutes } from "./routes/agents.js";
import { trainingRoutes } from "./routes/training.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { reputationRoutes } from "./routes/reputation.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { enterpriseRoutes } from "./routes/enterprise.js";
import { agentGraphRoutes } from "./routes/agentGraph.js";
import { monitoringRoutes } from "./routes/monitoring.js";
import { versioningRoutes } from "./routes/versioning.js";
import { webhooksRoutes } from "./routes/webhooks.js";
import { testingRoutes } from "./routes/testing.js";
import { memoryRoutes } from "./routes/memory.js";
import { domainsRoutes } from "./routes/domains.js";
import { schedulerRoutes } from "./routes/scheduler.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import { templateRoutes } from "./routes/templates.js";
import { twoFactorRoutes } from "./routes/twoFactor.js";
import { x402Routes } from "./routes/x402.js";
import { openclawRoutes } from "./routes/openclaw.js";
import { tokenRoutes } from "./routes/tokens.js";
import { createPartialSignTokenRoutesProduction } from "./routes/tokenLaunchPartialSignBindings.js";
import {
  createPublicAgentRoutesProduction,
  createAgentDetailRoutesProduction,
  createAgentListRoutesProduction,
} from "./routes/transparencyBindings.js";
import { playgroundRoutes } from "./routes/playground.js";
import { collaborationRoutes } from "./routes/collaboration.js";
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

  const app = Fastify({
    logger: logger as any,
    trustProxy: true,
  });

  // Register plugins
  await app.register(cors, {
    origin: env.NODE_ENV === "production" ? env.CORS_ORIGIN : true,
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
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
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
          apiKey: {
            type: "apiKey",
            in: "header",
            name: "X-API-Key",
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

  // Register routes
  await app.register(healthRoutes, { prefix: "/health" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(modelRoutes, { prefix: "/api/models" });
  await app.register(deploymentRoutes, { prefix: "/api/deployments" });
  await app.register(agentRoutes, { prefix: "/api/agents" });
  await app.register(trainingRoutes, { prefix: "/api/training" });
  await app.register(billingRoutes, { prefix: "/api/billing" });
  await app.register(settingsRoutes, { prefix: "/api/settings" });
  await app.register(marketplaceRoutes, { prefix: "/api/marketplace" });
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
  await app.register(collaborationRoutes, { prefix: "/api/agents" });
  // Treasury read routes — runway / payments / chart at /api/agents/:slug/*
  const { agentTreasuryRoutes } = await import("./routes/agent-treasury.js");
  await app.register(agentTreasuryRoutes, { prefix: "/api" });
  await app.register(inferenceRoutes); // OpenAI-compatible API at /v1/*

  // Global error handler — maps ZodError (bare .parse() in routes) to 400,
  // Fastify schema-validation to 400, else statusCode-aware fallback (F1).
  app.setErrorHandler(globalErrorHandler);

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

  // Graceful shutdown
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully`);
      await stopX402Queue();
      await stopTokenIndexerQueue();
      await stopTreasurySettlementQueue();
      await stopPaymentSubmitQueue();
      await stopPaymentPollQueue();
      await stopPaymentReapQueue();
      await stopFeeRouterQueue();
      await stopReputationAttestationQueue();
      await stopDeploymentStatusQueue();
      await app.close();
      process.exit(0);
    });
  }
}

main();
