/**
 * Analytics export (Pro "advanced analytics"): the dashboard's usage data
 * as CSV or JSON.
 *
 * CSV cells are quoted when needed, and cells that a spreadsheet would
 * evaluate as a formula (leading = + - @, tab or carriage return) are
 * prefixed with a single quote, since deployment names are user input.
 */

export const EXPORT_MAX_DAYS = 365;

export function clampExportDays(raw: unknown, fallback = 30): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), EXPORT_MAX_DAYS);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  columns: Array<{ key: keyof T & string; header: string }>,
): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c.key])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export const DAILY_COLUMNS = [
  { key: "timestamp", header: "date" },
  { key: "requests", header: "requests" },
  { key: "tokensIn", header: "tokens_in" },
  { key: "tokensOut", header: "tokens_out" },
  { key: "costCents", header: "cost_cents" },
  { key: "errors", header: "errors" },
] as const;

export const DEPLOYMENT_COLUMNS = [
  { key: "deploymentId", header: "deployment_id" },
  { key: "deploymentName", header: "deployment_name" },
  { key: "modelId", header: "model_id" },
  { key: "status", header: "status" },
  { key: "requests", header: "requests" },
  { key: "tokensIn", header: "tokens_in" },
  { key: "tokensOut", header: "tokens_out" },
  { key: "costCents", header: "cost_cents" },
  { key: "avgLatencyMs", header: "avg_latency_ms" },
  { key: "errorRate", header: "error_rate" },
] as const;
