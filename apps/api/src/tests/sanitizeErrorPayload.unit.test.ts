import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import {
  looksInternal,
  sanitizeErrorBody,
  sanitizeErrorPayloadHook,
  sanitizeMessage,
} from "../lib/sanitizeErrorPayload.js";

// Found by probing the running API: POST /api/webhooks with a field
// missing returned Prisma's rich error verbatim — absolute repo path,
// a code frame of the surrounding source, and the data payload including
// a freshly generated HMAC signing secret.
//
// ~109 handlers echo `error.message` from their own catch block, so the
// global error handler never sees these. This scrubs at the last point
// every error body passes through.

const PRISMA_LEAK = `
Invalid \`prisma.webhook.create()\` invocation in
/home/bprime/Bounties/WheelsAi/apps/api/src/services/webhooks.ts:117:25

  115 const secret = crypto.randomBytes(32).toString("hex");
→ 117 return prisma.webhook.create({
        data: {
          orgId: "3edbd036-4f9f-472c-8c4b-42cc8208e297",
          secret: "db1ad3456a0eb6bdd677511133f881d3f214de9d1f"
`;

test("the real observed Prisma leak is recognised as internal", () => {
  assert.equal(looksInternal(PRISMA_LEAK), true);
  const cleaned = sanitizeMessage(PRISMA_LEAK) as string;
  assert.equal(cleaned, "The request could not be completed.");
  // The three things that must never survive.
  assert.doesNotMatch(cleaned, /\/home\//, "no filesystem path");
  assert.doesNotMatch(cleaned, /prisma\./, "no ORM internals");
  assert.doesNotMatch(cleaned, /db1ad345/, "no generated secret");
});

test("ordinary business errors pass through untouched", () => {
  for (const message of [
    "Agent not found",
    "Minimum payout amount is $10.00",
    "You have already installed this agent",
    "Insufficient credits. Please add more credits to continue.",
    "Deploying requires a reservation of $5.40 in credits.",
  ]) {
    assert.equal(looksInternal(message), false, message);
    assert.equal(sanitizeMessage(message), message);
  }
});

test("stack frames, absolute paths and connection strings are all caught", () => {
  assert.equal(looksInternal("boom\n    at Object.<anonymous> (/app/x.js:1:1)"), true);
  assert.equal(looksInternal("ENOENT: open '/home/bprime/secret.pem'"), true);
  assert.equal(
    looksInternal("connect failed postgresql://user:hunter2@db:5432/app"),
    true,
  );
  assert.equal(looksInternal("C:\\\\Users\\\\app\\\\service.ts"), true);
});

test("every conventional message field is scrubbed, not just `error`", () => {
  const { body, changed } = sanitizeErrorBody({
    error: "Bad Request",
    message: PRISMA_LEAK,
    detail: PRISMA_LEAK,
    statusCode: 400,
  });
  assert.equal(changed, true);
  const out = body as Record<string, unknown>;
  assert.equal(out.message, "The request could not be completed.");
  assert.equal(out.detail, "The request could not be completed.");
  assert.equal(out.statusCode, 400, "non-message fields are preserved");
});

test("a clean body is returned unchanged so nothing is re-serialized", () => {
  const input = { error: "NotFoundError", message: "Agent not found" };
  const { body, changed } = sanitizeErrorBody(input);
  assert.equal(changed, false);
  assert.equal(body, input, "same reference");
});

// ============================================
// The hook, end to end through Fastify
// ============================================

async function appThatLeaks(status: number, payload: unknown) {
  const app = Fastify();
  app.addHook("onSend", sanitizeErrorPayloadHook as never);
  await app.register(async (child) => {
    child.get("/x", async (_req, reply) => reply.status(status).send(payload));
    child.get("/ok", async () => ({ secret: "not-an-error-body" }));
  });
  return app;
}

test("the hook scrubs an error response produced by a route's own catch block", async () => {
  const app = await appThatLeaks(400, { error: PRISMA_LEAK });
  const res = await app.inject({ method: "GET", url: "/x" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "The request could not be completed.");
});

test("the hook does NOT touch successful responses", async () => {
  // A 200 body may legitimately contain anything; scrubbing it would
  // corrupt real data.
  const app = await appThatLeaks(400, { error: "x" });
  const res = await app.inject({ method: "GET", url: "/ok" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().secret, "not-an-error-body");
});

test("a non-JSON error body carrying internals is replaced wholesale", async () => {
  const app = Fastify();
  app.addHook("onSend", sanitizeErrorPayloadHook as never);
  await app.register(async (child) => {
    child.get("/html", async (_req, reply) =>
      reply.status(500).type("text/plain").send(PRISMA_LEAK),
    );
  });
  const res = await app.inject({ method: "GET", url: "/html" });
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(res.body, /\/home\//);
});

test("index.ts registers the hook BEFORE the first route plugin", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "utf8",
  );
  const hookIdx = source.indexOf('app.addHook("onSend", sanitizeErrorPayloadHook');
  const firstRouteIdx = source.indexOf("await app.register(healthRoutes");
  assert.ok(hookIdx > -1, "hook not registered");
  assert.ok(
    hookIdx < firstRouteIdx,
    "hooks propagate only to child contexts created after them — same trap as setErrorHandler",
  );
});
