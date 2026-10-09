/**
 * Which model a model picker shows as chosen. Pure.
 *
 * A picker is handed a model id by its page: the agent's own, or a default
 * the page was written with. The server may not offer that model right now
 * (its provider key is missing, or the model left the catalog). A select
 * drawn with a value it has no option for shows its first option while the
 * page still holds the other id, so what is sent is not what is shown. The
 * rule here closes that gap: once the list has loaded, the chosen model is
 * always one of the offered ones.
 */

export interface OfferedModels {
  freeModels?: ReadonlyArray<{ id: string; available: boolean }> | null;
  externalModels?: ReadonlyArray<{ id: string }> | null;
}

/** The ids a picker offers, in the order it draws them: the free models that can answer now, then the others. */
export function offeredModelIds(models: OfferedModels | null | undefined): string[] {
  const free = (models?.freeModels ?? []).filter((model) => model.available).map((model) => model.id);
  const external = (models?.externalModels ?? []).map((model) => model.id);
  return [...free, ...external];
}

export interface ModelChoiceOptions {
  /**
   * The picker has an entry for "no model of its own" (value ""): the agent
   * then answers on the platform's default. Without it, "" is not a choice.
   */
  allowDefault?: boolean;
}

/**
 * The model the picker must show and the page must hold, given what is
 * offered: `value` when it is offered (or is the default entry), else the
 * default entry when there is one, else the first offered model. "" only
 * when nothing at all is offered.
 */
export function chosenModel(value: string, offered: readonly string[], options: ModelChoiceOptions = {}): string {
  if (offered.includes(value)) return value;
  if (options.allowDefault) return "";
  return offered[0] ?? "";
}
