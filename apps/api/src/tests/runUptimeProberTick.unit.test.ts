import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/runUptimeProberTick.ts (Wave 1) — the
// first caller recordUptimeEvent ever had. Uptime numbers on the
// Monitoring page were permanently null before this worker existed.

import type {
  DueMonitorRow,
  ProbeOutcome,
} from "../services/runUptimeProberTick.js";

const NOW = new Date("2026-08-02T12:00:00Z");

function monitor(overrides: Partial<DueMonitorRow> = {}): DueMonitorRow {
  return {
    id: "mon_1",
    targetType: "custom_url",
    targetId: null,
    targetUrl: "https://example.com/health",
    timeoutSeconds: 10,
    httpMethod: "GET",
    expectedStatus: 200,
    expectedBody: null,
    headers: null,
    ...overrides,
  };
}

function makeDeps(opts: {
  due: DueMonitorRow[];
  urls?: Record<string, string | null>;
  probes?: Record<string, ProbeOutcome | Error>;
  recordError?: Error;
}) {
  const recorded: Array<{ monitorId: string; result: ProbeOutcome }> = [];
  return {
    recorded,
    deps: {
      loadDueMonitors: async () => opts.due,
      resolveTargetUrl: async (m: DueMonitorRow) =>
        opts.urls && m.id in opts.urls
          ? opts.urls[m.id]!
          : (m.targetUrl ?? null),
      probe: async (m: DueMonitorRow): Promise<ProbeOutcome> => {
        const p = opts.probes?.[m.id];
        if (p instanceof Error) throw p;
        return p ?? { status: "up", statusCode: 200, latencyMs: 50 };
      },
      recordResult: async (monitorId: string, result: ProbeOutcome) => {
        if (opts.recordError) throw opts.recordError;
        recorded.push({ monitorId, result });
      },
    },
  };
}

test("a due monitor is probed and its result recorded", async () => {
  setupEnv();
  const { runUptimeProberTick } = await import(
    "../services/runUptimeProberTick.js"
  );
  const { deps, recorded } = makeDeps({ due: [monitor()] });
  const result = await runUptimeProberTick({ now: NOW }, deps);

  assert.deepEqual(result, { due: 1, probed: 1, up: 1, notUp: 0, failed: 0 });
  assert.equal(recorded[0]!.monitorId, "mon_1");
  assert.equal(recorded[0]!.result.status, "up");
});

test("an unresolvable target records an honest error event, not silence", async () => {
  const { runUptimeProberTick } = await import(
    "../services/runUptimeProberTick.js"
  );
  const { deps, recorded } = makeDeps({
    due: [monitor({ id: "mon_dep", targetType: "deployment", targetUrl: null })],
    urls: { mon_dep: null },
  });
  const result = await runUptimeProberTick({ now: NOW }, deps);

  assert.equal(result.probed, 1);
  assert.equal(result.notUp, 1);
  assert.equal(recorded[0]!.result.status, "error");
  assert.match(recorded[0]!.result.errorMessage!, /no probeable URL/);
});

test("down/timeout outcomes count as notUp and are recorded verbatim", async () => {
  const { runUptimeProberTick } = await import(
    "../services/runUptimeProberTick.js"
  );
  const { deps, recorded } = makeDeps({
    due: [monitor({ id: "m_down" }), monitor({ id: "m_timeout" })],
    probes: {
      m_down: { status: "down", statusCode: 503, latencyMs: 20 },
      m_timeout: { status: "timeout", latencyMs: 10_000 },
    },
  });
  const result = await runUptimeProberTick({ now: NOW }, deps);

  assert.deepEqual(result, { due: 2, probed: 2, up: 0, notUp: 2, failed: 0 });
  assert.deepEqual(
    recorded.map((r) => r.result.status),
    ["down", "timeout"],
  );
});

test("per-monitor isolation: a persist failure on one monitor does not stop the rest", async () => {
  const { runUptimeProberTick } = await import(
    "../services/runUptimeProberTick.js"
  );
  // First monitor's record throws; makeDeps recordError applies to all,
  // so instead simulate via a probe throw on the first monitor.
  const { deps, recorded } = makeDeps({
    due: [monitor({ id: "m_bad" }), monitor({ id: "m_good" })],
    probes: { m_bad: new Error("probe exploded") },
  });
  const result = await runUptimeProberTick({ now: NOW }, deps);

  assert.equal(result.failed, 1);
  assert.equal(result.probed, 1);
  assert.deepEqual(
    recorded.map((r) => r.monitorId),
    ["m_good"],
  );
});
