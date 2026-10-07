/**
 * What an alert rule may say (POST and PATCH /api/monitoring/rules).
 *
 * A rule used to be stored with whatever metric, operator and threshold the
 * request carried, and the evaluator then skipped what it did not recognise:
 * a rule that could never fire looked exactly like one that was watching.
 * Anything the evaluator cannot evaluate is refused here instead.
 *
 * Pure. The one check that needs the database - that a named deployment or
 * agent belongs to the caller's organization - is in services/monitoring.ts.
 */

export const ALERT_METRICS = [
  "error_rate",
  "latency_p95",
  "latency_avg",
  "request_count",
  "cost",
  "uptime",
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

/** The unit a rule's threshold is in, so no form or message has to guess. */
export const ALERT_METRIC_UNITS: Record<AlertMetric, string> = {
  error_rate: "percent",
  latency_p95: "ms",
  latency_avg: "ms",
  request_count: "requests",
  cost: "cents",
  uptime: "percent",
};

export const ALERT_OPERATORS = ["gt", "gte", "lt", "lte", "eq"] as const;
export const ALERT_RULE_TYPES = ["threshold", "anomaly", "uptime", "budget"] as const;
export const ALERT_RESOURCE_TYPES = ["deployment", "agent", "organization"] as const;
export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;

/** The longest window a rule may look back over: a day. */
export const MAX_ALERT_WINDOW_MINUTES = 1_440;
const MAX_COOLDOWN_MINUTES = 7 * 1_440;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf(field: string, value: unknown, allowed: readonly string[]): string | null {
  return typeof value === "string" && allowed.includes(value)
    ? null
    : `${field} must be one of: ${allowed.join(", ")}`;
}

function wholeNumber(field: string, value: unknown, min: number, max: number): string | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? null
    : `${field} must be a whole number from ${min} to ${max}`;
}

/**
 * The first thing wrong with a rule, or null. `partial` (an update) checks
 * only the fields that are present.
 */
export function alertRuleProblem(
  input: Record<string, unknown>,
  options: { partial: boolean },
): string | null {
  const has = (field: string) => input[field] !== undefined;
  const required = (field: string) => !options.partial || has(field);

  if (required("name")) {
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      return "name is required";
    }
  }
  const checks: Array<string | null> = [
    required("ruleType") ? oneOf("ruleType", input.ruleType, ALERT_RULE_TYPES) : null,
    required("resourceType")
      ? oneOf("resourceType", input.resourceType, ALERT_RESOURCE_TYPES)
      : null,
    required("metric") ? oneOf("metric", input.metric, ALERT_METRICS) : null,
    required("operator") ? oneOf("operator", input.operator, ALERT_OPERATORS) : null,
    has("severity") ? oneOf("severity", input.severity, ALERT_SEVERITIES) : null,
    has("windowMinutes")
      ? wholeNumber("windowMinutes", input.windowMinutes, 1, MAX_ALERT_WINDOW_MINUTES)
      : null,
    has("cooldownMinutes")
      ? wholeNumber("cooldownMinutes", input.cooldownMinutes, 1, MAX_COOLDOWN_MINUTES)
      : null,
  ];
  if (required("threshold")) {
    const threshold = input.threshold;
    if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
      const unit = ALERT_METRIC_UNITS[input.metric as AlertMetric];
      checks.push(`threshold must be a number of 0 or more${unit ? ` (${unit})` : ""}`);
    }
  }
  if (has("resourceId") && input.resourceId !== null) {
    if (typeof input.resourceId !== "string" || !UUID.test(input.resourceId)) {
      checks.push("resourceId must be the id of a deployment or an agent");
    }
  }
  if (
    (input.resourceType === "deployment" || input.resourceType === "agent") &&
    (input.resourceId === undefined || input.resourceId === null) &&
    !options.partial
  ) {
    checks.push(`resourceId is required for a rule on one ${input.resourceType}`);
  }
  if (has("channelIds") && !Array.isArray(input.channelIds)) {
    checks.push("channelIds must be a list");
  }
  return checks.find((problem) => problem !== null) ?? null;
}
