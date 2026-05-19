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

// Drives apps/api/src/queues/agent-message.worker.ts — the BullMQ worker
// tick that (a) asks the OpenClaw container for the agent's reply, then
// (b) posts that reply back to the platform. All IO is DI'd: callAgent,
// fetch, resolveOutboundCredentials. Nothing touches the network.

function fakeFetchOk() {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchFn: typeof fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      async text() {
        return "{}";
      },
      async json() {
        return { ok: true };
      },
    } as any;
  };
  return { calls, fetchFn };
}

const exampleMessage = {
  platform: "discord" as const,
  messageId: "m1",
  channelId: "c1",
  userId: "u1",
  userName: "alice",
  text: "hi",
  raw: {},
};

test("handleAgentMessage calls the OpenClaw container, dispatches the reply, and returns delivered", async () => {
  setupEnv();
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  const { calls, fetchFn } = fakeFetchOk();

  const result = await handleAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "discord",
      message: exampleMessage,
    },
    {
      callAgent: async () => ({ text: "hello back" }),
      resolveOutboundCredentials: async () => ({
        nodeUrl: "http://node.test",
        credentials: { kind: "discord-bot", botToken: "bot_token" },
      }),
      fetchFn,
    }
  );

  assert.equal(result.status, "delivered");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    "https://discord.com/api/v10/channels/c1/messages"
  );
  const payload = JSON.parse(calls[0]!.init.body);
  assert.equal(payload.content, "hello back");
});

test("handleAgentMessage returns skipped when the agent has no reply", async () => {
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  const { calls, fetchFn } = fakeFetchOk();

  const result = await handleAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "discord",
      message: exampleMessage,
    },
    {
      callAgent: async () => ({ text: "" }),
      resolveOutboundCredentials: async () => ({
        nodeUrl: "http://node.test",
        credentials: { kind: "discord-bot", botToken: "t" },
      }),
      fetchFn,
    }
  );

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "empty_reply");
  assert.equal(calls.length, 0);
});

test("handleAgentMessage throws so BullMQ retries when the platform POST fails", async () => {
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  const fetchFn: typeof fetch = async () =>
    ({
      ok: false,
      status: 500,
      async text() {
        return "boom";
      },
    } as any);

  await assert.rejects(
    () =>
      handleAgentMessage(
        {
          deploymentId: "dep_1",
          platform: "discord",
          message: exampleMessage,
        },
        {
          callAgent: async () => ({ text: "reply" }),
          resolveOutboundCredentials: async () => ({
            nodeUrl: "http://node.test",
            credentials: { kind: "discord-bot", botToken: "t" },
          }),
          fetchFn,
        }
      ),
    /platform_dispatch_failed/
  );
});

test("handleAgentMessage returns skipped when no channel config can be resolved", async () => {
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  const { calls, fetchFn } = fakeFetchOk();

  const result = await handleAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "discord",
      message: exampleMessage,
    },
    {
      callAgent: async () => ({ text: "reply" }),
      resolveOutboundCredentials: async () => null,
      fetchFn,
    }
  );

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no_channel_config");
  assert.equal(calls.length, 0);
});

test("handleAgentMessage throws so BullMQ retries when the OpenClaw container errors", async () => {
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  const { calls, fetchFn } = fakeFetchOk();

  await assert.rejects(
    () =>
      handleAgentMessage(
        {
          deploymentId: "dep_1",
          platform: "discord",
          message: exampleMessage,
        },
        {
          callAgent: async () => {
            throw new Error("node unreachable");
          },
          resolveOutboundCredentials: async () => ({
            nodeUrl: "http://node.test",
            credentials: { kind: "discord-bot", botToken: "t" },
          }),
          fetchFn,
        }
      ),
    /agent_call_failed/
  );
  assert.equal(calls.length, 0);
});

// ============================================
// Retry policy wiring (plan A6)
// ============================================

function fetchFnReturning(status: number, body = "", headers: Record<string, string> = {}) {
  const fetchFn: typeof fetch = async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      async text() {
        return body;
      },
    } as any);
  return fetchFn;
}

test("handleAgentMessage poison-drops a Discord 401 (revoked token) without retry", async () => {
  setupEnv();
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  const result = await handleAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "discord",
      message: exampleMessage,
    },
    {
      callAgent: async () => ({ text: "reply" }),
      resolveOutboundCredentials: async () => ({
        nodeUrl: "http://node.test",
        credentials: { kind: "discord-bot", botToken: "t" },
      }),
      fetchFn: fetchFnReturning(401, '{"message":"401: Unauthorized"}'),
    }
  );

  assert.equal(result.status, "poison_dropped");
  assert.equal((result as any).reason, "auth_failed");
});

test("handleAgentMessage poison-drops a Discord 404 (channel gone)", async () => {
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  const result = await handleAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "discord",
      message: exampleMessage,
    },
    {
      callAgent: async () => ({ text: "reply" }),
      resolveOutboundCredentials: async () => ({
        nodeUrl: "http://node.test",
        credentials: { kind: "discord-bot", botToken: "t" },
      }),
      fetchFn: fetchFnReturning(404, '{"code":10003,"message":"Unknown Channel"}'),
    }
  );

  assert.equal(result.status, "poison_dropped");
  assert.equal((result as any).reason, "channel_gone");
});

test("handleAgentMessage throws rate_limited with retryAfterMs surfaced for 429", async () => {
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  await assert.rejects(
    () =>
      handleAgentMessage(
        {
          deploymentId: "dep_1",
          platform: "discord",
          message: exampleMessage,
        },
        {
          callAgent: async () => ({ text: "reply" }),
          resolveOutboundCredentials: async () => ({
            nodeUrl: "http://node.test",
            credentials: { kind: "discord-bot", botToken: "t" },
          }),
          fetchFn: fetchFnReturning(
            429,
            '{"retry_after":2.5,"message":"You are being rate limited."}'
          ),
        }
      ),
    /rate_limited/
  );
});

test("handleAgentMessage poison-drops Slack invalid_auth (HTTP 200, ok:false)", async () => {
  const { handleAgentMessage } = await import(
    "../queues/agent-message.worker.js"
  );
  const result = await handleAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "slack",
      message: { ...exampleMessage, platform: "slack" as const },
    },
    {
      callAgent: async () => ({ text: "reply" }),
      resolveOutboundCredentials: async () => ({
        nodeUrl: "http://node.test",
        credentials: { kind: "slack-bot", botToken: "xoxb" },
      }),
      fetchFn: fetchFnReturning(200, '{"ok":false,"error":"invalid_auth"}'),
    }
  );

  assert.equal(result.status, "poison_dropped");
  assert.equal((result as any).reason, "auth_failed");
});
