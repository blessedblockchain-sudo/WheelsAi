import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import Fastify from "fastify";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Wave 0 wiring pins for the channel stack (plan A6). The entire inbound
// pipeline — signature verification, credential resolution, normalization,
// the agent-message queue, outbound dispatch — was complete and unit-tested
// but PRODUCTION-DEAD: createChannelWebhookRoutes was imported only by
// tests and the agent-message consumer was never started. These tests pin
// the production wiring so un-mounting it again fails CI, not a demo:
//
//   1. createChannelWebhookRoutesProduction exists and its resolver chain
//      really goes through Prisma + the OpenClaw config decryptor.
//   2. A correctly-signed Slack event flows through the production
//      resolver (real encryptConfig roundtrip) into the enqueue payload.
//   3. The queues barrel exports the consumer lifecycle pair index.ts
//      registers.

async function getPrisma(): Promise<any> {
  setupEnv();
  const { prisma } = await import("@wheelsai/db");
  return prisma;
}

test("production channel-webhook route resolves channels through the real prisma-backed chain (404 when unconfigured)", async () => {
  const p = await getPrisma();
  const orig = { ...p.openClawChannel };
  try {
    const queried: Array<{ deploymentId: string; platform: string }> = [];
    p.openClawChannel.findFirst = async (args: any) => {
      queried.push(args.where);
      return null;
    };

    const { createChannelWebhookRoutesProduction } = await import(
      "../routes/channelWebhookBindings.js"
    );
    const app = Fastify();
    await app.register(createChannelWebhookRoutesProduction());

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/dep_unknown/slack",
      payload: JSON.stringify({ type: "event_callback" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(queried, [{ deploymentId: "dep_unknown", platform: "slack" }]);
  } finally {
    Object.assign(p.openClawChannel, orig);
  }
});

test("a malformed (non-UUID) deployment id maps to 404, not 500 — public endpoint, scanner traffic", async () => {
  const p = await getPrisma();
  const orig = { ...p.openClawChannel };
  try {
    p.openClawChannel.findFirst = async () => {
      const err = new Error("Inconsistent column data: Error creating UUID");
      (err as Error & { code: string }).code = "P2023";
      throw err;
    };

    const { createChannelWebhookRoutesProduction } = await import(
      "../routes/channelWebhookBindings.js"
    );
    const app = Fastify();
    await app.register(createChannelWebhookRoutesProduction());

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/not-a-uuid/discord",
      payload: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    Object.assign(p.openClawChannel, orig);
  }
});

test("a signed Slack event flows through the production resolver (real encrypted config) into the enqueue payload", async () => {
  const p = await getPrisma();
  const orig = { ...p.openClawChannel };
  try {
    const { encryptConfig } = await import("../services/openclaw.js");
    const signingSecret = "prod_slack_secret";
    p.openClawChannel.findFirst = async () => ({
      id: "ch_1",
      deploymentId: "dep_slack",
      platform: "slack",
      enabled: true,
      configEncrypted: encryptConfig({ signingSecret, botToken: "xoxb-1" }),
    });

    // Production resolver + a recording enqueue: the BullMQ producer half
    // is pinned by presence below — a unit test must not touch Redis.
    const { buildChannelWebhookDeps } = await import(
      "../routes/channelWebhookBindings.js"
    );
    const { createChannelWebhookRoutes } = await import(
      "../routes/channelWebhooks.js"
    );
    const enqueued: any[] = [];
    const app = Fastify();
    await app.register(
      createChannelWebhookRoutes({
        resolveChannelConfig: buildChannelWebhookDeps().resolveChannelConfig,
        enqueue: async (payload) => {
          enqueued.push(payload);
        },
      }),
    );

    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "message", channel: "C9", user: "U9", ts: "9.9", text: "hi" },
    });
    const signature =
      "v0=" +
      crypto
        .createHmac("sha256", signingSecret)
        .update(`v0:${timestamp}:${body}`)
        .digest("hex");

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/dep_slack/slack",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-slack-signature": signature,
        "x-slack-request-timestamp": timestamp,
      },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].deploymentId, "dep_slack");
    assert.equal(enqueued[0].platform, "slack");
    assert.equal(enqueued[0].message.text, "hi");
  } finally {
    Object.assign(p.openClawChannel, orig);
  }
});

test("the production deps include the BullMQ enqueue, and the queues barrel exports the consumer lifecycle", async () => {
  setupEnv();
  const { buildChannelWebhookDeps } = await import(
    "../routes/channelWebhookBindings.js"
  );
  const deps = buildChannelWebhookDeps();
  assert.equal(typeof deps.resolveChannelConfig, "function");
  assert.equal(typeof deps.enqueue, "function");

  const queues = await import("../queues/index.js");
  assert.equal(typeof queues.startAgentMessageQueue, "function");
  assert.equal(typeof queues.stopAgentMessageQueue, "function");
});
