import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import * as crypto from "crypto";
import { getNosanaClient, type NosanaJobDefinition } from "./nosana.js";

const logger = createLogger("openclaw-service");

// Encryption helpers using AES-256-GCM
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const OPENCLAW_PORT = 8000;

const OPENCLAW_GPU_TIER_MAP: Record<string, string> = {
  basic: "3060",
  standard: "4070",
  premium: "4090",
  "rtx-3060": "3060",
  "rtx-4070": "4070",
  "rtx-4090": "4090",
};

export const SUPPORTED_PLATFORMS = [
  "discord",
  "telegram",
  "slack",
  "twitter",
  "whatsapp",
  "line",
  "messenger",
  "web",
  "api",
  "email",
] as const;

type OpenClawDeploymentRecord = Awaited<ReturnType<typeof getDeployment>>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeGpuTier(rawTier: unknown): string {
  if (typeof rawTier !== "string" || rawTier.trim().length === 0) {
    return "3060";
  }
  const normalized = rawTier.trim().toLowerCase();
  return OPENCLAW_GPU_TIER_MAP[normalized] ?? normalized;
}

function toEnvValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toStringEnvVars(input: Record<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key) continue;
    output[key] = toEnvValue(value);
  }
  return output;
}

function decryptConfigSafely(
  encrypted: string,
  context: { deploymentId: string; channelId?: string }
): Record<string, unknown> {
  try {
    return decryptConfig(encrypted);
  } catch (error) {
    logger.warn({ error, ...context }, "Failed to decrypt OpenClaw config");
    return {};
  }
}

function fallbackPublicUrlForDeployment(deployment: OpenClawDeploymentRecord): string {
  return `https://${deployment.agent.slug}.${env.OPENCLAW_SUBDOMAIN_BASE}`;
}

function buildOpenClawJobDefinition(deployment: OpenClawDeploymentRecord): {
  definition: NosanaJobDefinition;
  marketTier: string;
  fallbackPublicUrl: string;
} {
  const modelConfig = asRecord(deployment.agent.modelConfig);
  const marketTier = normalizeGpuTier(modelConfig.gpuTier);
  const decryptedEnv = decryptConfigSafely(deployment.envEncrypted, {
    deploymentId: deployment.id,
  });

  const enabledChannels = deployment.channels
    .filter((channel) => channel.enabled)
    .map((channel) => ({
      id: channel.id,
      platform: channel.platform,
      config: decryptConfigSafely(channel.configEncrypted, {
        deploymentId: deployment.id,
        channelId: channel.id,
      }),
    }));

  const definition: NosanaJobDefinition = {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "openclaw",
    },
    ops: [
      {
        type: "container/run",
        id: "openclaw-runtime",
        args: {
          image: deployment.dockerImage || env.OPENCLAW_DEFAULT_IMAGE,
          gpu: true,
          expose: [OPENCLAW_PORT],
          env: {
            ...toStringEnvVars(decryptedEnv),
            OPENCLAW_DEPLOYMENT_ID: deployment.id,
            OPENCLAW_AGENT_ID: deployment.agentId,
            OPENCLAW_AGENT_NAME: deployment.agent.name,
            OPENCLAW_AGENT_SLUG: deployment.agent.slug,
            OPENCLAW_VERSION: deployment.openclawVersion,
            OPENCLAW_SYSTEM_PROMPT: deployment.agent.systemPrompt ?? "",
            OPENCLAW_MODEL_CONFIG: JSON.stringify(modelConfig),
            OPENCLAW_CHANNELS: JSON.stringify(enabledChannels),
            PORT: String(OPENCLAW_PORT),
            NODE_ENV: env.NODE_ENV,
          },
        },
      },
    ],
  };

  return {
    definition,
    marketTier,
    fallbackPublicUrl: fallbackPublicUrlForDeployment(deployment),
  };
}

function isRecoverableNosanaError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("wallet not configured") || message.includes("unknown market tier");
}

function getEncryptionKey(): Buffer {
  // Use ENCRYPTION_KEY when available; fall back to JWT_SECRET for backward compatibility
  // with deployments that pre-date the dedicated key. In production, set ENCRYPTION_KEY
  // to an independent 32+ character secret so rotating JWT_SECRET doesn't break decryption.
  const source = env.ENCRYPTION_KEY ?? env.JWT_SECRET;
  return crypto.createHash("sha256").update(source).digest();
}

export function encryptConfig(data: Record<string, unknown>): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(JSON.stringify(data), "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + tag.toString("hex") + ":" + encrypted;
}

export function decryptConfig(encryptedStr: string): Record<string, unknown> {
  const key = getEncryptionKey();
  const [ivHex, tagHex, encrypted] = encryptedStr.split(":");
  if (!ivHex || !tagHex || !encrypted) throw new Error("Invalid encrypted config format");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

interface CreateDeploymentParams {
  orgId: string;
  name: string;
  slug: string;
  description?: string;
  systemPrompt?: string;
  modelConfig: Record<string, unknown>;
  gpuTier: string;
  openclawVersion?: string;
  envVars: Record<string, string>;
  channels: Array<{
    platform: string;
    config: Record<string, string>;
  }>;
}

export async function createDeployment(params: CreateDeploymentParams) {
  const {
    orgId,
    name,
    slug,
    description,
    systemPrompt,
    modelConfig,
    gpuTier,
    openclawVersion = "latest",
    envVars,
    channels,
  } = params;

  logger.info("Creating OpenClaw deployment", { orgId, name, slug });

  // Validate channels
  for (const channel of channels) {
    if (!SUPPORTED_PLATFORMS.includes(channel.platform as any)) {
      throw new Error(`Unsupported platform: ${channel.platform}`);
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    // Create the Agent
    const agent = await tx.agent.create({
      data: {
        orgId,
        name,
        slug,
        description: description || "",
        systemPrompt: systemPrompt || "",
        framework: "openclaw",
        sourceType: "inline",
        modelConfig: {
          ...(modelConfig as Record<string, unknown>),
          gpuTier,
        } as any,
      },
    });

    // Encrypt environment variables
    const encryptedEnvVars = encryptConfig(envVars);

    // Create the OpenClawDeployment
    const deployment = await tx.openClawDeployment.create({
      data: {
        agentId: agent.id,
        openclawVersion,
        envEncrypted: encryptedEnvVars,
        status: "PENDING",
      },
    });

    // Create OpenClawChannels
    const createdChannels = await Promise.all(
      channels.map((channel) =>
        tx.openClawChannel.create({
          data: {
            deploymentId: deployment.id,
            platform: channel.platform,
            configEncrypted: encryptConfig(channel.config),
            enabled: true,
          },
        })
      )
    );

    return {
      ...deployment,
      channels: createdChannels,
      agent,
    };
  });

  logger.info("OpenClaw deployment created", {
    deploymentId: result.id,
    agentId: result.agentId,
  });

  return result;
}

export async function getDeployment(id: string, orgId: string) {
  logger.info("Getting deployment", { id, orgId });

  const deployment = await prisma.openClawDeployment.findFirst({
    where: {
      id,
      agent: {
        orgId,
      },
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  if (!deployment) {
    throw new Error("Deployment not found or access denied");
  }

  return deployment;
}

export async function getDeployments(orgId: string) {
  logger.info("Getting deployments for org", { orgId });

  const deployments = await prisma.openClawDeployment.findMany({
    where: {
      agent: {
        orgId,
      },
    },
    include: {
      channels: true,
      agent: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return deployments;
}

interface UpdateDeploymentParams {
  envVars?: Record<string, string>;
  openclawVersion?: string;
}

export async function updateDeployment(
  id: string,
  orgId: string,
  params: UpdateDeploymentParams
) {
  logger.info("Updating deployment", { id, orgId, params });

  // Verify ownership
  await getDeployment(id, orgId);

  const updateData: any = {};

  if (params.envVars) {
    updateData.envEncrypted = encryptConfig(params.envVars);
  }

  if (params.openclawVersion) {
    updateData.openclawVersion = params.openclawVersion;
  }

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: updateData,
    include: {
      channels: true,
      agent: true,
    },
  });

  logger.info("Deployment updated", { id });

  return deployment;
}

export async function deleteDeployment(id: string, orgId: string) {
  logger.info("Deleting deployment", { id, orgId });

  // Verify ownership
  await getDeployment(id, orgId);

  await prisma.openClawDeployment.delete({
    where: { id },
  });

  logger.info("Deployment deleted", { id });

  return { success: true };
}

interface UpdateDeploymentStatusParams {
  nosanaJobId?: string;
  publicUrl?: string;
}

export async function updateDeploymentStatus(
  id: string,
  status: string,
  extra?: UpdateDeploymentStatusParams
) {
  logger.info("Updating deployment status", { id, status, extra });

  const updateData: any = { status };

  if (extra?.nosanaJobId) {
    updateData.nosanaJobId = extra.nosanaJobId;
  }

  if (extra?.publicUrl) {
    updateData.publicUrl = extra.publicUrl;
  }

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: updateData,
  });

  logger.info("Deployment status updated", { id, status });

  return deployment;
}

interface AddChannelParams {
  platform: string;
  config: Record<string, string>;
}

export async function addChannel(
  deploymentId: string,
  orgId: string,
  params: AddChannelParams
) {
  logger.info("Adding channel", { deploymentId, orgId, platform: params.platform });

  // Verify deployment ownership
  await getDeployment(deploymentId, orgId);

  // Validate platform
  if (!SUPPORTED_PLATFORMS.includes(params.platform as any)) {
    throw new Error(`Unsupported platform: ${params.platform}`);
  }

  const channel = await prisma.openClawChannel.create({
    data: {
      deploymentId,
      platform: params.platform,
      configEncrypted: encryptConfig(params.config),
      enabled: true,
    },
  });

  logger.info("Channel added", { channelId: channel.id, platform: params.platform });

  return channel;
}

interface UpdateChannelParams {
  config?: Record<string, string>;
  enabled?: boolean;
}

export async function updateChannel(
  channelId: string,
  orgId: string,
  params: UpdateChannelParams
) {
  logger.info("Updating channel", { channelId, orgId, params });

  // Verify ownership through deployment
  const channel = await prisma.openClawChannel.findUnique({
    where: { id: channelId },
    include: {
      deployment: {
        include: {
          agent: true,
        },
      },
    },
  });

  if (!channel || channel.deployment.agent.orgId !== orgId) {
    throw new Error("Channel not found or access denied");
  }

  const updateData: any = {};

  if (params.config) {
    updateData.configEncrypted = encryptConfig(params.config);
  }

  if (params.enabled !== undefined) {
    updateData.enabled = params.enabled;
  }

  const updated = await prisma.openClawChannel.update({
    where: { id: channelId },
    data: updateData,
  });

  logger.info("Channel updated", { channelId });

  return updated;
}

export async function removeChannel(channelId: string, orgId: string) {
  logger.info("Removing channel", { channelId, orgId });

  // Verify ownership through deployment
  const channel = await prisma.openClawChannel.findUnique({
    where: { id: channelId },
    include: {
      deployment: {
        include: {
          agent: true,
        },
      },
    },
  });

  if (!channel || channel.deployment.agent.orgId !== orgId) {
    throw new Error("Channel not found or access denied");
  }

  await prisma.openClawChannel.delete({
    where: { id: channelId },
  });

  logger.info("Channel removed", { channelId });

  return { success: true };
}

export async function updateHealthStatus(id: string, status: string) {
  logger.info("Updating health status", { id, status });

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      healthStatus: status,
      healthLastCheck: new Date(),
    },
  });

  logger.info("Health status updated", { id, status });

  return deployment;
}

export async function startDeployment(id: string, orgId: string) {
  logger.info("Starting deployment", { id, orgId });

  // Verify ownership
  const existing = await getDeployment(id, orgId);

  if (existing.status === "RUNNING" && existing.nosanaJobId) {
    logger.info("Deployment already running with active Nosana job", {
      id,
      jobId: existing.nosanaJobId,
    });
    return existing;
  }

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "BUILDING",
      healthStatus: "provisioning",
      healthLastCheck: new Date(),
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  const { definition, marketTier, fallbackPublicUrl } = buildOpenClawJobDefinition(deployment);

  try {
    const nosana = await getNosanaClient();
    const job = await nosana.submitJob(definition, marketTier);
    const jobStatus = await nosana.getJobStatus(job.id).catch((error) => {
      logger.warn({ error, id, jobId: job.id }, "Failed to fetch immediate Nosana job status");
      return null;
    });

    const updated = await prisma.openClawDeployment.update({
      where: { id },
      data: {
        status: jobStatus?.status === "running" ? "RUNNING" : "DEPLOYING",
        nosanaJobId: job.id,
        publicUrl: jobStatus?.nodeUrl ?? fallbackPublicUrl,
        healthStatus: jobStatus?.status === "running" ? "healthy" : "unknown",
        healthLastCheck: new Date(),
      },
      include: {
        channels: true,
        agent: true,
      },
    });

    logger.info("Deployment submitted to Nosana", {
      id,
      jobId: job.id,
      marketTier,
      publicUrl: updated.publicUrl,
    });

    return updated;
  } catch (error) {
    if (isRecoverableNosanaError(error)) {
      logger.warn(
        { error, id, marketTier },
        "Nosana unavailable for OpenClaw start, using fallback runtime status"
      );

      return prisma.openClawDeployment.update({
        where: { id },
        data: {
          status: "RUNNING",
          nosanaJobId: null,
          publicUrl: fallbackPublicUrl,
          healthStatus: "degraded",
          healthLastCheck: new Date(),
        },
        include: {
          channels: true,
          agent: true,
        },
      });
    }

    logger.error({ error, id }, "Failed to start OpenClaw deployment");

    await prisma.openClawDeployment.update({
      where: { id },
      data: {
        status: "FAILED",
        healthStatus: "down",
        healthLastCheck: new Date(),
      },
    });

    const message = error instanceof Error ? error.message : "Unknown error";
    throw new Error(`Failed to start deployment: ${message}`);
  }
}

export async function stopDeployment(id: string, orgId: string) {
  logger.info("Stopping deployment", { id, orgId });

  // Verify ownership
  const existing = await getDeployment(id, orgId);

  if (existing.nosanaJobId) {
    try {
      const nosana = await getNosanaClient();
      await nosana.stopDeployment(existing.nosanaJobId);
      logger.info("Stopped Nosana job for deployment", { id, jobId: existing.nosanaJobId });
    } catch (error) {
      logger.warn(
        { error, id, jobId: existing.nosanaJobId },
        "Failed to stop Nosana job, continuing with local status update"
      );
    }
  }

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "STOPPED",
      nosanaJobId: null,
      publicUrl: null,
      healthStatus: "down",
      healthLastCheck: new Date(),
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  logger.info("Deployment stopped", { id });

  return deployment;
}

export async function restartDeployment(id: string, orgId: string) {
  logger.info("Restarting deployment", { id, orgId });

  // Verify ownership
  const existing = await getDeployment(id, orgId);

  if (existing.nosanaJobId) {
    try {
      const nosana = await getNosanaClient();
      await nosana.stopDeployment(existing.nosanaJobId);
      logger.info("Stopped previous Nosana job before restart", {
        id,
        jobId: existing.nosanaJobId,
      });
    } catch (error) {
      logger.warn(
        { error, id, jobId: existing.nosanaJobId },
        "Failed to stop previous Nosana job during restart"
      );
    }
  }

  await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "PENDING",
      nosanaJobId: null,
      publicUrl: null,
      healthStatus: "unknown",
      healthLastCheck: new Date(),
    },
  });

  logger.info("Deployment reset completed, starting fresh deployment", { id });
  return startDeployment(id, orgId);
}
