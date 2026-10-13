/**
 * The Usage page, read off its source: it draws what lib/usage-view.ts says
 * from the one usage read, writes no sentence of its own, and its bar is
 * never the only carrier of what it shows. Also where the page is linked
 * from Billing and where it stands in the menu.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/usage-screen.unit.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { USAGE_PAID_HREF, locate } from "./nav";
import { ADD_CREDITS_HREF, USAGE_HREF, USAGE_WORDS } from "./usage-view";

const here = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(here, "..", "app/(dashboard)/dashboard");
const PAGE = readFileSync(join(DASHBOARD, "usage/page.tsx"), "utf8");
const BILLING = readFileSync(join(DASHBOARD, "billing/page.tsx"), "utf8");
/** What the page draws and does: its source with the comments taken out. */
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the page is at the address the warning emails link to, and the menu knows it", () => {
  assert.equal(USAGE_HREF, "/dashboard/usage");
  assert.ok(existsSync(join(DASHBOARD, "usage/page.tsx")));
  // One address, said in two pure files: they never part.
  assert.equal(USAGE_PAID_HREF, USAGE_HREF);
  const at = locate(USAGE_HREF, "", { tokenUi: false });
  assert.equal(at?.item.id, "usage");
  assert.equal(at?.tab?.href, USAGE_HREF);
  assert.equal(at?.showTabs, true);
});

test("the page reads the usage read alone", () => {
  assert.equal(PAGE.split("billingApi.").length, 2);
  assert.ok(PAGE.includes("await billingApi.getMarketplaceUsage()"));
  for (const other of ["marketplaceApi", "apiKeysApi", "fetch(", "getBalance"]) {
    assert.equal(PAGE.includes(other), false, other);
  }
  assert.match(PAGE, /const view = usageView\(usage\);/);
});

test("the page writes no sentence, no price and no date of its own", () => {
  for (const word of Object.values(USAGE_WORDS)) {
    assert.equal(CODE.includes(`"${word}"`) || CODE.includes(`>${word}<`), false, word);
  }
  assert.equal(/uses? left|uses? used|this month|this period|for 30 days|unlimited|Renews|\$\d/i.test(CODE), false);
  assert.equal(/new Date\(|toLocale|Intl\.|Date\.now|toFixed\(/.test(CODE), false);
  // Nothing a buyer must not read.
  assert.equal(/token|\bmodel\b|organi[sz]ation/i.test(CODE), false);
});

test("three states, each easy to read off: loading, could not load, the answer", () => {
  const loading = PAGE.indexOf("{isLoading ? (");
  const failed = PAGE.indexOf(") : loadError !== null ? (");
  const answer = PAGE.indexOf("{view.empty !== null ? (");
  assert.ok(loading > 0 && failed > loading && answer > failed);
  assert.match(PAGE, /<ErrorState title=\{USAGE_WORDS\.loadFailed\} error=\{loadError\} onRetry=\{loadUsage\} \/>/);
  // A read that failed leaves no old numbers on the page.
  assert.match(PAGE, /\} catch \(error\) \{\s+setUsage\(null\);\s+setLoadError\(error\);/);
});

test("the one balance with Add credits, to where Billing adds them", () => {
  assert.match(PAGE, /\{view\.balance !== null && <p [^>]*>\{view\.balance\}<\/p>\}/);
  assert.ok(PAGE.includes("{USAGE_WORDS.balanceNote}"));
  assert.match(PAGE, /<Link href=\{ADD_CREDITS_HREF\}>\s+<Button>\{USAGE_WORDS\.addCredits\}<\/Button>\s+<\/Link>/);
  assert.equal(ADD_CREDITS_HREF, "/dashboard/billing#add-credits");
  // Billing's card for adding credits answers to that anchor.
  assert.ok(BILLING.includes('<Card id="add-credits"'));
});

test("an organization that uses nothing reads one sentence and a link to the marketplace", () => {
  assert.match(PAGE, /description=\{view\.empty\}\s+actionLabel=\{USAGE_WORDS\.browse\}\s+actionHref="\/marketplace"/);
});

test("a row: the title linked to the agent's page, the plan's name, and only the lines it has", () => {
  assert.match(PAGE, /\{row\.href \? \(\s+<Link href=\{row\.href\}/);
  assert.ok(PAGE.includes("{row.planName && <Badge variant=\"secondary\">{row.planName}</Badge>}"));
  assert.ok(PAGE.includes("{row.bar && <UsesBar bar={row.bar} />}"));
  for (const line of ["renewalLine", "countLine", "extraLine", "perUseLine", "statusLine"]) {
    assert.ok(PAGE.includes(`{row.${line} && <p `), line);
  }
  assert.match(PAGE, /<UsageRow key=\{row\.listingId\} row=\{row\} \/>/);
});

test("the bar is not the only carrier of its meaning", () => {
  // The numbers are in text beside it.
  assert.ok(PAGE.includes("{bar.usedText}"));
  // It has a text alternative.
  assert.match(PAGE, /<div role="img" aria-label=\{bar\.label\}/);
  // The 85% and 100% states are words and an icon, not a colour alone.
  assert.match(PAGE, /\{bar\.levelLabel && \(\s+<Badge [^>]*>\s+<AlertTriangle [^>]*\/>\s+\{bar\.levelLabel\}/);
  // Both marks are drawn on the bar and named under it, from the pure file's list.
  assert.equal(PAGE.split("USAGE_BAR_MARKS.map(").length, 3);
  assert.ok(PAGE.includes("{mark.label}"));
  assert.match(PAGE, /style=\{\{ width: `\$\{bar\.percent\}%` \}\}/);
});

test("nothing on the page scrolls sideways at a phone's width", () => {
  assert.equal(/overflow-x|whitespace-nowrap|min-w-\[|w-\[\d/.test(PAGE), false);
  assert.ok(PAGE.includes('className="p-4 sm:p-8"'));
  assert.ok(PAGE.includes("flex flex-wrap items-center justify-between gap-4"));
});

test("Billing links to the page in the design's words", () => {
  assert.equal(USAGE_WORDS.linkLabel, "Usage of what you pay for");
  assert.match(BILLING, /<Link href=\{USAGE_HREF\} [^>]*>\s+\{USAGE_WORDS\.linkLabel\}\s+<\/Link>/);
  assert.ok(BILLING.includes('import { USAGE_HREF, USAGE_WORDS } from "@/lib/usage-view";'));
});
