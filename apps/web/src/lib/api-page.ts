/**
 * The API page of a listing, `/a/<handle>/api`: what someone who calls a paid
 * agent from code reads before they write a line. Where to send a request,
 * the model id, three snippets, what a use costs, the plans, the limits for
 * one buyer, the usage headers of an answer and the refusals a caller can
 * meet.
 *
 * Pure: the page passes what `GET /api/a/:handle/api` said and draws what
 * comes back. Every number here was sent by the API, the plans are worded by
 * the file that words them on the agent's page, and each refusal says the
 * API's own sentence.
 *
 * Never said here: how many people use the agent, what it runs on, anything
 * of the organization that sells it, or a count that has no end.
 */
import type { AgentApiEndpoint, AgentApiPage, MarketplaceListing, PlanOffer, PublicAgentDetail } from "./api";
import { SPEND_SCOPES } from "./jobs";
import { PAID_USE_MESSAGES, agentPagePath, priceLine, type PaidPrice } from "./paid-use";
import { API_KEY_ENV, paidAgentChatSnippets, paidAgentRunSnippets, type PaidAgentSnippets } from "./public-urls";
import { payAsYouGoLine, planAfterLine, planPriceLine, planUsesLine, plansOf } from "./use-plans";

// ============================================
// Words
// ============================================

/**
 * What the keys page calls the choice that lets a key pay for a paid agent.
 * Read from the file that words that page, so the two cannot drift apart.
 */
const PAYING_CHOICE = SPEND_SCOPES.find((option) => option.scope === "agents:use")?.label;

export const API_PAGE_WORDS = {
  /** The link to this page, on the agent's page and on the marketplace's listing page. */
  link: "Use it from code",
  createKey: "Create a key",
  oneKey: "One key and one balance work for every listing you use.",
  keyNote: `Each snippet reads your key from the ${API_KEY_ENV} environment variable.`,
  /** A key pays for a use only when it was given that choice by name, with its two caps. */
  keyScope: PAYING_CHOICE
    ? `When you create the key, turn on "${PAYING_CHOICE}" and set its two spending caps. A key without it cannot pay for a use.`
    : "When you create the key, let it pay for paid agents and set its two spending caps. A key without that cannot pay for a use.",
  /** A caller who never started on the agent's page is refused. Followed by the link to that page. */
  startFirst: "Start using the agent on its page before your first call.",
  /** Said of an agent that does one task from a form. */
  taskNote:
    "This agent does one task from a form. It is called at its own run address with the answers to its form, not by a chat completion.",
  taskForm: "Send one answer for each question of its form, by the question's name. The questions are on the agent's page.",
  /** Said under a price per use. */
  perUseNote: `${PAID_USE_MESSAGES.paidFromCredits} You are charged only for an answer that was delivered.`,
  /** Said under a price by the month. */
  monthlyNote: "Subscribe on the agent's page. Calls inside a month you paid for cost nothing more.",
  /** Said under the plans: this page starts nothing. */
  startPlan: "A plan is started on the agent's page.",
  /** The link back to the agent's own page. */
  agentPage: "The agent's page",
  otherAddresses: "Other addresses of this agent",
  headersAlways: "Every paid answer carries these headers.",
  headersOnPlan: "An answer on a plan adds these.",
  notFoundTitle: "Agent not found",
  notFound: "This agent doesn't exist or isn't public.",
  loadFailed: "Couldn't load this page",
} as const;

/** The headings of the page's parts, in the order they are drawn. */
export const API_PAGE_HEADINGS = {
  call: "Call it",
  price: "Price",
  plans: "Plans",
  limits: "Limits",
  headers: "Usage headers",
  refusals: "When a request is refused",
  key: "Your key",
} as const;

/** "Translator API": the page's title, on the page and in the browser's tab. */
export function apiPageTitle(name: string): string {
  return `${name.trim()} API`;
}

/** What a shared link to the page says under its title. */
export function apiPageSummary(name: string): string {
  return `Call ${name.trim()} from your own code: the address, the price, the plans and the limits.`;
}

// ============================================
// Where the page is, and who is sent to it
// ============================================

/** The API page of the agent at this handle. */
export function apiPagePath(handle: string): string {
  return `${agentPagePath(handle)}/api`;
}

/** The dashboard's keys page. */
const KEYS_PATH = "/dashboard/keys";

/**
 * Where "Create a key" goes. Someone signed out goes through sign-in and
 * lands on the keys page after it, as the agent's page sends people to sign
 * in. While it is not yet known who is there (null) the keys page itself:
 * the dashboard asks a signed-out visitor to sign in on its own.
 */
export function createKeyHref(authed: boolean | null): string {
  return authed === false ? `/login?next=${encodeURIComponent(KEYS_PATH)}` : KEYS_PATH;
}

/** Only an agent that is called has an API page: one that answers messages, or one that does a task. */
function isCalled(agentKind: unknown): boolean {
  return agentKind === "conversation" || agentKind === "task";
}

/**
 * The API page of an agent, from its public page; null when it has none.
 * Only an agent whose use is sold at a price has one, and a self-running
 * agent answers no call. The same rule the API answers its 404 by.
 */
export function apiPageHrefOfAgent(detail: Pick<PublicAgentDetail, "agent" | "use"> | null | undefined): string | null {
  if (!detail || detail.use?.state !== "paid" || !detail.use.paid) return null;
  const { handle, agentKind } = detail.agent;
  if (typeof handle !== "string" || handle === "" || !isCalled(agentKind)) return null;
  return apiPagePath(handle);
}

/**
 * The same from a marketplace listing: one that sells use, per use or by the
 * month, of an agent that has a public page and is called.
 */
export function apiPageHrefOfListing(
  listing: Pick<MarketplaceListing, "sells" | "pricingModel" | "agent"> | null | undefined,
): string | null {
  if (!listing || listing.sells !== "use") return null;
  if (listing.pricingModel !== "per_request" && listing.pricingModel !== "monthly") return null;
  const agent = listing.agent;
  // A row that does not say the agent is public is not linked: the page may not exist.
  if (!agent || agent.isPublic !== true || !isCalled(agent.agentKind)) return null;
  if (typeof agent.handle !== "string" || agent.handle === "") return null;
  return apiPagePath(agent.handle);
}

// ============================================
// What the API said
// ============================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * Whether a body read from the API is the page's own shape. Anything else is
 * treated as a failed read, never drawn in part.
 */
export function isAgentApiPage(body: unknown): body is AgentApiPage {
  if (!isRecord(body)) return false;
  if (!isText(body.handle) || !isText(body.name) || !isCalled(body.agentKind)) return false;
  if (!Array.isArray(body.endpoints) || !Array.isArray(body.plans) || !Array.isArray(body.refusals)) return false;
  if (typeof body.priceCents !== "number" || !isText(body.unit) || !isText(body.pricingModel)) return false;
  if (!isRecord(body.limits) || !isRecord(body.usageHeaders)) return false;
  return Array.isArray(body.usageHeaders.always) && Array.isArray(body.usageHeaders.onPlan);
}

// ============================================
// The parts of the page
// ============================================

/** One snippet, in its own box with its own copy button. */
export interface ApiPageSnippet {
  id: "curl" | "javascript" | "python";
  /** Shown on the box, and read out by its copy button. */
  label: string;
  code: string;
}

/** An address beside the one the snippets call. */
export interface ApiPageEndpoint {
  id: AgentApiEndpoint["use"];
  /** "POST https://api.example.com/api/a/translator/chat" */
  line: string;
  says: string;
}

/** A plan as the agent's page words it. */
export interface ApiPagePlan {
  id: string;
  name: string;
  /** "$9.00 for 30 days" */
  price: string;
  /** "500 uses" */
  uses: string;
  /** "then $0.04 a use", or "then it stops until it renews" */
  after: string;
}

export interface ApiPageHeader {
  name: string;
  /** What the header says, in one sentence. Null for a name this page has no sentence for: the name alone is shown. */
  says: string | null;
}

export interface ApiPageRefusal {
  status: number;
  /** The code a caller reads in the answer's body. Drawn as code, beside the sentence and never inside it. */
  code: string;
  /** The API's own sentence. */
  message: string;
}

export interface ApiPageView {
  /** "Translator API" */
  title: string;
  intro: string;
  /** The agent's own page. */
  agentHref: string;
  /** `chat`: called by a chat completion. `task`: run from its form's answers at its own address. */
  kind: "chat" | "task";
  /** The base address requests are sent to. */
  address: string;
  /** "model: a/translator". Null for a task, which names no model. */
  modelLine: string | null;
  /** "POST https://api.example.com/v1/chat/completions": what the snippets call. */
  callLine: string;
  /** For a task: that it is not called by a chat completion, and what to send. Empty for a chat. */
  callNotes: string[];
  snippets: ApiPageSnippet[];
  keyNote: string;
  /** The other addresses of this agent, each with what it is for. */
  otherEndpoints: ApiPageEndpoint[];
  /** "$0.05 per message" or "$9.00 a month". With plans it is said after them, in `payAsYouGo`. */
  priceLine: string | null;
  priceNote: string;
  plans: ApiPagePlan[];
  /** "Or pay as you go: $0.05 a message", after the plans. Null with no plans. */
  payAsYouGo: string | null;
  /** The limits for one buyer, a sentence each. */
  limits: string[];
  headers: { always: ApiPageHeader[]; onPlan: ApiPageHeader[] };
  refusals: ApiPageRefusal[];
  oneKey: string;
  /** What to turn on when the key is made, so that it can pay. */
  keyScope: string;
  /** That the agent is started on its own page first. */
  startFirst: string;
  createKeyLabel: string;
}

/** What each usage header says. The names are the API's (services/usageHeaders.ts). */
const HEADER_SENTENCES: Record<string, string> = {
  "x-wheelsai-charged-cents": "What this use cost, in cents. 0 for a use your plan or your subscription includes.",
  "x-wheelsai-balance-cents": "Your credits after this use, in cents.",
  "x-wheelsai-plan": "The id of the plan you are on.",
  "x-wheelsai-plan-limit": "The uses your plan gives you in its current 30 days.",
  "x-wheelsai-plan-used": "The uses taken so far.",
  "x-wheelsai-plan-remaining": "The uses left.",
  "x-wheelsai-plan-reset": "When the count starts again, as an ISO time. Left out when the plan will not renew.",
  "x-wheelsai-plan-warning": "85 when 85% of the plan is used, 100 when all of it is. Left out below 85%.",
};

/** What each address beside the called one is for. */
const ENDPOINT_SENTENCES: Record<AgentApiEndpoint["use"], string> = {
  openai: "OpenAI's chat completions, with the model id above.",
  chat: "The same conversation in WheelsAI's own shape.",
  run: "One run of the task, from the answers to its form.",
  access: "Where you stand: your plan and your credits. Reading it costs nothing.",
};

function headersOf(names: unknown): ApiPageHeader[] {
  if (!Array.isArray(names)) return [];
  return names.filter(isText).map((name) => ({ name, says: HEADER_SENTENCES[name] ?? null }));
}

function refusalsOf(raw: unknown): ApiPageRefusal[] {
  if (!Array.isArray(raw)) return [];
  const rows: ApiPageRefusal[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { status, code, message } = item;
    if (typeof status !== "number" || !Number.isInteger(status) || !isText(code) || !isText(message)) continue;
    rows.push({ status, code, message: message.trim() });
  }
  return rows;
}

const isLimit = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * The limits for one buyer, a sentence each. A plan's holder is held to the
 * plan's count in place of the day's limit, which is said only of a listing
 * that offers plans. A limit the API did not send is not said.
 */
export function limitLines(limits: Partial<AgentApiPage["limits"]> | null | undefined, hasPlans: boolean): string[] {
  const lines: string[] = [];
  if (isLimit(limits?.perMinute)) lines.push(`One buyer can send up to ${limits.perMinute} requests a minute.`);
  if (isLimit(limits?.perDayWithoutPlan)) {
    lines.push(
      hasPlans
        ? `A buyer on no plan can send up to ${limits.perDayWithoutPlan} requests a day. On a plan, the plan's count of uses takes the place of the daily limit.`
        : `One buyer can send up to ${limits.perDayWithoutPlan} requests a day.`,
    );
  }
  return lines;
}

function planRow(plan: PlanOffer): ApiPagePlan {
  return {
    id: plan.id,
    name: plan.name.trim(),
    price: planPriceLine(plan),
    uses: planUsesLine(plan),
    after: planAfterLine(plan),
  };
}

function snippetRows(snippets: PaidAgentSnippets): ApiPageSnippet[] {
  return [
    { id: "curl", label: "curl", code: snippets.curl },
    { id: "javascript", label: "JavaScript", code: snippets.javascript },
    { id: "python", label: "Python", code: snippets.python },
  ];
}

/**
 * The page, from the API's answer. `apiBase` is the address this app reached
 * the API at, used when the answer names no public address of its own.
 *
 * Null when the answer names nothing to call (a conversation with no model
 * id, a task with no run address): the page is then shown as not found, and
 * never with a snippet that calls something the API did not say.
 */
export function apiPageView(page: AgentApiPage, apiBase: string): ApiPageView | null {
  const address = (isText(page.baseUrl) ? page.baseUrl : apiBase).trim().replace(/\/+$/, "");
  const endpoints = Array.isArray(page.endpoints) ? page.endpoints.filter((endpoint) => isRecord(endpoint) && isText(endpoint.path)) : [];
  const at = (endpoint: AgentApiEndpoint) => `${address}${endpoint.path.startsWith("/") ? "" : "/"}${endpoint.path}`;

  let kind: ApiPageView["kind"];
  let called: AgentApiEndpoint | undefined;
  let snippets: PaidAgentSnippets;
  if (page.agentKind === "task") {
    called = endpoints.find((endpoint) => endpoint.use === "run");
    if (!called) return null;
    kind = "task";
    snippets = paidAgentRunSnippets({ baseUrl: address, path: called.path });
  } else {
    called = endpoints.find((endpoint) => endpoint.use === "openai");
    if (!called || !isText(page.model)) return null;
    kind = "chat";
    snippets = paidAgentChatSnippets({ baseUrl: address, model: page.model });
  }

  const name = page.name.trim();
  const monthly = page.pricingModel === "monthly";
  const price: PaidPrice = monthly
    ? { model: "monthly", cents: page.priceCents, unit: "month" }
    : { model: "per_request", cents: page.priceCents, unit: page.unit === "run" ? "run" : "message" };
  // A listing sold by the month offers no plan, whatever came with it.
  const plans = monthly ? [] : plansOf(page.plans);

  return {
    title: apiPageTitle(name),
    intro:
      kind === "chat"
        ? `Call ${name} from your own code. It answers through OpenAI's chat completions, so an OpenAI client works with it as it is.`
        : `Call ${name} from your own code. Send the answers to its form and get the result back.`,
    agentHref: agentPagePath(page.handle),
    kind,
    address,
    modelLine: kind === "chat" ? `model: ${page.model}` : null,
    callLine: `${called.method} ${snippets.endpointUrl}`,
    callNotes: kind === "task" ? [API_PAGE_WORDS.taskNote, API_PAGE_WORDS.taskForm] : [],
    snippets: snippetRows(snippets),
    keyNote: API_PAGE_WORDS.keyNote,
    otherEndpoints: endpoints
      .filter((endpoint) => endpoint !== called && endpoint.use in ENDPOINT_SENTENCES)
      .map((endpoint) => ({ id: endpoint.use, line: `${endpoint.method} ${at(endpoint)}`, says: ENDPOINT_SENTENCES[endpoint.use] })),
    priceLine: plans.length > 0 ? null : priceLine(price),
    priceNote: monthly ? API_PAGE_WORDS.monthlyNote : API_PAGE_WORDS.perUseNote,
    plans: plans.map(planRow),
    payAsYouGo: plans.length > 0 ? payAsYouGoLine(price) : null,
    limits: limitLines(page.limits, plans.length > 0),
    headers: { always: headersOf(page.usageHeaders?.always), onPlan: monthly ? [] : headersOf(page.usageHeaders?.onPlan) },
    refusals: refusalsOf(page.refusals),
    oneKey: API_PAGE_WORDS.oneKey,
    keyScope: API_PAGE_WORDS.keyScope,
    startFirst: API_PAGE_WORDS.startFirst,
    createKeyLabel: API_PAGE_WORDS.createKey,
  };
}
