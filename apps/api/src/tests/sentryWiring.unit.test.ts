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
setupEnv();

// Drives apps/api/src/lib/sentry.ts (B7): DSN-gated init and the
// 5xx-only onError capture hook. Both surfaces are injected so no SDK
// global state is touched.

test("initSentry without a DSN is a no-op and reports disabled", async () => {
  const { initSentry } = await import("../lib/sentry.js");
  let called = 0;
  const enabled = initSentry({ dsn: undefined, environment: "test" }, () => {
    called += 1;
  });
  assert.equal(enabled, false);
  assert.equal(called, 0);
});

test("initSentry with a DSN inits errors-only (tracesSampleRate 0)", async () => {
  const { initSentry } = await import("../lib/sentry.js");
  let options: unknown;
  const enabled = initSentry(
    { dsn: "https://key@o0.ingest.sentry.io/1", environment: "staging" },
    (opts) => {
      options = opts;
    },
  );
  assert.equal(enabled, true);
  assert.deepEqual(options, {
    dsn: "https://key@o0.ingest.sentry.io/1",
    environment: "staging",
    tracesSampleRate: 0,
  });
});

test("the onError hook reports 5xx errors and IGNORES 4xx business refusals", async () => {
  const { registerSentryErrorCapture } = await import("../lib/sentry.js");
  const captured: unknown[] = [];
  type OnErrorHook = (
    req: unknown,
    reply: unknown,
    error: unknown,
  ) => Promise<void>;
  let hook: OnErrorHook | null = null;
  const app = {
    addHook: (name: string, fn: OnErrorHook) => {
      assert.equal(name, "onError");
      hook = fn;
    },
  };
  registerSentryErrorCapture(app as never, (err) => captured.push(err));
  assert.ok(hook, "hook registered");
  // TS can't see the assignment inside the addHook callback.
  const fire = hook as unknown as OnErrorHook;

  const boom = Object.assign(new Error("db exploded"), { statusCode: 500 });
  const noStatus = new Error("bare throw"); // no statusCode → treated as 500
  const notFound = Object.assign(new Error("nope"), { statusCode: 404 });
  const gate501 = Object.assign(new Error("not enabled"), { statusCode: 501 });

  await fire(null, null, boom);
  await fire(null, null, noStatus);
  await fire(null, null, notFound);
  await fire(null, null, gate501);

  assert.deepEqual(captured, [boom, noStatus, gate501]);
});

test("SENTRY_DSN env: blank collapses to undefined (rail stays off)", async () => {
  const { validateEnv } = await import("../config/env.js");
  const data = validateEnv({
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://u:p@db:5432/app",
    JWT_SECRET: "a".repeat(32),
    SENTRY_DSN: "   ",
  });
  assert.equal(data.SENTRY_DSN, undefined);
});
