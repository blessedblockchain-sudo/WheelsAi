import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SAMPLE_MS,
  PUBLIC_LATENCY_SURFACES,
  agentSurface,
  buildLatencySample,
  classifyUpstreamOutcome,
  createLatencySampleSink,
  providerForDeployment,
  publicLatencyOrgCap,
  providerOfModelId,
  type LatencySample,
  type LatencySampleInput,
} from "../services/latencySamples.js";

// The landing page used to print "Latency: 47ms avg", a number nobody
// measured. services/latencySamples.ts is the measurement: one sample per
// request. These tests pin what a sample may and may not say, and that
// taking one can never slow or fail the request it describes.

const ORG = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-10-07T09:15:00.000Z");

const input = (over: Partial<LatencySampleInput> = {}): LatencySampleInput => ({
  orgId: ORG,
  surface: "v1",
  deploymentId: DEPLOYMENT,
  model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
  provider: "nosana",
  streamed: false,
  outcome: "ok",
  statusCode: 200,
  totalMs: 612.4,
  upstreamMs: 580.6,
  ...over,
});

// ============================================
// buildLatencySample
// ============================================

test("a sample is whole milliseconds, stamped from the injected clock", () => {
  const sample = buildLatencySample(input({ firstTokenMs: 120.5, outputTokens: 42 }), AT);
  assert.deepEqual(sample, {
    orgId: ORG,
    surface: "v1",
    agentId: null,
    deploymentId: DEPLOYMENT,
    model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    provider: "nosana",
    streamed: false,
    outcome: "ok",
    statusCode: 200,
    totalMs: 612,
    upstreamMs: 581,
    firstTokenMs: 121,
    outputTokens: 42,
    createdAt: AT,
  });
});

test("a total that is not a measurement yields no sample, never a zero", () => {
  for (const totalMs of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(buildLatencySample(input({ totalMs }), AT), null, `totalMs ${totalMs}`);
  }
  assert.equal(buildLatencySample(input({ totalMs: undefined as unknown as number }), AT), null);
  assert.equal(buildLatencySample(input({ totalMs: "612" as unknown as number }), AT), null);
});

test("a request that really took 0 ms is a measurement and is kept", () => {
  assert.equal(buildLatencySample(input({ totalMs: 0, upstreamMs: 0 }), AT)!.totalMs, 0);
});

test("a part that is not a measurement is null, and the sample survives", () => {
  const sample = buildLatencySample(
    input({ upstreamMs: Number.NaN, firstTokenMs: -5, outputTokens: Number.POSITIVE_INFINITY }),
    AT,
  )!;
  assert.equal(sample.totalMs, 612);
  assert.deepEqual([sample.upstreamMs, sample.firstTokenMs, sample.outputTokens], [null, null, null]);
});

test("parts absent from the input are null, not zero", () => {
  const sample = buildLatencySample(
    input({ upstreamMs: undefined, firstTokenMs: undefined, outputTokens: undefined, statusCode: undefined }),
    AT,
  )!;
  assert.deepEqual(
    [sample.upstreamMs, sample.firstTokenMs, sample.outputTokens, sample.statusCode],
    [null, null, null, null],
  );
});

test("the parts of a request never exceed the request", () => {
  const sample = buildLatencySample(input({ totalMs: 500, upstreamMs: 900, firstTokenMs: 501 }), AT)!;
  assert.deepEqual([sample.totalMs, sample.upstreamMs, sample.firstTokenMs], [500, 500, 500]);
});

test("a total beyond a day is capped at a day", () => {
  const sample = buildLatencySample(input({ totalMs: MAX_SAMPLE_MS * 3, upstreamMs: MAX_SAMPLE_MS * 2 }), AT)!;
  assert.equal(sample.totalMs, MAX_SAMPLE_MS);
  assert.equal(sample.upstreamMs, MAX_SAMPLE_MS);
});

test("a status that is not an HTTP status is dropped; a model name is trimmed and bounded", () => {
  assert.equal(buildLatencySample(input({ statusCode: 0 }), AT)!.statusCode, null);
  assert.equal(buildLatencySample(input({ statusCode: 200.5 }), AT)!.statusCode, null);
  assert.equal(buildLatencySample(input({ statusCode: 499 }), AT)!.statusCode, 499);
  assert.equal(buildLatencySample(input({ model: "   " }), AT)!.model, null);
  assert.equal(buildLatencySample(input({ model: "x".repeat(500) }), AT)!.model!.length, 200);
});

test("a sample with no organization or surface is not a sample", () => {
  assert.equal(buildLatencySample(input({ orgId: "" }), AT), null);
  assert.equal(buildLatencySample(input({ surface: "" }), AT), null);
});

// Samples of every organization are written many to a statement, so a field
// Postgres would refuse is not one tenant's problem: it would fail the whole
// statement. A playground caller chooses the model string, so it is the one
// that matters most.
test("a model name loses what a text column cannot hold, starting with NUL", () => {
  const model = (value: string) => buildLatencySample(input({ model: value }), AT)!.model;
  assert.equal(model("openai/gpt-4\u0000"), "openai/gpt-4");
  assert.equal(model("open\u0000ai/\u0007gpt\n-4\u007f\u0085"), "openai/gpt-4");
  assert.equal(model("\u0000\u0000"), null, "nothing storable left is no model, not an empty one");
  assert.equal(model(" \u0000 "), null);
  // Half a surrogate pair is not text either; a whole pair is kept.
  assert.equal(model("gpt\ud83d"), "gpt");
  assert.equal(model("\udc00gpt"), "gpt");
  assert.equal(model("gpt\ud83d\ude00"), "gpt\ud83d\ude00");
  // The length limit never cuts a pair in two.
  const long = model("x".repeat(199) + "\ud83d\ude00" + "y")!;
  assert.equal(long, "x".repeat(199) + "\ud83d\ude00");
  for (const value of ["a\u0000b", "\u0000", "x".repeat(500), "\ud83dz"]) {
    const stored = model(value);
    // Round-trips through UTF-8 unchanged: no lone surrogate was left behind.
    const wellFormed = stored === null || Buffer.from(stored, "utf8").toString("utf8") === stored;
    // eslint-disable-next-line no-control-regex
    assert.ok(stored === null || (!/[\u0000-\u001f\u007f]/.test(stored) && wellFormed), value);
  }
});

test("the provider and surface are held to the same rule", () => {
  const sample = buildLatencySample(input({ provider: "gr\u0000oq", surface: "agent_\u0000api" }), AT)!;
  assert.equal(sample.provider, "groq");
  assert.equal(sample.surface, "agent_api");
  assert.equal(buildLatencySample(input({ provider: "\u0000" }), AT)!.provider, "unknown");
  assert.equal(buildLatencySample(input({ surface: "\u0000" }), AT), null);
  assert.equal(buildLatencySample(input({ provider: "p".repeat(300) }), AT)!.provider.length, 64);
});

test("an id that is not a UUID never reaches a uuid column", () => {
  assert.equal(buildLatencySample(input({ orgId: "org-1" }), AT), null, "no organization, no sample");
  assert.equal(buildLatencySample(input({ orgId: `${ORG}\u0000` }), AT), null);
  const sample = buildLatencySample(input({ agentId: "agent-1", deploymentId: "dep\u0000" }), AT)!;
  assert.equal(sample.agentId, null);
  assert.equal(sample.deploymentId, null);
  assert.equal(buildLatencySample(input({ agentId: DEPLOYMENT }), AT)!.agentId, DEPLOYMENT);
});

test("an ending outside the list, or a clock that is not a time, is not a sample", () => {
  assert.equal(buildLatencySample(input({ outcome: "weird" as never }), AT), null);
  assert.equal(buildLatencySample(input(), new Date(Number.NaN)), null);
});

// ============================================
// The public figure's per-organization cap
// ============================================

test("one organization counts for an equal share of the publication minimum", () => {
  assert.equal(publicLatencyOrgCap(50, 3), 17);
  assert.equal(publicLatencyOrgCap(12, 3), 4);
  assert.equal(publicLatencyOrgCap(50, 1), 50);
  assert.equal(publicLatencyOrgCap(1, 3), 1);
  // Never zero and never unbounded, whatever it is given.
  for (const [samples, orgs] of [[0, 0], [Number.NaN, 3], [50, Number.NaN], [-4, -4], [50, 0]] as const) {
    const cap = publicLatencyOrgCap(samples, orgs);
    assert.ok(Number.isInteger(cap) && cap >= 1 && cap <= 50, `${samples}/${orgs} -> ${cap}`);
  }
});

test("at the default thresholds the minimum cannot be met by fewer organizations, and none holds a majority", () => {
  const cap = publicLatencyOrgCap(50, 3);
  assert.ok(2 * cap < 50, "two organizations at the cap are still short of 50");
  assert.ok(cap / 50 < 0.5, "at publication no organization supplies half the samples");
});

// ============================================
// Classification
// ============================================

test("ok needs an OK status AND an answer", () => {
  assert.equal(classifyUpstreamOutcome({ httpOk: true, hasAnswer: true }), "ok");
  // An inference server can answer 200 with an error in the body.
  assert.equal(classifyUpstreamOutcome({ httpOk: true, hasAnswer: false }), "error");
  assert.equal(classifyUpstreamOutcome({ httpOk: false, hasAnswer: true }), "error");
  // A fetch that threw has neither.
  assert.equal(classifyUpstreamOutcome({}), "error");
});

test("a fired deadline is a timeout; a caller who left is cancelled, whatever else happened", () => {
  assert.equal(classifyUpstreamOutcome({ timedOut: true }), "timeout");
  assert.equal(classifyUpstreamOutcome({ timedOut: true, httpOk: true, hasAnswer: false }), "timeout");
  assert.equal(classifyUpstreamOutcome({ clientGone: true }), "cancelled");
  assert.equal(classifyUpstreamOutcome({ clientGone: true, timedOut: true }), "cancelled");
});

test("the provider is read from the model id, and is unknown rather than guessed", () => {
  assert.equal(providerOfModelId("free/groq/llama-3.3-70b"), "groq");
  assert.equal(providerOfModelId("free/gemini/gemini-2.5-flash"), "google");
  assert.equal(providerOfModelId("free/together/llama-3.1-8b"), "together");
  assert.equal(providerOfModelId("openai/gpt-4"), "openai");
  assert.equal(providerOfModelId("anthropic/claude-3-opus"), "anthropic");
  assert.equal(providerOfModelId("wheelsai/llama-3.1-8b"), "nosana");
  for (const unknown of ["graph", "", null, undefined, "acme/model-x", "free/", "free/acme/m"]) {
    assert.equal(providerOfModelId(unknown), "unknown", String(unknown));
  }
});

test("a deployment is nosana on a real id, nosana_mock on a dev mock, unknown with none", () => {
  assert.equal(providerForDeployment({ nosanaJobIds: ["DeploymentManagerId1"] }), "nosana");
  assert.equal(providerForDeployment({ nosanaJobIds: ["mock_deploy_abc"] }), "nosana_mock");
  assert.equal(providerForDeployment({ nosanaJobIds: ["mock_job_abc"] }), "nosana_mock");
  assert.equal(providerForDeployment({ nosanaJobIds: [] }), "unknown");
  assert.equal(providerForDeployment({ nosanaJobIds: null }), "unknown");
  assert.equal(providerForDeployment({}), "unknown");
});

test("an agent chat's surface is its source; a source that is not a name has none", () => {
  assert.equal(agentSurface("api"), "agent_api");
  assert.equal(agentSurface("playground"), "agent_playground");
  assert.equal(agentSurface(""), null);
  assert.equal(agentSurface("api'; DROP TABLE x;--"), null);
});

test("the public figure counts interactive surfaces only", () => {
  assert.deepEqual(
    [...PUBLIC_LATENCY_SURFACES].sort(),
    ["agent_api", "agent_playground", "agent_trial", "agent_widget", "deployment_chat", "v1"],
  );
  for (const background of ["agent_scheduled", "agent_job", "agent_test", "agent_hired", "deployment_step"]) {
    assert.ok(!PUBLIC_LATENCY_SURFACES.includes(background), background);
  }
});

// ============================================
// The sink
// ============================================

const sampleOf = (totalMs: number): LatencySample => buildLatencySample(input({ totalMs }), AT)!;

function fakeTimers() {
  const pending: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    pending,
    timers: {
      set: (fn: () => void, ms: number) => {
        const entry = { fn, ms, cleared: false };
        pending.push(entry);
        return entry;
      },
      clear: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    },
    /** Fires every timer armed so far that was not cleared. */
    fire: () => {
      for (const entry of pending.splice(0)) if (!entry.cleared) entry.fn();
    },
  };
}

test("pushes within an interval become ONE insert", async () => {
  const batches: LatencySample[][] = [];
  const clock = fakeTimers();
  const sink = createLatencySampleSink({
    insertMany: async (samples) => {
      batches.push(samples);
    },
    flushIntervalMs: 1_000,
    timers: clock.timers,
  });

  assert.equal(clock.pending.length, 0, "an idle sink holds no timer");
  sink.push(sampleOf(100));
  sink.push(sampleOf(200));
  sink.push(sampleOf(300));
  assert.equal(clock.pending.length, 1, "one timer, armed by the first sample");
  assert.equal(clock.pending[0]!.ms, 1_000);
  assert.equal(batches.length, 0, "nothing is written on the request path");
  assert.equal(sink.stats().buffered, 3);

  clock.fire();
  await sink.flush();
  assert.deepEqual(batches.map((batch) => batch.map((s) => s.totalMs)), [[100, 200, 300]]);
  assert.deepEqual(sink.stats(), { buffered: 0, written: 3, droppedOverflow: 0, droppedFailed: 0 });

  // The next sample arms a new timer.
  sink.push(sampleOf(400));
  assert.equal(clock.pending.length, 1);
});

test("a null (unmeasured) sample is ignored", async () => {
  const batches: LatencySample[][] = [];
  const clock = fakeTimers();
  const sink = createLatencySampleSink({
    insertMany: async (samples) => {
      batches.push(samples);
    },
    timers: clock.timers,
  });
  sink.push(null);
  sink.push(buildLatencySample(input({ totalMs: Number.NaN }), AT));
  assert.equal(clock.pending.length, 0);
  await sink.close();
  assert.deepEqual(batches, []);
});

test("beyond the buffer new samples are dropped and counted, not held", async () => {
  const batches: LatencySample[][] = [];
  const clock = fakeTimers();
  const sink = createLatencySampleSink({
    insertMany: async (samples) => {
      batches.push(samples);
    },
    maxBuffer: 2,
    timers: clock.timers,
  });
  for (const ms of [1, 2, 3, 4, 5]) sink.push(sampleOf(ms));
  assert.deepEqual(sink.stats(), { buffered: 2, written: 0, droppedOverflow: 3, droppedFailed: 0 });
  await sink.flush();
  assert.deepEqual(batches.map((batch) => batch.map((s) => s.totalMs)), [[1, 2]]);
});

test("a large buffer is written in bounded statements", async () => {
  const sizes: number[] = [];
  const sink = createLatencySampleSink({
    insertMany: async (samples) => {
      sizes.push(samples.length);
    },
    maxBatch: 2,
    timers: fakeTimers().timers,
  });
  for (const ms of [1, 2, 3, 4, 5]) sink.push(sampleOf(ms));
  await sink.flush();
  assert.deepEqual(sizes, [2, 2, 1]);
});

test("a failed insert is logged, its batch dropped, and nothing throws", async () => {
  const warnings: Array<{ obj: any; msg: string }> = [];
  let attempts = 0;
  const clock = fakeTimers();
  const sink = createLatencySampleSink({
    insertMany: async () => {
      attempts += 1;
      throw new Error("database is down");
    },
    timers: clock.timers,
    logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
  });
  assert.doesNotThrow(() => sink.push(sampleOf(100)));
  clock.fire();
  await assert.doesNotReject(sink.flush());
  assert.equal(attempts, 1, "not retried: a down database must not grow a queue");
  assert.deepEqual(sink.stats(), { buffered: 0, written: 0, droppedOverflow: 0, droppedFailed: 1 });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.obj.dropped, 1);

  // The sink keeps working once the database is back.
  assert.doesNotThrow(() => sink.push(sampleOf(200)));
  assert.equal(sink.stats().buffered, 1);
});

// One row the database refuses must cost that row, not the other
// organizations' rows that happen to share its statement.
test("a row that cannot be stored is dropped alone; every other row in its batch is written", async () => {
  const stored: number[] = [];
  const statements: number[] = [];
  const warnings: Array<{ obj: any; msg: string }> = [];
  const clock = fakeTimers();
  const sink = createLatencySampleSink({
    insertMany: async (samples) => {
      statements.push(samples.length);
      // All-or-nothing, as a multi-row INSERT is.
      if (samples.some((sample) => sample.totalMs === 666)) throw new Error("invalid byte sequence");
      stored.push(...samples.map((sample) => sample.totalMs));
    },
    timers: clock.timers,
    logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
  });
  for (let ms = 1; ms <= 100; ms++) sink.push(sampleOf(ms === 37 ? 666 : ms));
  await sink.flush();
  assert.equal(stored.length, 99);
  assert.ok(!stored.includes(666));
  assert.deepEqual([...stored].sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 1).filter((ms) => ms !== 37));
  assert.deepEqual(sink.stats(), { buffered: 0, written: 99, droppedOverflow: 0, droppedFailed: 1 });
  assert.equal(warnings.length, 1, "one warning for the batch, not one per statement");
  assert.equal(warnings[0]!.obj.dropped, 1);
  assert.ok(statements.length <= 1 + 2 * Math.ceil(Math.log2(100)), `statements: ${statements.length}`);
});

test("several unstorable rows are each dropped alone", async () => {
  const stored: number[] = [];
  const clock = fakeTimers();
  const bad = new Set([3, 500, 501, 999]);
  const sink = createLatencySampleSink({
    insertMany: async (samples) => {
      if (samples.some((sample) => bad.has(sample.totalMs))) throw new Error("refused");
      stored.push(...samples.map((sample) => sample.totalMs));
    },
    timers: clock.timers,
  });
  for (let ms = 1; ms <= 1000; ms++) sink.push(sampleOf(ms));
  await sink.flush();
  assert.equal(stored.length, 996);
  assert.deepEqual(sink.stats(), { buffered: 0, written: 996, droppedOverflow: 0, droppedFailed: 4 });
});

test("a database that is down costs a bounded number of statements per batch, and holds nothing", async () => {
  let attempts = 0;
  const warnings: Array<{ obj: any; msg: string }> = [];
  const clock = fakeTimers();
  const sink = createLatencySampleSink({
    insertMany: async () => {
      attempts += 1;
      throw new Error("database is down");
    },
    timers: clock.timers,
    maxSalvageInserts: 6,
    logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
  });
  for (let ms = 1; ms <= 1000; ms++) sink.push(sampleOf(ms));
  await assert.doesNotReject(sink.flush());
  assert.equal(attempts, 7, "the batch itself plus the salvage allowance, not one per row");
  assert.deepEqual(sink.stats(), { buffered: 0, written: 0, droppedOverflow: 0, droppedFailed: 1000 });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.obj.dropped, 1000);

  // By default it stops after about one path down the halves.
  attempts = 0;
  const byDefault = createLatencySampleSink({
    insertMany: async () => {
      attempts += 1;
      throw new Error("database is down");
    },
    timers: clock.timers,
  });
  for (let ms = 1; ms <= 1000; ms++) byDefault.push(sampleOf(ms));
  await byDefault.flush();
  assert.ok(attempts <= 14, `attempts: ${attempts}`);
  assert.equal(byDefault.stats().droppedFailed, 1000);
});

test("push never throws, even when the timer or the logger does", async () => {
  const sink = createLatencySampleSink({
    insertMany: async () => {
      throw new Error("down");
    },
    timers: {
      set: () => {
        throw new Error("no timers");
      },
      clear: () => {},
    },
    logger: {
      warn: () => {
        throw new Error("no logger");
      },
    },
  });
  assert.doesNotThrow(() => sink.push(sampleOf(100)));
  await assert.doesNotReject(sink.close());
});

test("a slow insert never overlaps the next one", async () => {
  let running = 0;
  let overlapped = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sink = createLatencySampleSink({
    insertMany: async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await gate;
      running -= 1;
    },
    timers: fakeTimers().timers,
  });
  sink.push(sampleOf(1));
  const first = sink.flush();
  sink.push(sampleOf(2));
  const second = sink.flush();
  release();
  await Promise.all([first, second]);
  assert.equal(overlapped, false);
  assert.equal(sink.stats().written, 2);
});

test("close() writes what is buffered and clears the timer", async () => {
  const batches: LatencySample[][] = [];
  const clock = fakeTimers();
  const sink = createLatencySampleSink({
    insertMany: async (samples) => {
      batches.push(samples);
    },
    timers: clock.timers,
  });
  sink.push(sampleOf(100));
  const armed = clock.pending[0]!;
  await sink.close();
  assert.equal(armed.cleared, true);
  assert.deepEqual(batches.map((batch) => batch.map((s) => s.totalMs)), [[100]]);
});

test("the default timer is unref'd, so a pending write never keeps a process alive", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const handles: Array<ReturnType<typeof setTimeout>> = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const handle = realSetTimeout(fn, ms);
    handles.push(handle);
    return handle;
  }) as typeof setTimeout;
  try {
    const sink = createLatencySampleSink({ insertMany: async () => {}, flushIntervalMs: 60_000 });
    sink.push(sampleOf(100));
    assert.equal(handles.length, 1);
    assert.equal(handles[0]!.hasRef(), false);
    await sink.close();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
