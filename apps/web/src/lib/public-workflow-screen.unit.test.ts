/**
 * The page and the API page of a workflow on sale, read off their source:
 * they read the workflow's own public addresses with no cookie, draw the gate
 * through a workflow's door, and write no sentence of their own about what
 * is sold. The workflow's door and its run are plain modules, so they are
 * run here with the client's calls stood in for. Run with:
 *   cd apps/web && npx tsx --test src/lib/public-workflow-screen.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

import { agentDoor, paidWorkflowTransport, workflowDoor, type PaidTransportHooks } from "../components/public-agent/paid-transport";
import type { PanelNotice, PublicUseEvent } from "../components/public-agent/transport";
import { ApiError, paidUseApi, paidWorkflowApi, type PaidUseBilling } from "./api";
import { PAID_WORKFLOW_MESSAGES, runTimeNote, taskDraftKey, workflowDraftKey, type PaidNotice } from "./paid-use";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const PAGE_ROUTE = source("app/w/[slug]/page.tsx");
const VIEW = source("components/public-workflow/public-workflow-view.tsx");
const API_ROUTE = source("app/w/[slug]/api/page.tsx");
const API_VIEW = source("components/api-page/api-page-view.tsx");
const GATE = source("components/public-agent/paid-gate.tsx");
const AGENT_VIEW = source("components/public-agent/public-agent-view.tsx");

/** What a screen draws: its source without comments. */
const drawn = (text: string) => text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ============================================
// /w/<slug>
// ============================================

test("the page is read on the server from the workflow's own address, with no cookie, and nothing else", () => {
  assert.ok(PAGE_ROUTE.includes("`${API_BASE_URL}/api/w/${encodeURIComponent(slug)}`"));
  assert.ok(PAGE_ROUTE.includes('credentials: "omit"'));
  assert.ok(PAGE_ROUTE.includes('cache: "no-store"'));
  assert.equal(PAGE_ROUTE.match(/fetch\(/g)?.length, 1);
  assert.ok(PAGE_ROUTE.includes('if (res.status === 404) return "not_found";'));
  assert.ok(PAGE_ROUTE.includes("return isPublicWorkflowRead(body) ? body : null;"));
  // The tab and a shared link say the listing's title and line, and "Workflow not found" for a 404.
  assert.ok(PAGE_ROUTE.includes('if (read === "not_found") return { title: PAID_WORKFLOW_MESSAGES.notFoundTitle, robots: { index: false } };'));
  assert.ok(PAGE_ROUTE.includes("const title = read.title.trim();"));
  assert.ok(PAGE_ROUTE.includes("const summary = read.description?.trim() || `${title} on WheelsAI.`;"));
  assert.ok(PAGE_ROUTE.includes("return <PublicWorkflowView key={slug} slug={slug} initial={initial} />;"));
  assert.equal(PAID_WORKFLOW_MESSAGES.notFoundTitle, "Workflow not found");
});

test("in the browser the page reads only the workflow's public read, and a 404 is a page that does not exist", () => {
  assert.ok(VIEW.includes("paidWorkflowApi\n      .get(slug)"));
  assert.equal(VIEW.match(/paidWorkflowApi\s*\.\s*\w+/g)?.length, 1);
  for (const other of ["publicAgentApi", "paidUseApi", "marketplaceApi", "publicUseApi", "fetch("]) {
    assert.ok(!VIEW.includes(other), other);
  }
  assert.ok(VIEW.includes("if (error instanceof ApiError && error.status === 404) setNotFound(true);"));
  assert.ok(VIEW.includes("title={PAID_WORKFLOW_MESSAGES.notFoundTitle}"));
  assert.ok(VIEW.includes("description={PAID_WORKFLOW_MESSAGES.notFoundPage}"));
  assert.ok(VIEW.includes("if (!isPublicWorkflowRead(res)) throw new Error(PAID_WORKFLOW_MESSAGES.loadFailed);"));
});

test("the header is the listing's title and one line, a workflow's icon, and the way to its API page", () => {
  assert.ok(VIEW.includes("{read.title}"));
  assert.ok(VIEW.includes("{read.description}"));
  assert.ok(VIEW.includes('import { ArrowLeft, Code2, Workflow } from "lucide-react";'));
  assert.ok(!/\bBot\b/.test(VIEW), "not the agent's icon");
  assert.match(VIEW, /<Link\s+href=\{workflowApiPagePath\(read\.slug\)\}/);
  assert.ok(VIEW.includes("{API_PAGE_WORDS.link}"));
  // Wide content wraps inside the page on a phone.
  assert.ok(VIEW.includes("min-w-0 break-words text-2xl font-bold"));
  assert.ok(VIEW.includes("container mx-auto max-w-3xl px-4"));
});

test("the page is the gate with a workflow's door, the form the read gives, and nothing an agent's page adds", () => {
  assert.ok(VIEW.includes("workflowDoor(read.slug, read.maxRunMinutes)"));
  assert.ok(VIEW.includes("workflowPageTerms(read)"));
  assert.ok(VIEW.includes("{ task: { inputSchema: read.input.schema, maxInputChars: read.input.maxInputBytes } }"));
  assert.ok(VIEW.includes("<PaidGate door={door} use={use} terms={terms} title={PAID_WORKFLOW_MESSAGES.panelTitle} />"));
  assert.equal(PAID_WORKFLOW_MESSAGES.panelTitle, "Run it");
  // No chat, no list of results, no receipts, no free try.
  for (const absent of ["PublicChatPanel", "PublicResultsPanel", "PublicReceipts", "PaidResults", "tryFree", "chat:", "scheduled:"]) {
    assert.ok(!VIEW.includes(absent), absent);
  }
  // No sentence written here names an agent, a step, a model or tokens.
  assert.ok(!/\bagents?\b|\bsteps?\b|\bmodel\b|token|unlimited/i.test(drawn(VIEW).replace(/public-agent\//g, "")));
});

// ============================================
// The workflow's door and its run, run under node with the client's calls stood in for
// ============================================

const BILLING: PaidUseBilling = { chargedCents: 5, balanceCents: 95, access: "listing_pricing" };

/** The hooks a gate gives a transport, recording what was called, in order. */
function hooksFor(calls: string[], over: Partial<PaidTransportHooks> = {}): PaidTransportHooks {
  return {
    unit: "run",
    heldBack: () => null,
    toPanel: (notice: PaidNotice): PanelNotice => ({ message: notice.message, fields: notice.fields, retryAfterSeconds: null, paused: false }),
    onUsed: () => calls.push("used"),
    onBilled: () => calls.push("billed"),
    onStopped: (stopped) => calls.push(`stopped:${stopped}`),
    ...over,
  };
}

async function drain(events: AsyncIterable<PublicUseEvent>): Promise<PublicUseEvent[]> {
  const out: PublicUseEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("a workflow's door reads its access and runs it by its listing's slug, in the workflow's words", async (t) => {
  const door = workflowDoor("daily-brief", 10);
  assert.equal(door.subject, "workflow");
  assert.equal(door.path, "/w/daily-brief");
  assert.equal(door.draftKey, workflowDraftKey("daily-brief"));
  assert.equal(door.agent, null);
  assert.equal(door.runNote, runTimeNote(10));
  assert.equal(door.runNote, "A run can take up to 10 minutes. Keep this page open: closing it cancels the run.");

  // Its access is the workflow's, by the slug; its owner is read as the owner's case.
  const read = mock.method(paidWorkflowApi, "access", async () => ({ access: "own_workflow", listingId: "l1" }) as never);
  t.after(() => read.mock.restore());
  const state = await door.readAccess();
  assert.deepEqual(read.mock.calls.map((call) => call.arguments), [["daily-brief"]]);
  assert.equal(state.access, "own_agent");

  // Its form is run by the workflow's paid run, with the workflow's words.
  const run = mock.method(paidWorkflowApi, "run", async () => {
    throw new ApiError(404, "Not Found", { error: "workflow_not_found" });
  });
  t.after(() => run.mock.restore());
  const transport = door.taskTransport(hooksFor([]));
  await assert.rejects(drain(transport.send({ topic: "x" }, new AbortController().signal)), (error) => {
    assert.equal(transport.explain(error).message, "This workflow was not found.");
    return true;
  });
  assert.equal(run.mock.callCount(), 1);
  assert.equal(run.mock.calls[0]?.arguments[0], "daily-brief");
  // No time the API did not send is said.
  assert.equal(workflowDoor("x", Number.NaN).runNote, "Keep this page open: closing it cancels the run.");

  // An agent's door is today's calls by its handle, with an agent's words.
  const agent = agentDoor("support-bot", "Support Bot");
  assert.equal(agent.subject, "agent");
  assert.equal(agent.path, "/a/support-bot");
  assert.equal(agent.draftKey, taskDraftKey("support-bot"));
  assert.deepEqual(agent.agent, { handle: "support-bot", name: "Support Bot" });
  assert.equal(agent.runNote, null);
  const agentRead = mock.method(paidUseApi, "access", async () => ({ access: "none" }) as never);
  t.after(() => agentRead.mock.restore());
  await agent.readAccess();
  assert.deepEqual(agentRead.mock.calls.map((call) => call.arguments), [["support-bot"]]);
  assert.ok(AGENT_VIEW.includes("const door = useMemo(() => agentDoor(agent.handle, agent.name), [agent.handle, agent.name]);"));
  assert.ok(AGENT_VIEW.includes("<PaidGate door={door} use={use} terms={use.paid} title={PANEL_TITLES[kind](agent.name)} />"));
});

test("a workflow's run sends the input alone with a signal, and its answer is the text and the charge line", async (t) => {
  const run = mock.method(paidWorkflowApi, "run", async () => ({ output: { format: "text" as const, text: "Done." }, billing: BILLING }));
  t.after(() => run.mock.restore());
  const calls: string[] = [];
  const transport = paidWorkflowTransport("daily-brief", hooksFor(calls, { subject: "workflow" }));
  // No waiting label: the panel shows Stop while the run goes.
  assert.equal(transport.waitingLabel, undefined);
  const signal = new AbortController().signal;
  const events = await drain(transport.send({ topic: "news" }, signal));
  assert.deepEqual(run.mock.calls[0]?.arguments, ["daily-brief", { input: { topic: "news" } }, signal]);
  assert.deepEqual(events, [
    { type: "delta", content: "Done." },
    { type: "charged", line: "This run cost $0.05. Your credits: $0.95." },
    { type: "done" },
  ]);
  // The stopped sentence goes when a run is sent, the access is read again, and the count is drawn from the billing.
  assert.deepEqual(calls, ["stopped:false", "used", "billed"]);
});

test("a workflow's run that is stopped says so, a refused one is worded for a workflow, and both read the access again", async (t) => {
  // Stop, or the page closing: the request rejects with the browser's abort error, never an answer of the API.
  const run = mock.method(paidWorkflowApi, "run", (_slug: string, _body: unknown, signal?: AbortSignal) => {
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
  });
  t.after(() => run.mock.restore());
  const calls: string[] = [];
  const transport = paidWorkflowTransport("daily-brief", hooksFor(calls, { subject: "workflow" }));
  const stop = new AbortController();
  const sent = drain(transport.send({ topic: "news" }, stop.signal));
  stop.abort();
  await assert.rejects(sent, { name: "AbortError" });
  assert.deepEqual(calls, ["stopped:false", "stopped:true", "used"]);

  // A refusal: never said to be stopped, the API's sentence, and the access read again.
  run.mock.mockImplementation(async () => {
    throw new ApiError(429, "Too Many Requests", {
      error: "workflow_busy",
      message: "This workflow is running as many times as it can right now. Nothing was charged. Try again in a minute.",
    });
  });
  calls.length = 0;
  await assert.rejects(drain(transport.send({ topic: "news" }, new AbortController().signal)), (error) => {
    assert.equal(
      transport.explain(error).message,
      "This workflow is running as many times as it can right now. Nothing was charged. Try again in a minute.",
    );
    return true;
  });
  assert.deepEqual(calls, ["stopped:false", "used"]);

  // No answer at all: the workflow's words, never an agent's.
  assert.equal(transport.explain(new TypeError("Failed to fetch")).message, "The workflow could not be reached. Check your connection and try again.");

  // A send the page holds back asks nothing of the API.
  run.mock.resetCalls();
  calls.length = 0;
  const held = paidWorkflowTransport("daily-brief", hooksFor(calls, { subject: "workflow", heldBack: () => ({ message: "Start first.", fields: {}, retryAfterSeconds: null, paused: false }) }));
  await assert.rejects(drain(held.send({ topic: "news" }, new AbortController().signal)), (error) => {
    assert.equal(held.explain(error).message, "Start first.");
    return true;
  });
  assert.equal(run.mock.callCount(), 0);
  assert.deepEqual(calls, []);

  // The panel cancels a run whose page is closed.
  assert.match(source("components/public-agent/public-task-panel.tsx"), /useEffect\(\(\) => \(\) => abortRef\.current\?\.abort\(\), \[\]\);/);
});

test("the gate draws a workflow's page through its door: no free try, no chat, no results, notes under the form", () => {
  assert.match(GATE, /const handle = door\.agent\?\.handle \?\? null;/);
  assert.match(GATE, /const terms = useMemo\(\(\) => pageTermsFor\(pageTerms, subject\), \[pageTerms, subject\]\);/);
  assert.match(GATE, /const next = await door\.readAccess\(\);/);
  assert.match(GATE, /\{door\.agent && \(\s*<p>\s*<Link\s+href=\{tryFreeHref\(terms\.listingSlug\)\}/);
  assert.match(GATE, /chat: hasChat && handle !== null \? paidChatTransport\(\{ \.\.\.hooks, handle \}\) : null,/);
  assert.match(GATE, /task: hasTask \? door\.taskTransport\(hooks\) : null,/);
  assert.match(GATE, /draft=\{\{ key: door\.draftKey, keep: view\.kind === "signed_out" \}\}/);
  assert.match(GATE, /signInHref\(\{ path: door\.path \}\)/);
  assert.match(GATE, /registerHref\(\{ path: door\.path \}\)/);
  assert.doesNotMatch(GATE, /signInHref\(handle\)|registerHref\(handle\)/);
  // The privacy sentence and the run's time limit under the form, with what Stop did above them.
  assert.match(GATE, /<p>\{privacyLine\(keepsCopy, subject\)\}<\/p>/);
  assert.match(GATE, /\{door\.runNote && <p>\{door\.runNote\}<\/p>\}/);
  assert.match(GATE, /\{notesUnderForm && \(\s*<div[^>]*>\s*\{runStopped && \(\s*<p role="status"[^>]*>\s*\{PAID_WORKFLOW_MESSAGES\.stopped\}/);
  assert.ok(GATE.indexOf("{notesUnderForm && (") > GATE.indexOf("<PublicTaskPanel"));
  // The recheck of a pause is an agent's alone.
  assert.match(GATE, /if \(!paused\) return;\s*\/\/[^\n]*\n\s*if \(handle === null\) return;/);
  // A refused start, plan start, free trial or move is worded for what is sold.
  assert.match(GATE, /act: "start",\s*unit,\s*subject,/);
  assert.equal(GATE.split("refusal, unit, subject }))").length - 1, 3);
  assert.equal(GATE.split("refusal, unit }))").length - 1, 0);
  // After Stop the access is read again later, when the refund has landed; nothing is read once the page has closed.
  assert.match(
    GATE,
    /stoppedReads\.current = stopped\s*\?\s*STOPPED_REREADS_MS\.map\(\(ms\) => window\.setTimeout\(\(\) => void live\.current\.readAccess\(\), ms\)\)\s*:\s*\[\];/,
  );
  assert.match(GATE, /useEffect\(\(\) => \(\) => stoppedReads\.current\.forEach\(\(timer\) => window\.clearTimeout\(timer\)\), \[\]\);/);
});

// ============================================
// /w/<slug>/api
// ============================================

test("the API page is read from the workflow's API page address alone, with no cookie", () => {
  assert.ok(API_ROUTE.includes("`${API_BASE_URL}/api/w/${encodeURIComponent(slug)}/api`"));
  assert.ok(API_ROUTE.includes('credentials: "omit"'));
  assert.ok(API_ROUTE.includes('cache: "no-store"'));
  assert.equal(API_ROUTE.match(/fetch\(/g)?.length, 1);
  assert.ok(API_ROUTE.includes('if (res.status === 404) return "not_found";'));
  assert.ok(API_ROUTE.includes("return isWorkflowApiPage(body) ? body : null;"));
  assert.ok(API_ROUTE.includes("const title = apiPageTitle(page.name);"));
  assert.ok(API_ROUTE.includes('if (page === "not_found") return { title: WORKFLOW_API_PAGE_WORDS.notFoundTitle, robots: { index: false } };'));
  assert.ok(API_ROUTE.includes('return <ApiPageView key={slug} handle={slug} initial={initial} reader="workflow" />;'));
  // Not the agent's reads.
  for (const other of ["/api/a/", "publicAgentApi", "paidUseApi", "isAgentApiPage"]) assert.ok(!API_ROUTE.includes(other), other);
});

test("the API page's view reads a workflow's page by its reader, and draws it with the agent's page's parts", () => {
  assert.ok(API_VIEW.includes('reader === "workflow" ? paidWorkflowApi.getApiPage(handle) : publicAgentApi.getApiPage(handle);'));
  assert.ok(API_VIEW.includes("if (!isApiPageFor(reader, res)) throw new Error(API_PAGE_WORDS.loadFailed);"));
  assert.ok(API_VIEW.includes('reader = "agent"'));
  // A workflow's page that does not exist says so in its own words.
  assert.ok(API_VIEW.includes("title={WORKFLOW_API_PAGE_WORDS.notFoundTitle}"));
  assert.ok(API_VIEW.includes("description={WORKFLOW_API_PAGE_WORDS.notFound}"));
  // The back link and the links to start a plan say the page's own words, from the pure file.
  assert.ok(!API_VIEW.includes("{API_PAGE_WORDS.agentPage}"));
  assert.equal(API_VIEW.split("{view.pageLabel}").length - 1, 4);
  assert.ok(API_VIEW.includes("{view.startPlan}"));
  assert.ok(API_VIEW.includes("{view.otherAddresses}"));
});
