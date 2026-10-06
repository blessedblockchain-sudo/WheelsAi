import type { Agent, WheelsAI } from "@wheelsai/sdk";

import { CliError } from "../errors.js";

/**
 * Find an agent in the caller's organization by slug or id (one request).
 * The API has no slug filter, so the SDK lists the agents and matches client-side.
 */
export async function resolveAgent(wheels: WheelsAI, reference: string): Promise<Agent> {
  const agent = await wheels.agents.resolve(reference);
  if (!agent) {
    throw new CliError(`No agent "${reference}" in your organization.`, {
      hint: "List your agents with `wheelsai agents list`.",
    });
  }
  return agent;
}

/** The agent reference from `--agent` and/or the positional argument. */
export function agentReference(positional: string | undefined, option: string | undefined): string {
  if (positional && option && positional !== option) {
    throw new CliError(`Two different agents given: "${positional}" and --agent "${option}".`);
  }
  const reference = option ?? positional;
  if (!reference) {
    throw new CliError("Which agent? Pass --agent <slug-or-id>.");
  }
  return reference;
}
