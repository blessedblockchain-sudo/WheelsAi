/**
 * What the Share tab shows for each kind of agent. Run with:
 *   cd apps/web && npx tsx --test src/lib/agent-share.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_LINK_WORDS,
  addressPrefix,
  apiOrigin,
  buttonSnippet,
  codeCard,
  linkView,
  parseDailyCap,
  sampleTaskInput,
  shareCards,
  shareTabHref,
  switchOf,
  websiteCard,
  type ShareAgent,
  type ShareLink,
} from "./agent-share";

const here = dirname(fileURLToPath(import.meta.url));

const API = "https://api.wheels.example";
const WEB = "https://app.wheels.example";

const agent = (over: Partial<ShareAgent> = {}): ShareAgent => ({
  id: "0d6c3a52-9f3e-4a55-8a44-0b1a6f1f2c11",
  name: "Research Summarizer",
  slug: "research-summarizer",
  agentKind: "conversation",
  apiEndpoint: `${API}/v1/agents/research-summarizer/chat/completions`,
  openaiBaseUrl: `${API}/v1/agents/research-summarizer`,
  openaiModel: "agent/research-summarizer",
  kindConfig: null,
  ...over,
});

const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  state: "on",
  handle: "research-summarizer",
  url: `${WEB}/a/research-summarizer`,
  dailyCap: 100,
  usedToday: 12,
  showResults: false,
  toolsOffForVisitors: false,
  ...over,
});

const described = { agentKind: "conversation" as const, description: "Summarizes research papers." };

// ============================================
// The link: state to sentence
// ============================================

test("off: the explanation, one switch, nothing about limits", () => {
  const view = linkView(link({ state: "off", handle: null, url: null }), described);
  assert.equal(view.status, "Link is off");
  assert.equal(
    view.sentence,
    "Anyone with this link can use your agent. No sign-in needed. Their use counts toward your plan, each visitor is limited, and you can pause the link at any time.",
  );
  assert.deepEqual(view.actions, ["turn_on"]);
  assert.equal(view.turnOnLabel, "Turn link on");
  assert.equal(view.capLine, null);
  assert.equal(view.usedLine, null);
  assert.equal(view.askDescription, false);
});

test("on: the limit, today's count, and both pause and turn off", () => {
  const view = linkView(link(), described);
  assert.equal(view.status, "Link is on");
  assert.equal(view.capLine, "Up to 100 uses a day.");
  assert.equal(view.usedLine, "Used today: 12.");
  assert.deepEqual(view.actions, ["pause", "turn_off"]);

  assert.equal(linkView(link({ dailyCap: 100_000, usedToday: 1_234 }), described).capLine, "Up to 100,000 uses a day.");
  assert.equal(linkView(link({ dailyCap: 100_000, usedToday: 1_234 }), described).usedLine, "Used today: 1,234.");
  assert.equal(linkView(link({ dailyCap: 1 }), described).capLine, "Up to 1 use a day.");
  // A count that could not be read is said, never shown as zero.
  assert.equal(linkView(link({ usedToday: null }), described).usedLine, "Today's count is unavailable.");
});

test("paused: says so and offers to turn it back on", () => {
  const view = linkView(link({ state: "paused" }), described);
  assert.equal(view.status, "Link is paused");
  assert.equal(view.turnOnLabel, "Turn back on");
  assert.deepEqual(view.actions, ["turn_on", "turn_off"]);
  assert.equal(view.capLine, "Up to 100 uses a day.");
});

test("public with no way to use it yet: the plan's sentence and its button", () => {
  const view = linkView(link({ state: "view_only" }), described);
  assert.equal(view.status, null);
  assert.equal(view.sentence, "This agent's page is public, but visitors cannot use the agent from it yet.");
  assert.equal(view.turnOnLabel, "Let visitors use it.");
  assert.deepEqual(view.actions, ["turn_on", "turn_off"]);
  // A change of limit or address there is sent as "paused": with nothing to pause, nothing moves.
  assert.equal(switchOf("view_only"), "paused");
  assert.equal(switchOf("paused"), "paused");
  assert.equal(switchOf("on"), "on");
  assert.equal(switchOf("off"), "off");
  assert.equal(addressPrefix(link()), `${WEB}/a/`);
  assert.equal(addressPrefix(link({ url: null })), "/a/");
});

test("an agent with no description is asked for one line before the link goes on", () => {
  for (const description of [null, "", "   "]) {
    for (const state of ["off", "view_only", "paused"] as const) {
      assert.equal(linkView(link({ state }), { agentKind: "task", description }).askDescription, true, state);
    }
    // Already on: nothing stands in the way of what is working.
    assert.equal(linkView(link({ state: "on" }), { agentKind: "task", description }).askDescription, false);
  }
  assert.equal(PUBLIC_LINK_WORDS.describe, "Add one line that tells people what this agent does.");
});

test("the tools sentence shows only when a tool is withheld; results only for an agent that runs on its own", () => {
  assert.equal(linkView(link(), described).toolsLine, null);
  assert.equal(
    linkView(link({ toolsOffForVisitors: true }), described).toolsLine,
    "For visitors, tools that send requests out or read and save files are turned off.",
  );
  assert.equal(linkView(link(), { agentKind: "scheduled", description: "x" }).offerShowResults, true);
  assert.equal(linkView(link({ state: "paused" }), { agentKind: "scheduled", description: "x" }).offerShowResults, true);
  assert.equal(linkView(link({ state: "off" }), { agentKind: "scheduled", description: "x" }).offerShowResults, false);
  assert.equal(linkView(link(), { agentKind: "task", description: "x" }).offerShowResults, false);
  assert.equal(PUBLIC_LINK_WORDS.showResults, "Show its latest results on this page.");
});

test("a daily limit is a whole number from 1 to 100,000", () => {
  assert.deepEqual(parseDailyCap("250"), { ok: true, value: 250 });
  assert.deepEqual(parseDailyCap(" 100,000 "), { ok: true, value: 100_000 });
  for (const bad of ["", "0", "100001", "1.5", "-3", "many"]) {
    const result = parseDailyCap(bad);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.equal(result.message, "Choose a daily limit from 1 to 100,000 uses.");
  }
});

// ============================================
// Cards per kind
// ============================================

test("a chat agent: the chat box on a website, the OpenAI endpoint in code", () => {
  const cards = shareCards(agent(), link());
  assert.equal(cards.website.type, "chat_box");
  assert.deepEqual(
    cards.code.rows.map((row) => row.label),
    ["Endpoint", "OpenAI base URL", "Model id"],
  );
  assert.equal(cards.code.rows[0]!.value, `${API}/v1/agents/research-summarizer/chat/completions`);
  assert.match(cards.code.snippet!, /^curl https:\/\/api\.wheels\.example\/v1\/agents\/research-summarizer\/chat\/completions /);
  assert.equal(cards.code.webhookLine, null);
});

test("a task agent: a button that opens the public page, and the run route", () => {
  const task = agent({ agentKind: "task" });
  const cards = shareCards(task, link());
  assert.equal(cards.website.type, "button");
  if (cards.website.type === "button") {
    assert.equal(
      cards.website.snippet,
      `<a href="${WEB}/a/research-summarizer" target="_blank" rel="noopener">\n  Open Research Summarizer\n</a>`,
    );
  }
  assert.deepEqual(cards.code.rows, [{ label: "Run a task (POST)", value: `${API}/api/agents/${task.id}/run` }]);
  assert.match(cards.code.snippet!, new RegExp(`^curl -X POST ${API}/api/agents/${task.id}/run `));
  // The default form: one long-text question.
  assert.match(cards.code.snippet!, /"your_request": "Your answer"/);
  assert.match(cards.code.snippet!, /"stream": false/);
});

test("an agent that runs on its own: the same button, the schedule run, the runs list and the webhook event", () => {
  const scheduled = agent({ agentKind: "scheduled" });
  const cards = shareCards(scheduled, link());
  assert.equal(cards.website.type, "button");
  assert.deepEqual(cards.code.rows, [
    { label: "Run it now (POST)", value: `${API}/api/agents/${scheduled.id}/schedule/run` },
    { label: "Its runs (GET)", value: `${API}/api/agents/${scheduled.id}/runs` },
    { label: "Webhook event", value: "scheduled_task.completed" },
  ]);
  assert.equal(cards.code.webhookLine, "Every finished run is also sent to your webhooks.");
});

test("the button waits for the link to have an address", () => {
  const task = agent({ agentKind: "task" });
  for (const state of [null, link({ state: "off" }), link({ state: "off", handle: null, url: null }), link({ handle: null, url: null })]) {
    const card = websiteCard(task, state);
    assert.equal(card.type, "button");
    if (card.type === "button") {
      assert.equal(card.snippet, null);
      assert.equal(card.unavailable, "Turn the public link on to get a button for your website.");
    }
  }
  // On, with a handle, and the server does not know its own web address: no guessed one.
  const unknown = websiteCard(task, link({ url: null }));
  if (unknown.type === "button") {
    assert.equal(unknown.snippet, null);
    assert.match(unknown.unavailable!, /cannot be shown right now/);
  }
  // Paused and view-only pages exist, so the button is offered.
  for (const state of ["paused", "view_only"] as const) {
    const card = websiteCard(task, link({ state }));
    assert.ok(card.type === "button" && card.snippet !== null, state);
  }
});

test("a name cannot break out of the button's HTML", () => {
  const html = buttonSnippet(`${WEB}/a/x?a=1&b="2"`, `<script>"Bot" & co</script>`);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;&quot;Bot&quot; &amp; co&lt;\/script&gt;/);
  assert.match(html, /href="https:\/\/app\.wheels\.example\/a\/x\?a=1&amp;b=&quot;2&quot;"/);
});

test("a form's answers are sampled by their names in code, and survive a shell line", () => {
  const kindConfig = {
    task: {
      fields: [
        { key: "topic", label: "Topic", type: "short_text", required: true },
        { key: "tone", label: "Tone", type: "choice", required: false, options: ["It's formal", "Casual"] },
        { key: "words", label: "Words", type: "number", required: false },
        { key: "sources", label: "Sources", type: "list", required: false },
        { key: "cite", label: "Cite", type: "yes_no", required: false },
        { key: "page", label: "Page", type: "link", required: false },
      ],
    },
  };
  assert.deepEqual(sampleTaskInput(kindConfig), {
    topic: "Your answer",
    tone: "It's formal",
    words: 1,
    sources: ["First item", "Second item"],
    cite: true,
    page: "https://example.com",
  });
  const snippet = codeCard(agent({ agentKind: "task", kindConfig })).snippet!;
  assert.match(snippet, /It'\\''s formal/);
});

// ============================================
// Only addresses the server gave
// ============================================

function addressesIn(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>\\]+/g) ?? [];
}

function everyString(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(everyString);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(everyString);
  return [];
}

test("every address printed is one the server gave", () => {
  for (const agentKind of ["conversation", "task", "scheduled"] as const) {
    const cards = shareCards(agent({ agentKind }), link());
    const printed = everyString(cards).flatMap(addressesIn);
    assert.ok(printed.length > 0, agentKind);
    for (const address of printed) {
      // example.com is a sample answer inside a form, not an address of ours.
      assert.ok(
        address.startsWith(`${API}/`) || address.startsWith(`${WEB}/a/`) || address === "https://example.com",
        `${agentKind}: ${address}`,
      );
    }
  }
});

test("with no address from the server, none is made up: paths only, and a sentence that says so", () => {
  for (const agentKind of ["conversation", "task", "scheduled"] as const) {
    const cards = shareCards(agent({ agentKind, apiEndpoint: null, openaiBaseUrl: null }), link({ url: null }));
    const printed = everyString(cards).flatMap(addressesIn);
    assert.deepEqual(printed, [], agentKind);
    assert.equal(cards.code.snippet, null);
    assert.equal(cards.code.note, "The full address cannot be shown right now. These paths are on the WheelsAI API.");
    assert.ok(cards.code.rows[0]!.value.startsWith("/"), cards.code.rows[0]!.value);
  }
  // A host-relative endpoint is not an address either.
  assert.equal(apiOrigin("/v1/agents/x/chat/completions"), null);
  assert.equal(apiOrigin(null), null);
  assert.equal(apiOrigin(`${API}/v1/agents/x/chat/completions`), API);
  assert.equal(apiOrigin("https://example.org/base/v1/agents/x/chat/completions"), "https://example.org/base");
});

test("neither the pure file nor the tab reads the browser's address or the build's settings for an address", () => {
  const files = [join(here, "agent-share.ts"), join(here, "..", "components", "dashboard", "agent-tabs", "share-tab.tsx")];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /window\.location|location\.origin|location\.host|document\.location/, file);
    assert.doesNotMatch(source, /process\.env|API_BASE_URL|absoluteApiUrl/, file);
  }
});

test("the Share tab has an address other pages can link to", () => {
  assert.equal(shareTabHref("abc"), "/dashboard/agents/abc?tab=share");
});
