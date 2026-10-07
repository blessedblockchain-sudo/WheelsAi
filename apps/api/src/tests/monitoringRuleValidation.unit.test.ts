import assert from "node:assert/strict";
import test from "node:test";

import {
  ALERT_METRICS,
  ALERT_METRIC_UNITS,
  alertRuleProblem,
} from "../services/alertRuleValidation.js";

// POST and PATCH /api/monitoring/rules answer 400 with this text. A rule the
// evaluator cannot evaluate used to be stored and then silently skipped; it
// is refused here instead.

const RESOURCE = "33333333-3333-4333-8333-333333333333";

const valid = {
  name: "Slow answers",
  ruleType: "threshold",
  resourceType: "organization",
  metric: "latency_p95",
  operator: "gt",
  threshold: 2_000,
  windowMinutes: 15,
  channelIds: [],
};

const create = (overrides: Record<string, unknown>) =>
  alertRuleProblem({ ...valid, ...overrides }, { partial: false });
const update = (updates: Record<string, unknown>) => alertRuleProblem(updates, { partial: true });

test("a latency_p95 rule with a threshold in ms is accepted, as is every metric the evaluator computes", () => {
  assert.equal(create({}), null);
  for (const metric of ALERT_METRICS) assert.equal(create({ metric }), null, metric);
  assert.deepEqual([...ALERT_METRICS].sort(), [
    "cost",
    "error_rate",
    "latency_avg",
    "latency_p95",
    "request_count",
    "uptime",
  ]);
});

test("latency thresholds are in ms", () => {
  assert.equal(ALERT_METRIC_UNITS.latency_p95, "ms");
  assert.equal(ALERT_METRIC_UNITS.latency_avg, "ms");
  assert.match(create({ threshold: -1 })!, /threshold .* \(ms\)/);
});

test("a metric the evaluator does not compute is refused, not stored", () => {
  assert.match(create({ metric: "latency_p99" })!, /^metric must be one of: .*latency_p95/);
  assert.match(create({ metric: undefined })!, /^metric /);
});

test("a bad operator is refused", () => {
  assert.match(create({ operator: "between" })!, /^operator must be one of: gt, gte, lt, lte, eq/);
});

test("a threshold must be a finite number of 0 or more", () => {
  for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, -5, "2000", null, undefined]) {
    assert.match(create({ threshold })!, /^threshold /, String(threshold));
  }
  assert.equal(create({ threshold: 0 }), null);
  assert.equal(create({ threshold: 0.5 }), null);
});

test("the window is a whole number of minutes from 1 to a day", () => {
  for (const windowMinutes of [0, 1_441, 2.5, -1, "5"]) {
    assert.match(create({ windowMinutes })!, /^windowMinutes must be a whole number from 1 to 1440/);
  }
  assert.equal(create({ windowMinutes: 1 }), null);
  assert.equal(create({ windowMinutes: 1_440 }), null);
  assert.equal(create({ windowMinutes: undefined }), null, "omitted takes the default");
});

test("a rule on one deployment or agent must name it by id", () => {
  assert.match(create({ resourceType: "deployment" })!, /^resourceId is required/);
  assert.match(create({ resourceType: "agent", resourceId: "my-agent" })!, /^resourceId must be the id/);
  assert.equal(create({ resourceType: "agent", resourceId: RESOURCE }), null);
  assert.match(create({ resourceType: "cluster" })!, /^resourceType must be one of/);
});

test("name, rule type and severity are checked", () => {
  assert.equal(create({ name: "  " }), "name is required");
  assert.match(create({ ruleType: "vibes" })!, /^ruleType /);
  assert.match(create({ severity: "apocalyptic" })!, /^severity /);
  assert.match(create({ cooldownMinutes: 0 })!, /^cooldownMinutes /);
  assert.match(create({ channelIds: "all" })!, /^channelIds /);
});

test("an update is checked the same way, on the fields it carries", () => {
  assert.equal(update({}), null);
  assert.equal(update({ threshold: 3_000 }), null);
  assert.equal(update({ metric: "latency_avg", windowMinutes: 60 }), null);
  assert.match(update({ metric: "latency_p99" })!, /^metric /);
  assert.match(update({ operator: "!=" })!, /^operator /);
  assert.match(update({ threshold: Number.NaN })!, /^threshold /);
  assert.match(update({ windowMinutes: 0 })!, /^windowMinutes /);
  assert.match(update({ windowMinutes: 1_441 })!, /^windowMinutes /);
  assert.match(update({ resourceId: "not-an-id" })!, /^resourceId /);
});
