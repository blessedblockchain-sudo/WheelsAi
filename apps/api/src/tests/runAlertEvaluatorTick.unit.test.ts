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

// Drives apps/api/src/services/runAlertEvaluatorTick.ts (Wave 1) — the
// first caller triggerAlert ever had. 'error_rate > 5' rules were pure
// decoration before this worker existed.

import type {
  AlertRuleRow,
  MetricComputation,
} from "../services/runAlertEvaluatorTick.js";

const NOW = new Date("2026-08-02T12:00:00Z");

function rule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: "rule_1",
    orgId: "org_1",
    name: "high error rate",
    metric: "error_rate",
    operator: "gt",
    threshold: 5,
    windowMinutes: 5,
    severity: "warning",
    cooldownMinutes: 60,
    lastTriggeredAt: null,
    resourceType: "organization",
    resourceId: null,
    ...overrides,
  };
}

function makeDeps(opts: {
  rules: AlertRuleRow[];
  metrics?: Record<string, MetricComputation | Error>;
  fireReturnsNull?: boolean;
}) {
  const fired: Array<{ ruleId: string; value: number; detail?: string }> = [];
  const emitted: Array<{ ruleId: string; alertId: string }> = [];
  return {
    fired,
    emitted,
    deps: {
      loadEnabledRules: async () => opts.rules,
      computeMetric: async (r: AlertRuleRow): Promise<MetricComputation> => {
        const m = opts.metrics?.[r.id];
        if (m instanceof Error) throw m;
        return m ?? { kind: "value", value: 10 };
      },
      fireAlert: async (r: AlertRuleRow, value: number, detail?: string) => {
        fired.push(detail === undefined ? { ruleId: r.id, value } : { ruleId: r.id, value, detail });
        return opts.fireReturnsNull
          ? null
          : { id: `alert_for_${r.id}`, title: `${r.name} triggered` };
      },
      emitAlertTriggered: async (
        r: AlertRuleRow,
        alert: { id: string },
      ) => {
        emitted.push({ ruleId: r.id, alertId: alert.id });
      },
    },
  };
}

test("a breaching rule fires an alert and emits the webhook event", async () => {
  setupEnv();
  const { runAlertEvaluatorTick } = await import(
    "../services/runAlertEvaluatorTick.js"
  );
  const { deps, fired, emitted } = makeDeps({
    rules: [rule()],
    metrics: { rule_1: { kind: "value", value: 12.5 } },
  });
  const result = await runAlertEvaluatorTick({ now: NOW }, deps);

  assert.equal(result.breached, 1);
  assert.equal(result.fired, 1);
  assert.deepEqual(fired, [{ ruleId: "rule_1", value: 12.5 }]);
  assert.deepEqual(emitted, [{ ruleId: "rule_1", alertId: "alert_for_rule_1" }]);
});

test("a within-threshold value fires nothing", async () => {
  const { runAlertEvaluatorTick } = await import(
    "../services/runAlertEvaluatorTick.js"
  );
  const { deps, fired } = makeDeps({
    rules: [rule()],
    metrics: { rule_1: { kind: "value", value: 2 } },
  });
  const result = await runAlertEvaluatorTick({ now: NOW }, deps);

  assert.equal(result.withinThreshold, 1);
  assert.equal(fired.length, 0);
});

test("operator table: gt/gte/lt/lte/eq evaluate correctly at the boundary", async () => {
  const { runAlertEvaluatorTick } = await import(
    "../services/runAlertEvaluatorTick.js"
  );
  const cases: Array<{ operator: string; value: number; breach: boolean }> = [
    { operator: "gt", value: 5, breach: false },
    { operator: "gte", value: 5, breach: true },
    { operator: "lt", value: 5, breach: false },
    { operator: "lte", value: 5, breach: true },
    { operator: "eq", value: 5, breach: true },
    { operator: "eq", value: 5.1, breach: false },
  ];
  for (const c of cases) {
    const { deps, fired } = makeDeps({
      rules: [rule({ operator: c.operator })],
      metrics: { rule_1: { kind: "value", value: c.value } },
    });
    await runAlertEvaluatorTick({ now: NOW }, deps);
    assert.equal(
      fired.length,
      c.breach ? 1 : 0,
      `${c.operator} with value ${c.value} vs threshold 5`,
    );
  }
});

test("cooldown: triggerAlert returning null counts as inCooldown, no webhook", async () => {
  const { runAlertEvaluatorTick } = await import(
    "../services/runAlertEvaluatorTick.js"
  );
  const { deps, emitted } = makeDeps({
    rules: [rule()],
    metrics: { rule_1: { kind: "value", value: 99 } },
    fireReturnsNull: true,
  });
  const result = await runAlertEvaluatorTick({ now: NOW }, deps);

  assert.equal(result.breached, 1);
  assert.equal(result.fired, 0);
  assert.equal(result.inCooldown, 1);
  assert.equal(emitted.length, 0);
});

test("no_data and unsupported metrics are counted, never evaluated as zero", async () => {
  const { runAlertEvaluatorTick } = await import(
    "../services/runAlertEvaluatorTick.js"
  );
  const { deps, fired } = makeDeps({
    rules: [
      rule({ id: "r_nodata", operator: "lt", threshold: 100 }),
      rule({ id: "r_unsup", metric: "queue_depth" }),
    ],
    metrics: {
      // lt 100 would BREACH if no-data were coerced to 0 — the counter
      // proves it is not.
      r_nodata: { kind: "no_data" },
      r_unsup: { kind: "unsupported", reason: "unknown usage metric queue_depth" },
    },
  });
  const result = await runAlertEvaluatorTick({ now: NOW }, deps);

  assert.equal(result.noData, 1);
  assert.equal(result.unsupported, 1);
  assert.equal(fired.length, 0);
});

test("per-rule isolation: a computeMetric throw fails that rule only", async () => {
  const { runAlertEvaluatorTick } = await import(
    "../services/runAlertEvaluatorTick.js"
  );
  const { deps, fired } = makeDeps({
    rules: [rule({ id: "r_bad" }), rule({ id: "r_good" })],
    metrics: {
      r_bad: new Error("metrics store down"),
      r_good: { kind: "value", value: 50 },
    },
  });
  const result = await runAlertEvaluatorTick({ now: NOW }, deps);

  assert.equal(result.failed, 1);
  assert.equal(result.fired, 1);
  assert.deepEqual(fired, [{ ruleId: "r_good", value: 50 }]);
});

test("a latency_p95 breach in ms fires once, with what the value is of, and cooldown still applies", async () => {
  const { runAlertEvaluatorTick } = await import(
    "../services/runAlertEvaluatorTick.js"
  );
  const p95 = rule({ id: "r_p95", name: "slow answers", metric: "latency_p95", operator: "gt", threshold: 2_000 });
  const measured: MetricComputation = { kind: "value", value: 2_140, detail: "ms over 37 requests" };

  const first = makeDeps({ rules: [p95], metrics: { r_p95: measured } });
  const result = await runAlertEvaluatorTick({ now: NOW }, first.deps);
  assert.equal(result.breached, 1);
  assert.equal(result.fired, 1);
  assert.equal(result.unsupported, 0, "latency_p95 is evaluated, not skipped");
  assert.deepEqual(first.fired, [{ ruleId: "r_p95", value: 2_140, detail: "ms over 37 requests" }]);
  assert.equal(first.emitted.length, 1);

  // Still breaching on the next pass: the trigger's cooldown declines.
  const second = makeDeps({ rules: [p95], metrics: { r_p95: measured }, fireReturnsNull: true });
  const again = await runAlertEvaluatorTick({ now: NOW }, second.deps);
  assert.deepEqual([again.breached, again.fired, again.inCooldown], [1, 0, 1]);
  assert.equal(second.emitted.length, 0);

  // 1,900 ms is within a 2,000 ms threshold.
  const within = makeDeps({ rules: [p95], metrics: { r_p95: { kind: "value", value: 1_900 } } });
  const quiet = await runAlertEvaluatorTick({ now: NOW }, within.deps);
  assert.deepEqual([quiet.withinThreshold, quiet.fired], [1, 0]);
});

test("a latency window with no request is no_data: an lt rule does not fire on a missing 0 ms", async () => {
  const { runAlertEvaluatorTick } = await import(
    "../services/runAlertEvaluatorTick.js"
  );
  const { deps, fired } = makeDeps({
    rules: [rule({ id: "r_avg", metric: "latency_avg", operator: "lt", threshold: 500 })],
    metrics: { r_avg: { kind: "no_data" } },
  });
  const result = await runAlertEvaluatorTick({ now: NOW }, deps);
  assert.deepEqual([result.noData, result.breached], [1, 0]);
  assert.equal(fired.length, 0);
});
