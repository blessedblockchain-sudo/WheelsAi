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

// Drives apps/api/src/queues/agent-message.queue.ts — the thin typed wrapper
// around BullMQ that the webhook route calls to hand off an inbound message
// to the worker. Tests inject a fake queue so we never hit Redis.

function makeFakeQueue() {
  const calls: Array<{ name: string; data: unknown; opts: unknown }> = [];
  return {
    calls,
    add: async (name: string, data: unknown, opts: unknown) => {
      calls.push({ name, data, opts });
      return { id: `job_${calls.length}` };
    },
  };
}

test("enqueueAgentMessage validates payload shape and rejects bad input", async () => {
  setupEnv();
  const { enqueueAgentMessage } = await import(
    "../queues/agent-message.queue.js"
  );
  const fakeQueue = makeFakeQueue();
  await assert.rejects(
    () =>
      enqueueAgentMessage(
        { deploymentId: "", platform: "discord", message: null as any },
        { queue: fakeQueue as any }
      ),
    /deploymentId/
  );
  assert.equal(fakeQueue.calls.length, 0);
});

test("enqueueAgentMessage forwards a well-formed job to the queue", async () => {
  setupEnv();
  const { enqueueAgentMessage } = await import(
    "../queues/agent-message.queue.js"
  );
  const fakeQueue = makeFakeQueue();

  const result = await enqueueAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "discord",
      message: {
        platform: "discord",
        messageId: "m1",
        channelId: "c1",
        userId: "u1",
        userName: "alice",
        text: "hello",
        raw: {},
      },
    },
    { queue: fakeQueue as any }
  );

  assert.equal(result.id, "job_1");
  assert.equal(fakeQueue.calls.length, 1);
  const call = fakeQueue.calls[0]!;
  assert.equal(call.name, "agent-message");
  const data = call.data as any;
  assert.equal(data.deploymentId, "dep_1");
  assert.equal(data.platform, "discord");
  assert.equal(data.message.messageId, "m1");
});

test("enqueueAgentMessage sets a bounded retry policy so stuck messages don't loop forever", async () => {
  const { enqueueAgentMessage } = await import(
    "../queues/agent-message.queue.js"
  );
  const fakeQueue = makeFakeQueue();
  await enqueueAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "telegram",
      message: {
        platform: "telegram",
        messageId: "5",
        channelId: "chat_1",
        userId: "u_1",
        userName: null,
        text: "gm",
        raw: {},
      },
    },
    { queue: fakeQueue as any }
  );
  const opts = fakeQueue.calls[0]!.opts as any;
  assert.ok(opts.attempts >= 3 && opts.attempts <= 10, `attempts bounded, got ${opts.attempts}`);
  assert.equal(opts.backoff?.type, "exponential");
  // removeOnComplete keeps the queue depth bounded.
  assert.ok(opts.removeOnComplete !== undefined);
  assert.ok(opts.removeOnFail !== undefined);
});

test("enqueueAgentMessage deduplicates by (deploymentId, platform, messageId)", async () => {
  const { enqueueAgentMessage, buildJobId } = await import(
    "../queues/agent-message.queue.js"
  );
  const fakeQueue = makeFakeQueue();
  await enqueueAgentMessage(
    {
      deploymentId: "dep_1",
      platform: "discord",
      message: {
        platform: "discord",
        messageId: "m1",
        channelId: "c1",
        userId: "u1",
        userName: "a",
        text: "hi",
        raw: {},
      },
    },
    { queue: fakeQueue as any }
  );
  const opts = fakeQueue.calls[0]!.opts as any;
  assert.equal(opts.jobId, buildJobId("dep_1", "discord", "m1"));
});
