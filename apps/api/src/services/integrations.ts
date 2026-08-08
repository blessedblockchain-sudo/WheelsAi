import { prisma } from "@wheelsai/db";
import crypto from "crypto";

import { safeFetch } from "../lib/ssrfGuard.js";

// ============================================
// Types
// ============================================

export type IntegrationType = "slack" | "discord" | "github" | "zapier" | "make" | "n8n";

export const INTEGRATION_TYPES: IntegrationType[] = [
  "slack",
  "discord",
  "github",
  "zapier",
  "make",
  "n8n",
];

export interface IntegrationConfig {
  slack?: {
    workspace?: string;
    channel?: string;
    botToken?: string;
  };
  discord?: {
    guildId?: string;
    channelId?: string;
    webhookUrl?: string;
  };
  github?: {
    owner?: string;
    repo?: string;
    branch?: string;
  };
  zapier?: {
    webhookUrl?: string;
  };
  make?: {
    webhookUrl?: string;
  };
  n8n?: {
    webhookUrl?: string;
    instanceUrl?: string;
  };
}

export interface CreateIntegrationInput {
  type: IntegrationType;
  name: string;
  config?: IntegrationConfig[IntegrationType];
  scopes?: string[];
}

export interface UpdateIntegrationInput {
  name?: string;
  config?: IntegrationConfig[IntegrationType];
  scopes?: string[];
  isEnabled?: boolean;
}

// ============================================
// Integration CRUD
// ============================================

export async function createIntegration(
  orgId: string,
  input: CreateIntegrationInput
) {
  return prisma.integration.create({
    data: {
      orgId,
      type: input.type,
      name: input.name,
      config: (input.config || {}) as any,
      scopes: input.scopes || [],
    },
  });
}

export async function getIntegrations(
  orgId: string,
  options: {
    type?: IntegrationType;
    isEnabled?: boolean;
    limit?: number;
    offset?: number;
  } = {}
) {
  const { type, isEnabled, limit = 20, offset = 0 } = options;

  const where: any = { orgId };
  if (type) where.type = type;
  if (isEnabled !== undefined) where.isEnabled = isEnabled;

  const [integrations, total] = await Promise.all([
    prisma.integration.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        type: true,
        name: true,
        config: true,
        scopes: true,
        isEnabled: true,
        isConnected: true,
        lastSyncAt: true,
        lastError: true,
        externalId: true,
        externalName: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.integration.count({ where }),
  ]);

  return { integrations, total };
}

export async function getIntegration(orgId: string, integrationId: string) {
  return prisma.integration.findFirst({
    where: { id: integrationId, orgId },
    select: {
      id: true,
      type: true,
      name: true,
      config: true,
      scopes: true,
      isEnabled: true,
      isConnected: true,
      lastSyncAt: true,
      lastError: true,
      externalId: true,
      externalName: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function updateIntegration(
  orgId: string,
  integrationId: string,
  input: UpdateIntegrationInput
) {
  return prisma.integration.update({
    where: { id: integrationId },
    data: {
      name: input.name,
      config: input.config as any,
      scopes: input.scopes,
      isEnabled: input.isEnabled,
    },
  });
}

export async function deleteIntegration(orgId: string, integrationId: string) {
  return prisma.integration.delete({
    where: { id: integrationId },
  });
}

// ============================================
// OAuth Flow Support
// ============================================

export function generateOAuthState(orgId: string, integrationType: IntegrationType): string {
  const payload = {
    orgId,
    type: integrationType,
    nonce: crypto.randomBytes(16).toString("hex"),
    timestamp: Date.now(),
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function parseOAuthState(state: string): {
  orgId: string;
  type: IntegrationType;
  nonce: string;
  timestamp: number;
} | null {
  try {
    const payload = JSON.parse(Buffer.from(state, "base64url").toString());
    // Check if state is expired (15 minutes)
    if (Date.now() - payload.timestamp > 15 * 60 * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function completeOAuthFlow(
  orgId: string,
  integrationId: string,
  credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    externalId?: string;
    externalName?: string;
  }
) {
  // Encrypt tokens before storing
  const encryptedAccessToken = encryptToken(credentials.accessToken);
  const encryptedRefreshToken = credentials.refreshToken
    ? encryptToken(credentials.refreshToken)
    : null;

  return prisma.integration.update({
    where: { id: integrationId },
    data: {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: credentials.expiresAt,
      externalId: credentials.externalId,
      externalName: credentials.externalName,
      isConnected: true,
      lastError: null,
    },
  });
}

export async function disconnectIntegration(orgId: string, integrationId: string) {
  return prisma.integration.update({
    where: { id: integrationId },
    data: {
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      isConnected: false,
      externalId: null,
      externalName: null,
    },
  });
}

// ============================================
// Integration Actions
// ============================================

export async function sendSlackMessage(
  integrationId: string,
  channel: string,
  message: string,
  blocks?: any[]
) {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration || integration.type !== "slack" || !integration.accessToken) {
    throw new Error("Slack integration not configured");
  }

  const token = decryptToken(integration.accessToken);

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text: message,
      blocks,
    }),
  });

  const result = await response.json();

  // Log the event
  await prisma.integrationEvent.create({
    data: {
      integrationId,
      eventType: "action",
      action: "send_message",
      inputPayload: { channel, message: message.substring(0, 500) },
      outputPayload: result,
      status: result.ok ? "success" : "failed",
      errorMessage: result.error,
      completedAt: new Date(),
    },
  });

  if (!result.ok) {
    throw new Error(`Slack API error: ${result.error}`);
  }

  return result;
}

export async function sendDiscordMessage(
  integrationId: string,
  content: string,
  embeds?: any[]
) {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration || integration.type !== "discord") {
    throw new Error("Discord integration not configured");
  }

  const config = integration.config as { webhookUrl?: string };
  if (!config?.webhookUrl) {
    throw new Error("Discord webhook URL not configured");
  }

  const response = await safeFetch(config.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      embeds,
    }),
  });

  const success = response.ok;

  // Log the event
  await prisma.integrationEvent.create({
    data: {
      integrationId,
      eventType: "action",
      action: "send_message",
      inputPayload: { content: content.substring(0, 500) },
      status: success ? "success" : "failed",
      errorMessage: success ? null : `HTTP ${response.status}`,
      completedAt: new Date(),
    },
  });

  if (!success) {
    throw new Error(`Discord webhook error: HTTP ${response.status}`);
  }

  return { success: true };
}

export async function triggerZapierWebhook(
  integrationId: string,
  data: Record<string, any>
) {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration || integration.type !== "zapier") {
    throw new Error("Zapier integration not configured");
  }

  const config = integration.config as { webhookUrl?: string };
  if (!config?.webhookUrl) {
    throw new Error("Zapier webhook URL not configured");
  }

  const response = await safeFetch(config.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  const success = response.ok;
  let responseData = null;
  try {
    responseData = await response.json();
  } catch {
    // Ignore JSON parse errors
  }

  // Log the event
  await prisma.integrationEvent.create({
    data: {
      integrationId,
      eventType: "action",
      action: "trigger_workflow",
      inputPayload: data,
      outputPayload: responseData,
      status: success ? "success" : "failed",
      errorMessage: success ? null : `HTTP ${response.status}`,
      completedAt: new Date(),
    },
  });

  if (!success) {
    throw new Error(`Zapier webhook error: HTTP ${response.status}`);
  }

  return { success: true, response: responseData };
}

export async function triggerMakeWebhook(
  integrationId: string,
  data: Record<string, any>
) {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration || integration.type !== "make") {
    throw new Error("Make integration not configured");
  }

  const config = integration.config as { webhookUrl?: string };
  if (!config?.webhookUrl) {
    throw new Error("Make webhook URL not configured");
  }

  const response = await safeFetch(config.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  const success = response.ok;

  // Log the event
  await prisma.integrationEvent.create({
    data: {
      integrationId,
      eventType: "action",
      action: "trigger_workflow",
      inputPayload: data,
      status: success ? "success" : "failed",
      errorMessage: success ? null : `HTTP ${response.status}`,
      completedAt: new Date(),
    },
  });

  if (!success) {
    throw new Error(`Make webhook error: HTTP ${response.status}`);
  }

  return { success: true };
}

export async function triggerN8nWebhook(
  integrationId: string,
  data: Record<string, any>
) {
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration || integration.type !== "n8n") {
    throw new Error("n8n integration not configured");
  }

  const config = integration.config as { webhookUrl?: string };
  if (!config?.webhookUrl) {
    throw new Error("n8n webhook URL not configured");
  }

  const response = await safeFetch(config.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });

  const success = response.ok;
  let responseData = null;
  try {
    responseData = await response.json();
  } catch {
    // Ignore JSON parse errors
  }

  // Log the event
  await prisma.integrationEvent.create({
    data: {
      integrationId,
      eventType: "action",
      action: "trigger_workflow",
      inputPayload: data,
      outputPayload: responseData,
      status: success ? "success" : "failed",
      errorMessage: success ? null : `HTTP ${response.status}`,
      completedAt: new Date(),
    },
  });

  if (!success) {
    throw new Error(`n8n webhook error: HTTP ${response.status}`);
  }

  return { success: true, response: responseData };
}

// ============================================
// Integration Events
// ============================================

export async function getIntegrationEvents(
  orgId: string,
  integrationId: string,
  options: {
    limit?: number;
    offset?: number;
    status?: string;
    action?: string;
  } = {}
) {
  const { limit = 20, offset = 0, status, action } = options;

  // Verify integration belongs to org
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, orgId },
  });

  if (!integration) {
    throw new Error("Integration not found");
  }

  const where: any = { integrationId };
  if (status) where.status = status;
  if (action) where.action = action;

  const [events, total] = await Promise.all([
    prisma.integrationEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.integrationEvent.count({ where }),
  ]);

  return { events, total };
}

// ============================================
// Token Encryption Helpers
// ============================================

import { env } from "../config/env.js";
const ENCRYPTION_KEY = env.ENCRYPTION_KEY || env.JWT_SECRET;
const ALGORITHM = "aes-256-gcm";

function encryptToken(token: string): Buffer {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, "hex").slice(0, 32),
    iv
  );

  let encrypted = cipher.update(token, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  // Combine iv + authTag + encrypted data
  return Buffer.concat([iv, authTag, Buffer.from(encrypted, "hex")]);
}

function decryptToken(encryptedBuffer: Buffer): string {
  const iv = encryptedBuffer.slice(0, 16);
  const authTag = encryptedBuffer.slice(16, 32);
  const encrypted = encryptedBuffer.slice(32);

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, "hex").slice(0, 32),
    iv
  );
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted.toString("hex"), "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

// ============================================
// Available Integrations Info
// ============================================

export function getAvailableIntegrations() {
  return [
    {
      type: "slack",
      name: "Slack",
      description: "Send notifications and interact with Slack channels",
      icon: "slack",
      features: ["notifications", "messages", "alerts"],
      requiresOAuth: true,
    },
    {
      type: "discord",
      name: "Discord",
      description: "Send notifications to Discord channels via webhooks",
      icon: "discord",
      features: ["notifications", "messages"],
      requiresOAuth: false,
    },
    {
      type: "github",
      name: "GitHub",
      description: "Deploy agents from GitHub repositories and sync code",
      icon: "github",
      features: ["deployment", "sync", "issues"],
      requiresOAuth: true,
    },
    {
      type: "zapier",
      name: "Zapier",
      description: "Connect WheelsAI to 5,000+ apps via Zapier workflows",
      icon: "zapier",
      features: ["automation", "workflows"],
      requiresOAuth: false,
    },
    {
      type: "make",
      name: "Make (Integromat)",
      description: "Build powerful automations with Make scenarios",
      icon: "make",
      features: ["automation", "workflows"],
      requiresOAuth: false,
    },
    {
      type: "n8n",
      name: "n8n",
      description: "Self-hosted workflow automation with n8n",
      icon: "n8n",
      features: ["automation", "workflows", "self-hosted"],
      requiresOAuth: false,
    },
  ];
}
