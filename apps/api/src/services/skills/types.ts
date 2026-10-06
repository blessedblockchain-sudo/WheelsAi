/**
 * Skill (tool) contracts shared by the registry, the tool loop and the graph
 * interpreter.
 *
 * The one rule every skill obeys: NEVER SIMULATE SUCCESS. A skill that
 * cannot do its job (provider not configured, storage missing, no agent
 * context) returns `{ status: "unavailable", reason }`, which reaches the
 * model as the literal text "unavailable: <reason>" and reaches the UI as an
 * explicit label. It never returns plausible-looking output.
 */

/**
 * Where a skill is being invoked from.
 *
 *   playground  interactive chat in the dashboard
 *   job         a batch / orchestration step
 *   trial       a try-before-you-buy run of someone else's agent - money
 *               moving skills are NEVER available here
 *   scheduled   a scheduler-triggered run
 *   graph       a visual-builder graph run
 *   test        the agent test runner: the agent's saved data must not change
 *               and nothing may spend money (file_write and every
 *               money-moving skill are refused)
 *
 * `trial` is also what a marketplace BUYER's run uses (see runMode.ts): the
 * agent's prompt and tools were written by someone else.
 */
export type ToolMode = "playground" | "job" | "trial" | "scheduled" | "graph" | "test";

export interface ToolContext {
  mode: ToolMode;
  agentId: string;
  orgId: string;
  signal?: AbortSignal;
}

export type SkillResult =
  | { status: "ok"; output: string; data?: unknown }
  | { status: "unavailable"; reason: string }
  | { status: "error"; message: string };

export type SkillAvailability =
  | { available: true }
  | { available: false; reason: string };

/** Agent-level facts some skills depend on (e.g. a bound knowledge base). */
export interface AgentAvailabilityContext {
  hasKnowledgeBase?: boolean;
}

/** The JSON-schema subset sent to the model as a function's `parameters`. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface SkillDefinition {
  /** Stable identifier; what `Agent.tools[].name` stores. */
  key: string;
  /** Bumped when the input contract or behaviour changes incompatibly. */
  version: string;
  name: string;
  description: string;
  /** Sent to the model as the function's parameters. */
  inputSchema: JsonSchemaObject;
  /** True when the skill can move value (funds, credits, on-chain state). */
  moneyMoving: boolean;
  /**
   * True when the skill changes the agent's saved data (files, memory). Such
   * skills are refused in `test` mode: a test run must not leave the agent
   * different from how it found it.
   */
  writesState?: boolean;
  /** Names of the server configuration the skill needs (operator-facing). */
  requires?: string[];
  /** Honest availability right now. Omitted means "always available". */
  availability?: (agent?: AgentAvailabilityContext) => SkillAvailability;
  execute(input: unknown, ctx: ToolContext): Promise<SkillResult>;
}

export interface SkillDescriptor {
  key: string;
  version: string;
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  moneyMoving: boolean;
  requires: string[];
  available: boolean;
  unavailableReason: string | null;
}

/** OpenAI-compatible function tool, as sent in `tools`. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
  };
}

/** Renders a result the way the model (and logs) see it. */
export function skillResultToText(result: SkillResult): string {
  switch (result.status) {
    case "ok":
      return result.output;
    case "unavailable":
      return `unavailable: ${result.reason}`;
    case "error":
      return `error: ${result.message}`;
  }
}
