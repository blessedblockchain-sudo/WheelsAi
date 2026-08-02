/**
 * Alert-evaluator tick (Wave 1) — the first caller triggerAlert ever
 * had. One call = one evaluation pass over every enabled AlertRule:
 * compute the rule's metric over its own window, compare against its
 * threshold, and on a breach hand off to the (already real) trigger —
 * which owns cooldown, the Alert row, and channel notifications — then
 * emit the alert.triggered webhook event.
 *
 * Honesty rule: a metric we cannot truthfully compute (latency_p95 needs
 * raw samples; only per-window aggregates exist today) is SKIPPED and
 * counted, never approximated into a fake evaluation.
 *
 * Per-rule isolation: one bad rule never stops the rest.
 */

export interface AlertRuleRow {
  id: string;
  orgId: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  windowMinutes: number;
  severity: string;
  cooldownMinutes: number;
  lastTriggeredAt: Date | null;
  resourceType: string;
  resourceId: string | null;
}

export type MetricComputation =
  | { kind: "value"; value: number }
  | { kind: "no_data" }
  | { kind: "unsupported"; reason: string };

export interface AlertEvaluatorTickDeps {
  loadEnabledRules: () => Promise<AlertRuleRow[]>;
  /** The rule's metric over [now - windowMinutes, now], honestly. */
  computeMetric: (rule: AlertRuleRow, now: Date) => Promise<MetricComputation>;
  /** monitoring.triggerAlert — cooldown + Alert row + notifications. */
  fireAlert: (
    rule: AlertRuleRow,
    metricValue: number,
  ) => Promise<{ id: string; title: string } | null>;
  /** Fire-and-forget webhook emission for a created alert. */
  emitAlertTriggered: (
    rule: AlertRuleRow,
    alert: { id: string; title: string },
    metricValue: number,
  ) => Promise<void>;
}

export interface AlertEvaluatorTickResult {
  rules: number;
  breached: number;
  fired: number;
  inCooldown: number;
  withinThreshold: number;
  noData: number;
  unsupported: number;
  failed: number;
}

function breaches(value: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    default:
      return false;
  }
}

export async function runAlertEvaluatorTick(
  input: { now: Date },
  deps: AlertEvaluatorTickDeps,
): Promise<AlertEvaluatorTickResult> {
  const rules = await deps.loadEnabledRules();

  const result: AlertEvaluatorTickResult = {
    rules: rules.length,
    breached: 0,
    fired: 0,
    inCooldown: 0,
    withinThreshold: 0,
    noData: 0,
    unsupported: 0,
    failed: 0,
  };

  for (const rule of rules) {
    try {
      const computation = await deps.computeMetric(rule, input.now);

      if (computation.kind === "no_data") {
        result.noData += 1;
        continue;
      }
      if (computation.kind === "unsupported") {
        result.unsupported += 1;
        continue;
      }

      if (!breaches(computation.value, rule.operator, rule.threshold)) {
        result.withinThreshold += 1;
        continue;
      }

      result.breached += 1;
      const alert = await deps.fireAlert(rule, computation.value);
      if (alert === null) {
        // triggerAlert's cooldown declined to create a new alert.
        result.inCooldown += 1;
        continue;
      }
      result.fired += 1;
      await deps
        .emitAlertTriggered(rule, alert, computation.value)
        .catch(() => {});
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
