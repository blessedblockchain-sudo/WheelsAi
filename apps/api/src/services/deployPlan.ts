/**
 * Launch deploy-plan compiler (plan A7).
 *
 * Pure function the unified /dashboard/launch wizard calls to turn a parsed
 * character file + user-supplied env values + a GPU tier choice into a
 * ready-to-submit deploy plan:
 *
 *   - validation:  which required env vars are still missing
 *   - jobDefinition: the Nosana job (OpenClaw container, GPU, exposed port,
 *                  env vars) ready for nosana.submitJob
 *   - channels:    OpenClawChannel rows the deploy route should create
 *   - resourcePlan: market address, price/sec, replicas
 *
 * Composes ParsedCharacter (frameworks/eliza.ts) + MARKETS (nosana.ts) +
 * the OpenClaw image. No IO. No Prisma coupling — the route persists.
 */

import { env } from "../config/env.js";
import { MARKETS, type NosanaJobDefinition } from "./nosana.js";
import type { ChannelBinding } from "./frameworks/eliza.js";

const OPENCLAW_PORT = 3000;

/**
 * The structural shape compileDeployPlan consumes — both
 * services/frameworks/eliza.ts and services/frameworks/crewai.ts produce
 * objects assignable to this. Keeping the interface minimal means the
 * planner doesn't grow framework-specific branches.
 */
export interface ParsedAgentSpec {
  name: string;
  slug: string;
  requiredEnvVars: string[];
  channelBindings: Array<{ platform: ChannelBinding["platform"]; envKeys: readonly string[] }>;
}

export interface CompileDeployPlanInput {
  agentSpec: ParsedAgentSpec;
  envValues: Record<string, string>;
  gpuTier: string;
  replicas?: number;
  /** Override agentSpec.slug — useful when the slug collides with an existing deployment. */
  agentSlug?: string;
  /** Override the OpenClaw container image. Defaults to env.OPENCLAW_DEFAULT_IMAGE. */
  dockerImage?: string;
}

export interface DeployPlanValidation {
  missingEnvVars: string[];
  isReady: boolean;
}

export interface DeployPlanChannel {
  platform: ChannelBinding["platform"];
  envKeys: readonly string[];
}

export interface ResourcePlan {
  market: string;
  pricePerSecondUsd: number;
  replicas: number;
  tier: string;
}

export interface CompiledDeployPlan {
  validation: DeployPlanValidation;
  jobDefinition: NosanaJobDefinition;
  channels: DeployPlanChannel[];
  resourcePlan: ResourcePlan;
}

export function compileDeployPlan(input: CompileDeployPlanInput): CompiledDeployPlan {
  const replicas = input.replicas ?? 1;
  if (!Number.isInteger(replicas) || replicas <= 0) {
    throw new Error(`replicas must be a positive integer, got ${input.replicas}`);
  }

  const market = MARKETS[input.gpuTier];
  if (!market) {
    throw new Error(
      `compileDeployPlan: unknown gpuTier '${input.gpuTier}'. Valid tiers: ${Object.keys(MARKETS).join(", ")}`,
    );
  }

  // Validation: every requiredEnvVar must have a non-empty value supplied.
  const supplied = new Set(
    Object.entries(input.envValues)
      .filter(([, v]) => typeof v === "string" && v.length > 0)
      .map(([k]) => k),
  );
  const missingEnvVars = input.agentSpec.requiredEnvVars
    .filter((k) => !supplied.has(k))
    .sort();

  // Build the job env: only keys the character declares + WheelsAI-side identity.
  const jobEnv: Record<string, string> = {};
  const slug = input.agentSlug ?? input.agentSpec.slug;
  jobEnv.AGENT_NAME = input.agentSpec.name;
  jobEnv.AGENT_SLUG = slug;
  for (const key of input.agentSpec.requiredEnvVars) {
    const v = input.envValues[key];
    if (typeof v === "string" && v.length > 0) jobEnv[key] = v;
  }

  const dockerImage = input.dockerImage ?? env.OPENCLAW_DEFAULT_IMAGE;

  const jobDefinition: NosanaJobDefinition = {
    version: "0.1",
    type: "container",
    meta: { trigger: "wheelsai-launch" },
    ops: [
      {
        type: "container/run",
        id: `openclaw-${slug}`,
        args: {
          image: dockerImage,
          gpu: true,
          expose: [OPENCLAW_PORT],
          env: jobEnv,
        },
      },
    ],
  };

  const channels: DeployPlanChannel[] = input.agentSpec.channelBindings.map((b) => ({
    platform: b.platform,
    envKeys: b.envKeys,
  }));

  return {
    validation: {
      missingEnvVars,
      isReady: missingEnvVars.length === 0,
    },
    jobDefinition,
    channels,
    resourcePlan: {
      market: market.address,
      pricePerSecondUsd: market.pricePerSecond,
      replicas,
      tier: input.gpuTier,
    },
  };
}
