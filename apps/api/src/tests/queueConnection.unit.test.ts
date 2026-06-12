import assert from "node:assert/strict";
import test from "node:test";

// B5 (REMEDIATION_PLAN): the queue connection must carry the FULL
// REDIS_URL — credentials, TLS, db index — or every BullMQ worker fails
// AUTH against managed Redis while /health stays green.

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

test("plain redis URL: host/port, blocking-safe retries, no TLS", async () => {
  const { getQueueConnectionOpts } = await import("../queues/connection.js");
  const { connection } = getQueueConnectionOpts("redis://localhost:6379");
  const c = connection as Record<string, unknown>;
  assert.equal(c.host, "localhost");
  assert.equal(c.port, 6379);
  assert.equal(c.maxRetriesPerRequest, null);
  assert.equal(c.tls, undefined);
  assert.equal(c.password, undefined);
});

test("authed rediss URL: credentials, TLS, and db index are preserved", async () => {
  const { getQueueConnectionOpts } = await import("../queues/connection.js");
  const { connection } = getQueueConnectionOpts(
    "rediss://default:s3cr%21t@fly-redis.upstash.io:6380/2"
  );
  const c = connection as Record<string, unknown>;
  assert.equal(c.host, "fly-redis.upstash.io");
  assert.equal(c.port, 6380);
  assert.equal(c.username, "default");
  assert.equal(c.password, "s3cr!t"); // percent-decoded
  assert.equal(c.db, 2);
  assert.deepEqual(c.tls, {});
});

test("password-only URL (redis://:pass@host) is preserved", async () => {
  const { getQueueConnectionOpts } = await import("../queues/connection.js");
  const { connection } = getQueueConnectionOpts("redis://:hunter2@10.0.0.5:6379");
  const c = connection as Record<string, unknown>;
  assert.equal(c.host, "10.0.0.5");
  assert.equal(c.password, "hunter2");
  assert.equal(c.username, undefined);
});
