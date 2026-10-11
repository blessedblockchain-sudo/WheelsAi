/**
 * The warning at Stop and the words of a paused listing. Run with:
 *   cd apps/web && npx tsx --test src/lib/listing-pause.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { DeploymentDependents, PaidUseRefusal } from "./api";
import {
  AGENT_PAUSED_MESSAGE,
  LISTING_PAUSED_START_MESSAGE,
  PAUSED_RECHECK_MS,
  PUBLIC_PAUSED_NOTICE,
  SELL_PAUSED_NOTICE,
  STOP_WARNING_WORDS,
  accessIsPaused,
  listingIsPaused,
  stopWarning,
  stopWarningLead,
  stopWarningOnSale,
} from "./listing-pause";
import { PAID_REFUSAL_RULES, paidRefusalNotice } from "./paid-use";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, "..", path), "utf8");

type Dependent = DeploymentDependents["agents"][number];
const agent = (name: string, onSale = false): Dependent => ({
  id: `id-${name}`,
  name,
  onSale,
  listing: onSale ? { id: `l-${name}`, title: name, pricingModel: "monthly", subscribers: 2 } : null,
});

const KEEP = "People who pay monthly keep the days they paid for.";

// ============================================
// The dialog at Stop
// ============================================

test("with no agent answering from the deployment nothing is asked", () => {
  assert.equal(stopWarning({ agents: [] }), null);
});

test("one agent: the line speaks of one, names it, and has the two buttons", () => {
  const warning = stopWarning({ agents: [agent("Support Bot")] });
  assert.deepEqual(warning, {
    title: "Stop this deployment?",
    lead: "1 agent answers from this deployment and will stop answering until you deploy this model again or give it another model:",
    names: ["Support Bot"],
    onSale: null,
    confirmLabel: "Stop deployment",
    cancelLabel: "Keep it running",
  });
});

test("several agents: the line counts them and names each, in the API's order", () => {
  const warning = stopWarning({ agents: [agent("Support Bot"), agent("Researcher"), agent("Billing Helper")] });
  assert.equal(
    warning?.lead,
    "3 agents answer from this deployment and will stop answering until you deploy this model again or give them another model:",
  );
  assert.deepEqual(warning?.names, ["Support Bot", "Researcher", "Billing Helper"]);
  assert.equal(warning?.onSale, null);
  assert.equal(
    stopWarningLead(2),
    "2 agents answer from this deployment and will stop answering until you deploy this model again or give them another model:",
  );
});

test("one agent on sale: one more line, about its listing", () => {
  const warning = stopWarning({ agents: [agent("Support Bot", true), agent("Researcher")] });
  assert.equal(
    warning?.onSale,
    `On sale: Support Bot. Its listing is paused while it cannot answer: nobody can start using it and nobody is charged. ${KEEP}`,
  );
  // The agent that is not on sale is named among those that stop answering, and not among those on sale.
  assert.deepEqual(warning?.names, ["Support Bot", "Researcher"]);
  assert.doesNotMatch(warning?.onSale ?? "", /Researcher/);
});

test("several agents on sale: the line names each and speaks of their listings", () => {
  const warning = stopWarning({ agents: [agent("Support Bot", true), agent("Researcher"), agent("Billing Helper", true)] });
  assert.equal(
    warning?.onSale,
    `On sale: Support Bot, Billing Helper. Their listings are paused while they cannot answer: nobody can start using them and nobody is charged. ${KEEP}`,
  );
  assert.equal(stopWarningOnSale([]), null);
});

test("only `onSale: true` puts an agent on the sale line, whatever else the row carries", () => {
  const row = { ...agent("Support Bot"), listing: { id: "l", title: "Support Bot", pricingModel: "free", subscribers: 0 } };
  assert.equal(stopWarning({ agents: [row] })?.onSale, null);
});

test("an agent with a blank name is still counted and still named", () => {
  const warning = stopWarning({ agents: [agent("  "), agent("Researcher")] });
  assert.match(warning?.lead ?? "", /^2 agents answer /);
  assert.deepEqual(warning?.names, ["Unnamed agent", "Researcher"]);
});

test("when the agents cannot be read the dialog still opens, says so, and keeps the two buttons", () => {
  for (const unread of [null, {} as DeploymentDependents, { agents: "x" } as unknown as DeploymentDependents]) {
    assert.deepEqual(stopWarning(unread), {
      title: "Stop this deployment?",
      lead: "We could not check which agents answer from this deployment. Agents set to its model will stop answering when it stops.",
      names: [],
      onSale: null,
      confirmLabel: "Stop deployment",
      cancelLabel: "Keep it running",
    });
  }
  assert.equal(STOP_WARNING_WORDS.cancel, "Keep it running");
});

// ============================================
// The two notices
// ============================================

test("the Sell tab's notice, and where its link goes", () => {
  assert.equal(
    SELL_PAUSED_NOTICE.message,
    "Paused. The model this agent runs on is not running, so nobody can start using it and nobody is charged. People who pay monthly keep the days they paid for. It goes back on sale by itself when the model runs again.",
  );
  assert.deepEqual(SELL_PAUSED_NOTICE.action, { label: "Deploy a model", href: "/dashboard/deployments/new" });
});

test("the public page's notice", () => {
  assert.equal(
    PUBLIC_PAUSED_NOTICE,
    "This agent is paused right now. Nobody is charged while it is paused, and a month already paid for is made longer by that time. Try again later.",
  );
});

test("a listing is paused when my-listings says so, with or without a time; null and absent are not a pause", () => {
  assert.equal(listingIsPaused({ paused: { since: "2026-10-11T09:00:00.000Z" } }), true);
  assert.equal(listingIsPaused({ paused: { since: null } }), true);
  assert.equal(listingIsPaused({ paused: null }), false);
  assert.equal(listingIsPaused({}), false);
  assert.equal(listingIsPaused(null), false);
});

test("the access view pauses the page only with `paused: true`", () => {
  assert.equal(accessIsPaused({ paused: true }), true);
  assert.equal(accessIsPaused({ paused: false }), false);
  assert.equal(accessIsPaused({}), false);
  assert.equal(accessIsPaused(null), false);
  assert.equal(accessIsPaused({ paused: "true" } as unknown as { paused?: boolean }), false);
});

test("no sentence here has an em dash", () => {
  const all = [
    ...Object.values(STOP_WARNING_WORDS),
    stopWarningLead(1),
    stopWarningLead(4),
    stopWarningOnSale(["A"]) ?? "",
    stopWarningOnSale(["A", "B"]) ?? "",
    SELL_PAUSED_NOTICE.message,
    PUBLIC_PAUSED_NOTICE,
    AGENT_PAUSED_MESSAGE,
    LISTING_PAUSED_START_MESSAGE,
  ];
  for (const sentence of all) assert.doesNotMatch(sentence, /[–—]/, sentence);
});

// ============================================
// The two refusals
// ============================================

const refusal = (error: string, message = ""): PaidUseRefusal => ({ error, message });

test("agent_paused and listing_paused are shown with the API's own sentence, and offer nothing to press", () => {
  const used = paidRefusalNotice({
    status: 503,
    refusal: refusal("agent_paused", "This agent is paused right now. Nothing was charged."),
    act: "chat",
    unit: "message",
  });
  assert.equal(used.code, "agent_paused");
  assert.equal(used.message, "This agent is paused right now. Nothing was charged.");
  assert.deepEqual(used.action, { kind: "wait", label: null });
  assert.equal(used.refundedCents, null);

  const started = paidRefusalNotice({
    status: 409,
    refusal: refusal(
      "listing_paused",
      "This agent is paused right now, so nothing was started and nothing was charged. Try again later.",
    ),
    act: "start",
    unit: "message",
  });
  assert.equal(started.code, "listing_paused");
  assert.equal(
    started.message,
    "This agent is paused right now, so nothing was started and nothing was charged. Try again later.",
  );
  assert.deepEqual(started.action, { kind: "wait", label: null });
});

test("without a sentence from the API, each of the two says its own", () => {
  assert.equal(AGENT_PAUSED_MESSAGE, "This agent is paused right now. Nothing was charged.");
  assert.equal(
    LISTING_PAUSED_START_MESSAGE,
    "This agent is paused right now, so nothing was started and nothing was charged. Try again later.",
  );
  assert.equal(PAID_REFUSAL_RULES.agent_paused?.fallback, AGENT_PAUSED_MESSAGE);
  assert.equal(PAID_REFUSAL_RULES.listing_paused?.fallback, LISTING_PAUSED_START_MESSAGE);
  for (const act of ["chat", "task"] as const) {
    assert.equal(
      paidRefusalNotice({ status: 503, refusal: refusal("agent_paused"), act, unit: "run" }).message,
      AGENT_PAUSED_MESSAGE,
    );
  }
  assert.equal(
    paidRefusalNotice({ status: 409, refusal: refusal("listing_paused"), act: "start", unit: "message" }).message,
    LISTING_PAUSED_START_MESSAGE,
  );
});

// ============================================
// How the pages use them
// ============================================

test("both Stop buttons ask first, stop only on a yes, and cannot fire twice", () => {
  for (const path of ["app/(dashboard)/dashboard/deployments/[id]/page.tsx", "app/(dashboard)/dashboard/deployments/page.tsx"]) {
    const page = source(path);
    const stop = page.slice(page.indexOf("async function handleStop"), page.indexOf("return (", page.indexOf("async function handleStop")));
    const guard = stop.indexOf("if (stoppingRef.current) return;");
    const ask = stop.indexOf("if (!(await confirmStopDeployment(");
    const act = stop.indexOf("deploymentsApi.delete(");
    assert.ok(guard >= 0 && ask > guard && act > ask, `${path}: guard, then the question, then the stop`);
    assert.match(stop, /finally \{\s*stoppingRef\.current = false;/, `${path}: the guard is released whatever happened`);
    assert.match(page, /useConfirm\(\)/, `${path}: the app's own dialog`);
  }
});

test("the question at Stop reads the dependents, opens on a failed read, and uses the helper's words", () => {
  const asked = source("components/dashboard/stop-deployment-warning.tsx");
  assert.match(asked, /deploymentsApi\.dependents\(deploymentId\)/);
  assert.match(asked, /catch \{\s*dependents = null;/);
  assert.match(asked, /stopWarning\(dependents\)/);
  assert.match(asked, /if \(!warning\) return true;/);
  assert.match(asked, /confirmLabel: warning\.confirmLabel/);
  assert.match(asked, /cancelLabel: warning\.cancelLabel/);
  assert.doesNotMatch(asked, /window\.confirm|[^.\w]confirm\(\s*["'`]/);
  const api = source("lib/api.ts");
  assert.match(api, /dependents: \(id: string\) =>\s*api<DeploymentDependents>\(`\/api\/deployments\/\$\{id\}\/dependents`\)/);
});

test("the Sell tab says a paused listing first, with the link to deploy a model", () => {
  const tab = source("components/dashboard/agent-tabs/sell-tab.tsx");
  assert.match(tab, /listingIsPaused\(listing\)/);
  assert.match(tab, /SELL_PAUSED_NOTICE\.message/);
  assert.match(tab, /href=\{SELL_PAUSED_NOTICE\.action\.href\}/);
  // Top of the tab in both of its shapes: before the status card, and before the question.
  assert.match(tab, /<div className="space-y-6">\s*\{pausedNotice\}/);
  assert.match(tab, /<CardContent className="space-y-5 py-6">\s*\{pausedNotice\}/);
});

test("the public page shows the pause in place of the gate, holds sends back, and disables sending", () => {
  const gate = source("components/public-agent/paid-gate.tsx");
  assert.match(gate, /const paused = signedIn && accessIsPaused\(access\);/);
  assert.match(gate, /\) : paused \? \([\s\S]*?\{PUBLIC_PAUSED_NOTICE\}[\s\S]*?\) : \(\s*<>\s*<p className="break-words text-foreground">\{view\.sentence\}<\/p>/);
  assert.match(gate, /if \(live\.current\.paused\) \{\s*return \{ message: AGENT_PAUSED_MESSAGE/);
  assert.equal(gate.match(/sendDisabled=\{paused\}/g)?.length, 2);
  for (const panel of ["public-chat-panel.tsx", "public-task-panel.tsx"]) {
    const text = source(`components/public-agent/${panel}`);
    assert.match(text, /sendDisabled = false/, panel);
    assert.match(text, /\|\| sendDisabled\) return;/, panel);
    assert.match(text, /<Button type="submit" disabled=\{[^}]*sendDisabled[^}]*\}>/, panel);
  }
});

test("a paused public page asks again by itself, so the pause ends without a reload", () => {
  // Sending is disabled and the gate has no button while paused: without this nothing would read the access again.
  assert.ok(PAUSED_RECHECK_MS >= 10_000 && PAUSED_RECHECK_MS <= 60_000);
  const gate = source("components/public-agent/paid-gate.tsx");
  const start = gate.indexOf("if (!paused) return;");
  assert.ok(start >= 0, "the effect runs only while paused");
  const effect = gate.slice(start, gate.indexOf("}, [paused, handle]);", start));
  assert.match(effect, /paidUseApi\.access\(handle\)/);
  assert.match(effect, /window\.setInterval\(\(\) => void recheck\(\), PAUSED_RECHECK_MS\)/);
  assert.match(effect, /addEventListener\("visibilitychange"/);
  assert.match(effect, /window\.clearInterval\(timer\)/);
  assert.match(effect, /removeEventListener\("visibilitychange"/);
  // A failed read leaves the page as it is: no error panel in place of the notice.
  assert.doesNotMatch(effect, /setAccessError|setSessionEnded/);
});

test("the docs say what a pause is, and name the route, the two refusals and the two fields", () => {
  const guide = source("app/docs/guides/marketplace/page.tsx");
  assert.match(guide, /<h3 id="model-stops">When the model stops<\/h3>/);
  assert.match(guide, /\{ id: "model-stops", title: "When the model stops", sub: true \}/);
  assert.match(source("app/docs/api/deployments/page.tsx"), /path="\/api\/deployments\/\{deploymentId\}\/dependents"/);
  const market = source("app/docs/api/marketplace/page.tsx");
  assert.match(market, /<code>listing_paused<\/code>/);
  assert.match(market, /carries <code>paused<\/code>/);
  const agents = source("app/docs/api/agents/page.tsx");
  assert.match(agents, /<code>agent_paused<\/code>/);
  assert.match(agents, /"paused": false/);
});
