import type { GraphIssue, WheelsAI } from "@wheelsai/sdk";
import { WheelsAIError } from "@wheelsai/sdk";

import { clean } from "./terminal.js";

export type GraphCheck =
  /** The agent has no visual graph: nothing to validate. */
  | { kind: "none" }
  | { kind: "valid"; nodes: number; edges: number; issues: GraphIssue[] }
  | { kind: "invalid"; nodes: number; edges: number; issues: GraphIssue[] }
  /** The graph could not be read, so it was not checked. */
  | { kind: "skipped"; reason: string };

/**
 * Validate the agent's graph with the API's own validator.
 *
 * The graph routes authorize by user (not organization), so an API key cannot read a
 * graph: the API refuses it (404, or 401/403). With an API key that refusal is reported as
 * "skipped" rather than failing the deploy. Anything else (a 5xx, no answer) is a real
 * failure with either credential and is thrown, so a graph is never waved through unread.
 */
export async function checkAgentGraph(
  wheels: WheelsAI,
  agentId: string,
  credential: "token" | "apiKey" | "none",
): Promise<GraphCheck> {
  let graph;
  try {
    ({ data: graph } = await wheels.agents.getGraph(agentId));
  } catch (error) {
    const refused = error instanceof WheelsAIError && [401, 403, 404].includes(error.status);
    if (credential === "apiKey" && refused) {
      return {
        kind: "skipped",
        reason:
          `an API key cannot read agent graphs (the API said "${clean(error.message)}"). ` +
          "Sign in with `wheelsai login --email` to validate them, or pass --no-validate.",
      };
    }
    throw error;
  }

  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  if (nodes.length === 0) return { kind: "none" };

  const { data: result } = await wheels.agents.validateGraph(agentId, { nodes, edges });
  return {
    kind: result.valid ? "valid" : "invalid",
    nodes: nodes.length,
    edges: edges.length,
    issues: result.issues ?? [],
  };
}
