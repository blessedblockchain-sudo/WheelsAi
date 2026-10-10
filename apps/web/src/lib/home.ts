/**
 * What Home says, as plain data: the four next steps (Create, Try, Share,
 * Earn), the links of an agent's row, the two account lines (verify your
 * email, fund your account) and whether a failed load is worth telling.
 *
 * Pure. One rule above the others: Home promises only what can happen now.
 * A line about email or about paying is given only when the server said it
 * can happen; an answer that could not be read counts as "cannot".
 *
 * Run the tests with:
 *   cd apps/web && npx tsx --test src/lib/home.unit.test.ts
 */
import type { AgentKind } from "@wheelsai/shared/agent-kind";

import { kindOf, newAgentHref } from "./agent-list";
import { buildAgentTabs } from "./agent-tabs";
import type { BillingRails } from "./api";
import { packPayment } from "./credit-purchase";

// ============================================
// Words
// ============================================

/** The title over the three choices, in the create screen's words. */
export const HOME_CREATE_TITLE = "How will people use it?";

/** The two other things to build. Links go where the menu's Workflows and Models items go. */
export const HOME_BUILD_MORE = [
  {
    id: "workflow",
    title: "Build a workflow",
    first: "Make several agents work together, one step after another.",
    second: "Chain agents into pipelines, give them branches and loops, and run them on a schedule.",
    primary: { label: "Open workflows", href: "/dashboard/orchestrations" },
    secondary: { label: "Scheduler", href: "/dashboard/scheduler" },
  },
  {
    id: "model",
    title: "Deploy or fine-tune a model",
    first: "Run an open AI model of your own, or teach one with your data.",
    second: "Models run on Nosana GPUs, billed per second, behind an OpenAI-compatible API.",
    primary: { label: "Model catalog", href: "/dashboard/models" },
    secondary: { label: "Fine-tune", href: "/dashboard/training/new" },
  },
] as const;

/** The create screen's six steps for an agent that carries code. */
export const IMPORT_CODE_HREF = "/dashboard/agents/new?mode=code";

// ============================================
// Agents
// ============================================

/** The fields of an agent Home reads (Agent has them all). */
export interface HomeAgent {
  id: string;
  name?: string;
  agentKind?: AgentKind | string | null;
  createdAt?: string;
}

function createdAtOf(agent: HomeAgent): number {
  const at = agent.createdAt ? Date.parse(agent.createdAt) : NaN;
  return Number.isNaN(at) ? 0 : at;
}

/** The newest agents first. Agents with no readable date keep the order they came in. */
export function newestAgents<T extends HomeAgent>(agents: readonly T[], limit = 3): T[] {
  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => createdAtOf(b.agent) - createdAtOf(a.agent) || a.index - b.index)
    .slice(0, limit)
    .map(({ agent }) => agent);
}

export interface HomeLink {
  label: string;
  href: string;
}

export interface AgentLinks {
  /** The agent's own page, on the tab it opens on. */
  first: HomeLink;
  share: HomeLink;
  sell: HomeLink;
}

function tabHref(agentId: string, tab: string): string {
  return `/dashboard/agents/${encodeURIComponent(agentId)}?tab=${tab}`;
}

/** Where an agent's row links: its first tab (Chat, Run or Runs), Share and Sell. */
export function agentLinks(agent: HomeAgent): AgentLinks {
  // The first basic tab is the one the kind opens on; Chat stands in if the list were ever empty.
  const first = buildAgentTabs({ agentKind: kindOf(agent.agentKind), hasCode: false, advanced: false })[0] ?? {
    id: "chat",
    label: "Chat",
  };
  return {
    first: { label: first.label, href: tabHref(agent.id, first.id) },
    share: { label: "Share", href: tabHref(agent.id, "share") },
    sell: { label: "Sell", href: tabHref(agent.id, "sell") },
  };
}

// ============================================
// The four next steps
// ============================================

export type HomeStepId = "create" | "try" | "share" | "earn";

export interface HomeStep {
  id: string;
  label: string;
  detail: string;
  done: boolean;
  href: string;
}

/** A listing, as far as Home reads it (MarketplaceListing has both fields). */
export interface HomeListing {
  agentId?: string | null;
  status: string;
}

export interface HomeHas {
  /** The person's agents. Any order: the newest is found here. */
  agents: readonly HomeAgent[];
  /** Whether the newest agent has been used at least once; null when the page cannot know. */
  used?: boolean | null;
  /** The state of the newest agent's public link; null when it could not be read. */
  linkState?: string | null;
  /** The person's listings; null when they could not be read. */
  listings?: readonly HomeListing[] | null;
}

const TRY_DETAIL: Record<AgentKind, string> = {
  conversation: "Send it a message in its Chat tab.",
  task: "Fill in its form in the Run tab.",
  scheduled: "Run it now from its Runs tab.",
};

/**
 * Create, Try, Share, Earn. Each is done or not from what the person has,
 * and links to the newest agent's tab for that step, or to the create screen
 * when there is no agent yet. Something the page could not read is not done.
 */
export function nextSteps(has: HomeHas): HomeStep[] {
  const [newest] = newestAgents(has.agents, 1);
  const create = newAgentHref({});
  const links = newest ? agentLinks(newest) : null;
  const published = (has.listings ?? []).some((listing) => listing.status === "published");

  return [
    {
      id: "create",
      label: "Create an agent",
      detail: "Choose how people will use it. It is live at once.",
      done: Boolean(newest),
      href: create,
    },
    {
      id: "try",
      label: "Try it",
      detail: newest ? TRY_DETAIL[kindOf(newest.agentKind)] : "Use your agent yourself, before anyone else does.",
      done: Boolean(newest) && has.used === true,
      href: links?.first.href ?? create,
    },
    {
      id: "share",
      label: "Share it",
      detail: "Turn on its public link, or put it on your website.",
      done: Boolean(newest) && (has.linkState === "on" || published),
      href: links?.share.href ?? create,
    },
    {
      id: "earn",
      label: "Earn from it",
      detail: "Choose who can use it, and set a price.",
      done: Boolean(newest) && published,
      href: links?.sell.href ?? create,
    },
  ];
}

// ============================================
// The account lines
// ============================================

export interface AccountFacts {
  /** The person signed up with an email address. */
  hasEmail: boolean;
  /** null until the account has been read, or when the read failed. */
  emailVerified: boolean | null;
  /** `capabilities.emailDelivery.available`; null when the capabilities could not be read. */
  emailDelivery: boolean | null;
  /** The rails of GET /api/billing/packages; null when they could not be read. */
  rails: BillingRails | null;
  creditCents: number;
}

function assetWords(assets: readonly string[]): string {
  if (assets.length <= 1) return assets.join("");
  return `${assets.slice(0, -1).join(", ")} or ${assets[assets.length - 1]}`;
}

/** The ways of paying that are live, in words; null when there is none or the rails are unknown. */
export function fundingDetail(rails: BillingRails | null | undefined): string | null {
  const payment = packPayment(rails);
  const wallet = payment.wallet && rails ? `from a wallet, in ${assetWords(rails.walletAssets)}` : null;
  if (payment.card && wallet) return `Add credits by card, or ${wallet}.`;
  if (payment.card) return "Add credits by card.";
  if (wallet) return `Add credits ${wallet}.`;
  return null;
}

/** Whether a person can add credits right now. Unknown rails count as no. */
export function canAddCredits(rails: BillingRails | null | undefined): boolean {
  return fundingDetail(rails) !== null;
}

/**
 * "Verify your email" and "Fund your account". Each is given only when it
 * can happen now: a verification link can be sent, a way of paying is live.
 */
export function accountSteps(facts: AccountFacts): HomeStep[] {
  const steps: HomeStep[] = [];
  if (facts.hasEmail && facts.emailVerified === false && facts.emailDelivery === true) {
    steps.push({
      id: "verify",
      label: "Verify your email",
      detail: "Send the link from Settings. A new account's first verification adds $5 of credits.",
      done: false,
      href: "/dashboard/settings",
    });
  }
  const funding = fundingDetail(facts.rails);
  if (funding) {
    steps.push({
      id: "fund",
      label: "Fund your account",
      detail: funding,
      done: facts.creditCents > 0,
      href: "/dashboard/billing",
    });
  }
  return steps;
}

// ============================================
// A load cut off by leaving
// ============================================

/**
 * True when a failed load should be neither shown nor logged: the person is
 * leaving the page, and the browser dropped the request. An answer from the
 * server (anything carrying an HTTP status) is a real failure even then.
 */
export function cutOffByLeaving(error: unknown, leaving: boolean): boolean {
  if (!leaving) return false;
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status !== "number";
}
