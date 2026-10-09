/**
 * What the Share tab of an agent shows, as plain data: the three cards (the
 * public link, a website, code) for each kind of agent, and the sentence for
 * each state of the public link.
 *
 * Pure, with one rule above the others: every address printed here was given
 * by the server (the agent's `apiEndpoint`, the public link's `url`). None
 * is built from the browser's own address or from this build's settings, so
 * a copied line is true wherever the dashboard happens to be open. When the
 * server gave no address, the path alone is shown and a sentence says so.
 */
import { taskFieldsOf, type AgentKind, type TaskField } from "@wheelsai/shared/agent-kind";

/** The fields of an agent this file reads (AgentDetail has them all). */
export interface ShareAgent {
  id: string;
  name: string;
  slug: string;
  agentKind: AgentKind;
  /** The agent's chat-completions URL as the API returned it; null when the API does not know its public address. */
  apiEndpoint: string | null;
  openaiBaseUrl: string | null;
  openaiModel: string;
  kindConfig?: unknown;
}

/** The fields of the public link this file reads (PublicLink has them all). */
export interface ShareLink {
  state: "off" | "view_only" | "on" | "paused";
  handle: string | null;
  url: string | null;
  dailyCap: number;
  usedToday: number | null;
  showResults: boolean;
  toolsOffForVisitors: boolean;
}

// ============================================
// The public link
// ============================================

export const PUBLIC_LINK_WORDS = {
  explanation:
    "Anyone with this link can use your agent. No sign-in needed. Their use counts toward your plan, each visitor is limited, and you can pause the link at any time.",
  on: "Link is on",
  paused: "Link is paused",
  off: "Link is off",
  viewOnly: "This agent's page is public, but visitors cannot use the agent from it yet.",
  letVisitorsUseIt: "Let visitors use it.",
  describe: "Add one line that tells people what this agent does.",
  toolsOff: "For visitors, tools that send requests out or read and save files are turned off.",
  showResults: "Show its latest results on this page.",
  change: "Change.",
  countUnavailable: "Today's count is unavailable.",
  membersOnly: "Only an owner or admin of your organization can change this link.",
  addressUnavailable: "The link's full address cannot be shown right now.",
} as const;

export const DAILY_CAP_MIN = 1;
export const DAILY_CAP_MAX = 100_000;

const number = (value: number) => value.toLocaleString("en-US");

export type LinkAction = "turn_on" | "pause" | "turn_off";

export interface LinkView {
  /** "Link is on", "Link is paused", "Link is off"; null while the page is public and not yet usable. */
  status: string | null;
  /** The sentence under the title for this state. */
  sentence: string;
  /** What the button that turns it on reads. */
  turnOnLabel: string;
  /** What an owner can do from here, in the order the buttons are drawn. */
  actions: LinkAction[];
  /** Ask for the one-line description before turning it on. */
  askDescription: boolean;
  /** "Up to 100 uses a day." Shown while the link has a page to limit. */
  capLine: string | null;
  /** "Used today: 12." */
  usedLine: string | null;
  /** The sentence about tools, when the agent has one that visitors do not get. */
  toolsLine: string | null;
  /** Whether "Show its latest results on this page." is offered. */
  offerShowResults: boolean;
}

/** What the link card shows for a link in this state. */
export function linkView(link: ShareLink, agent: { agentKind: AgentKind; description: string | null }): LinkView {
  const live = link.state === "on" || link.state === "paused";
  const actions: Record<ShareLink["state"], LinkAction[]> = {
    off: ["turn_on"],
    view_only: ["turn_on", "turn_off"],
    on: ["pause", "turn_off"],
    paused: ["turn_on", "turn_off"],
  };
  return {
    status:
      link.state === "on"
        ? PUBLIC_LINK_WORDS.on
        : link.state === "paused"
          ? PUBLIC_LINK_WORDS.paused
          : link.state === "off"
            ? PUBLIC_LINK_WORDS.off
            : null,
    sentence: link.state === "view_only" ? PUBLIC_LINK_WORDS.viewOnly : PUBLIC_LINK_WORDS.explanation,
    turnOnLabel:
      link.state === "view_only"
        ? PUBLIC_LINK_WORDS.letVisitorsUseIt
        : link.state === "paused"
          ? "Turn back on"
          : "Turn link on",
    actions: actions[link.state],
    askDescription: link.state !== "on" && !(agent.description ?? "").trim(),
    capLine: live ? `Up to ${number(link.dailyCap)} use${link.dailyCap === 1 ? "" : "s"} a day.` : null,
    usedLine: !live
      ? null
      : link.usedToday === null
        ? PUBLIC_LINK_WORDS.countUnavailable
        : `Used today: ${number(link.usedToday)}.`,
    toolsLine: link.toolsOffForVisitors ? PUBLIC_LINK_WORDS.toolsOff : null,
    offerShowResults: agent.agentKind === "scheduled" && live,
  };
}

/** The daily limit an owner typed, or the sentence that says why it cannot be saved. */
export function parseDailyCap(text: string): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = text.trim().replace(/,/g, "");
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(value) || value < DAILY_CAP_MIN || value > DAILY_CAP_MAX) {
    return { ok: false, message: `Choose a daily limit from ${number(DAILY_CAP_MIN)} to ${number(DAILY_CAP_MAX)} uses.` };
  }
  return { ok: true, value };
}

/**
 * The state to send with a change that is not the switch itself (the limit,
 * the address, whether results show): the state the link is already in. A
 * page that is public and not yet usable is sent as "paused", which for a
 * page with nothing to pause changes nothing.
 */
export function switchOf(state: ShareLink["state"]): "on" | "paused" | "off" {
  return state === "view_only" ? "paused" : state;
}

/** What comes before the handle in the link's address, taken from the address the server gave. */
export function addressPrefix(link: Pick<ShareLink, "handle" | "url">): string {
  if (link.url && link.handle && link.url.endsWith(`/a/${link.handle}`)) {
    return link.url.slice(0, link.url.length - link.handle.length);
  }
  return "/a/";
}

// ============================================
// On a website
// ============================================

export type WebsiteCard =
  | { type: "chat_box"; title: string; description: string }
  | {
      type: "button";
      title: string;
      description: string;
      /** The HTML to paste; null until the link has an address the server told us. */
      snippet: string | null;
      /** Why there is no snippet yet. */
      unavailable: string | null;
    };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A plain link that opens the agent's public page, as a small piece of HTML. */
export function buttonSnippet(url: string, agentName: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">\n  Open ${escapeHtml(agentName)}\n</a>`;
}

export function websiteCard(agent: ShareAgent, link: ShareLink | null): WebsiteCard {
  if (agent.agentKind === "conversation") {
    return {
      type: "chat_box",
      title: "On a website",
      description: "Put a chat box for this agent on your own site. Create a key, list the sites that may use it, and paste the snippet.",
    };
  }
  const title = "On a website";
  const description = "A button for your site that opens this agent's public page.";
  if (!link || link.state === "off" || !link.handle) {
    return { type: "button", title, description, snippet: null, unavailable: "Turn the public link on to get a button for your website." };
  }
  if (!link.url) {
    return {
      type: "button",
      title,
      description,
      snippet: null,
      unavailable: `${PUBLIC_LINK_WORDS.addressUnavailable} The button appears here once it can.`,
    };
  }
  return { type: "button", title, description, snippet: buttonSnippet(link.url, agent.name), unavailable: null };
}

// ============================================
// Use from code
// ============================================

export interface CodeRow {
  label: string;
  value: string;
}

export interface CodeCard {
  title: string;
  description: string;
  rows: CodeRow[];
  /** A curl call to copy; null when the server gave no address to call. */
  snippet: string | null;
  /** Said when an address could not be shown in full. */
  note: string | null;
  /** The sentence about webhooks, for an agent that runs on its own. */
  webhookLine: string | null;
}

/**
 * The API's own origin, read out of the endpoint the server returned for
 * this agent. null when it returned none, or anything that is not an
 * absolute http(s) address.
 */
export function apiOrigin(apiEndpoint: string | null): string | null {
  if (!apiEndpoint || !/^https?:\/\//i.test(apiEndpoint)) return null;
  const marker = apiEndpoint.indexOf("/v1/");
  if (marker > 0) return apiEndpoint.slice(0, marker);
  try {
    return new URL(apiEndpoint).origin;
  } catch {
    return null;
  }
}

function sampleAnswer(field: TaskField): unknown {
  switch (field.type) {
    case "number":
      return 1;
    case "yes_no":
      return true;
    case "choice":
      return field.options?.[0] ?? "";
    case "link":
      return "https://example.com";
    case "list":
      return ["First item", "Second item"];
    default:
      return "Your answer";
  }
}

/** One answer for each question of the agent's form, by its name in code. */
export function sampleTaskInput(kindConfig: unknown): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of taskFieldsOf(kindConfig)) input[field.key] = sampleAnswer(field);
  return input;
}

/** JSON inside single quotes on a shell line. */
function shellJson(value: unknown): string {
  return `'${JSON.stringify(value, null, 2).replace(/'/g, `'\\''`)}'`;
}

const PATH_ONLY_NOTE = "The full address cannot be shown right now. These paths are on the WheelsAI API.";

export function codeCard(agent: ShareAgent): CodeCard {
  const origin = apiOrigin(agent.apiEndpoint);
  const title = "Use from code";

  if (agent.agentKind === "task") {
    const path = `/api/agents/${agent.id}/run`;
    const input = sampleTaskInput(agent.kindConfig);
    return {
      title,
      description: "Send the form's answers and get one result back. A run counts as one API call on your plan.",
      rows: [{ label: "Run a task (POST)", value: `${origin ?? ""}${path}` }],
      snippet: origin
        ? `curl -X POST ${origin}${path} \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d ${shellJson({ input, stream: false })}`
        : null,
      note: origin ? null : PATH_ONLY_NOTE,
      webhookLine: null,
    };
  }

  if (agent.agentKind === "scheduled") {
    const run = `/api/agents/${agent.id}/schedule/run`;
    const runs = `/api/agents/${agent.id}/runs`;
    return {
      title,
      description: "Start a run from your own code, read what it produced, and get each finished run on a webhook.",
      rows: [
        { label: "Run it now (POST)", value: `${origin ?? ""}${run}` },
        { label: "Its runs (GET)", value: `${origin ?? ""}${runs}` },
        { label: "Webhook event", value: "scheduled_task.completed" },
      ],
      snippet: origin
        ? `curl -X POST ${origin}${run} \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY"

curl ${origin}${runs} \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY"`
        : null,
      note: origin ? null : PATH_ONLY_NOTE,
      webhookLine: "Every finished run is also sent to your webhooks.",
    };
  }

  // A chat agent: its OpenAI-compatible endpoint, exactly as the API returned it.
  if (!agent.apiEndpoint || !agent.openaiBaseUrl) {
    return {
      title,
      description: "Any OpenAI client can talk to this agent. A chat completion counts as one API call on your plan.",
      rows: [
        { label: "Endpoint", value: `/v1/agents/${agent.slug}/chat/completions` },
        { label: "Model id", value: agent.openaiModel },
      ],
      snippet: null,
      note: PATH_ONLY_NOTE,
      webhookLine: null,
    };
  }
  return {
    title,
    description: "Any OpenAI client can talk to this agent. A chat completion counts as one API call on your plan.",
    rows: [
      { label: "Endpoint", value: agent.apiEndpoint },
      { label: "OpenAI base URL", value: agent.openaiBaseUrl },
      { label: "Model id", value: agent.openaiModel },
    ],
    snippet: `curl ${agent.apiEndpoint} \\
  -H "Authorization: Bearer $WHEELSAI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d ${shellJson({ messages: [{ role: "user", content: "Hello!" }] })}`,
    note: null,
    webhookLine: null,
  };
}

// ============================================
// The three cards
// ============================================

export interface ShareCards {
  website: WebsiteCard;
  code: CodeCard;
}

/** The website and code cards of an agent; the link card is drawn from linkView. */
export function shareCards(agent: ShareAgent, link: ShareLink | null): ShareCards {
  return { website: websiteCard(agent, link), code: codeCard(agent) };
}

/** Where the Share tab of an agent is, for a link from elsewhere in the dashboard. */
export function shareTabHref(agentId: string): string {
  return `/dashboard/agents/${agentId}?tab=share`;
}
