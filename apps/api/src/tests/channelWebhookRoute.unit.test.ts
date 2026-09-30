import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import Fastify from "fastify";
import nacl from "tweetnacl";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/routes/channelWebhooks.ts — the inbound route that
// receives Discord/Telegram/Slack callbacks, authenticates them, normalizes
// them, and enqueues them to the agent-message BullMQ queue.
//
// All deps are injected (resolveChannelConfig, enqueue) so these tests never
// touch Prisma or Redis.

interface ChannelConfig {
  deploymentId: string;
  platform: "discord" | "telegram" | "slack";
  credentials:
    | { kind: "discord"; publicKeyHex: string }
    | { kind: "telegram"; botToken: string }
    | { kind: "slack"; signingSecret: string };
}

function buildApp(deps: any) {
  const app = Fastify();
  return import("../routes/channelWebhooks.js").then(async (mod) => {
    await app.register(mod.createChannelWebhookRoutes(deps));
    return app;
  });
}

// ============================================
// Discord
// ============================================

test("channel webhook route rejects a bad Discord signature with 401", async () => {
  setupEnv();
  const kp = nacl.sign.keyPair();
  const publicKeyHex = Buffer.from(kp.publicKey).toString("hex");
  const enqueued: any[] = [];
  const app = await buildApp({
    resolveChannelConfig: async (): Promise<ChannelConfig> => ({
      deploymentId: "dep_1",
      platform: "discord",
      credentials: { kind: "discord", publicKeyHex },
    }),
    enqueue: async (p: any) => {
      enqueued.push(p);
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/dep_1/discord",
    payload: JSON.stringify({ type: 1 }),
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": "deadbeef".repeat(16), // 64 bytes of junk
      "x-signature-timestamp": "1",
    },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(enqueued.length, 0);
});

test("channel webhook route responds to Discord PING (type=1) with pong without enqueueing", async () => {
  const kp = nacl.sign.keyPair();
  const publicKeyHex = Buffer.from(kp.publicKey).toString("hex");
  const enqueued: any[] = [];
  const app = await buildApp({
    resolveChannelConfig: async (): Promise<ChannelConfig> => ({
      deploymentId: "dep_1",
      platform: "discord",
      credentials: { kind: "discord", publicKeyHex },
    }),
    enqueue: async (p: any) => {
      enqueued.push(p);
    },
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 1 });
  const sig = Buffer.from(
    nacl.sign.detached(Buffer.from(timestamp + body), kp.secretKey)
  ).toString("hex");

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/dep_1/discord",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sig,
      "x-signature-timestamp": timestamp,
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { type: 1 }); // pong
  assert.equal(enqueued.length, 0);
});

test("channel webhook route enqueues a valid Discord MESSAGE_CREATE event", async () => {
  const kp = nacl.sign.keyPair();
  const publicKeyHex = Buffer.from(kp.publicKey).toString("hex");
  const enqueued: any[] = [];
  const app = await buildApp({
    resolveChannelConfig: async (): Promise<ChannelConfig> => ({
      deploymentId: "dep_1",
      platform: "discord",
      credentials: { kind: "discord", publicKeyHex },
    }),
    enqueue: async (p: any) => {
      enqueued.push(p);
    },
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    t: "MESSAGE_CREATE",
    d: {
      id: "m_1",
      channel_id: "c_1",
      author: { id: "u_1", username: "alice", bot: false },
      content: "hi bot",
    },
  });
  const sig = Buffer.from(
    nacl.sign.detached(Buffer.from(timestamp + body), kp.secretKey)
  ).toString("hex");

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/dep_1/discord",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sig,
      "x-signature-timestamp": timestamp,
    },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].deploymentId, "dep_1");
  assert.equal(enqueued[0].platform, "discord");
  assert.equal(enqueued[0].message.text, "hi bot");
});

test("channel webhook route does not enqueue a Discord message authored by a bot", async () => {
  const kp = nacl.sign.keyPair();
  const publicKeyHex = Buffer.from(kp.publicKey).toString("hex");
  const enqueued: any[] = [];
  const app = await buildApp({
    resolveChannelConfig: async (): Promise<ChannelConfig> => ({
      deploymentId: "dep_1",
      platform: "discord",
      credentials: { kind: "discord", publicKeyHex },
    }),
    enqueue: async (p: any) => {
      enqueued.push(p);
    },
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    t: "MESSAGE_CREATE",
    d: {
      id: "m_1",
      channel_id: "c_1",
      author: { id: "other_bot", username: "other", bot: true },
      content: "loop",
    },
  });
  const sig = Buffer.from(
    nacl.sign.detached(Buffer.from(timestamp + body), kp.secretKey)
  ).toString("hex");

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/dep_1/discord",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": sig,
      "x-signature-timestamp": timestamp,
    },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(enqueued.length, 0);
});

// ============================================
// Telegram
// ============================================

test("channel webhook route enqueues a valid Telegram text message", async () => {
  const botToken = "123456:TEST";
  const body = JSON.stringify({
    update_id: 1,
    message: {
      message_id: 5,
      chat: { id: 11, type: "private" },
      from: { id: 22, username: "bob" },
      text: "gm",
    },
  });
  const { telegramWebhookSecret } = await import("../services/channelAuth.js");
  const secretToken = telegramWebhookSecret(botToken, "dep_tg");
  const enqueued: any[] = [];
  const app = await buildApp({
    resolveChannelConfig: async (): Promise<ChannelConfig> => ({
      deploymentId: "dep_tg",
      platform: "telegram",
      credentials: { kind: "telegram", botToken },
    }),
    enqueue: async (p: any) => {
      enqueued.push(p);
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/webhooks/dep_tg/telegram",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secretToken,
    },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].message.text, "gm");
  assert.equal(enqueued[0].message.userName, "bob");
});

test("channel webhook route rejects a wrong Telegram secret token with 401", async () => {
  const botToken = "123456:TEST";
  const body = JSON.stringify({ update_id: 1, message: { message_id: 5, chat: { id: 1 }, from: { id: 2 }, text: "x" } });
  const enqueued: any[] = [];
  const app = await buildApp({
    resolveChannelConfig: async (): Promise<ChannelConfig> => ({
      deploymentId: "dep_tg",
      platform: "telegram",
      credentials: { kind: "telegram", botToken },
    }),
    enqueue: async (p: any) => {
      enqueued.push(p);
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/dep_tg/telegram",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": "deadbeef",
    },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(enqueued.length, 0);
});

// ============================================
// Slack
// ============================================

test("channel webhook route answers Slack url_verification with the challenge", async () => {
  const signingSecret = "slack_secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: "url_verification", challenge: "chal123" });
  const sigBase = `v0:${timestamp}:${body}`;
  const signature =
    "v0=" + crypto.createHmac("sha256", signingSecret).update(sigBase).digest("hex");
  const enqueued: any[] = [];
  const app = await buildApp({
    resolveChannelConfig: async (): Promise<ChannelConfig> => ({
      deploymentId: "dep_slack",
      platform: "slack",
      credentials: { kind: "slack", signingSecret },
    }),
    enqueue: async (p: any) => {
      enqueued.push(p);
    },
  });
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
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { challenge: "chal123" });
  assert.equal(enqueued.length, 0);
});

test("channel webhook route enqueues a valid Slack event_callback message", async () => {
  const signingSecret = "slack_secret";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type: "event_callback",
    event: {
      type: "message",
      channel: "C1",
      user: "U1",
      ts: "1.0",
      text: "what",
    },
  });
  const sigBase = `v0:${timestamp}:${body}`;
  const signature =
    "v0=" + crypto.createHmac("sha256", signingSecret).update(sigBase).digest("hex");
  const enqueued: any[] = [];
  const app = await buildApp({
    resolveChannelConfig: async (): Promise<ChannelConfig> => ({
      deploymentId: "dep_slack",
      platform: "slack",
      credentials: { kind: "slack", signingSecret },
    }),
    enqueue: async (p: any) => {
      enqueued.push(p);
    },
  });
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
  assert.equal(enqueued[0].message.text, "what");
});

// ============================================
// Misc
// ============================================

test("channel webhook route returns 404 when the deployment has no channel config", async () => {
  const app = await buildApp({
    resolveChannelConfig: async () => null,
    enqueue: async () => {},
  });
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/missing_dep/discord",
    payload: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.statusCode, 404);
});

test("channel webhook route returns 404 for an unsupported platform", async () => {
  const app = await buildApp({
    resolveChannelConfig: async () => null,
    enqueue: async () => {},
  });
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/dep_1/myspace",
    payload: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.equal(res.statusCode, 404);
});
