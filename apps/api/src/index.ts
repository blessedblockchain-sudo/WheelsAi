import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";

// BigInt JSON serialization support (used by Prisma for BigInt columns)
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
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
import { startX402SettlementWorker } from "./services/x402Settlement.js";
import { startTokenIndexerWorker } from "./services/tokenIndexer.js";

async function main() {
  const app = Fastify({
    logger: logger,
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
  await app.register(inferenceRoutes); // OpenAI-compatible API at /v1/*

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    app.log.error(error);

    if (error.validation) {
      return reply.status(400).send({
        error: "Validation Error",
        message: error.message,
        details: error.validation,
      });
    }

    const statusCode = error.statusCode ?? 500;
    const message =
      statusCode === 500 ? "Internal Server Error" : error.message;

    return reply.status(statusCode).send({
      error: error.name ?? "Error",
      message,
    });
  });

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

  const stopSettlementWorker = startX402SettlementWorker();
  const stopTokenIndexer = startTokenIndexerWorker();

  // Graceful shutdown
  const signals = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully`);
      stopSettlementWorker();
      stopTokenIndexer();
      await app.close();
      process.exit(0);
    });
  }
}

main();
