/**
 * Plans on the Sell tab and in the listing wizard, read off the screens'
 * source: both draw the one block, both save the listing first and its plans
 * second through the one body, and neither writes a word of its own.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/sell-plans-screens.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PLAN_WORDS } from "./sell-plans";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(join(here, "..", path), "utf8");

const BLOCK = source("components/dashboard/sell/plans-block.tsx");
const QUESTION = source("components/dashboard/sell/who-can-use.tsx");
const SELL_TAB = source("components/dashboard/agent-tabs/sell-tab.tsx");
const WIZARD = source("app/(dashboard)/dashboard/marketplace/publish/page.tsx");

test("the block is drawn by the question, under Pay per use only, so both screens have it", () => {
  assert.match(QUESTION, /import \{ PlansBlock \} from "\.\/plans-block";/);
  assert.match(QUESTION, /selected && choice\.id === "per_use" && plansShown &&/);
  assert.match(QUESTION, /plans\.form\.loaded && sellsWithPlans\(form\)/);
  for (const screen of [SELL_TAB, WIZARD]) {
    assert.match(screen, /<WhoCanUse/);
    assert.match(screen, /plans=\{\{/);
    assert.equal(screen.includes("PlansBlock"), false);
  }
});

test("the block's words are the pure file's, and it offers no free trial", () => {
  // Short labels can be met in a comment; a sentence in a screen would be a second copy of it.
  for (const word of Object.values(PLAN_WORDS).filter((candidate) => candidate.includes(" "))) {
    assert.equal(BLOCK.includes(word), false, word);
    assert.equal(QUESTION.includes(word), false, word);
  }
  for (const key of ["title", "name", "price", "uses", "whenOut", "stop", "extra", "extraPrice", "add", "noUnlimited"]) {
    assert.ok(BLOCK.includes(`PLAN_WORDS.${key}`), key);
  }
  for (const screen of [BLOCK, QUESTION, SELL_TAB, WIZARD]) {
    assert.equal(/free trial/i.test(screen), false);
    assert.equal(/unlimited/i.test(screen.replace(/PLAN_WORDS\.noUnlimited/g, "")), false);
  }
  // Ending a plan asks in the app's own dialog.
  assert.match(BLOCK, /useConfirm/);
  assert.match(BLOCK, /endPlanDialog\(row, saved\)/);
});

test("both screens check the plans first, save the listing, then send the whole set once", () => {
  // The save's own check, with the answer that is being saved: on the Sell tab that is `sent`, the form
  // after the dialog about copies, not the one on screen.
  assert.match(SELL_TAB, /const plansSave = plansSaveOf\(\{ sell: sent, form: plans, saved: plansRead, limits: planLimits \}\);/);
  assert.match(WIZARD, /const plansSave = plansSaveOf\(\{ sell, form: plans, saved: plansRead, limits: planLimits \}\);/);
  for (const screen of [SELL_TAB, WIZARD]) {
    assert.equal(screen.split("const plansSave = plansSaveOf(").length, 2);
    const check = screen.indexOf("const plansSave = plansSaveOf(");
    const invalid = screen.indexOf('plansSave.kind === "invalid"');
    const listing = screen.indexOf("marketplaceApi.updateListing(");
    const send = screen.indexOf("marketplaceApi.setListingPlans(");
    assert.ok(check > 0 && invalid > check, "the plans are checked");
    assert.ok(listing > invalid, "the listing is saved after the check");
    assert.ok(send > listing, "the plans are sent after the listing");
    // One call, with the body the pure function made, and only when it made one.
    assert.equal(screen.split("marketplaceApi.setListingPlans(").length, 2);
    assert.match(
      screen,
      /if \(plansSave\.kind === "send"\) \{\s+try \{\s+(?:const res = )?await marketplaceApi\.setListingPlans\([\w.]+, plansSave\.plans, plansSave\.ended\);/,
    );
    // The plans that end are the ones the pure function named, never a list made on the screen.
    assert.equal(screen.split("plansSave.ended").length, 2);
    // A refusal is read from the error's own body and said through the pure file.
    assert.match(screen, /planFieldErrors\(fields\)/);
    assert.match(screen, /plansRefusedLine\(/);
  }
});

test("a save ends only a plan the rows were made from, never one that a later read brought", () => {
  // After a refused save both screens read the listing again and keep the rows as they were typed. A plan
  // that someone else added is then in the new read and has no row: measured against the new read, a second
  // press of Save would name it as ended. So the save is measured against the read the rows came from.
  for (const screen of [SELL_TAB, WIZARD]) {
    const calls = screen.match(/plans(?:Save|Problem)Of\(\{[^}]*\}\)/g) ?? [];
    assert.ok(calls.length > 0);
    for (const call of calls) assert.match(call, /saved: plansRead,/, call);
    // That read changes only where the rows are filled from the server, on the line after them.
    const sets = screen.split("setPlansRead(").length - 1;
    const besideRows =
      (screen.match(/setPlans\(plansFormOf\((\{ plans: res\.plans \}|\w+)\)\);\s+setPlansRead\(savedPlansOf\(\1\)\);/g) ?? []).length +
      (screen.match(/setPlans\(emptyPlansForm\(\)\);\s+setPlansRead\(\[\]\);/g) ?? []).length;
    assert.equal(besideRows, sets);
    assert.equal(screen.split("setPlans(plansFormOf(").length - 1 + (screen.split("setPlans(emptyPlansForm())").length - 1), sets);
  }
  // The Sell tab: not when the rows are kept after a refusal.
  assert.match(SELL_TAB, /if \(!keepPlans\) \{\s+setPlans\(plansFormOf\(listing\)\);\s+setPlansRead\(savedPlansOf\(listing\)\);/);
  // The wizard: the step's own check is measured the same way, and a listing adopted after a refusal is not filled again.
  assert.match(WIZARD, /plans: \{ form: plans, saved: plansRead, limits: planLimits \},/);
  const adoptedBranch = WIZARD.slice(WIZARD.indexOf("if (adopted.current) {"), WIZARD.indexOf("if (filledFor.current === key) return;"));
  assert.ok(adoptedBranch.length > 0);
  assert.equal(adoptedBranch.includes("setPlans"), false);
});

test("the Sell tab shows a line for each plan of a listing on sale, from the creator's own listing", () => {
  assert.match(SELL_TAB, /planSaleLines\(listing\)/);
  assert.match(SELL_TAB, /savedPlansOf\(listing\)/);
  // A refused save of plans keeps the rows as they were typed.
  assert.match(SELL_TAB, /await load\(plansProblem !== null\)/);
});

test("the Sell tab keeps the answer of a save of plans, and a change of plans alone enables Save changes", () => {
  // The ids of new plans come from the answer, not from a reload that can fail.
  assert.match(SELL_TAB, /const res = await marketplaceApi\.setListingPlans\(savedListing\.id, plansSave\.plans, plansSave\.ended\);/);
  assert.match(SELL_TAB, /setPlans\(plansFormOf\(\{ plans: res\.plans \}\)\);/);
  assert.match(SELL_TAB, /listing: \{ \.\.\.\(d\.listing \?\? savedListing\), plans: res\.plans \}/);
  const kept = SELL_TAB.indexOf("setPlans(plansFormOf({ plans: res.plans }))");
  assert.ok(kept > 0 && kept < SELL_TAB.indexOf("await load(plansProblem !== null)"));
  assert.match(SELL_TAB, /const plansUnchanged = plansSaveOf\(\{ sell: form, form: plans, saved: plansRead, limits: planLimits \}\)\.kind === "none";/);
  assert.match(SELL_TAB, /keepCopy === data\.keepCopy\) && plansUnchanged;/);
  // A failed keep-a-copy setting and refused plans are both said.
  assert.match(SELL_TAB, /partSavedLine\(plansProblem, keepProblem\)/);
});

test("after a row is taken away, focus goes to the button that adds one", () => {
  assert.match(BLOCK, /focusAdd\.current = true;\s+onChange\(removePlanRow\(form, row\.key\)\);/);
  assert.match(BLOCK, /addRef\.current\?\.focus\(\);/);
  assert.match(BLOCK, /<Button ref=\{addRef\}/);
});

test("a save refused because the plans changed elsewhere offers Reload beside its sentence, on both screens", () => {
  for (const screen of [SELL_TAB, WIZARD]) {
    // Whether it is offered is the pure file's to say, from the refusal's own code, where the refusal is caught.
    assert.equal(screen.split("plansReloadOffered(codeOf(").length, 2);
    const refused = screen.indexOf("plansRefusedLine(");
    const offered = screen.indexOf("plansReloadOffered(codeOf(");
    assert.ok(refused > 0 && offered > refused && offered - refused < 400);
    // One button, with the pure file's word, that waits while a save is in flight.
    assert.equal(screen.split("{PLANS_RELOAD_WORDS.button}").length, 2);
    assert.match(screen, /onClick=\{\(\) => void reloadPlans\(\)\}/);
    assert.equal(screen.includes('"Reload"'), false);
    // A read that fails keeps the button and says so in the pure file's words.
    assert.ok(screen.includes("PLANS_RELOAD_WORDS.failed"));
    // The next save starts with nothing offered.
    assert.ok(screen.includes("plans_changed") === false);
  }
  // The Sell tab: the button sits under the sentence, only after such a refusal, and the reload is the tab's
  // own load, which fills the rows and the read they are measured against from the listing.
  assert.match(SELL_TAB, /\{error\}\s+<\/p>\s+\{plansStale && \(\s+<Button/);
  assert.match(SELL_TAB, /async function reloadPlans\(\) \{\s+setBusy\("reload"\);\s+const read = await load\(\);/);
  assert.match(SELL_TAB, /setPlansStale\(plansReloadOffered\(codeOf\(err\)\)\);/);
  assert.match(SELL_TAB, /async function save\(sent: SellForm = form\) \{\s+setError\(null\);\s+setPlansStale\(false\);/);
  // The offer goes with its sentence: an edit or a stop that clears the sentence clears the offer too, so the
  // button is never under a sentence about something else. The one place that keeps it is a reload that failed.
  assert.match(SELL_TAB, /function change\(next: SellForm\) \{\s+setForm\(next\);\s+setErrors\(\{\}\);\s+setError\(null\);\s+setPlansStale\(false\);/);
  assert.match(SELL_TAB, /function changePlans\(next: PlansForm\) \{\s+setPlans\(next\);\s+setPlanErrors\(noPlanErrors\(\)\);\s+setError\(null\);\s+setPlansStale\(false\);/);
  assert.match(SELL_TAB, /setBusy\("stop"\);\s+setError\(null\);\s+setPlansStale\(false\);/);
  assert.equal(SELL_TAB.split("setError(null);").length, SELL_TAB.split("setPlansStale(false);").length);
  // The wizard: under the sentence of step 3, for the listing that was refused, read again by its id.
  assert.match(WIZARD, /\{plansProblem\}\s+<\/p>\s+\{plansStaleFor && \(\s+<Button/);
  assert.match(WIZARD, /setPlansStaleFor\(plansReloadOffered\(codeOf\(error\)\) \? listingId : null\);/);
  assert.match(
    WIZARD,
    /const fresh = read\.find\(\(listing\) => listing\.id === plansStaleFor\) \?\? null;\s+setData\([^\n]+\);\s+setPlans\(plansFormOf\(fresh\)\);\s+setPlansRead\(savedPlansOf\(fresh\)\);/,
  );
});
