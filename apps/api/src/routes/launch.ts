/**
 * POST /launch — unified build → deploy entry point (plan A7).
 *
 * Request:
 *   { characterJson, envValues, gpuTier, replicas? }
 *
 * Flow:
 *   1. Auth gate. 401 if missing.
 *   2. Schema check on the body. 400 if shape is wrong.
 *   3. parseElizaCharacter. 400 invalid_character on parse/validation throws.
 *   4. compileDeployPlan. 400 invalid_gpu_tier or invalid_payload on throws.
 *   5. If !validation.isReady → 400 validation_failed with the missing list.
 *   6. persistDeployment (DI). 500 persistence_failed on error.
 *   7. submitJob (DI). 502 nosana_submit_failed on error — but include the
 *      deploymentId so the client can "retry submit" without redoing step 6.
 *   8. 200 with { deploymentId, agentId, jobId, channels, resourcePlan }.
 *
 * Persistence + submission are dependency-injected so this route is unit-
 * testable without Prisma, the encryption key, or the Solana RPC.
 */

import { z } from "zod";
import type { FastifyPluginAsync } from "fastify";

import { parseElizaCharacter } from "../services/frameworks/eliza.js";
import { parseCrewAi } from "../services/frameworks/crewai.js";
import {
  compileDeployPlan,
  type ParsedAgentSpec,
  type ResourcePlan,
} from "../services/deployPlan.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("launch-route");

const SUPPORTED_FRAMEWORKS = ["elizaos", "crewai"] as const;
type Framework = (typeof SUPPORTED_FRAMEWORKS)[number];

// ============================================
// Schema
// ============================================

const launchBodySchema = z.object({
  framework: z
    .enum(SUPPORTED_FRAMEWORKS as unknown as [Framework, ...Framework[]])
    .optional(),
  characterJson: z.union([z.string(), z.record(z.unknown())]),
  // CrewAi parser needs a crew name; the route falls back to "agent" so an
  // omitted field produces a stable slug rather than a 400.
  crewName: z.string().min(1).optional(),
  envValues: z.record(z.string()).default({}),
  gpuTier: z.string().min(1),
  replicas: z.number().int().positive().optional(),
  agentSlug: z.string().min(1).optional(),
});

// ============================================
// DI surface
// ============================================

export interface PersistDeploymentInput {
  orgId: string;
  agentSlug: string;
  characterName: string;
  jobDefinition: unknown;
  channels: Array<{ platform: string; envKeys: readonly string[] }>;
  envValues: Record<string, string>;
  resourcePlan: ResourcePlan;
}

export interface PersistDeploymentResult {
  deploymentId: string;
  agentId: string;
}

export interface LaunchRouteDeps {
  persistDeployment: (
    input: PersistDeploymentInput,
  ) => Promise<PersistDeploymentResult>;
  submitJob: (
    jobDefinition: unknown,
    market: string,
  ) => Promise<{ jobId: string }>;
}

// ============================================
// Plugin
// ============================================

export function createLaunchRoutes(deps: LaunchRouteDeps): FastifyPluginAsync {
  return async (app) => {
    app.post("/launch", async (request, reply) => {
      // 1. Auth gate
      if (!request.auth) {
        return reply.status(401).send({ error: "unauthenticated" });
      }
      const { orgId } = request.auth;

      // 2. Schema validation
      const parsed = launchBodySchema.safeParse(request.body);
      if (!parsed.success) {
        // Distinguish unsupported framework (a real user-actionable error)
        // from generic shape failures so the wizard can show a helpful UI.
        const flat = parsed.error.flatten();
        const frameworkErr = flat.fieldErrors.framework;
        if (frameworkErr && frameworkErr.length > 0) {
          return reply.status(400).send({
            error: "unsupported_framework",
            details: flat,
          });
        }
        return reply.status(400).send({
          error: "invalid_payload",
          details: flat,
        });
      }
      const {
        framework: rawFramework,
        characterJson,
        crewName,
        envValues,
        gpuTier,
        replicas,
        agentSlug,
      } = parsed.data;
      // Default framework=elizaos for backward compat with pre-A10 clients.
      const framework: Framework = rawFramework ?? "elizaos";

      // 3. Parse via the framework-specific adapter.
      let agentSpec: ParsedAgentSpec & { name: string; slug: string };
      try {
        if (framework === "elizaos") {
          agentSpec = parseElizaCharacter(characterJson);
        } else {
          agentSpec = parseCrewAi(characterJson, { name: crewName ?? "agent" });
        }
      } catch (err) {
        return reply.status(400).send({
          error: "invalid_character",
          message: (err as Error).message,
        });
      }

      // 4. Compile deploy plan
      let plan;
      try {
        plan = compileDeployPlan({
          agentSpec,
          envValues,
          gpuTier,
          replicas,
          agentSlug,
        });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("gpuTier")) {
          return reply.status(400).send({
            error: "invalid_gpu_tier",
            message: msg,
          });
        }
        return reply.status(400).send({
          error: "invalid_payload",
          message: msg,
        });
      }

      // 5. Validation gate — env vars all present?
      if (!plan.validation.isReady) {
        return reply.status(400).send({
          error: "validation_failed",
          missingEnvVars: plan.validation.missingEnvVars,
        });
      }

      // 6. Persist
      let persisted;
      try {
        persisted = await deps.persistDeployment({
          orgId,
          agentSlug: agentSlug ?? agentSpec.slug,
          characterName: agentSpec.name,
          jobDefinition: plan.jobDefinition,
          channels: plan.channels,
          envValues,
          resourcePlan: plan.resourcePlan,
        });
      } catch (err) {
        logger.error({ err, orgId }, "persistDeployment failed");
        return reply.status(500).send({
          error: "persistence_failed",
          message: (err as Error).message,
        });
      }

      // 7. Submit to Nosana
      try {
        const submitted = await deps.submitJob(
          plan.jobDefinition,
          plan.resourcePlan.market,
        );
        return reply.status(200).send({
          deploymentId: persisted.deploymentId,
          agentId: persisted.agentId,
          jobId: submitted.jobId,
          channels: plan.channels,
          resourcePlan: plan.resourcePlan,
        });
      } catch (err) {
        logger.error(
          { err, orgId, deploymentId: persisted.deploymentId },
          "nosana submit failed; deployment row exists for retry",
        );
        return reply.status(502).send({
          error: "nosana_submit_failed",
          deploymentId: persisted.deploymentId,
          message: (err as Error).message,
        });
      }
    });
  };
}
