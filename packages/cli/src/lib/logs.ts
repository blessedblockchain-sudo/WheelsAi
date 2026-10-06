import { WheelsAIError, type Agent, type AgentDeployment, type WheelsAI } from "@wheelsai/sdk";

import { CliError } from "../errors.js";
import { resolveAgent } from "./agents.js";

/**
 * Locate an agent deployment by id. There is no endpoint that takes a deployment id alone,
 * so: ask the agent named by --agent; otherwise the agent whose latest deployment (already in
 * the agent list) matches, then each remaining agent in turn (a 404 means "not this one").
 */
export async function findAgentDeployment(
  wheels: WheelsAI,
  deploymentId: string,
  agentReference: string | undefined,
): Promise<{ agent: Agent; deployment: AgentDeployment } | null> {
  const fetchOn = async (agent: Agent) => {
    try {
      return (await wheels.agents.getDeployment(agent.id, deploymentId)).deployment;
    } catch (error) {
      if (error instanceof WheelsAIError && error.status === 404) return null;
      // Asking agent after agent can trip the rate limiter in a large organization.
      if (error instanceof WheelsAIError && error.status === 429 && !agentReference) {
        throw new CliError(`${error.message} (HTTP 429) while searching your agents for the deployment.`, {
          hint: "Skip the search: pass --agent <slug-or-id>, or --model for a model deployment.",
        });
      }
      throw error;
    }
  };

  if (agentReference) {
    const agent = await resolveAgent(wheels, agentReference);
    const deployment = await fetchOn(agent);
    return deployment ? { agent, deployment } : null;
  }

  const { agents } = await wheels.agents.list();
  const newest = agents.find((agent) => agent.latestDeployment?.id === deploymentId);
  if (newest) {
    const deployment = await fetchOn(newest);
    if (deployment) return { agent: newest, deployment };
  }
  for (const agent of agents) {
    if (agent === newest) continue;
    const deployment = await fetchOn(agent);
    if (deployment) return { agent, deployment };
  }
  return null;
}
