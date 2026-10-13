/**
 * Plans on the Installed page, read off the page's source: it draws what the
 * pure files say, writes no sentence of its own about a plan, and a move is
 * sent once, with the terms of the card that was pressed.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/installed-plans-screen.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { INSTALLED_PLAN_WORDS } from "./installed-plans";
import { INSTALLED_WORDS } from "./installed-rows";
import { USAGE_WORDS } from "./usage-view";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, "..", "app/(dashboard)/dashboard/marketplace/installs/page.tsx"), "utf8");

/** The function that sends a move, from its first line to the next function. */
const MOVE = PAGE.slice(PAGE.indexOf("async function handleMoveUp("), PAGE.indexOf("async function handleUninstall("));

test("the page writes no sentence about a plan: the words are the pure file's", () => {
  for (const word of Object.values(INSTALLED_PLAN_WORDS)) assert.equal(PAGE.includes(word), false, word);
  assert.equal(/30 days|uses you have left|for 30 days|unlimited/i.test(PAGE), false);
  for (const used of ["moveUpChoice(", "moveUpConfirm(", "moveUpRefusal(", "movedLine(", "INSTALLED_PLAN_WORDS.moveUp", "INSTALLED_PLAN_WORDS.noneBigger"]) {
    assert.ok(PAGE.includes(used), used);
  }
});

test("Move up opens the choice of bigger plans, drawn from the rows as they were last read", () => {
  assert.match(PAGE, /else if \(action\.id === "move_up"\) setChoosingFor\(install\.listingId\);/);
  assert.match(PAGE, /const choosing = installs\.find\(\(install\) => install\.listingId === choosingFor\) \?\? null;/);
  assert.match(PAGE, /const choice = choosing \? moveUpChoice\(choosing\) : null;/);
  // Each card says its price, its uses and what happens after them, and has the one button.
  for (const part of ["{card.name}", "{card.price}", "{card.uses}, {card.after}", "aria-label={card.moveLabel}"]) {
    assert.ok(PAGE.includes(part), part);
  }
  assert.match(PAGE, /onClick=\{\(\) => void handleMoveUp\(choosing, card\.offer\)\}/);
  // The menu's entry waits like the other actions that spend or change a renewal.
  assert.match(PAGE, /const waits = action\.id !== "review" && action\.id !== "uninstall";/);
});

test("a move asks in the app's dialog first, and sends the terms held from the moment it opened", () => {
  assert.ok(MOVE.length > 0);
  const held = MOVE.indexOf("const dialog = moveUpConfirm(install, offer);");
  const split = MOVE.indexOf("const { terms, ...asked } = dialog;");
  const asked = MOVE.indexOf("const ok = await confirmAction(asked);");
  const stop = MOVE.indexOf("if (!ok) return;");
  const sent = MOVE.indexOf("await marketplaceApi.movePlan(install.listingId, terms);");
  assert.ok(held > 0 && split > held && asked > split && stop > asked && sent > stop);
  // One call, and nothing else on the page moves a plan or starts one.
  assert.equal(PAGE.split("marketplaceApi.movePlan(").length, 2);
  assert.equal(PAGE.includes("marketplaceApi.startPlan("), false);
  assert.equal(PAGE.split("moveUpConfirm(").length, 2);
});

test("a move cannot be pressed twice", () => {
  // Held from the press of a card to the API's answer, without waiting for a redraw.
  assert.match(MOVE, /if \(moving\.current \|\| busyListingId\) return;/);
  const taken = MOVE.indexOf("moving.current = true;");
  assert.ok(taken > 0 && taken < MOVE.indexOf("await confirmAction(asked)"));
  assert.match(MOVE, /\} finally \{\s+moving\.current = false;\s+\}/);
  // The list of plans closes before the question is asked, and its buttons wait while anything is in flight.
  assert.ok(MOVE.indexOf("setChoosingFor(null);") < MOVE.indexOf("await confirmAction(asked)"));
  assert.match(PAGE, /aria-label=\{card\.moveLabel\}\s+disabled=\{busyListingId !== null\}/);
});

test("a refused move shows the API's sentence, offers credits when they are short, and the rows are read again", () => {
  assert.match(MOVE, /const refusal = moveUpRefusal\(answered \? error\.status : 0, answered \? getErrorMessage\(error, ""\) : null\);/);
  assert.match(MOVE, /toast\.error\(refusal\.message, refusal\.addCredits \? \{ action: ADD_CREDITS \} : undefined\);/);
  // Read again after a move and after a refusal alike: the call is in the finally of the try that sends.
  // The row is held until that read is in, so the plan it has just left cannot be pressed.
  assert.match(MOVE, /\} finally \{\s+(?:\/\/[^\n]*\s+)*await loadInstalls\(\);\s+setBusyListingId\(null\);\s+\}/);
  assert.equal(MOVE.split("loadInstalls();").length, 2);
  assert.ok(MOVE.indexOf("setBusyListingId(null);") < MOVE.indexOf("moving.current = false;"));
  // The same way to add credits as the page's other refusals for too few of them.
  assert.equal(PAGE.split('"/dashboard/billing"').length, 2);
});

test("resuming a renewal that is refused shows the API's sentence and leaves the row as it is", () => {
  const renewal = PAGE.slice(PAGE.indexOf("async function handleRenewal("), PAGE.indexOf("async function handleMoveUp("));
  assert.match(renewal, /await marketplaceApi\.resumeSubscription\(install\.listingId\);/);
  assert.match(renewal, /toast\.error\(getErrorMessage\(error, "Could not update the subscription"\)\);/);
  // Only a 409, or a 404 for use, reads the rows again: a 403 changes nothing on the page.
  assert.match(renewal, /if \(error instanceof ApiError && \(error\.status === 409 \|\| \(using && error\.status === 404\)\)\) loadInstalls\(\);/);
});

test("who may spend is read beside the rows, and each row is drawn for that person", () => {
  assert.match(PAGE, /const \{ installs, canSpend \} = await marketplaceApi\.getMyInstalls\(\);/);
  assert.match(PAGE, /setCanSpend\(canSpend\);/);
  // Unknown until the API says: only a clear "no" changes a row.
  assert.match(PAGE, /const \[canSpend, setCanSpend\] = useState<boolean \| undefined>\(undefined\);/);
  assert.match(PAGE, /const rows = installs\.map\(\(install\) => \(\{ install, row: installedRow\(install, \{\}, \{ canSpend \}\) \}\)\);/);
  assert.match(PAGE, /\{rows\.map\(\(\{ install, row \}\) => \{/);
  // The page decides nothing about an action itself: it draws the row's own list.
  assert.equal(/canSpend (===|!==) (true|false) [&|?]/.test(PAGE), false);
  assert.match(PAGE, /\{row\.actions\.map\(\(action\) => \{/);
});

test("a member reads who to ask once, in the pure file's words", () => {
  assert.match(PAGE, /const askAdmin = askAdminOnce\(rows\.map\(\(\{ row \}\) => row\)\);/);
  assert.equal(PAGE.split("{askAdmin}").length, 2);
  assert.match(PAGE, /\{askAdmin && <p [^>]*>\{askAdmin\}<\/p>\}/);
  assert.equal(PAGE.includes(INSTALLED_WORDS.askAdmin), false);
  // A list of bigger plans left open closes for someone who may not spend.
  assert.match(PAGE, /if \(canSpend === false\) setChoosingFor\(null\);/);
});

test("the page links to the usage page in the design's words", () => {
  assert.match(PAGE, /<Link href=\{USAGE_HREF\} [^>]*>\s+\{USAGE_WORDS\.linkLabel\}\s+<\/Link>/);
  assert.equal(PAGE.includes(USAGE_WORDS.linkLabel), false);
  assert.equal(PAGE.includes('"/dashboard/usage"'), false);
});
