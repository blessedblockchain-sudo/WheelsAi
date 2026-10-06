/**
 * health_check: probe one target and fail the task unless it is up.
 *
 * Targets:
 *   url         the URL in the payload
 *   deployment  one of the organization's model deployments (/health on
 *               a node)
 *   agent       the task's agent runtime (/health on its public URL)
 *   monitor     whatever one of the organization's uptime monitors
 *               points at, probed with that monitor's own settings
 *
 * A target with nothing to probe yet (a deployment with no node, an agent
 * with no runtime) is reported as exactly that: an `error` result with
 * the reason, never a skipped check and never "up".
 *
 * When a monitor is named, the result is also written to it, so the
 * uptime page and this task agree.
 *
 * Optional remediation: restart a stopped or failed deployment. It runs
 * only through an injected restart service, because a restart reserves
 * credits; when the server has none, the result says the action is
 * unavailable and why.
 *
 * Pure: resolution, the probe, the recorder and the restart are injected.
 */

import {
  RESTART_UNAVAILABLE_REASON,
  type HealthCheckPayload,
} from "../scheduledTaskTypes.js";
import type { ScheduledTaskForExecution, TaskResult, TaskRunContext } from "./context.js";
import { permanentFailure } from "./taskError.js";

export interface ProbeSpec {
  timeoutSeconds: number;
  httpMethod: string;
  expectedStatus: number;
  expectedBody: string | null;
  headers: unknown;
}

export interface ProbeResult {
  status: "up" | "down" | "degraded" | "timeout" | "error";
  statusCode?: number;
  latencyMs?: number;
  errorMessage?: string;
}

export interface MonitorForCheck extends ProbeSpec {
  id: string;
  /** Null when the monitor's target has nothing to probe yet. */
  url: string | null;
}

export interface HealthCheckDeps {
  /** Org-scoped. `healthUrl` is null while the deployment has no node URL. */
  loadDeployment: (
    deploymentId: string,
    orgId: string,
  ) => Promise<{ id: string; status: string; healthUrl: string | null } | null>;
  /** Org-scoped. `healthUrl` is null while the agent has no runtime URL. */
  loadAgentRuntime: (
    agentId: string,
    orgId: string,
  ) => Promise<{ healthUrl: string | null } | null>;
  /** Org-scoped. */
  loadMonitor: (monitorId: string, orgId: string) => Promise<MonitorForCheck | null>;
  /** Classifies; never throws. Goes through the SSRF guard. */
  probe: (spec: ProbeSpec, url: string) => Promise<ProbeResult>;
  recordUptimeEvent: (monitorId: string, result: ProbeResult) => Promise<void>;
  /** Null when this server has no restart service that applies billing. */
  restartDeployment:
    | null
    | ((deploymentId: string, orgId: string) => Promise<{ status: string }>);
}

const RESTARTABLE = new Set(["stopped", "failed"]);

type Remediation =
  | { action: "restart_deployment"; status: "restarted"; deploymentStatus: string }
  | { action: "restart_deployment"; status: "skipped" | "unavailable" | "failed"; reason: string };

export async function runHealthCheck(
  task: ScheduledTaskForExecution,
  payload: HealthCheckPayload,
  ctx: TaskRunContext,
  deps: HealthCheckDeps,
): Promise<TaskResult> {
  let spec: ProbeSpec = {
    timeoutSeconds: payload.timeoutSeconds,
    httpMethod: "GET",
    expectedStatus: payload.expectedStatus,
    expectedBody: payload.expectedBody ?? null,
    headers: null,
  };
  let url: string | null = null;
  let unresolved = "";
  let deployment: { id: string; status: string } | null = null;

  const monitor = payload.monitorId
    ? await deps.loadMonitor(payload.monitorId, task.orgId)
    : null;
  if (payload.monitorId && !monitor) {
    throw permanentFailure("uptime monitor not found in this organization");
  }

  if (payload.target === "url") {
    url = payload.url ?? null;
    if (!url) throw permanentFailure("a url health check needs payload.url");
  } else if (payload.target === "deployment") {
    if (!payload.deploymentId) {
      throw permanentFailure("a deployment health check needs payload.deploymentId");
    }
    const row = await deps.loadDeployment(payload.deploymentId, task.orgId);
    if (!row) throw permanentFailure("deployment not found in this organization");
    deployment = { id: row.id, status: row.status };
    url = row.healthUrl;
    if (!url) unresolved = `the deployment has no node URL to probe (status: ${row.status})`;
  } else if (payload.target === "agent") {
    if (!task.agentId) throw permanentFailure("an agent health check needs an agent on the task");
    const runtime = await deps.loadAgentRuntime(task.agentId, task.orgId);
    if (!runtime) throw permanentFailure("agent not found in this organization");
    url = runtime.healthUrl;
    if (!url) unresolved = "the agent has no running runtime with a public URL to probe";
  } else {
    // target === "monitor": its own URL and its own expectations.
    if (!monitor) throw permanentFailure("a monitor health check needs payload.monitorId");
    spec = monitor;
    url = monitor.url;
    if (!url) unresolved = "the monitor's target has no URL to probe yet";
  }

  if (ctx.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  const result: ProbeResult = url
    ? await deps.probe(spec, url)
    : { status: "error", errorMessage: unresolved };
  // A cancel or timeout that landed mid-probe: the run is over, and an
  // uptime event written now would belong to no execution.
  if (ctx.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

  let recordedToMonitor = false;
  if (monitor) {
    await deps.recordUptimeEvent(monitor.id, result);
    recordedToMonitor = true;
  }

  let remediation: Remediation | undefined;
  if (result.status !== "up" && payload.onDown === "restart_deployment" && deployment) {
    if (!RESTARTABLE.has(deployment.status)) {
      remediation = {
        action: "restart_deployment",
        status: "skipped",
        reason: `the deployment is ${deployment.status}; only a stopped or failed deployment is restarted`,
      };
    } else if (!deps.restartDeployment) {
      remediation = {
        action: "restart_deployment",
        status: "unavailable",
        reason: RESTART_UNAVAILABLE_REASON,
      };
    } else {
      try {
        const restarted = await deps.restartDeployment(deployment.id, task.orgId);
        remediation = {
          action: "restart_deployment",
          status: "restarted",
          deploymentStatus: restarted.status,
        };
      } catch (err) {
        // Out of credits, a lost race with another restart: the owner
        // needs the real reason next to the failed check.
        remediation = {
          action: "restart_deployment",
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  const output = {
    target: payload.target,
    url,
    status: result.status,
    statusCode: result.statusCode ?? null,
    latencyMs: result.latencyMs ?? null,
    recordedToMonitor,
    ...(remediation ? { remediation } : {}),
  };
  if (result.status !== "up") {
    const detail = result.errorMessage ? `: ${result.errorMessage}` : "";
    const fix =
      remediation && remediation.status !== "restarted"
        ? `; restart ${remediation.status}: ${remediation.reason}`
        : remediation
          ? "; deployment restart started"
          : "";
    // Permanent: the check ran and this is its answer.
    throw permanentFailure(`health check ${result.status}${detail}${fix}`, output);
  }
  return { output };
}
