import assert from "node:assert/strict";
import test from "node:test";

// Env must be in place BEFORE the queue module is first imported.
process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";
process.env.GPU_BILLING_INTERVAL_MS = "0";

// Drives queues/gpu-billing.queue.ts. With GPU_BILLING_INTERVAL_MS=0 the worker
// is disabled: start/stop must be harmless and must NOT open a Redis
// connection (so this test process exits cleanly - nothing to close).

test("startGpuBillingQueue / stopGpuBillingQueue are exported and a disabled worker opens no connection", async () => {
  const mod = await import("../queues/gpu-billing.queue.js");
  assert.equal(typeof mod.startGpuBillingQueue, "function");
  assert.equal(typeof mod.stopGpuBillingQueue, "function");
  await mod.startGpuBillingQueue();
  await mod.stopGpuBillingQueue();
  await mod.stopGpuBillingQueue(); // idempotent
});

test("GPU_BILLING_INTERVAL_MS is parsed by config/nosanaDeploy (default 60000, 0 disables)", async () => {
  const { loadNosanaDeployConfig } = await import("../config/nosanaDeploy.js");
  assert.equal(loadNosanaDeployConfig({}).gpuBillingIntervalMs, 60_000);
  assert.equal(loadNosanaDeployConfig({ GPU_BILLING_INTERVAL_MS: "15000" }).gpuBillingIntervalMs, 15_000);
  assert.equal(loadNosanaDeployConfig({ GPU_BILLING_INTERVAL_MS: "0" }).gpuBillingIntervalMs, 0);
});
