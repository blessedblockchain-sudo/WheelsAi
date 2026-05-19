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

// Drives apps/api/src/services/channelDispatch.ts — pure functions that take
// the reply text + the target channel config and return a {method, url,
// headers, body} request. The worker layer makes the actual fetch; these
// builders stay deterministic and trivially testable.

// ============================================
// Discord
// ============================================

test("buildDiscordReply targets the channel messages endpoint and uses a Bot token", async () => {
  setupEnv();
  const { buildDiscordReply } = await import("../services/channelDispatch.js");
  const req = buildDiscordReply({
    botToken: "MTE.xyz",
    channelId: "chan_abc",
    text: "hello back",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://discord.com/api/v10/channels/chan_abc/messages");
  assert.equal(req.headers["Authorization"], "Bot MTE.xyz");
  assert.equal(req.headers["Content-Type"], "application/json");
  const body = JSON.parse(req.body);
  assert.equal(body.content, "hello back");
});

test("buildDiscordReply truncates content to the 2000-character Discord limit", async () => {
  const { buildDiscordReply } = await import("../services/channelDispatch.js");
  const longText = "a".repeat(2500);
  const req = buildDiscordReply({
    botToken: "MTE.xyz",
    channelId: "c",
    text: longText,
  });
  const body = JSON.parse(req.body);
  assert.equal(body.content.length, 2000);
});

test("buildDiscordReply URL-encodes path segments defensively", async () => {
  const { buildDiscordReply } = await import("../services/channelDispatch.js");
  const req = buildDiscordReply({
    botToken: "t",
    channelId: "chan/with/slashes",
    text: "hi",
  });
  // channelId should be encoded so it cannot escape into subresources
  assert.equal(
    req.url,
    "https://discord.com/api/v10/channels/chan%2Fwith%2Fslashes/messages"
  );
});

// ============================================
// Telegram
// ============================================

test("buildTelegramReply targets sendMessage with chat_id in the body", async () => {
  setupEnv();
  const { buildTelegramReply } = await import("../services/channelDispatch.js");
  const req = buildTelegramReply({
    botToken: "123:ABC",
    chatId: "11",
    text: "gm",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://api.telegram.org/bot123:ABC/sendMessage");
  assert.equal(req.headers["Content-Type"], "application/json");
  const body = JSON.parse(req.body);
  assert.equal(body.chat_id, "11");
  assert.equal(body.text, "gm");
});

test("buildTelegramReply truncates to the 4096-character Telegram limit", async () => {
  const { buildTelegramReply } = await import("../services/channelDispatch.js");
  const req = buildTelegramReply({
    botToken: "t",
    chatId: "1",
    text: "b".repeat(5000),
  });
  assert.equal(JSON.parse(req.body).text.length, 4096);
});

test("buildTelegramReply rejects a bot token with embedded whitespace (defense in depth)", async () => {
  const { buildTelegramReply } = await import("../services/channelDispatch.js");
  assert.throws(
    () =>
      buildTelegramReply({
        botToken: "123:AB CD",
        chatId: "1",
        text: "x",
      }),
    /botToken/
  );
});

// ============================================
// Slack
// ============================================

test("buildSlackReply posts to chat.postMessage with a Bearer token", async () => {
  setupEnv();
  const { buildSlackReply } = await import("../services/channelDispatch.js");
  const req = buildSlackReply({
    botToken: "xoxb-secret",
    channel: "C1",
    text: "ok",
  });
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://slack.com/api/chat.postMessage");
  assert.equal(req.headers["Authorization"], "Bearer xoxb-secret");
  assert.equal(req.headers["Content-Type"], "application/json; charset=utf-8");
  const body = JSON.parse(req.body);
  assert.equal(body.channel, "C1");
  assert.equal(body.text, "ok");
});

test("buildSlackReply forwards thread_ts when present (so replies thread)", async () => {
  const { buildSlackReply } = await import("../services/channelDispatch.js");
  const req = buildSlackReply({
    botToken: "xoxb-secret",
    channel: "C1",
    text: "in-thread",
    threadTs: "1.2",
  });
  const body = JSON.parse(req.body);
  assert.equal(body.thread_ts, "1.2");
});

// ============================================
// buildReplyForPlatform dispatcher
// ============================================

test("buildReplyForPlatform routes to the correct builder", async () => {
  const { buildReplyForPlatform } = await import("../services/channelDispatch.js");

  const d = buildReplyForPlatform({
    platform: "discord",
    credentials: { kind: "discord-bot", botToken: "b" },
    channelId: "c",
    text: "t",
  });
  assert.ok(d.url.startsWith("https://discord.com/"));

  const t = buildReplyForPlatform({
    platform: "telegram",
    credentials: { kind: "telegram-bot", botToken: "1:T" },
    channelId: "chat",
    text: "t",
  });
  assert.ok(t.url.startsWith("https://api.telegram.org/"));

  const s = buildReplyForPlatform({
    platform: "slack",
    credentials: { kind: "slack-bot", botToken: "xoxb-s" },
    channelId: "C1",
    text: "t",
  });
  assert.ok(s.url.startsWith("https://slack.com/"));
});

test("buildReplyForPlatform throws when platform does not match credentials kind", async () => {
  const { buildReplyForPlatform } = await import("../services/channelDispatch.js");
  assert.throws(
    () =>
      buildReplyForPlatform({
        platform: "discord",
        credentials: { kind: "telegram-bot", botToken: "x" } as any,
        channelId: "c",
        text: "t",
      }),
    /credential kind mismatch/
  );
});
