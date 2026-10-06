/**
 * Which model an agent's chat runs on. Pure.
 *
 * Every chat path (playground, /v1, the scheduler, workflow steps, test runs
 * and graph llm nodes) picks the same model for the same agent through this. They used to disagree: the playground fell back to a free model
 * and ignored `modelConfig.model`; the scheduler read `model` and had no
 * fallback.
 *
 * Precedence: the caller's override, then the agent's `externalModel`, then
 * its legacy `model`, then the first free model whose provider key the
 * platform actually has. null means there is nothing to run on - the caller
 * answers an honest "not configured" rather than guessing a model.
 */

export interface ResolveAgentModelArgs {
  /** A per-request choice (the playground's model picker). */
  override?: string | null;
  /** The agent row's modelConfig JSON, as stored. */
  modelConfig: unknown;
  /** Ids of free models whose provider key is configured, in catalog order. */
  availableFreeModelIds: readonly string[];
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export function resolveAgentModelId(args: ResolveAgentModelArgs): string | null {
  const config =
    typeof args.modelConfig === "object" && args.modelConfig !== null
      ? (args.modelConfig as Record<string, unknown>)
      : {};
  return (
    nonEmpty(args.override) ??
    nonEmpty(config.externalModel) ??
    nonEmpty(config.model) ??
    args.availableFreeModelIds[0] ??
    null
  );
}
