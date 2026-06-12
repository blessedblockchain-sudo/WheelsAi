import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

// A6 (REMEDIATION_PLAN): the Nosana training webhook mutates job state
// and previously had no authentication. Pins the HMAC token derivation,
// constant-time verification, and the route-level 401.

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

const SECRET = "s".repeat(32);
const JOB_ID = "0d4f7b1e-3a52-4b8e-9f60-1c2d3e4f5a6b";

test("token derivation is deterministic and job-scoped", async () => {
  const { deriveTrainingWebhookToken } = await import(
    "../services/trainingWebhookAuth.js"
  );
  const a = deriveTrainingWebhookToken(JOB_ID, SECRET);
  const b = deriveTrainingWebhookToken(JOB_ID, SECRET);
  const other = deriveTrainingWebhookToken("another-job", SECRET);
  assert.equal(a, b);
  assert.notEqual(a, other);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("verify accepts the derived token and rejects everything else", async () => {
  const { deriveTrainingWebhookToken, verifyTrainingWebhookToken } = await import(
    "../services/trainingWebhookAuth.js"
  );
  const token = deriveTrainingWebhookToken(JOB_ID, SECRET);
  assert.equal(verifyTrainingWebhookToken(JOB_ID, token, SECRET), true);
  assert.equal(verifyTrainingWebhookToken(JOB_ID, undefined, SECRET), false);
  assert.equal(verifyTrainingWebhookToken(JOB_ID, "", SECRET), false);
  assert.equal(verifyTrainingWebhookToken(JOB_ID, "deadbeef", SECRET), false);
  assert.equal(verifyTrainingWebhookToken(JOB_ID, "not-hex-at-all!!", SECRET), false);
  // Token for a different job must not authorize this one.
  const otherToken = deriveTrainingWebhookToken("another-job", SECRET);
  assert.equal(verifyTrainingWebhookToken(JOB_ID, otherToken, SECRET), false);
});

test("POST /jobs/:id/webhook without a valid token returns 401 before any lookup", async () => {
  const { trainingRoutes } = await import("../routes/training.js");
  const app = Fastify({ logger: false });
  await app.register(trainingRoutes, { prefix: "/api/training" });

  const res = await app.inject({
    method: "POST",
    url: `/api/training/jobs/${JOB_ID}/webhook`,
    payload: { status: "completed", outputPath: "s3://evil/override" },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, "invalid_webhook_token");

  const resBadToken = await app.inject({
    method: "POST",
    url: `/api/training/jobs/${JOB_ID}/webhook?token=deadbeef`,
    payload: { status: "completed" },
  });
  assert.equal(resBadToken.statusCode, 401);
  await app.close();
});
