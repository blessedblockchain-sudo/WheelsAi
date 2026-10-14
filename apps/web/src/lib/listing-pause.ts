/**
 * The words for a deployment that agents answer from, and for a listing that
 * is paused because its agent's model is not running. Pure: the pages pass
 * what the API said and draw what comes back.
 *
 * A listing is paused only while the model its agent runs on is not running.
 * Nobody presses anything to end it: it goes back on sale by itself.
 *
 * A workflow on sale is never paused. While a deployment it needs is stopped
 * it cannot run: people who pay for it are refused and nobody is charged, and
 * a plan on it that comes due is not charged while it cannot run and ends if
 * that lasts the API's days of grace. The warning at Stop names those
 * workflows too.
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
  /**
   * The sentence about the workflows on sale that cannot run while the deployment is stopped. Present
   * only when there are some, so a warning about agents alone is exactly what it was.
   */
  workflows?: string | null;
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
 * "1 workflow you sell runs on this deployment and cannot run until you deploy
 * this model again." The lead of the dialog when no agent answers from the
 * deployment and workflows on sale need it.
 */
export function stopWarningWorkflowLead(count: number): string {
  return count === 1
    ? "1 workflow you sell runs on this deployment and cannot run until you deploy this model again."
    : `${count} workflows you sell run on this deployment and cannot run until you deploy this model again.`;
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** "three days", "one day": the days of grace as the sentence says them. */
function daysInWords(days: number): string {
  const number = days <= 10 ? NUMBER_WORDS[days] : days.toLocaleString("en-US");
  return `${number} ${days === 1 ? "day" : "days"}`;
}

/**
 * The sentence about the workflows on sale that need the deployment, with one
 * name or with several; null when there are none. `graceDays` is the API's
 * `renewalGraceDays`: how long a plan that comes due waits for the workflow
 * to run again before it ends. When it is not a whole number of days the
 * sentence leaves that part out rather than guess.
 */
export function stopWarningWorkflows(names: readonly string[], graceDays?: number | null): string | null {
  if (names.length === 0) return null;
  const one = names.length === 1;
  const days = typeof graceDays === "number" && Number.isInteger(graceDays) && graceDays > 0 ? graceDays : null;
  const notCharged = one
    ? "A plan that comes due is not charged while it cannot run"
    : "A plan that comes due is not charged while they cannot run";
  const plans = days === null ? `${notCharged}.` : `${notCharged}, and ends if that lasts ${daysInWords(days)}.`;
  const lead = one
    ? `On sale: the workflow ${names[0]}. It cannot run while this deployment is stopped: people who pay for it are refused and nobody is charged.`
    : `On sale: the workflows ${names.join(", ")}. They cannot run while this deployment is stopped: people who pay for them are refused and nobody is charged.`;
  return `${lead} ${plans} The days already paid for keep counting.`;
}

/**
 * The sentence about the workflows taken off sale that somebody is still on a
 * plan for, with one name or with several; null when there are none. Their
 * plans are not renewed whatever the workflow can do: they end at the close
 * of the days paid for, and until then the people on them are refused while
 * it cannot run.
 */
export function stopWarningOffSaleWorkflows(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return names.length === 1
    ? `No longer on sale, with plans still running: the workflow ${names[0]}. People on a plan are refused while it cannot run, and nobody is charged. Their plans end when the 30 days they paid for end.`
    : `No longer on sale, with plans still running: the workflows ${names.join(", ")}. People on a plan are refused while they cannot run, and nobody is charged. Their plans end when the 30 days they paid for end.`;
}

/** A workflow's name as it is shown: one whose name is blank is still named. */
function shownWorkflowName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  return text === "" ? "Unnamed workflow" : text;
}

/** The workflows of the answer, read as none when an older API did not say or said something else. */
function workflowsOf(dependents: DeploymentDependents): NonNullable<DeploymentDependents["workflows"]> {
  return Array.isArray(dependents.workflows)
    ? dependents.workflows.filter((workflow) => typeof workflow === "object" && workflow !== null)
    : [];
}

/**
 * What Stop asks first. null when no agent answers from the deployment and no
 * workflow on sale needs it: Stop then does what it always did. `dependents`
 * is null when they could not be read: the dialog still opens, and says so.
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
  const workflows = workflowsOf(dependents);
  // The workflows whose listing is published are said to be on sale, with the days of grace. One taken off
  // sale is in the answer because somebody's plan on it still runs: its plans end at their period's end
  // whatever it can do, so it gets a sentence of its own, never "On sale" or the days of grace.
  const onSaleWorkflows = workflows.filter((workflow) => workflow.onSale === true);
  const offSaleWorkflows = workflows.filter((workflow) => workflow.onSale !== true);
  const sentences = [
    stopWarningWorkflows(
      onSaleWorkflows.map((workflow) => shownWorkflowName(workflow.name)),
      onSaleWorkflows.find((workflow) => Number.isInteger(workflow.renewalGraceDays))?.renewalGraceDays ?? null,
    ),
    stopWarningOffSaleWorkflows(offSaleWorkflows.map((workflow) => shownWorkflowName(workflow.name))),
  ].filter((sentence): sentence is string => sentence !== null);
  const workflowSentence = sentences.length > 0 ? sentences.join(" ") : null;
  if (agents.length === 0) {
    if (workflows.length === 0) return null;
    // Only workflows need it: a lead of their own, no list of agents.
    return { ...base, lead: stopWarningWorkflowLead(workflows.length), names: [], onSale: null, workflows: workflowSentence };
  }
  return {
    ...base,
    lead: stopWarningLead(agents.length),
    names: agents.map((agent) => shownName(agent.name)),
    onSale: stopWarningOnSale(agents.filter((agent) => agent.onSale === true).map((agent) => shownName(agent.name))),
    ...(workflowSentence !== null && { workflows: workflowSentence }),
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
