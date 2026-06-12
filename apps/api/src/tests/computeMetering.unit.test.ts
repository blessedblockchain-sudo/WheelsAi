import assert from "node:assert/strict";
import test from "node:test";

// Minimal env so importing services/env.ts doesn't exit the process.
function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// stubbedDeps returns a MeteringDeps object that feeds canned getJobStatus
// responses to the service under test — no SDK, no network.
function stubbedDeps(jobResponses: Record<string, unknown>) {
  return {
    getJobStatus: async (jobId: string) => {
      const res = jobResponses[jobId];
      if (res === undefined) return null;
      if (res instanceof Error) throw res;
      return res as any;
    },
  };
}

// ============================================
// getPricePerSecond
// ============================================

test("getPricePerSecond returns the exact tier rate for known tiers", async () => {
  setupEnv();
  const { getPricePerSecond } = await import("../services/computeMetering.js");
  // MARKETS is the source of truth; these values are pinned so anyone changing
  // pricing knows they're touching the billing surface.
  assert.equal(getPricePerSecond("3060"), 0.0001);
  assert.equal(getPricePerSecond("4070"), 0.00015);
  assert.equal(getPricePerSecond("4090"), 0.00025);
  assert.equal(getPricePerSecond("a100"), 0.0008);
  assert.equal(getPricePerSecond("h100"), 0.0015);
});

test("getPricePerSecond falls back to 3060 pricing when tier is unknown", async () => {
  setupEnv();
  const { getPricePerSecond } = await import("../services/computeMetering.js");
  assert.equal(getPricePerSecond("nonexistent-tier"), 0.0001);
  assert.equal(getPricePerSecond(""), 0.0001);
});

// ============================================
// calculateJobComputeCost
// ============================================

test("calculateJobComputeCost uses on-chain start/end when SDK does not report price", async () => {
  setupEnv();
  const { calculateJobComputeCost } = await import("../services/computeMetering.js");
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date("2026-01-01T01:00:00Z"); // exactly 3600 seconds
  const deps = stubbedDeps({
    job_completed: {
      id: "job_completed",
      market: "",
      status: "completed",
      startTime: start,
      endTime: end,
      cost: undefined,
    },
  });
  const result = await calculateJobComputeCost("job_completed", "4090", deps);
  assert.equal(result.source, "on-chain");
  assert.equal(result.computeSeconds, 3600);
  assert.equal(result.pricePerSecondUsd, 0.00025);
  assert.equal(result.costUsd, 3600 * 0.00025); // 0.9
});

test("calculateJobComputeCost treats running jobs as 'now - start'", async () => {
  setupEnv();
  const { calculateJobComputeCost } = await import("../services/computeMetering.js");
  const now = Date.now();
  const start = new Date(now - 60_000); // 60 seconds ago
  const deps = stubbedDeps({
    job_running: {
      id: "job_running",
      market: "",
      status: "running",
      startTime: start,
      endTime: undefined,
      cost: undefined,
    },
  });
  const result = await calculateJobComputeCost("job_running", "3060", deps);
  assert.equal(result.source, "on-chain");
  // One-second tolerance for wall-clock drift during the test.
  assert.ok(
    Math.abs(result.computeSeconds - 60) <= 1,
    `expected ~60 compute seconds, got ${result.computeSeconds}`
  );
  assert.equal(result.pricePerSecondUsd, 0.0001);
});

test("calculateJobComputeCost prefers sdk-reported cost when present", async () => {
  setupEnv();
  const { calculateJobComputeCost } = await import("../services/computeMetering.js");
  const start = new Date("2026-01-01T00:00:00Z");
  const end = new Date("2026-01-01T00:10:00Z");
  const deps = stubbedDeps({
    job_with_sdk_cost: {
      id: "job_with_sdk_cost",
      market: "",
      status: "completed",
      startTime: start,
      endTime: end,
      cost: 0.42, // SDK is authoritative (includes Nosana settlement math)
    },
  });
  const result = await calculateJobComputeCost("job_with_sdk_cost", "4090", deps);
  assert.equal(result.source, "sdk-reported");
  assert.equal(result.costUsd, 0.42);
  // computeSeconds is back-derived from cost / pricePerSecond so the
  // treasury worker can still meter GPU-seconds even when SDK gives cost.
  assert.equal(result.computeSeconds, Math.round(0.42 / 0.00025));
});

test("calculateJobComputeCost returns zero cost when job is not found", async () => {
  setupEnv();
  const { calculateJobComputeCost } = await import("../services/computeMetering.js");
  const deps = stubbedDeps({});
  const result = await calculateJobComputeCost("job_missing", "3060", deps);
  assert.equal(result.source, "unavailable");
  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});

test("calculateJobComputeCost returns unavailable when nosana client throws", async () => {
  setupEnv();
  const { calculateJobComputeCost } = await import("../services/computeMetering.js");
  const deps = stubbedDeps({ job_thrown: new Error("RPC down") });
  const result = await calculateJobComputeCost("job_thrown", "4090", deps);
  assert.equal(result.source, "unavailable");
  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});

test("calculateJobComputeCost handles a job with no start time", async () => {
  setupEnv();
  const { calculateJobComputeCost } = await import("../services/computeMetering.js");
  const deps = stubbedDeps({
    job_no_start: {
      id: "job_no_start",
      market: "",
      status: "queued",
      startTime: undefined,
      endTime: undefined,
      cost: undefined,
    },
  });
  const result = await calculateJobComputeCost("job_no_start", "4090", deps);
  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});

// ============================================
// calculateDeploymentComputeCost
// ============================================

test("calculateDeploymentComputeCost sums across every attached job", async () => {
  setupEnv();
  const { calculateDeploymentComputeCost } = await import(
    "../services/computeMetering.js"
  );
  const base = Date.now();
  const deps = stubbedDeps({
    job_a: {
      id: "job_a",
      market: "",
      status: "completed",
      startTime: new Date(base - 10_000),
      endTime: new Date(base - 5_000), // 5s
    },
    job_b: {
      id: "job_b",
      market: "",
      status: "completed",
      startTime: new Date(base - 8_000),
      endTime: new Date(base - 1_000), // 7s
    },
  });
  const result = await calculateDeploymentComputeCost(["job_a", "job_b"], "3060", deps);
  assert.equal(result.computeSeconds, 12);
  assert.equal(result.costUsd, 12 * 0.0001);
});

test("calculateDeploymentComputeCost returns zeros for an empty job list", async () => {
  setupEnv();
  const { calculateDeploymentComputeCost } = await import(
    "../services/computeMetering.js"
  );
  const deps = stubbedDeps({});
  const result = await calculateDeploymentComputeCost([], "h100", deps);
  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});

// ============================================
// calculateJobComputeCostForWindow (delta billing, D2)
// ============================================

test("calculateJobComputeCostForWindow bills exactly the window delta for a long-running job", async () => {
  // The D2 pin: a job running for 2 hours, with the treasury's
  // lastComputeBillAt cursor 1 hour ago, bills exactly 1 hour — not the
  // cumulative 2-hour lifetime the old metering re-charged every tick.
  setupEnv();
  const { calculateJobComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const now = new Date("2026-01-01T12:00:00Z");
  const deps = stubbedDeps({
    job_long: {
      id: "job_long",
      market: "",
      status: "running",
      startTime: new Date("2026-01-01T10:00:00Z"), // started 2h ago
      endTime: undefined, // still running
      cost: undefined,
    },
  });
  const result = await calculateJobComputeCostForWindow(
    "job_long",
    "4090",
    { start: new Date("2026-01-01T11:00:00Z"), end: now }, // billed 1h ago
    deps,
  );
  assert.equal(result.source, "on-chain");
  assert.equal(result.computeSeconds, 3600);
  assert.equal(result.costUsd, 3600 * 0.00025);
});

test("calculateJobComputeCostForWindow bills 0 for a job that ended before the window started", async () => {
  setupEnv();
  const { calculateJobComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const deps = stubbedDeps({
    job_done: {
      id: "job_done",
      market: "",
      status: "completed",
      startTime: new Date("2026-01-01T08:00:00Z"),
      endTime: new Date("2026-01-01T09:00:00Z"), // ended before window
      cost: undefined,
    },
  });
  const result = await calculateJobComputeCostForWindow(
    "job_done",
    "4090",
    {
      start: new Date("2026-01-01T11:00:00Z"),
      end: new Date("2026-01-01T12:00:00Z"),
    },
    deps,
  );
  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});

test("calculateJobComputeCostForWindow clamps to jobStart for a job started mid-window", async () => {
  setupEnv();
  const { calculateJobComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const deps = stubbedDeps({
    job_mid: {
      id: "job_mid",
      market: "",
      status: "running",
      startTime: new Date("2026-01-01T11:30:00Z"), // started inside the window
      endTime: undefined,
      cost: undefined,
    },
  });
  const result = await calculateJobComputeCostForWindow(
    "job_mid",
    "3060",
    {
      start: new Date("2026-01-01T11:00:00Z"),
      end: new Date("2026-01-01T12:00:00Z"),
    },
    deps,
  );
  // Only the 30 minutes the job actually ran inside the window.
  assert.equal(result.computeSeconds, 1800);
  assert.equal(result.costUsd, 1800 * 0.0001);
});

test("calculateJobComputeCostForWindow with a null window start bills from the job's own start", async () => {
  // First-ever bill: lastComputeBillAt is null → no lower bound; the
  // job's full (in-window) lifetime is billable.
  setupEnv();
  const { calculateJobComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const deps = stubbedDeps({
    job_first: {
      id: "job_first",
      market: "",
      status: "completed",
      startTime: new Date("2026-01-01T10:00:00Z"),
      endTime: new Date("2026-01-01T11:00:00Z"),
      cost: undefined,
    },
  });
  const result = await calculateJobComputeCostForWindow(
    "job_first",
    "4090",
    { start: null, end: new Date("2026-01-01T12:00:00Z") },
    deps,
  );
  assert.equal(result.computeSeconds, 3600);
  assert.equal(result.costUsd, 3600 * 0.00025);
});

test("calculateJobComputeCostForWindow clamps a running job's accrual at the window end", async () => {
  // Whatever runs after window.end belongs to the NEXT window; billing
  // past it would double-charge once the cursor advances.
  setupEnv();
  const { calculateJobComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const deps = stubbedDeps({
    job_run: {
      id: "job_run",
      market: "",
      status: "running",
      startTime: new Date("2026-01-01T10:00:00Z"),
      endTime: undefined,
      cost: undefined,
    },
  });
  const result = await calculateJobComputeCostForWindow(
    "job_run",
    "3060",
    {
      start: new Date("2026-01-01T11:00:00Z"),
      end: new Date("2026-01-01T11:10:00Z"),
    },
    deps,
  );
  assert.equal(result.computeSeconds, 600);
});

test("calculateJobComputeCostForWindow prorates SDK-reported cost over the window", async () => {
  // SDK cost is cumulative for the whole job; taking it verbatim every
  // tick is the exact compounding-over-billing bug D2 fixes. The window
  // pays cost * (windowSeconds / lifetimeSeconds).
  setupEnv();
  const { calculateJobComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const deps = stubbedDeps({
    job_sdk: {
      id: "job_sdk",
      market: "",
      status: "completed",
      startTime: new Date("2026-01-01T10:00:00Z"),
      endTime: new Date("2026-01-01T12:00:00Z"), // 2h lifetime
      cost: 1.8, // whole-job cost
    },
  });
  const result = await calculateJobComputeCostForWindow(
    "job_sdk",
    "4090",
    {
      start: new Date("2026-01-01T11:00:00Z"), // last hour only
      end: new Date("2026-01-01T12:00:00Z"),
    },
    deps,
  );
  assert.equal(result.source, "sdk-reported");
  assert.equal(result.computeSeconds, 3600);
  // Half the lifetime → half the SDK cost.
  assert.ok(
    Math.abs(result.costUsd - 0.9) < 1e-9,
    `expected ~0.9 got ${result.costUsd}`,
  );
});

test("calculateJobComputeCostForWindow returns zeros for queued/missing/erroring jobs", async () => {
  setupEnv();
  const { calculateJobComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const window = {
    start: new Date("2026-01-01T11:00:00Z"),
    end: new Date("2026-01-01T12:00:00Z"),
  };
  const deps = stubbedDeps({
    job_queued: {
      id: "job_queued",
      market: "",
      status: "queued",
      startTime: undefined,
      endTime: undefined,
      cost: undefined,
    },
    job_thrown: new Error("RPC down"),
  });

  const queued = await calculateJobComputeCostForWindow("job_queued", "4090", window, deps);
  assert.equal(queued.computeSeconds, 0);
  assert.equal(queued.costUsd, 0);

  const missing = await calculateJobComputeCostForWindow("job_missing", "4090", window, deps);
  assert.equal(missing.source, "unavailable");
  assert.equal(missing.costUsd, 0);

  const thrown = await calculateJobComputeCostForWindow("job_thrown", "4090", window, deps);
  assert.equal(thrown.source, "unavailable");
  assert.equal(thrown.costUsd, 0);
});

// ============================================
// calculateDeploymentComputeCostForWindow
// ============================================

test("calculateDeploymentComputeCostForWindow sums window-clamped costs across jobs", async () => {
  setupEnv();
  const { calculateDeploymentComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const deps = stubbedDeps({
    // Fully inside the window: 10 minutes.
    job_a: {
      id: "job_a",
      market: "",
      status: "completed",
      startTime: new Date("2026-01-01T11:10:00Z"),
      endTime: new Date("2026-01-01T11:20:00Z"),
    },
    // Ended before the window: contributes 0.
    job_b: {
      id: "job_b",
      market: "",
      status: "completed",
      startTime: new Date("2026-01-01T09:00:00Z"),
      endTime: new Date("2026-01-01T10:00:00Z"),
    },
  });
  const result = await calculateDeploymentComputeCostForWindow(
    ["job_a", "job_b"],
    "3060",
    {
      start: new Date("2026-01-01T11:00:00Z"),
      end: new Date("2026-01-01T12:00:00Z"),
    },
    deps,
  );
  assert.equal(result.computeSeconds, 600);
  assert.equal(result.costUsd, 600 * 0.0001);
});

test("calculateDeploymentComputeCostForWindow returns zeros for an empty job list", async () => {
  setupEnv();
  const { calculateDeploymentComputeCostForWindow } = await import(
    "../services/computeMetering.js"
  );
  const result = await calculateDeploymentComputeCostForWindow(
    [],
    "h100",
    { start: null, end: new Date() },
    stubbedDeps({}),
  );
  assert.equal(result.computeSeconds, 0);
  assert.equal(result.costUsd, 0);
});
