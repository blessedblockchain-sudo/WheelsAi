import assert from "node:assert/strict";
import test from "node:test";

import type { PublicLatencyWindow } from "../services/buildLatencySampleDeps.js";
import { HISTOGRAM_EDGES_MS } from "../services/latencyQueries.js";
import { PUBLIC_LATENCY_SURFACES } from "../services/latencySamples.js";
import {
  createPublicLatencyReader,
  errorSharePercent,
  summarizePublicLatency,
  summarizePublicLatencyDetail,
  type PublicLatencySnapshot,
} from "../services/publicLatency.js";

// The landing page, the CLI and /status state this figure. Its one rule is
// that a number appears only when it was measured over enough traffic from
// enough organizations; everything else is a named state with nulls.

const AT = new Date("2026-10-07T09:00:00.000Z");
const thresholds = { windowHours: 24, minSamples: 50, minOrgs: 3 };

function window(overrides: Partial<PublicLatencyWindow> = {}): PublicLatencyWindow {
  return {
    windowHours: 24,
    sampleCount: 1284,
    orgCount: 7,
    p50Ms: 612,
    p95Ms: 2140,
    firstTokenSampleCount: 402,
    firstTokenOrgCount: 5,
    firstTokenP50Ms: 380,
    computedAt: AT,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PublicLatencyWindow> = {}): PublicLatencySnapshot {
  return {
    window: window(overrides),
    outcomes: { ok: 1284, error: 12, timeout: 4, cancelled: 0 },
    histogram: [...HISTOGRAM_EDGES_MS, null].map((upToMs, i) => ({ upToMs, count: i })),
  };
}

const numbers = (figure: { p50Ms: unknown; p95Ms: unknown; firstTokenP50Ms: unknown }) => [
  figure.p50Ms,
  figure.p95Ms,
  figure.firstTokenP50Ms,
];

// ============================================
// The three states
// ============================================

test("enough answers from enough organizations is measured, in whole ms, with what it measures", () => {
  const figure = summarizePublicLatency(window({ p50Ms: 612.4 }), thresholds);
  assert.deepEqual(figure, {
    status: "measured",
    metric: "response_time",
    definition: figure.definition,
    surfaces: [...PUBLIC_LATENCY_SURFACES],
    windowHours: 24,
    sampleCount: 1284,
    minSampleCount: 50,
    minOrgCount: 3,
    maxSamplesPerOrg: 17,
    p50Ms: 612,
    p95Ms: 2140,
    firstTokenP50Ms: 380,
    firstTokenSampleCount: 402,
    computedAt: AT.toISOString(),
  });
  assert.match(figure.definition, /successful answers only/);
  assert.match(figure.definition, /network time .* not included/);
});

test("the figure states how many of one organization's answers count, in every state", () => {
  assert.match(summarizePublicLatency(window(), thresholds).definition, /Each organization counts for a bounded number/);
  for (const state of [window(), window({ sampleCount: 2 }), null]) {
    assert.equal(summarizePublicLatency(state, thresholds).maxSamplesPerOrg, 17);
  }
  assert.equal(
    summarizePublicLatency(window(), { windowHours: 24, minSamples: 12, minOrgs: 3 }).maxSamplesPerOrg,
    4,
  );
});

test("the thresholds are inclusive: exactly the minimum is measured, one short is not", () => {
  assert.equal(summarizePublicLatency(window({ sampleCount: 50, orgCount: 3 }), thresholds).status, "measured");
  assert.equal(
    summarizePublicLatency(window({ sampleCount: 49, orgCount: 3 }), thresholds).status,
    "insufficient_data",
  );
  assert.equal(
    summarizePublicLatency(window({ sampleCount: 50, orgCount: 2 }), thresholds).status,
    "insufficient_data",
  );
});

test("too few samples states the count and no latency", () => {
  const figure = summarizePublicLatency(window({ sampleCount: 12, orgCount: 5 }), thresholds);
  assert.equal(figure.status, "insufficient_data");
  assert.equal(figure.sampleCount, 12);
  assert.deepEqual(numbers(figure), [null, null, null]);
  assert.equal(figure.computedAt, AT.toISOString());
});

test("plenty of samples from too few organizations is still not published", () => {
  const figure = summarizePublicLatency(window({ sampleCount: 9_000, orgCount: 2 }), thresholds);
  assert.equal(figure.status, "insufficient_data");
  assert.deepEqual(numbers(figure), [null, null, null]);
});

test("an empty table never yields a number", () => {
  const figure = summarizePublicLatency(
    window({ sampleCount: 0, orgCount: 0, p50Ms: null, p95Ms: null, firstTokenSampleCount: 0, firstTokenOrgCount: 0, firstTokenP50Ms: null }),
    thresholds,
  );
  assert.equal(figure.status, "insufficient_data");
  assert.equal(figure.sampleCount, 0);
  assert.deepEqual(numbers(figure), [null, null, null]);
  // Even with the thresholds set as low as they go.
  const lowest = summarizePublicLatency(
    window({ sampleCount: 0, orgCount: 0, p50Ms: null, p95Ms: null }),
    { windowHours: 24, minSamples: 1, minOrgs: 1 },
  );
  assert.equal(lowest.status, "insufficient_data");
  assert.equal(lowest.p50Ms, null);
});

test("enough rows without a percentile is not a measurement", () => {
  const figure = summarizePublicLatency(window({ p50Ms: null }), thresholds);
  assert.equal(figure.status, "insufficient_data");
  assert.deepEqual(numbers(figure), [null, null, null]);
});

test("unread samples are unavailable, with every number and count null", () => {
  const figure = summarizePublicLatency(null, thresholds);
  assert.equal(figure.status, "unavailable");
  assert.deepEqual(numbers(figure), [null, null, null]);
  assert.deepEqual([figure.sampleCount, figure.firstTokenSampleCount, figure.computedAt], [null, null, null]);
  // What would be needed is still stated.
  assert.deepEqual([figure.minSampleCount, figure.minOrgCount, figure.windowHours], [50, 3, 24]);
});

test("time to first token is held to the same thresholds on its own samples", () => {
  const fewStreams = summarizePublicLatency(window({ firstTokenSampleCount: 49 }), thresholds);
  assert.equal(fewStreams.status, "measured");
  assert.equal(fewStreams.firstTokenP50Ms, null);
  assert.equal(fewStreams.firstTokenSampleCount, 49);
  assert.equal(fewStreams.p50Ms, 612, "the headline does not depend on streams");

  const oneOrgStreams = summarizePublicLatency(window({ firstTokenOrgCount: 1 }), thresholds);
  assert.equal(oneOrgStreams.firstTokenP50Ms, null);

  assert.equal(summarizePublicLatency(window({ firstTokenSampleCount: 50, firstTokenOrgCount: 3 }), thresholds).firstTokenP50Ms, 380);
});

// ============================================
// The proof section's extras
// ============================================

test("the histogram and error share are published only with a measured figure", () => {
  const measured = summarizePublicLatencyDetail(snapshot(), thresholds);
  assert.equal(measured.status, "measured");
  assert.equal(measured.histogram?.length, HISTOGRAM_EDGES_MS.length + 1);
  assert.equal(measured.histogram?.at(-1)?.upToMs, null);
  assert.equal(measured.errorSharePercent, 1.23); // 16 of 1300

  // A handful of requests from one customer: their distribution stays private.
  const thin = summarizePublicLatencyDetail(snapshot({ sampleCount: 6, orgCount: 1 }), thresholds);
  assert.equal(thin.status, "insufficient_data");
  assert.deepEqual([thin.histogram, thin.errorSharePercent], [null, null]);

  const unread = summarizePublicLatencyDetail(null, thresholds);
  assert.equal(unread.status, "unavailable");
  assert.deepEqual([unread.histogram, unread.errorSharePercent], [null, null]);
});

test("the error share counts errors and timeouts against every recorded request; none recorded is null", () => {
  assert.equal(errorSharePercent({ ok: 90, error: 6, timeout: 2, cancelled: 2 }), 8);
  assert.equal(errorSharePercent({ ok: 10, error: 0, timeout: 0, cancelled: 0 }), 0);
  assert.equal(errorSharePercent({ ok: 0, error: 0, timeout: 0, cancelled: 0 }), null);
});

// ============================================
// The cached reader
// ============================================

function reader(options: { timeoutMs?: number } = {}) {
  const state = {
    now: 1_000_000,
    loads: 0,
    next: (async () => snapshot()) as () => Promise<PublicLatencySnapshot>,
  };
  const r = createPublicLatencyReader({
    loadSnapshot: () => {
      state.loads += 1;
      return state.next();
    },
    thresholds,
    now: () => state.now,
    ttlMs: 60_000,
    maxStaleMs: 600_000,
    retryMs: 5_000,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  return { r, state };
}

const failing = async (): Promise<PublicLatencySnapshot> => {
  throw new Error("connection refused");
};

test("the samples are read once per TTL, however many callers ask", async () => {
  const { r, state } = reader();
  assert.equal((await r.figure()).status, "measured");
  await r.figure();
  await r.detail();
  assert.equal(state.loads, 1, "the figure and its detail come from the same read");

  state.now += 59_999;
  await r.figure();
  assert.equal(state.loads, 1);

  state.now += 1;
  await r.figure();
  assert.equal(state.loads, 2);
});

test("concurrent callers share one read", async () => {
  const { r, state } = reader();
  let release!: (value: PublicLatencySnapshot) => void;
  state.next = () => new Promise((resolve) => (release = resolve));
  const waiting = [r.figure(), r.detail(), r.figure()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.loads, 1);
  release(snapshot());
  const [a, b, c] = await Promise.all(waiting);
  assert.deepEqual([a!.status, b!.status, c!.status], ["measured", "measured", "measured"]);
  assert.equal(state.loads, 1);
});

test("a failing read with nothing to fall back on is unavailable, and is not retried on every request", async () => {
  const { r, state } = reader();
  state.next = failing;
  const figure = await r.figure();
  assert.equal(figure.status, "unavailable");
  assert.deepEqual(numbers(figure), [null, null, null]);

  await r.figure();
  await r.detail();
  assert.equal(state.loads, 1, "a public endpoint must not turn an outage into a query per visitor");

  state.now += 5_000;
  state.next = async () => snapshot();
  assert.equal((await r.figure()).status, "measured");
  assert.equal(state.loads, 2);
});

test("a failure within max-stale states the last good figure with its original time", async () => {
  const { r, state } = reader();
  const first = await r.figure();
  state.next = failing;
  state.now += 61_000;
  const stale = await r.figure();
  assert.equal(stale.status, "measured");
  assert.equal(stale.p50Ms, 612);
  assert.equal(stale.computedAt, first.computedAt, "a stale figure does not pass for a fresh one");
  assert.equal(state.loads, 2);
});

test("beyond max-stale the old figure is no longer stated", async () => {
  const { r, state } = reader();
  await r.figure();
  state.next = failing;
  state.now += 600_000;
  const gone = await r.detail();
  assert.equal(gone.status, "unavailable");
  assert.deepEqual([...numbers(gone), gone.histogram, gone.errorSharePercent], [null, null, null, null, null]);
});

test("a read that hangs past the timeout is unavailable, and no second read piles onto it", async () => {
  const { r, state } = reader({ timeoutMs: 20 });
  let release!: (value: PublicLatencySnapshot) => void;
  state.next = () => new Promise((resolve) => (release = resolve));

  assert.equal((await r.figure()).status, "unavailable");
  assert.equal((await r.figure()).status, "unavailable");
  assert.equal(state.loads, 1, "the slow query is still the only one running");

  // When it finally answers, the answer is used.
  release(snapshot());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await r.figure()).status, "measured");
  assert.equal(state.loads, 1);
});

test("a read that fails after its caller timed out is not an unhandled rejection", async () => {
  const { r, state } = reader({ timeoutMs: 10 });
  let fail!: (err: Error) => void;
  state.next = () => new Promise((_resolve, reject) => (fail = reject));
  assert.equal((await r.figure()).status, "unavailable");
  fail(new Error("late failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await r.figure()).status, "unavailable");
});

test("the reader never rejects, even when the loader throws synchronously", async () => {
  const r = createPublicLatencyReader({
    loadSnapshot: () => {
      throw new Error("not even a promise");
    },
    thresholds,
  });
  assert.equal((await r.figure()).status, "unavailable");
  assert.equal((await r.detail()).status, "unavailable");
  assert.equal(r.unavailableFigure().status, "unavailable");
  assert.equal(r.unavailableDetail().histogram, null);
});
