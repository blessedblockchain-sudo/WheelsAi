/**
 * The words for a deployment that agents answer from, and for a listing that
 * is paused because its agent's model is not running. Pure: the pages pass
 * what the API said and draw what comes back.
 *
 * A listing is paused only while the model its agent runs on is not running.
 * Nobody presses anything to end it: it goes back on sale by itself.
 */
import type { DeploymentDependents } from "./api";

// ============================================
// The warning at Stop
// ============================================

export const STOP_WARNING_WORDS = {
  title: "Stop this deployment?",
  confirm: "Stop deployment",
  cancel: "Keep it running",
  unknown:
    "We could not check which agents answer from this deployment. Agents set to its model will stop answering when it stops.",
} as const;

/** What the dialog at Stop says. */
export interface StopWarning {
  title: string;
  /** The sentence that opens the dialog. */
  lead: string;
  /** The agents the lead speaks of, in the order the API gave them; empty when they could not be read. */
  names: string[];
  /** The sentence about the ones on sale; null when none is. */
  onSale: string | null;
  confirmLabel: string;
  cancelLabel: string;
}

/** A name as it is shown: an agent whose name is blank is still counted and still named. */
function shownName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  return text === "" ? "Unnamed agent" : text;
}

/** "1 agent answers from this deployment ...:" or "3 agents answer from this deployment ...:". */
export function stopWarningLead(count: number): string {
  return count === 1
    ? "1 agent answers from this deployment and will stop answering until you deploy this model again or give it another model:"
    : `${count} agents answer from this deployment and will stop answering until you deploy this model again or give them another model:`;
}

/** The sentence about the agents on sale, with one name or with several. */
export function stopWarningOnSale(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) {
    return `On sale: ${names[0]}. Its listing is paused while it cannot answer: nobody can start using it and nobody is charged. People who pay monthly keep the days they paid for.`;
  }
  return `On sale: ${names.join(", ")}. Their listings are paused while they cannot answer: nobody can start using them and nobody is charged. People who pay monthly keep the days they paid for.`;
}

/**
 * What Stop asks first. null when no agent answers from the deployment: Stop
 * then does what it always did. `dependents` is null when they could not be
 * read: the dialog still opens, and says so.
 */
export function stopWarning(dependents: DeploymentDependents | null): StopWarning | null {
  const base = {
    title: STOP_WARNING_WORDS.title,
    confirmLabel: STOP_WARNING_WORDS.confirm,
    cancelLabel: STOP_WARNING_WORDS.cancel,
  };
  if (!dependents || !Array.isArray(dependents.agents)) {
    return { ...base, lead: STOP_WARNING_WORDS.unknown, names: [], onSale: null };
  }
  const agents = dependents.agents;
  if (agents.length === 0) return null;
  return {
    ...base,
    lead: stopWarningLead(agents.length),
    names: agents.map((agent) => shownName(agent.name)),
    onSale: stopWarningOnSale(agents.filter((agent) => agent.onSale === true).map((agent) => shownName(agent.name))),
  };
}

// ============================================
// The two notices
// ============================================

/** The Sell tab, to the creator. */
export const SELL_PAUSED_NOTICE = {
  message:
    "Paused. The model this agent runs on is not running, so nobody can start using it and nobody is charged. People who pay monthly keep the days they paid for. It goes back on sale by itself when the model runs again.",
  action: { label: "Deploy a model", href: "/dashboard/deployments/new" },
} as const;

/** The agent's public page, to someone who pays to use it. */
export const PUBLIC_PAUSED_NOTICE =
  "This agent is paused right now. Nobody is charged while it is paused, and a month already paid for is made longer by that time. Try again later.";

/**
 * How often the public page asks again while it shows the pause. Sending is
 * disabled then, so nothing else on the page would read the access, and the
 * page would stay paused after the model runs again.
 */
export const PAUSED_RECHECK_MS = 30_000;

/** What the API says when a use is refused on a paused listing (503 `agent_paused`). */
export const AGENT_PAUSED_MESSAGE = "This agent is paused right now. Nothing was charged.";

/** What the API says when a start is refused on a paused listing (409 `listing_paused`). */
export const LISTING_PAUSED_START_MESSAGE =
  "This agent is paused right now, so nothing was started and nothing was charged. Try again later.";

/** Whether the seller's own listing is paused at this moment, as `my-listings` answered it. */
export function listingIsPaused(listing: { paused?: { since: string | null } | null } | null | undefined): boolean {
  return typeof listing?.paused === "object" && listing.paused !== null;
}

/** Whether the access view says the agent is paused. Anything but `true` is not a pause. */
export function accessIsPaused(access: { paused?: boolean } | null | undefined): boolean {
  return access?.paused === true;
}
