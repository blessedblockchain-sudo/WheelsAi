import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatLatencyValue, loadPlatformLatency, readPublicLatency } from "../src/lib/latency.js";

const measured = {
  status: "measured",
  definition: "Time the API took.",
  windowHours: 24,
  sampleCount: 1284,
  minSampleCount: 50,
  minOrgCount: 3,
  p50Ms: 612,
  p95Ms: 2140,
  computedAt: "2026-10-07T00:00:00.000Z",
};

describe("loadPlatformLatency", () => {
  it("returns the figure the API stated", async () => {
    const figure = await loadPlatformLatency(async () => ({ frameworks: 6, latency: measured }));
    assert.equal(figure?.status, "measured");
    assert.equal(formatLatencyValue(figure), "612 ms p50");
  });

  it("returns null, never throws, when the API cannot be asked or states no figure", async () => {
    assert.equal(await loadPlatformLatency(async () => Promise.reject(new Error("ECONNREFUSED"))), null);
    assert.equal(await loadPlatformLatency(async () => ({ frameworks: 6 })), null);
    assert.equal(await loadPlatformLatency(async () => null), null);
    assert.equal(await loadPlatformLatency(async () => "<html>"), null);
  });

  it("gives up on an API that does not answer in time", async () => {
    const never = new Promise<unknown>(() => {});
    assert.equal(await loadPlatformLatency(() => never, 10), null);
  });
});

describe("the latency line", () => {
  it("prints a number only for a measured figure", () => {
    assert.equal(formatLatencyValue(readPublicLatency(measured)), "612 ms p50");
    assert.equal(
      formatLatencyValue(readPublicLatency({ ...measured, status: "insufficient_data", sampleCount: 12, p50Ms: 47 })),
      "measuring (12 of 50 requests)",
    );
    assert.equal(formatLatencyValue(readPublicLatency({ ...measured, status: "unavailable" })), "live figure unavailable");
    assert.equal(formatLatencyValue(readPublicLatency({ ...measured, p50Ms: null })), "live figure unavailable");
    assert.equal(formatLatencyValue(null), "live figure unavailable");
  });
});
