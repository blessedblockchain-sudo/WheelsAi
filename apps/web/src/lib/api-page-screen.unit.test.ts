/**
 * The API page of a listing, read off its source: it draws what the pure
 * file says, writes no sentence of its own about a price, a plan or a limit,
 * builds no address by hand, and is linked only where a listing sells use.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/api-page-screen.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { API_PAGE_HEADINGS, API_PAGE_WORDS } from "./api-page";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const ROUTE = source("app/a/[slug]/api/page.tsx");
const VIEW = source("components/api-page/api-page-view.tsx");
const AGENT_VIEW = source("components/public-agent/public-agent-view.tsx");
const LISTING = source("app/marketplace/[slug]/page.tsx");

test("the page is read from the API page's own address, with no cookie, and nothing else", () => {
  assert.ok(ROUTE.includes("`${API_BASE_URL}/api/a/${encodeURIComponent(handle)}/api`"));
  assert.ok(ROUTE.includes('credentials: "omit"'));
  assert.ok(ROUTE.includes('cache: "no-store"'));
  assert.equal(ROUTE.match(/fetch\(/g)?.length, 1);
  // In the browser: the one public read, after a failed read or a retry.
  assert.ok(VIEW.includes(".getApiPage(handle)"));
  assert.equal(VIEW.match(/publicAgentApi\b\s*\.\s*\w+/g)?.length, 1);
  for (const other of ["paidUseApi", "marketplaceApi", "billingApi", "publicAgentApi.get("]) {
    assert.ok(!VIEW.includes(other) && !ROUTE.includes(other), other);
  }
});

test("an unknown handle and an agent whose use is not sold read as a page that does not exist", () => {
  assert.ok(ROUTE.includes('if (res.status === 404) return "not_found";'));
  assert.ok(ROUTE.includes('if (page === "not_found") return { title: API_PAGE_WORDS.notFoundTitle, robots: { index: false } };'));
  assert.ok(ROUTE.includes("return isAgentApiPage(body) ? body : null;"));
  assert.ok(VIEW.includes("if (error instanceof ApiError && error.status === 404) setNotFound(true);"));
  assert.ok(VIEW.includes("title={API_PAGE_WORDS.notFoundTitle}"));
  assert.ok(VIEW.includes("description={API_PAGE_WORDS.notFound}"));
  // The same words as the agent's own page.
  assert.ok(AGENT_VIEW.includes(`title="${API_PAGE_WORDS.notFoundTitle}"`));
  assert.ok(AGENT_VIEW.includes(`description="${API_PAGE_WORDS.notFound}"`));
});

test("the title in the browser's tab is the agent's name and API", () => {
  assert.ok(ROUTE.includes("const title = apiPageTitle(page.name);"));
  assert.ok(ROUTE.includes("const summary = apiPageSummary(page.name);"));
  assert.ok(ROUTE.includes("return <ApiPageView key={slug} handle={slug} initial={initial} />;"));
});

test("the view draws the pure file's model and writes no sentence of its own", () => {
  assert.ok(VIEW.includes("const view = page && !notFound ? apiPageView(page, API_BASE_URL) : null;"));
  for (const word of [...Object.values(API_PAGE_WORDS), ...Object.values(API_PAGE_HEADINGS)]) {
    assert.equal(VIEW.includes(`"${word}"`) || VIEW.includes(`>${word}<`), false, word);
  }
  assert.equal(/30 days|a month|per message|per run|a minute|a day|unlimited|token|cents/i.test(VIEW), false);
  for (const drawn of [
    "{view.title}",
    "{view.intro}",
    "{view.callLine}",
    "{view.modelLine}",
    "{view.keyNote}",
    "{endpoint.line}",
    "{endpoint.says}",
    "{plan.name}",
    "{plan.price}",
    "{plan.uses}",
    "{plan.after}",
    "{view.payAsYouGo}",
    "{view.trialLine}",
    "{view.priceLine}",
    "{view.priceNote}",
    "{header.name}",
    "{header.says}",
    "{refusal.status}",
    "{refusal.code}",
    "{refusal.message}",
    "{view.oneKey}",
    "{view.keyScope}",
    "{view.startFirst}",
    "{view.createKeyLabel}",
  ]) {
    assert.ok(VIEW.includes(drawn), drawn);
  }
  assert.ok(VIEW.includes("view.callNotes.map("));
  assert.ok(VIEW.includes("view.limits.map("));
  // The free trial is one line of the pure file's, drawn only when there is one, and never worded here.
  assert.equal(VIEW.split("{view.trialLine && ").length - 1, 2, "under the plans, or under the one price");
  assert.equal(/free trial|Try \d|uses free/i.test(VIEW.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")), false);
});

test("the view builds no address and no snippet by hand", () => {
  assert.equal(/https?:\/\//.test(VIEW), false);
  assert.equal(/chat\/completions|\/v1|agent\/|Bearer|curl /.test(VIEW), false);
  assert.equal(VIEW.includes("${API_BASE_URL}"), false);
});

test("each snippet stands in its own box with a copy button, and scrolls inside it", () => {
  assert.ok(VIEW.includes('import { CodeBlock } from "@/components/marketing/code-block";'));
  assert.match(VIEW, /view\.snippets\.map\(\(snippet\) => \(\s*<CodeBlock key=\{snippet\.id\} title=\{snippet\.label\} code=\{snippet\.code\}/);
  const block = source("components/marketing/code-block.tsx");
  assert.ok(block.includes("navigator.clipboard.writeText(code)"));
  assert.ok(block.includes("overflow-x-auto"));
  // An address or a header's name that is longer than a phone is wide wraps.
  assert.ok(VIEW.includes("break-all"));
});

test("Create a key goes to the keys page, through sign-in for someone signed out", () => {
  assert.ok(VIEW.includes("const { authed } = useSession();"));
  assert.ok(VIEW.includes("<Link href={createKeyHref(authed)}"));
  assert.equal(VIEW.includes("/dashboard/keys"), false);
  assert.equal(VIEW.includes("/login"), false);
});

test("the page offers nothing that charges: no start, no button that spends", () => {
  assert.equal(/onClick=\{/.test(VIEW), false);
  assert.equal(/<Button\b|<form\b|<input\b/.test(VIEW), false);
});

test("the agent's page links to it only for an agent whose use is sold", () => {
  assert.ok(AGENT_VIEW.includes("const apiPageHref = apiPageHrefOfAgent(detail);"));
  assert.match(AGENT_VIEW, /\{apiPageHref && \(\s*<Link\s+href=\{apiPageHref\}/);
  assert.ok(AGENT_VIEW.includes("{API_PAGE_WORDS.link}"));
  assert.equal(AGENT_VIEW.includes(API_PAGE_WORDS.link), false);
});

test("the marketplace's listing page links to it only for a listing that sells use", () => {
  assert.ok(LISTING.includes("const apiPageHref = apiPageHrefOfListing(listing);"));
  assert.match(LISTING, /\{apiPageHref && \(\s*<Link\s+href=\{apiPageHref\}/);
  assert.ok(LISTING.includes("{API_PAGE_WORDS.link}"));
  assert.equal(LISTING.includes(API_PAGE_WORDS.link), false);
});
