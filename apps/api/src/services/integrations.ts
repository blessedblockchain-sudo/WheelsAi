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
  // orgId is part of the WHERE, not just a parameter that gets ignored.
  // Route-level pre-checks existed for some callers but not all, and a
  // guard that lives only at the call site is one new caller away from a
  // cross-tenant write.
  const updated = await prisma.integration.updateMany({
    where: { id: integrationId, orgId },
    data: {
      name: input.name,
      config: input.config as any,
      scopes: input.scopes,
      isEnabled: input.isEnabled,
    },
  });
  if (updated.count === 0) {
    throw new Error("Integration not found");
  }
  return prisma.integration.findFirstOrThrow({ where: { id: integrationId, orgId } });
}

export async function deleteIntegration(orgId: string, integrationId: string) {
  const deleted = await prisma.integration.deleteMany({
    where: { id: integrationId, orgId },
  });
  if (deleted.count === 0) {
    throw new Error("Integration not found");
  }
  return { success: true };
}

// ============================================
// OAuth Flow Support
// ============================================

// OAuth state generation/parsing used to live here. It was removed, not
// replaced in place: `generateOAuthState` emitted UNSIGNED base64url JSON
// containing the orgId, and `parseOAuthState` checked expiry using the
// timestamp from that same attacker-supplied blob. Anyone could mint a
// state binding an install to any organization. `completeOAuthFlow` went
// with them — it was the only writer of `isConnected` and had zero
// callers. The replacement is services/signedState.ts (HMAC-signed,
// server-side TTL) plus a single-use nonce; see services/oauthStateStore.ts.

export async function disconnectIntegration(orgId: string, integrationId: string) {
  // This was the one LIVE cross-org IDOR: the route had no ownership
  // pre-check and this function accepted orgId and never used it, so any
  // authenticated user could disconnect any organization's integration
  // by id.
  const updated = await prisma.integration.updateMany({
    where: { id: integrationId, orgId },
    data: {
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      isConnected: false,
      externalId: null,
      externalName: null,
    },
  });
  if (updated.count === 0) {
    throw new Error("Integration not found");
  }
  return prisma.integration.findFirstOrThrow({ where: { id: integrationId, orgId } });
}

// ============================================
// Integration Actions
// ============================================

export async function sendSlackMessage(
  orgId: string,
  integrationId: string,
  channel: string,
  message: string,
  blocks?: any[]
) {
  // Scoped read: a sender that resolves by bare id would let any caller
  // fire another organization's configured webhook (and, via the test
  // endpoint's stored response, read what it returned).
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, orgId },
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
  orgId: string,
  integrationId: string,
  content: string,
  embeds?: any[]
) {
  // Scoped read: a sender that resolves by bare id would let any caller
  // fire another organization's configured webhook (and, via the test
  // endpoint's stored response, read what it returned).
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, orgId },
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
  orgId: string,
  integrationId: string,
  data: Record<string, any>
) {
  // Scoped read: a sender that resolves by bare id would let any caller
  // fire another organization's configured webhook (and, via the test
  // endpoint's stored response, read what it returned).
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, orgId },
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
  orgId: string,
  integrationId: string,
  data: Record<string, any>
) {
  // Scoped read: a sender that resolves by bare id would let any caller
  // fire another organization's configured webhook (and, via the test
  // endpoint's stored response, read what it returned).
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, orgId },
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
  orgId: string,
  integrationId: string,
  data: Record<string, any>
) {
  // Scoped read: a sender that resolves by bare id would let any caller
  // fire another organization's configured webhook (and, via the test
  // endpoint's stored response, read what it returned).
  const integration = await prisma.integration.findFirst({
    where: { id: integrationId, orgId },
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

const ALGORITHM = "aes-256-gcm";

/**
 * Derives a guaranteed-valid 32-byte key.
 *
 * The previous derivation was `getEncryptionKey()`
 * against an env var validated as `z.string().min(32)` — CHARACTERS, not
 * hex. `Buffer.from(x, "hex")` stops at the first non-hex character, so a
 * normal passphrase silently produced a short (often empty) key and
 * createCipheriv threw at runtime. sha256 always yields exactly 32 bytes
 * from any input. Read lazily, so rotating the secret does not require a
 * process restart to take effect.
 */
function getEncryptionKey(): Buffer {
  const secret = env.ENCRYPTION_KEY || env.JWT_SECRET;
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptToken(token: string): Buffer {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    ALGORITHM,
    getEncryptionKey(),
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
    getEncryptionKey(),
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
