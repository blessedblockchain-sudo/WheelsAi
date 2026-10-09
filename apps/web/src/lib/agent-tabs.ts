/**
 * The tabs of an agent's own page.
 *
 * Basic tabs are what everyone sees: the tab the agent's kind opens on
 * (Chat, Run or Runs), then Share, Sell and Settings. The technical tabs sit
 * behind one Advanced switch. Nothing is removed: every tab is reachable by
 * turning the switch on, and a link to an advanced tab turns it on.
 *
 * Tab ids are what the page puts in `?tab=`. The ids the page had before
 * this model (overview, api, versions, code, logs, settings) are unchanged,
 * and `deployments` still opens the tab that took its place (GPU).
 */
import type { AgentKind } from "@wheelsai/shared/agent-kind";

export type AgentTabId =
  | "chat"
  | "run"
  | "runs"
  | "share"
  | "sell"
  | "settings"
  | "api"
  | "versions"
  | "code"
  | "logs"
  | "gpu"
  | "overview"
  | "schedule";

export interface AgentTab {
  id: AgentTabId;
  label: string;
  /** true for a tab that shows only while the Advanced switch is on. */
  advanced: boolean;
}

/** The query parameter that names the open tab. */
export const AGENT_TAB_PARAM = "tab";

/** Where the Advanced switch is remembered, in the browser's local storage. */
export const AGENT_ADVANCED_STORAGE_KEY = "wheelsai:agent-advanced";

/** The label of the switch. */
export const AGENT_ADVANCED_LABEL = "Advanced";

const LABELS: Record<AgentTabId, string> = {
  chat: "Chat",
  run: "Run",
  runs: "Runs",
  share: "Share",
  sell: "Sell",
  settings: "Settings",
  api: "API",
  versions: "Versions",
  code: "Code",
  logs: "Logs",
  gpu: "GPU",
  overview: "Overview",
  schedule: "Schedule",
};

const FIRST_TAB: Record<AgentKind, AgentTabId> = {
  conversation: "chat",
  task: "run",
  scheduled: "runs",
};

/** The front doors a kind does not open on, kept under Advanced. */
const OTHER_DOORS: Record<AgentKind, AgentTabId[]> = {
  conversation: ["schedule"],
  task: ["chat", "schedule"],
  scheduled: ["chat"],
};

const TECHNICAL: AgentTabId[] = ["api", "versions", "code", "logs", "gpu", "overview"];

/** Ids from older links, and the tab each one opens now. */
export const FORMER_TAB_IDS: Readonly<Record<string, AgentTabId>> = {
  deployments: "gpu",
  playground: "chat",
};

function kindOf(agentKind: AgentKind | null | undefined): AgentKind {
  return agentKind === "task" || agentKind === "scheduled" ? agentKind : "conversation";
}

/** The tab an agent's page opens on: Chat, Run or Runs. */
export function firstTabOf(agentKind: AgentKind | null | undefined): AgentTabId {
  return FIRST_TAB[kindOf(agentKind)];
}

export interface AgentTabsModel {
  agentKind: AgentKind | null | undefined;
  /** Whether the agent carries code (see `agentCarriesCode`). */
  hasCode: boolean;
  /** The Advanced switch. Left out, it is where the switch starts for this agent. */
  advanced?: boolean;
}

/**
 * The tabs to show, in order. With the switch off: the first tab, Share,
 * Sell, Settings. With it on, the advanced tabs follow: API, Versions, Code,
 * Logs, GPU, Overview, then the front doors this kind does not open on.
 */
export function buildAgentTabs({ agentKind, hasCode, advanced }: AgentTabsModel): AgentTab[] {
  const kind = kindOf(agentKind);
  const showAdvanced = advanced ?? advancedStartsOn(hasCode);
  const basic: AgentTabId[] = [FIRST_TAB[kind], "share", "sell", "settings"];
  const tabs: AgentTab[] = basic.map((id) => ({ id, label: LABELS[id], advanced: false }));
  if (showAdvanced) {
    for (const id of [...TECHNICAL, ...OTHER_DOORS[kind]]) {
      tabs.push({ id, label: LABELS[id], advanced: true });
    }
  }
  return tabs;
}

export interface ResolvedTab {
  /** The tab to open. */
  tab: AgentTabId;
  /** true when the tab is an advanced one and the switch is off: turn the switch on to show it. */
  turnOnAdvanced: boolean;
  /** The Advanced switch as it should stand once the tab is open. */
  advanced: boolean;
}

/**
 * The tab a link asks for (`?tab=logs`). An advanced tab opens and reports
 * that the Advanced switch must turn on. An older id opens the tab that
 * replaced it. An unknown id, or one this kind of agent does not have, opens
 * the first tab.
 */
export function resolveTab(requested: string | null | undefined, model: AgentTabsModel): ResolvedTab {
  const kind = kindOf(model.agentKind);
  const advanced = model.advanced ?? advancedStartsOn(model.hasCode);
  const all = buildAgentTabs({ ...model, advanced: true });

  let id = (requested ?? "").trim().toLowerCase();
  const former = Object.prototype.hasOwnProperty.call(FORMER_TAB_IDS, id) ? FORMER_TAB_IDS[id] : undefined;
  if (former) id = former;
  // The schedule lives on Runs for a self-running agent and on Schedule for the others.
  if (id === "schedule" && kind === "scheduled") id = "runs";
  else if (id === "runs" && kind !== "scheduled") id = "schedule";

  const found = all.find((tab) => tab.id === id);
  if (!found) return { tab: FIRST_TAB[kind], turnOnAdvanced: false, advanced };
  const turnOnAdvanced = found.advanced && !advanced;
  return { tab: found.id, turnOnAdvanced, advanced: advanced || found.advanced };
}

/** An agent carries code when it has source of its own: pasted, or at an address. */
export function agentCarriesCode(agent: { sourceCode?: string | null; sourceUrl?: string | null }): boolean {
  return Boolean(agent.sourceCode?.trim()) || Boolean(agent.sourceUrl?.trim());
}

/** Where the Advanced switch starts when nothing is remembered: on for agents that carry code. */
export function advancedStartsOn(hasCode: boolean): boolean {
  return hasCode;
}

/** What is written under `AGENT_ADVANCED_STORAGE_KEY`. */
export function storedAdvanced(advanced: boolean): string {
  return advanced ? "on" : "off";
}

/**
 * The switch when the page opens. A remembered choice ("on" or "off") is
 * kept; with none, or anything else in storage, it starts on for agents
 * that carry code and off for the rest.
 */
export function initialAdvanced(stored: string | null | undefined, hasCode: boolean): boolean {
  if (stored === "on") return true;
  if (stored === "off") return false;
  return advancedStartsOn(hasCode);
}

export interface AgentMoreLink {
  id: "builder" | "analytics" | "contributors";
  label: string;
  href: string;
}

/** The entries of the page's More menu: pages of the agent that are not tabs. */
export function agentMoreLinks(agentId: string): AgentMoreLink[] {
  const base = `/dashboard/agents/${encodeURIComponent(agentId)}`;
  return [
    { id: "builder", label: "Visual Builder", href: `${base}/builder` },
    { id: "analytics", label: "Analytics", href: `${base}/analytics` },
    { id: "contributors", label: "Contributors", href: `${base}/contributors` },
  ];
}

/** The label of the More menu's button. */
export const AGENT_MORE_LABEL = "More";
