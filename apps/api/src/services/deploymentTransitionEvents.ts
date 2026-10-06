/**
 * The webhook events one OBSERVED deployment transition produces.
 *
 * The deployment-status worker announces what it saw on Nosana:
 * deployment.running / deployment.failed / deployment.stopped for both
 * kinds of deployment. An agent deployment that reaches running is also the
 * moment the agent is deployed, so it carries agent.deployed as well - an
 * event type that was subscribable from the start and never sent.
 *
 * Only the tick's compare-and-set winner calls this, so each transition is
 * announced once. Delivery is best effort: a failed lookup or emission is
 * logged and never fails the row.
 */

import type { DeploymentStatusTransition } from "./runDeploymentStatusTick.js";

export type DeploymentTransitionEventType =
  | "deployment.running"
  | "deployment.failed"
  | "deployment.stopped"
  | "agent.deployed";

export interface DeployedAgent {
  agentId: string;
  name: string;
  slug: string;
}

export interface DeploymentTransitionEvent {
  type: DeploymentTransitionEventType;
  data: Record<string, unknown>;
  resourceType: "deployment" | "agent";
  resourceId: string;
}

/** `degraded` (and any other non-terminal state) has no event type. */
function deploymentEventType(toStatus: string): DeploymentTransitionEventType | null {
  if (toStatus === "running") return "deployment.running";
  if (toStatus === "failed") return "deployment.failed";
  if (toStatus === "stopped") return "deployment.stopped";
  return null;
}

/** Whether this transition is an agent deployment starting to run. */
export function isAgentDeployed(transition: DeploymentStatusTransition): boolean {
  return (
    transition.kind === "agent" &&
    transition.toStatus === "running" &&
    transition.fromStatus !== "running"
  );
}

/** Pure. `agent` is the deployment's agent, when it was looked up. */
export function deploymentTransitionEvents(
  transition: DeploymentStatusTransition,
  agent: DeployedAgent | null,
): DeploymentTransitionEvent[] {
  const events: DeploymentTransitionEvent[] = [];
  const type = deploymentEventType(transition.toStatus);
  if (type) {
    events.push({
      type,
      data: {
        deploymentId: transition.id,
        deploymentKind: transition.kind,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        observedAt: transition.observedAt.toISOString(),
      },
      resourceType: "deployment",
      resourceId: transition.id,
    });
  }
  if (agent && isAgentDeployed(transition)) {
    events.push({
      type: "agent.deployed",
      data: {
        agentId: agent.agentId,
        name: agent.name,
        slug: agent.slug,
        deploymentId: transition.id,
        observedAt: transition.observedAt.toISOString(),
      },
      // Filed under the agent, like agent.created: a webhook scoped to one
      // agent receives it.
      resourceType: "agent",
      resourceId: agent.agentId,
    });
  }
  return events;
}

export interface EmitDeploymentTransitionDeps {
  /** The agent behind an agent deployment of `orgId`; null when the row is gone. */
  loadDeployedAgent: (deploymentId: string, orgId: string) => Promise<DeployedAgent | null>;
  triggerWebhook: (
    orgId: string,
    type: DeploymentTransitionEventType,
    data: Record<string, unknown>,
    resourceType: string,
    resourceId: string,
  ) => Promise<unknown>;
  onError?: (err: unknown, eventType: string) => void;
}

export function createEmitDeploymentTransition(
  deps: EmitDeploymentTransitionDeps,
): (transition: DeploymentStatusTransition) => Promise<void> {
  return async (transition) => {
    let agent: DeployedAgent | null = null;
    if (isAgentDeployed(transition)) {
      // A failed lookup costs agent.deployed only; deployment.running is
      // still sent.
      agent = await deps.loadDeployedAgent(transition.id, transition.orgId).catch((err) => {
        deps.onError?.(err, "agent.deployed");
        return null;
      });
    }
    for (const event of deploymentTransitionEvents(transition, agent)) {
      await deps
        .triggerWebhook(transition.orgId, event.type, event.data, event.resourceType, event.resourceId)
        .catch((err) => deps.onError?.(err, event.type));
    }
  };
}
