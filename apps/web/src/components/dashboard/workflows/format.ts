/** Small display helpers shared by the workflow and scheduler screens. */

export function formatDuration(ms?: number | null): string {
  if (ms === null || ms === undefined) return "--";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** "5m ago" / "In 2h"; a date beyond a week either way. */
export function formatRelative(value?: string | null, never = "Never"): string {
  if (!value) return never;
  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const minutes = Math.floor(Math.abs(diffMs) / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (minutes < 1) return future ? "In a moment" : "Just now";
  if (minutes < 60) return future ? `In ${minutes}m` : `${minutes}m ago`;
  if (hours < 24) return future ? `In ${hours}h` : `${hours}h ago`;
  if (days < 7) return future ? `In ${days}d` : `${days}d ago`;
  return date.toLocaleDateString();
}

export function formatInterval(seconds: number): string {
  if (seconds % 86_400 === 0) return `Every ${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `Every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} min`;
  return `Every ${seconds}s`;
}

export function formatSchedule(task: {
  scheduleType: string;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  scheduledAt?: string | null;
}): string {
  if (task.scheduleType === "interval" && task.intervalSeconds) return formatInterval(task.intervalSeconds);
  if (task.scheduleType === "cron" && task.cronExpression) return task.cronExpression;
  if (task.scheduleType === "once" && task.scheduledAt) return new Date(task.scheduledAt).toLocaleString();
  return "Not set";
}

export function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export type Tone = "neutral" | "info" | "success" | "danger" | "warning";

/** Semantic tone classes; the only place run and task states get a colour. */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-primary/15 text-primary",
  success: "bg-success/10 text-success",
  danger: "bg-danger/10 text-danger",
  warning: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
};

const STATUS_TONE: Record<string, Tone> = {
  queued: "neutral",
  pending: "neutral",
  running: "info",
  completed: "success",
  success: "success",
  active: "success",
  failed: "danger",
  error: "danger",
  timeout: "danger",
  cancelled: "warning",
  paused: "warning",
  skipped: "neutral",
  disabled: "neutral",
};

export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? "neutral";
}
