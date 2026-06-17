import assert from "node:assert/strict";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
}

// Drives apps/api/src/lib/errorHandler.ts — the global Fastify error
// handler (remediation F1). ~14 route files validate with a bare
// schema.parse(), which throws ZodError; the handler must surface that as
// a 400, not a 500, while still hiding genuine internal-error messages.

async function appThrowing(
  thrower: (request: import("fastify").FastifyRequest) => void,
): Promise<FastifyInstance> {
  setupEnv();
  const { globalErrorHandler } = await import("../lib/errorHandler.js");
  const app = Fastify();
  app.setErrorHandler(globalErrorHandler);
  app.post("/t", async (request) => {
    thrower(request);
    return { ok: true };
  });
  await app.ready();
  return app;
}

test("ZodError from a bare .parse() becomes 400 validation_failed with flattened details", async () => {
  const app = await appThrowing((request) => {
    z.object({ name: z.string() }).parse(request.body);
  });
  const res = await app.inject({
    method: "POST",
    url: "/t",
    payload: { name: 123 }, // wrong type → ZodError
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, "validation_failed");
  assert.ok(
    body.details?.fieldErrors?.name,
    "flattened field errors should name the offending field",
  );
  await app.close();
});

test("a generic thrown Error maps to 500 and never leaks the internal message", async () => {
  const app = await appThrowing(() => {
    throw new Error("secret connection string in here");
  });
  const res = await app.inject({ method: "POST", url: "/t", payload: {} });
  assert.equal(res.statusCode, 500);
  const body = res.json();
  assert.equal(body.error, "InternalError");
  assert.equal(body.message, "Internal Server Error");
  assert.ok(
    !JSON.stringify(body).includes("secret connection string"),
    "internal error message must not be sent to the client",
  );
  await app.close();
});

test("an error carrying a statusCode passes through with its name and message", async () => {
  const app = await appThrowing(() => {
    const e = new Error("I'm a teapot") as Error & {
      statusCode?: number;
    };
    e.statusCode = 418;
    e.name = "TeapotError";
    throw e;
  });
  const res = await app.inject({ method: "POST", url: "/t", payload: {} });
  assert.equal(res.statusCode, 418);
  const body = res.json();
  assert.equal(body.error, "TeapotError");
  assert.equal(body.message, "I'm a teapot");
  await app.close();
});
