import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";
import {
  buildPublicLatencyReader,
  publicLatencyThresholdsFromEnv,
} from "../services/buildPublicLatencyDeps.js";

// Binding test: the public figure is the sample table's own window, outcome
// counts and histogram, read together, published under the configured
// thresholds - and one failed part means nothing is stated.

const AT = new Date("2026-10-07T09:00:00.000Z");
const thresholds = { windowHours: 24, minSamples: 2, minOrgs: 2 };

function samples(overrides: { fail?: "window" | "outcomes" | "histogram" } = {}) {
  const calls: string[] = [];
  const failIf = (part: string) => {
    calls.push(part);
    if (overrides.fail === part) throw new Error(`${part} unreadable`);
  };
  return {
    calls,
    samples: {
      loadPublicLatencyRow: async () => {
        failIf("window");
        return {
          windowHours: 24,
          sampleCount: 4,
          orgCount: 2,
          p50Ms: 500,
          p95Ms: 1000,
          firstTokenSampleCount: 0,
          firstTokenOrgCount: 0,
          firstTokenP50Ms: null,
          computedAt: AT,
        };
      },
      loadOutcomeCounts: async () => {
        failIf("outcomes");
        return { ok: 4, error: 1, timeout: 0, cancelled: 0 };
      },
      loadLatencyHistogram: async () => {
        failIf("histogram");
        return [
          { upToMs: 500, count: 2 },
          { upToMs: null, count: 2 },
        ];
      },
    },
  };
}

test("one read is the window, the outcome counts and the histogram together", async () => {
  const { samples: s, calls } = samples();
  const reader = buildPublicLatencyReader({ samples: s, thresholds });
  const detail = await reader.detail();
  assert.deepEqual(calls.sort(), ["histogram", "outcomes", "window"]);
  assert.equal(detail.status, "measured");
  assert.deepEqual([detail.p50Ms, detail.p95Ms, detail.sampleCount], [500, 1000, 4]);
  assert.deepEqual(detail.histogram, [
    { upToMs: 500, count: 2 },
    { upToMs: null, count: 2 },
  ]);
  assert.equal(detail.errorSharePercent, 20);
  assert.deepEqual([detail.minSampleCount, detail.minOrgCount], [2, 2]);

  // The figure for the landing page is the same read, not a second one.
  assert.equal((await reader.figure()).p50Ms, 500);
  assert.equal(calls.length, 3);
});

for (const part of ["window", "outcomes", "histogram"] as const) {
  test(`an unreadable ${part} makes the whole figure unavailable, never a partial one`, async () => {
    const reader = buildPublicLatencyReader({ samples: samples({ fail: part }).samples, thresholds });
    const figure = await reader.figure();
    assert.equal(figure.status, "unavailable");
    assert.equal(figure.p50Ms, null);
  });
}

test("the thresholds come from the environment's own names", () => {
  assert.deepEqual(
    publicLatencyThresholdsFromEnv({
      PUBLIC_LATENCY_WINDOW_HOURS: 48,
      PUBLIC_LATENCY_MIN_SAMPLES: 75,
      PUBLIC_LATENCY_MIN_ORGS: 4,
    }),
    { windowHours: 48, minSamples: 75, minOrgs: 4 },
  );
});
