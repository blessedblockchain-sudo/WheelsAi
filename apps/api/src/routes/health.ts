import { FastifyPluginAsync } from "fastify";
import { prisma } from "@wheelsai/db";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "wheelsai-api",
      version: "0.1.0",
    };
  });

  app.get("/ready", async (request, reply) => {
    const checks: Record<string, string> = {};

    // Check database
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch {
      checks.database = "failed";
    }

    // Check Redis
    try {
      const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
      await redis.ping();
      await redis.quit();
      checks.redis = "ok";
    } catch {
      checks.redis = "failed";
    }

    const allOk = Object.values(checks).every((v) => v === "ok");

    if (!allOk) {
      reply.status(503);
      return { status: "not_ready", checks };
    }

    return { status: "ready", checks };
  });

  app.get("/live", async () => {
    return { status: "alive" };
  });
};
