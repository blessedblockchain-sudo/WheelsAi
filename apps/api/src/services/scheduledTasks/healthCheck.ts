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
 * A restart is a new Nosana deployment and a new hold on the owner's
 * credits, so the remediation is held to two rules:
 *   - a deployment its owner stopped stays stopped. Stopping is how an
 *     owner stops paying, and a check that undid it on the next tick
 *     would leave disabling the task as the only way to stop;
 *   - automatic restarts of one deployment are limited and backed off
 *     (autoRestartDecision), so a deployment that fails every time it
 *     starts is not restarted on every tick for as long as the task runs.
 * Either way the result says the restart was skipped, and why.
 *
 * Pure: resolution, the probe, the recorder, the restart and the claim on
 * the restart counter are injected.
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

/** Automatic restarts tried in the current window, and when the last one was. */
export interface AutoRestartRecord {
  count: number;
  lastAt: Date | null;
}

export interface DeploymentForCheck {
  id: string;
  status: string;
  /** Its owner pressed Stop (as opposed to the platform stopping it). */
  stoppedByOwner: boolean;
  healthUrl: string | null;
  autoRestarts: AutoRestartRecord;
}

export interface HealthCheckDeps {
  /** Org-scoped. `healthUrl` is null while the deployment has no node URL. */
  loadDeployment: (deploymentId: string, orgId: string) => Promise<DeploymentForCheck | null>;
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
  /**
   * Null when this server has no restart service that applies billing.
   * The service refuses a deployment its owner stopped, in its own claim.
   */
  restartDeployment:
    | null
    | ((deploymentId: string, orgId: string) => Promise<{ status: string }>);
  /**
   * Org-scoped compare-and-set of the deployment's restart record from
   * `expected` to `next`. False when it no longer reads `expected`: another
   * task watching the same deployment recorded a restart first.
   */
  claimAutoRestart: (
    deploymentId: string,
    orgId: string,
    expected: AutoRestartRecord,
    next: AutoRestartRecord,
  ) => Promise<boolean>;
}

const RESTARTABLE = new Set(["stopped", "failed"]);

/**
 * At most `max` automatic restarts of one deployment per window, each one
 * waiting twice as long as the one before (5, 10, 20, 40 minutes). The
 * window ends `windowMs` after the last restart; the owner restarting the
 * deployment by hand ends it at once.
 */
export const AUTO_RESTART_LIMITS = {
  max: 5,
  windowMs: 24 * 60 * 60_000,
  firstBackoffMs: 5 * 60_000,
};

export type AutoRestartDecision =
  | { allowed: true; next: AutoRestartRecord }
  | { allowed: false; reason: string };

/**
 * Whether one more automatic restart may be tried now. A restart the
 * service then refuses (no credits, quota) still counts: its reason is
 * retried on the same backoff rather than on every tick.
 */
export function autoRestartDecision(
  record: AutoRestartRecord,
  now: Date,
  limits: typeof AUTO_RESTART_LIMITS = AUTO_RESTART_LIMITS,
): AutoRestartDecision {
  const last = record.lastAt;
  if (!last || record.count <= 0 || now.getTime() - last.getTime() >= limits.windowMs) {
    return { allowed: true, next: { count: 1, lastAt: now } };
  }
  if (record.count >= limits.max) {
    const resumes = new Date(last.getTime() + limits.windowMs).toISOString();
    return {
      allowed: false,
      reason: `restart limit reached: ${record.count} automatic restarts, the last at ${last.toISOString()}; restart it by hand, or automatic restarts resume after ${resumes}`,
    };
  }
  const notBefore = last.getTime() + limits.firstBackoffMs * 2 ** (record.count - 1);
  if (now.getTime() < notBefore) {
    return {
      allowed: false,
      reason: `backing off after automatic restart ${record.count} of ${limits.max} at ${last.toISOString()}; the next is not tried before ${new Date(notBefore).toISOString()}`,
    };
  }
  return { allowed: true, next: { count: record.count + 1, lastAt: now } };
}

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
  let deployment: DeploymentForCheck | null = null;

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
    deployment = row;
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
    } else if (deployment.stoppedByOwner) {
      remediation = {
        action: "restart_deployment",
        status: "skipped",
        reason: "the deployment was stopped by its owner and stays stopped; start it by hand to resume",
      };
    } else if (!deps.restartDeployment) {
      remediation = {
        action: "restart_deployment",
        status: "unavailable",
        reason: RESTART_UNAVAILABLE_REASON,
      };
    } else {
      remediation = await restartWithinLimits(deployment, task.orgId, ctx.now, deps.restartDeployment, deps);
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

async function restartWithinLimits(
  deployment: DeploymentForCheck,
  orgId: string,
  now: Date,
  restartDeployment: NonNullable<HealthCheckDeps["restartDeployment"]>,
  deps: Pick<HealthCheckDeps, "claimAutoRestart">,
): Promise<Remediation> {
  const decision = autoRestartDecision(deployment.autoRestarts, now);
  if (!decision.allowed) {
    return { action: "restart_deployment", status: "skipped", reason: decision.reason };
  }
  // Recorded BEFORE the restart is asked for, and only if the record still
  // reads what the decision was made on: two tasks on one deployment cannot
  // both spend the same slot, and a crash after the restart cannot leave it
  // uncounted.
  const claimed = await deps.claimAutoRestart(deployment.id, orgId, deployment.autoRestarts, decision.next);
  if (!claimed) {
    return {
      action: "restart_deployment",
      status: "skipped",
      reason: "another check recorded an automatic restart of this deployment at the same moment",
    };
  }
  try {
    const restarted = await restartDeployment(deployment.id, orgId);
    return { action: "restart_deployment", status: "restarted", deploymentStatus: restarted.status };
  } catch (err) {
    // Out of credits, a lost race with another restart: the owner
    // needs the real reason next to the failed check.
    return {
      action: "restart_deployment",
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
