import { prisma } from "@wheelsai/db";
import { createLogger } from "../utils/logger.js";
import { env } from "../config/env.js";
import * as crypto from "crypto";

const logger = createLogger("openclaw-service");

// Encryption helpers using AES-256-GCM
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

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

function getEncryptionKey(): Buffer {
  // Derive key from JWT_SECRET (in production, use a dedicated encryption key)
  return crypto.createHash("sha256").update(env.JWT_SECRET).digest();
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
  const parts = encryptedStr.split(":");
  const iv = Buffer.from(parts[0], "hex");
  const tag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];
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
        modelConfig,
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
  const existing = await getDeployment(id, orgId);

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
  const existing = await getDeployment(id, orgId);

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

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "BUILDING",
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  // TODO: Trigger Nosana job creation here
  logger.info("Deployment start initiated (Nosana job creation pending)", { id });

  return deployment;
}

export async function stopDeployment(id: string, orgId: string) {
  logger.info("Stopping deployment", { id, orgId });

  // Verify ownership
  const existing = await getDeployment(id, orgId);

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "STOPPED",
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  // TODO: Trigger Nosana job termination here
  logger.info("Deployment stopped", { id });

  return deployment;
}

export async function restartDeployment(id: string, orgId: string) {
  logger.info("Restarting deployment", { id, orgId });

  // Verify ownership
  const existing = await getDeployment(id, orgId);

  const deployment = await prisma.openClawDeployment.update({
    where: { id },
    data: {
      status: "BUILDING",
    },
    include: {
      channels: true,
      agent: true,
    },
  });

  // TODO: Trigger Nosana job restart here
  logger.info("Deployment restart initiated", { id });

  return deployment;
}
