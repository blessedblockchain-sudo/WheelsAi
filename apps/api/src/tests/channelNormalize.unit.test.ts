import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/channelNormalize.ts — the function that takes
// a raw platform-specific webhook payload and flattens it into the
// InboundMessage shape the agent-message BullMQ queue consumes. The queue
// payload must be platform-agnostic so the agent runtime doesn't need to
// know whether a message came from Discord, Telegram, Slack, etc.

// ============================================
// Discord
// ============================================

test("normalizeInboundMessage parses a Discord MESSAGE_CREATE event", async () => {
  setupEnv();
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  // Abbreviated Discord event shape (t=MESSAGE_CREATE, d=message object)
  const payload = {
    t: "MESSAGE_CREATE",
    d: {
      id: "msg_123",
      channel_id: "chan_abc",
      guild_id: "guild_z",
      author: { id: "user_42", username: "alice", bot: false },
      content: "hey bot",
    },
  };
  const msg = normalizeInboundMessage({ platform: "discord", payload });
  assert.deepEqual(msg, {
    platform: "discord",
    messageId: "msg_123",
    channelId: "chan_abc",
    userId: "user_42",
    userName: "alice",
    text: "hey bot",
    raw: payload,
  });
});

test("normalizeInboundMessage drops Discord messages authored by bots", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  const payload = {
    t: "MESSAGE_CREATE",
    d: {
      id: "msg_1",
      channel_id: "chan_x",
      author: { id: "bot_1", username: "other-bot", bot: true },
      content: "loop forever",
    },
  };
  const msg = normalizeInboundMessage({ platform: "discord", payload });
  assert.equal(msg, null);
});

test("normalizeInboundMessage ignores non-MESSAGE_CREATE Discord events", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  const payload = {
    t: "PING",
    d: {},
  };
  assert.equal(normalizeInboundMessage({ platform: "discord", payload }), null);
});

// ============================================
// Telegram
// ============================================

test("normalizeInboundMessage parses a Telegram text message update", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  const payload = {
    update_id: 1001,
    message: {
      message_id: 5,
      chat: { id: 12345, type: "private" },
      from: { id: 67890, username: "bob" },
      text: "gm",
    },
  };
  const msg = normalizeInboundMessage({ platform: "telegram", payload });
  assert.deepEqual(msg, {
    platform: "telegram",
    messageId: "5",
    channelId: "12345",
    userId: "67890",
    userName: "bob",
    text: "gm",
    raw: payload,
  });
});

test("normalizeInboundMessage returns null for Telegram updates without a text message", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  assert.equal(
    normalizeInboundMessage({
      platform: "telegram",
      payload: { update_id: 2, edited_message: { text: "edit" } },
    }),
    null
  );
});

// ============================================
// Slack
// ============================================

test("normalizeInboundMessage parses a Slack event_callback message event", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  const payload = {
    type: "event_callback",
    event: {
      type: "message",
      channel: "C123",
      user: "U456",
      ts: "1713964800.000100",
      text: "what is up",
    },
  };
  const msg = normalizeInboundMessage({ platform: "slack", payload });
  assert.deepEqual(msg, {
    platform: "slack",
    messageId: "1713964800.000100",
    channelId: "C123",
    userId: "U456",
    userName: null,
    text: "what is up",
    raw: payload,
  });
});

test("normalizeInboundMessage drops Slack bot_message subtypes", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  const payload = {
    type: "event_callback",
    event: {
      type: "message",
      subtype: "bot_message",
      channel: "C123",
      bot_id: "B1",
      ts: "1.2",
      text: "I am a bot",
    },
  };
  assert.equal(normalizeInboundMessage({ platform: "slack", payload }), null);
});

test("normalizeInboundMessage responds to Slack url_verification with challenge passthrough", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  // url_verification is a special case — the verifier needs to know to
  // return the challenge rather than enqueue a message. We represent that
  // as a sentinel object so the route can branch on it.
  const payload = { type: "url_verification", challenge: "abc123" };
  const result = normalizeInboundMessage({ platform: "slack", payload });
  assert.deepEqual(result, { __special: "slack_url_verification", challenge: "abc123" });
});

// ============================================
// Unknown / malformed
// ============================================

test("normalizeInboundMessage returns null for an unsupported platform", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  assert.equal(
    normalizeInboundMessage({ platform: "whatsapp" as any, payload: {} }),
    null
  );
});

test("normalizeInboundMessage returns null for an unparseable payload", async () => {
  const { normalizeInboundMessage } = await import("../services/channelNormalize.js");
  assert.equal(normalizeInboundMessage({ platform: "discord", payload: null }), null);
  assert.equal(
    normalizeInboundMessage({ platform: "telegram", payload: "not an object" }),
    null
  );
});
