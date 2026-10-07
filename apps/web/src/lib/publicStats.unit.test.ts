/**
 * The landing page's one read of GET /api/public/stats. Run with:
 *   cd apps/web && npx tsx --test src/lib/publicStats.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createPublicStatsReader, landingLatencyValue, latencyLineInput, readPublicStats } from "./publicStats";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const measured = {
  status: "measured",
  definition: "Time the WheelsAI API took.",
  windowHours: 24,
  sampleCount: 1284,
  minSampleCount: 50,
  minOrgCount: 3,
  p50Ms: 612,
  p95Ms: 2140,
  computedAt: "2026-10-07T00:00:00.000Z",
};
const body = (latency: unknown) => ({ frameworks: 6, models: 21, pricingModels: 4, channels: 3, latency });
const ok = (value: unknown) => ({ ok: true, json: async () => value });

test("everyone who asks shares one request", async () => {
  let requests = 0;
  const read = createPublicStatsReader(async () => {
    requests += 1;
    return ok(body(measured));
  });
  const [a, b, c] = await Promise.all([read(), read(), read()]);
  await read();
  assert.equal(requests, 1);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(a.phase, "ready");
});

test("a failed request is not kept: the next reader asks again", async () => {
  let requests = 0;
  const read = createPublicStatsReader(async () => {
    requests += 1;
    if (requests === 1) throw new TypeError("Failed to fetch");
    return ok(body(measured));
  });
  assert.deepEqual(await read(), { phase: "failed" });
  assert.equal((await read()).phase, "ready");
  assert.equal(requests, 2);
});

test("a non-200 answer, a non-JSON body and a body that is not stats all fail, and never reject", async () => {
  const failures = [
    async () => ({ ok: false, json: async () => ({ error: "boom" }) }),
    async () => ({ ok: true, json: async () => Promise.reject(new SyntaxError("Unexpected token <")) }),
    async () => ok(null),
    async () => ok([1, 2]),
  ];
  for (const request of failures) {
    assert.deepEqual(await createPublicStatsReader(request)(), { phase: "failed" });
  }
});

test("the latency line: measured, measuring, unavailable, and loading before the answer", () => {
  const line = (state: Parameters<typeof latencyLineInput>[0]) => landingLatencyValue(latencyLineInput(state));
  const ready = (latency: unknown) => ({ phase: "ready" as const, stats: readPublicStats(body(latency))! });

  assert.equal(line({ phase: "loading" }), "measuring…");
  assert.equal(line(ready(measured)), "612 ms p50");
  // Below the thresholds the landing page states no count of requests,
  // whether the shortfall is in requests or in organizations.
  for (const sampleCount of [0, 12, 80]) {
    assert.equal(
      line(ready({ ...measured, status: "insufficient_data", sampleCount, p50Ms: null, p95Ms: null })),
      "measuring",
    );
  }
  assert.equal(line(ready({ ...measured, status: "unavailable", sampleCount: null, p50Ms: null })), "live figure unavailable");
  assert.equal(line({ phase: "failed" }), "live figure unavailable");
  // An API that predates the measurement answers stats without a latency block.
  assert.equal(line(ready(undefined)), "live figure unavailable");
});

test("the product counts are read, and a missing one stays missing", () => {
  assert.deepEqual(readPublicStats({ frameworks: 6, models: "21" }), {
    frameworks: 6,
    models: null,
    pricingModels: null,
    channels: null,
    latency: null,
  });
});

test("the landing preview holds no latency number of its own", () => {
  const preview = source("components/landing/code-preview.tsx");
  assert.ok(preview.includes("<LiveLatencyValue />"));
  assert.ok(!/\d\s?ms\b/.test(preview), "a hardcoded latency is back in the landing preview");
  for (const file of ["components/landing/code-preview.tsx", "components/landing/live-latency.tsx", "lib/publicStats.ts"]) {
    assert.ok(!source(file).includes("47"), `${file} mentions 47`);
  }
  // One request per page: the stat tiles read the shared hook, not their own fetch.
  const tiles = source("components/landing/stats-section.tsx");
  assert.ok(tiles.includes("usePublicStats()"));
  assert.ok(!tiles.includes("fetch("));
});
