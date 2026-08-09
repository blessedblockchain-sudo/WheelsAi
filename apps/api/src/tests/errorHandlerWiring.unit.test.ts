import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { z } from "zod";

import { globalErrorHandler } from "../lib/errorHandler.js";

// The F1 global error handler was correct but INERT: index.ts called
// app.setErrorHandler AFTER every app.register(). Fastify's register()
// creates an encapsulated child context that captures the error handler
// present at registration time, so a handler installed afterwards never
// applies to any route plugin.
//
// Observed live before the fix: GET /api/agents/not-a-uuid/playground/chat
// answered 500 with the raw Zod issue list in `message`. Two problems in
// one: wrong status class, and internal validation structure echoed to
// the client — the exact thing the handler's 500-message hiding exists to
// prevent.

test("a ZodError from a route's bare .parse() becomes a 400, not a 500", async () => {
  const app = Fastify();
  // Installed BEFORE the plugin, which is the whole point.
  app.setErrorHandler(globalErrorHandler);
  await app.register(async (child) => {
    child.get("/thing/:id", async (request) => {
      z.object({ id: z.string().uuid() }).parse(request.params);
      return { ok: true };
    });
  });

  const res = await app.inject({ method: "GET", url: "/thing/not-a-uuid" });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, "validation_failed");
  assert.deepEqual(body.details.fieldErrors.id, ["Invalid uuid"]);
});

test("registering BEFORE setErrorHandler leaves the plugin on Fastify's default — the bug", async () => {
  const app = Fastify();
  await app.register(async (child) => {
    child.get("/thing/:id", async (request) => {
      z.object({ id: z.string().uuid() }).parse(request.params);
      return { ok: true };
    });
  });
  // Too late for the already-registered child context.
  app.setErrorHandler(globalErrorHandler);

  const res = await app.inject({ method: "GET", url: "/thing/not-a-uuid" });
  assert.equal(
    res.statusCode,
    500,
    "this is the behavior that shipped: the handler never ran",
  );
});

test("an internal 500's message is never echoed to the client", async () => {
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(async (child) => {
    child.get("/boom", async () => {
      throw new Error("connection string postgres://user:password@host/db");
    });
  });

  const res = await app.inject({ method: "GET", url: "/boom" });
  assert.equal(res.statusCode, 500);
  const body = res.json();
  assert.equal(body.message, "Internal Server Error");
  assert.doesNotMatch(JSON.stringify(body), /postgres:\/\//, "no internals leak");
});

test("a statusCode-bearing error keeps its own status and message", async () => {
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  await app.register(async (child) => {
    child.get("/nope", async () => {
      throw Object.assign(new Error("Agent not found"), { statusCode: 404 });
    });
  });
  const res = await app.inject({ method: "GET", url: "/nope" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().message, "Agent not found");
});

test("index.ts installs the handler BEFORE the first route plugin", () => {
  // A source pin: this ordering is invisible at the type level and was
  // wrong for the entire life of the F1 remediation.
  const source = readFileSync(
    fileURLToPath(new URL("../index.ts", import.meta.url)),
    "utf8",
  );
  const handlerIdx = source.indexOf("app.setErrorHandler(globalErrorHandler)");
  const firstRouteIdx = source.indexOf("await app.register(healthRoutes");
  assert.ok(handlerIdx > -1, "setErrorHandler call not found");
  assert.ok(firstRouteIdx > -1, "route registration not found");
  assert.ok(
    handlerIdx < firstRouteIdx,
    "setErrorHandler must precede route registration or it applies to nothing",
  );
});
