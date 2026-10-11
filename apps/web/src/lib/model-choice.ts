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
  /** The models the organization runs itself. An older server does not send the list. */
  hostedModels?: ReadonlyArray<{ id: string; available: boolean }> | null;
  freeModels?: ReadonlyArray<{ id: string; available: boolean }> | null;
  externalModels?: ReadonlyArray<{ id: string }> | null;
}

/** How the id of a model the organization runs itself begins. */
export const HOSTED_MODEL_PREFIX = "wheelsai/";

/**
 * The ids a picker offers. Their order is the order a picker falls back in
 * when the model it was handed is not offered: the free models that can
 * answer now, then the ones that need a key, and the organization's own
 * models that can answer last. A model the organization runs is offered and
 * never fallen back to: an agent moves onto a GPU only when a person chooses
 * that. (The picker draws its groups in an order of its own.)
 */
export function offeredModelIds(models: OfferedModels | null | undefined): string[] {
  const free = (models?.freeModels ?? []).filter((model) => model.available).map((model) => model.id);
  const external = (models?.externalModels ?? []).map((model) => model.id);
  const hosted = (models?.hostedModels ?? []).filter((model) => model.available).map((model) => model.id);
  return [...free, ...external, ...hosted];
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

/** What a picker needs of one model the organization runs itself, to draw it. */
export interface HostedModelEntry {
  id: string;
  displayName: string;
  available: boolean;
  state: "running" | "starting" | "not_answering";
  deployment: { slug: string };
}

/** The picker's group for the models the organization runs itself. */
export const HOSTED_GROUP_LABEL = "Your models on Nosana";

/**
 * The words of a hosted model's entry. One that can answer names the
 * deployment it answers from; one that cannot says why in the same brackets,
 * and the picker draws it disabled.
 */
export function hostedModelLabel(model: HostedModelEntry): string {
  if (model.available) return `${model.displayName} (your deployment ${model.deployment.slug})`;
  return `${model.displayName} (${model.state === "starting" ? "starting" : "not answering right now"})`;
}

/**
 * Whether a picker that keeps its value draws the extra "not available right
 * now" entry for it. A hosted model that is listed but cannot answer already
 * has its own entry, which says why, so it gets no second one.
 */
export function isUnlistedModel(
  value: string,
  models: OfferedModels | null | undefined,
): boolean {
  if (value === "") return false;
  if (offeredModelIds(models).includes(value)) return false;
  return !(models?.hostedModels ?? []).some((model) => model.id === value);
}

/** The line under an agent's model picker: plain words, or words that end in a link. */
export type HostedModelLine =
  | { kind: "hosted"; text: string }
  | { kind: "stopped"; text: string; linkLabel: string; href: string }
  | { kind: "deploy"; text: string; linkLabel: string; href: string };

const DEPLOY_LINK = { linkLabel: "Deploy a model", href: "/dashboard/deployments/new" } as const;

/**
 * The line under an agent's model picker. When the chosen model is one the
 * organization runs: where the agent answers from and what that means. When
 * it is one the organization ran and no longer does: that the agent cannot
 * answer, which nothing else on the page says. When the organization runs
 * none: how to get one. Nothing in every other case, and nothing when the
 * server did not say which models the organization runs.
 */
export function hostedModelLine(
  value: string,
  hostedModels: ReadonlyArray<HostedModelEntry> | null | undefined,
): HostedModelLine | null {
  if (!hostedModels) return null;
  const chosen = hostedModels.find((model) => model.id === value);
  if (chosen) {
    return {
      kind: "hosted",
      text: `This agent answers from your deployment ${chosen.deployment.slug}. It can answer only while that deployment is running. Its GPU time is billed by the second on the deployment.`,
    };
  }
  if (value.startsWith(HOSTED_MODEL_PREFIX)) {
    return {
      kind: "stopped",
      text: "This agent is set to a model your organization is not running now, so it cannot answer. Deploy that model again, or choose another model.",
      ...DEPLOY_LINK,
    };
  }
  if (hostedModels.length === 0) {
    return {
      kind: "deploy",
      text: "To have this agent think on a GPU you run, deploy a model on Nosana, then choose it here.",
      ...DEPLOY_LINK,
    };
  }
  return null;
}
