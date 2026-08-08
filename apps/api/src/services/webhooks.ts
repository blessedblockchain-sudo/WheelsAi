import { prisma } from "@wheelsai/db";
import crypto from "crypto";
import { safeFetch } from "../lib/ssrfGuard.js";

// ============================================
// Types
// ============================================

export type WebhookEventType =
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "agent.deployed"
  | "agent.version.created"
  | "deployment.started"
  | "deployment.running"
  | "deployment.stopped"
  | "deployment.failed"
  | "training.started"
  | "training.completed"
  | "training.failed"
  | "alert.triggered"
  | "alert.resolved"
  | "billing.low_balance"
  | "billing.payment_received";

export const WEBHOOK_EVENTS: WebhookEventType[] = [
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.deployed",
  "agent.version.created",
  "deployment.started",
  "deployment.running",
  "deployment.stopped",
  "deployment.failed",
  "training.started",
  "training.completed",
  "training.failed",
  "alert.triggered",
  "alert.resolved",
  "billing.low_balance",
  "billing.payment_received",
];

export interface CreateWebhookInput {
  name: string;
  description?: string;
  url: string;
  events: string[];
  resourceType?: string;
  resourceId?: string;
  headers?: Record<string, string>;
  retryCount?: number;
  timeoutSeconds?: number;
}

export interface UpdateWebhookInput {
  name?: string;
  description?: string;
  url?: string;
  events?: string[];
  resourceType?: string;
  resourceId?: string;
  headers?: Record<string, string>;
  retryCount?: number;
  timeoutSeconds?: number;
  isEnabled?: boolean;
}

export interface WebhookPayload {
  id: string;
  type: WebhookEventType;
  timestamp: string;
  data: Record<string, any>;
}

function toWebhookPayload(value: unknown): WebhookPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const payload = value as Record<string, unknown>;
  if (
    typeof payload.id !== "string" ||
    typeof payload.type !== "string" ||
    typeof payload.timestamp !== "string" ||
    typeof payload.data !== "object" ||
    payload.data === null
  ) {
    return null;
  }

  return payload as unknown as WebhookPayload;
}

function normalizeWebhookHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

// ============================================
// Webhook CRUD Operations
// ============================================

export async function createWebhook(orgId: string, input: CreateWebhookInput) {
  // Generate a secure secret for HMAC signature
  const secret = crypto.randomBytes(32).toString("hex");

  return prisma.webhook.create({
    data: {
      orgId,
      name: input.name,
      description: input.description,
      url: input.url,
      secret,
      events: input.events,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      headers: input.headers,
      retryCount: input.retryCount ?? 3,
      timeoutSeconds: input.timeoutSeconds ?? 30,
    },
  });
}

export async function getWebhooks(
  orgId: string,
  options: {
    limit?: number;
    offset?: number;
    isEnabled?: boolean;
  } = {}
) {
  const { limit = 20, offset = 0, isEnabled } = options;

  const where: any = { orgId };
  if (isEnabled !== undefined) {
    where.isEnabled = isEnabled;
  }

  const [webhooks, total] = await Promise.all([
    prisma.webhook.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        name: true,
        description: true,
        url: true,
        events: true,
        resourceType: true,
        resourceId: true,
        isEnabled: true,
        retryCount: true,
        timeoutSeconds: true,
        lastDeliveredAt: true,
        lastFailedAt: true,
        lastError: true,
        consecutiveFailures: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.webhook.count({ where }),
  ]);

  return { webhooks, total };
}

export async function getWebhook(orgId: string, webhookId: string) {
  return prisma.webhook.findFirst({
    where: { id: webhookId, orgId },
    include: {
      deliveries: {
        orderBy: { scheduledAt: "desc" },
        take: 10,
      },
    },
  });
}

export async function updateWebhook(
  orgId: string,
  webhookId: string,
  input: UpdateWebhookInput
) {
  const updated = await prisma.webhook.updateMany({
    where: { id: webhookId, orgId },
    data: {
      name: input.name,
      description: input.description,
      url: input.url,
      events: input.events,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      headers: input.headers,
      retryCount: input.retryCount,
      timeoutSeconds: input.timeoutSeconds,
      isEnabled: input.isEnabled,
    },
  });
  if (updated.count === 0) {
    throw new Error("Webhook not found");
  }
  return prisma.webhook.findFirstOrThrow({ where: { id: webhookId, orgId } });
}

export async function deleteWebhook(orgId: string, webhookId: string) {
  const deleted = await prisma.webhook.deleteMany({
    where: { id: webhookId, orgId },
  });
  if (deleted.count === 0) {
    throw new Error("Webhook not found");
  }
  return { success: true };
}

export async function regenerateWebhookSecret(orgId: string, webhookId: string) {
  const secret = crypto.randomBytes(32).toString("hex");

  const rotated = await prisma.webhook.updateMany({
    where: { id: webhookId, orgId },
    data: { secret },
  });
  if (rotated.count === 0) {
    throw new Error("Webhook not found");
  }
  return { id: webhookId, secret };
}

// ============================================
// Webhook Delivery
// ============================================

export async function triggerWebhook(
  orgId: string,
  eventType: WebhookEventType,
  data: Record<string, any>,
  resourceType?: string,
  resourceId?: string
) {
  // Find all webhooks subscribed to this event
  const webhooks = await prisma.webhook.findMany({
    where: {
      orgId,
      isEnabled: true,
      events: { has: eventType },
      ...(resourceType && {
        OR: [{ resourceType: null }, { resourceType }],
      }),
      ...(resourceId && {
        OR: [{ resourceId: null }, { resourceId }],
      }),
    },
  });

  const eventId = crypto.randomUUID();
  const payload: WebhookPayload = {
    id: eventId,
    type: eventType,
    timestamp: new Date().toISOString(),
    data,
  };

  // Create delivery records for each webhook
  const deliveries = await Promise.all(
    webhooks.map((webhook) =>
      prisma.webhookDelivery.create({
        data: {
          webhookId: webhook.id,
          eventType,
          eventId,
          payload: payload as any,
          status: "pending",
        },
      })
    )
  );

  // Trigger deliveries asynchronously
  for (const delivery of deliveries) {
    const webhook = webhooks.find((w) => w.id === delivery.webhookId);
    if (webhook) {
      deliverWebhook(webhook, delivery.id, payload).catch((err) => {
        console.error(`Webhook delivery failed: ${err.message}`);
      });
    }
  }

  return { eventId, webhooksTriggered: webhooks.length };
}

async function deliverWebhook(
  webhook: {
    id: string;
    url: string;
    secret: string;
    headers: any;
    timeoutSeconds: number;
    retryCount: number;
  },
  deliveryId: string,
  payload: WebhookPayload
) {
  const payloadString = JSON.stringify(payload);

  // Generate HMAC signature
  const signature = crypto
    .createHmac("sha256", webhook.secret)
    .update(payloadString)
    .digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Signature": `sha256=${signature}`,
    "X-Webhook-Event": payload.type,
    "X-Webhook-Delivery": deliveryId,
    ...normalizeWebhookHeaders(webhook.headers),
  };

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhook.timeoutSeconds * 1000);

    const response = await safeFetch(webhook.url, {
      method: "POST",
      headers,
      body: payloadString,
      timeoutMs: webhook.timeoutSeconds * 1000,
    });

    clearTimeout(timeout);

    const responseTimeMs = Date.now() - startTime;
    const responseBody = await response.text();

    if (response.ok) {
      // Success
      await prisma.$transaction([
        prisma.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            status: "success",
            statusCode: response.status,
            responseBody: responseBody.substring(0, 10000),
            responseTimeMs,
            deliveredAt: new Date(),
          },
        }),
        prisma.webhook.update({
          where: { id: webhook.id },
          data: {
            lastDeliveredAt: new Date(),
            consecutiveFailures: 0,
            lastError: null,
          },
        }),
      ]);
    } else {
      // HTTP error
      throw new Error(`HTTP ${response.status}: ${responseBody.substring(0, 500)}`);
    }
  } catch (error: any) {
    const responseTimeMs = Date.now() - startTime;
    const errorMessage = error.message || "Unknown error";

    // Get current delivery to check attempt count
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
    });

    const attempt = delivery?.attempt || 1;
    const shouldRetry = attempt < webhook.retryCount;

    // Calculate next retry time with exponential backoff
    const nextRetryAt = shouldRetry
      ? new Date(Date.now() + Math.pow(2, attempt) * 60000) // 2^attempt minutes
      : null;

    await prisma.$transaction([
      prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: shouldRetry ? "retrying" : "failed",
          statusCode: null,
          responseTimeMs,
          errorMessage,
          attempt: attempt + 1,
          nextRetryAt,
        },
      }),
      prisma.webhook.update({
        where: { id: webhook.id },
        data: {
          lastFailedAt: new Date(),
          lastError: errorMessage,
          consecutiveFailures: { increment: 1 },
        },
      }),
    ]);

    // Schedule retry if needed
    if (shouldRetry && nextRetryAt) {
      setTimeout(async () => {
        const updatedWebhook = await prisma.webhook.findUnique({
          where: { id: webhook.id },
        });
        if (updatedWebhook && updatedWebhook.isEnabled) {
          const payload = toWebhookPayload(delivery?.payload);
          if (payload) {
            deliverWebhook(updatedWebhook, deliveryId, payload);
          }
        }
      }, nextRetryAt.getTime() - Date.now());
    }
  }
}

export async function getWebhookDeliveries(
  orgId: string,
  webhookId: string,
  options: {
    limit?: number;
    offset?: number;
    status?: string;
  } = {}
) {
  const { limit = 20, offset = 0, status } = options;

  // Verify webhook belongs to org
  const webhook = await prisma.webhook.findFirst({
    where: { id: webhookId, orgId },
  });

  if (!webhook) {
    throw new Error("Webhook not found");
  }

  const where: any = { webhookId };
  if (status) {
    where.status = status;
  }

  const [deliveries, total] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where,
      orderBy: { scheduledAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.webhookDelivery.count({ where }),
  ]);

  return { deliveries, total };
}

export async function retryDelivery(orgId: string, webhookId: string, deliveryId: string) {
  const webhook = await prisma.webhook.findFirst({
    where: { id: webhookId, orgId },
  });

  if (!webhook) {
    throw new Error("Webhook not found");
  }

  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id: deliveryId, webhookId },
  });

  if (!delivery) {
    throw new Error("Delivery not found");
  }

  // Reset delivery status
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "pending",
      attempt: 1,
      nextRetryAt: null,
      errorMessage: null,
    },
  });

  // Trigger delivery
  const payload = toWebhookPayload(delivery.payload);
  if (!payload) {
    throw new Error("Invalid delivery payload");
  }
  deliverWebhook(webhook, deliveryId, payload);

  return { message: "Retry scheduled" };
}

export async function testWebhook(orgId: string, webhookId: string) {
  const webhook = await prisma.webhook.findFirst({
    where: { id: webhookId, orgId },
  });

  if (!webhook) {
    throw new Error("Webhook not found");
  }

  const testPayload: WebhookPayload = {
    id: crypto.randomUUID(),
    type: "agent.created",
    timestamp: new Date().toISOString(),
    data: {
      test: true,
      message: "This is a test webhook delivery",
      agentId: "test-agent-id",
      agentName: "Test Agent",
    },
  };

  // Create test delivery
  const delivery = await prisma.webhookDelivery.create({
    data: {
      webhookId,
      eventType: "agent.created",
      eventId: testPayload.id,
      payload: testPayload as any,
      status: "pending",
    },
  });

  // Deliver synchronously for test
  const payloadString = JSON.stringify(testPayload);
  const signature = crypto
    .createHmac("sha256", webhook.secret)
    .update(payloadString)
    .digest("hex");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Signature": `sha256=${signature}`,
    "X-Webhook-Event": testPayload.type,
    "X-Webhook-Delivery": delivery.id,
    "X-Webhook-Test": "true",
    ...normalizeWebhookHeaders(webhook.headers),
  };

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhook.timeoutSeconds * 1000);

    const response = await safeFetch(webhook.url, {
      method: "POST",
      headers,
      body: payloadString,
      timeoutMs: webhook.timeoutSeconds * 1000,
    });

    clearTimeout(timeout);

    const responseTimeMs = Date.now() - startTime;
    const responseBody = await response.text();

    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: response.ok ? "success" : "failed",
        statusCode: response.status,
        responseBody: responseBody.substring(0, 10000),
        responseTimeMs,
        deliveredAt: new Date(),
        errorMessage: response.ok ? null : `HTTP ${response.status}`,
      },
    });

    return {
      success: response.ok,
      statusCode: response.status,
      responseTimeMs,
      deliveryId: delivery.id,
    };
  } catch (error: any) {
    const responseTimeMs = Date.now() - startTime;

    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "failed",
        responseTimeMs,
        errorMessage: error.message,
      },
    });

    return {
      success: false,
      error: error.message,
      responseTimeMs,
      deliveryId: delivery.id,
    };
  }
}

// ============================================
// Signature Verification (for consumers)
// ============================================

// verifyWebhookSignature was removed. It built the right `sha256=` shape
// but compared with `===`, which short-circuits on the first differing
// byte and leaks the expected HMAC to a timing attacker. It had zero
// callers, so it was a trap for the next person to wire an inbound
// webhook. Use timingSafeEqualHex from services/channelAuth.ts, which
// guards non-hex input and length mismatch before crypto.timingSafeEqual
// (that function THROWS on unequal lengths, which is attacker-reachable).
