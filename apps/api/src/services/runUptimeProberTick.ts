/**
 * Uptime prober tick (Wave 1) — the first caller recordUptimeEvent ever
 * had. One call = one pass of the uptime-prober worker: probe every
 * monitor whose own check interval has elapsed, classify the result, and
 * hand it to the (already real) recorder that maintains current status,
 * uptime percentages, and latency stats.
 *
 * Target resolution is honest: a monitor pointed at a deployment with no
 * node URL yet records an `error` event saying so — the page shows a
 * truthful failure, not silence and not an invented "up".
 *
 * Per-monitor isolation: one probe/persist failure never stops the rest.
 */

export interface DueMonitorRow {
  id: string;
  targetType: string;
  targetId: string | null;
  targetUrl: string | null;
  timeoutSeconds: number;
  httpMethod: string;
  expectedStatus: number;
  expectedBody: string | null;
  headers: unknown;
}

export interface ProbeOutcome {
  status: "up" | "down" | "degraded" | "timeout" | "error";
  statusCode?: number;
  latencyMs?: number;
  errorMessage?: string;
}

export interface UptimeProberTickDeps {
  /** Enabled monitors whose checkIntervalSeconds has elapsed. */
  loadDueMonitors: (args: { now: Date }) => Promise<DueMonitorRow[]>;
  /**
   * The URL to probe for this monitor, or null when the target has no
   * probeable URL yet (deployment without a node, agent without a
   * runtime URL). Null becomes an honest `error` event.
   */
  resolveTargetUrl: (monitor: DueMonitorRow) => Promise<string | null>;
  /** HTTP probe — classifies, never throws. */
  probe: (monitor: DueMonitorRow, url: string) => Promise<ProbeOutcome>;
  /** recordUptimeEvent — persists event + status + rolling stats. */
  recordResult: (monitorId: string, result: ProbeOutcome) => Promise<void>;
}

export interface UptimeProberTickResult {
  due: number;
  probed: number;
  up: number;
  notUp: number;
  failed: number;
}

export async function runUptimeProberTick(
  input: { now: Date },
  deps: UptimeProberTickDeps,
): Promise<UptimeProberTickResult> {
  const due = await deps.loadDueMonitors({ now: input.now });

  const result: UptimeProberTickResult = {
    due: due.length,
    probed: 0,
    up: 0,
    notUp: 0,
    failed: 0,
  };

  for (const monitor of due) {
    try {
      const url = await deps.resolveTargetUrl(monitor);

      const outcome: ProbeOutcome = url
        ? await deps.probe(monitor, url)
        : {
            status: "error",
            errorMessage:
              "target has no probeable URL yet (no running node / runtime URL)",
          };

      await deps.recordResult(monitor.id, outcome);
      result.probed += 1;
      if (outcome.status === "up") result.up += 1;
      else result.notUp += 1;
    } catch {
      // Resolution or persistence blew up — the monitor keeps its last
      // state; next tick retries. Other monitors still run.
      result.failed += 1;
    }
  }

  return result;
}
