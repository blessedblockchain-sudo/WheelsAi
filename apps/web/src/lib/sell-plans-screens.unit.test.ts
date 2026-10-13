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
  assert.match(SELL_TAB, /const plansSave = plansSaveOf\(\{ sell: sent, form: plans, saved: savedPlans, limits: planLimits \}\);/);
  assert.match(WIZARD, /const plansSave = plansSaveOf\(\{ sell, form: plans, saved: savedPlans, limits: planLimits \}\);/);
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
      /if \(plansSave\.kind === "send"\) \{\s+try \{\s+(?:const res = )?await marketplaceApi\.setListingPlans\([\w.]+, plansSave\.plans\);/,
    );
    // A refusal is read from the error's own body and said through the pure file.
    assert.match(screen, /planFieldErrors\(fields\)/);
    assert.match(screen, /plansRefusedLine\(/);
  }
});

test("the Sell tab shows a line for each plan of a listing on sale, from the creator's own listing", () => {
  assert.match(SELL_TAB, /planSaleLines\(listing\)/);
  assert.match(SELL_TAB, /savedPlansOf\(listing\)/);
  // A refused save of plans keeps the rows as they were typed.
  assert.match(SELL_TAB, /await load\(plansProblem !== null\)/);
});

test("the Sell tab keeps the answer of a save of plans, and a change of plans alone enables Save changes", () => {
  // The ids of new plans come from the answer, not from a reload that can fail.
  assert.match(SELL_TAB, /const res = await marketplaceApi\.setListingPlans\(savedListing\.id, plansSave\.plans\);/);
  assert.match(SELL_TAB, /setPlans\(plansFormOf\(\{ plans: res\.plans \}\)\);/);
  assert.match(SELL_TAB, /listing: \{ \.\.\.\(d\.listing \?\? savedListing\), plans: res\.plans \}/);
  const kept = SELL_TAB.indexOf("setPlans(plansFormOf({ plans: res.plans }))");
  assert.ok(kept > 0 && kept < SELL_TAB.indexOf("await load(plansProblem !== null)"));
  assert.match(SELL_TAB, /const plansUnchanged = plansSaveOf\(\{ sell: form, form: plans, saved: savedPlans, limits: planLimits \}\)\.kind === "none";/);
  assert.match(SELL_TAB, /keepCopy === data\.keepCopy\) && plansUnchanged;/);
  // A failed keep-a-copy setting and refused plans are both said.
  assert.match(SELL_TAB, /partSavedLine\(plansProblem, keepProblem\)/);
});

test("after a row is taken away, focus goes to the button that adds one", () => {
  assert.match(BLOCK, /focusAdd\.current = true;\s+onChange\(removePlanRow\(form, row\.key\)\);/);
  assert.match(BLOCK, /addRef\.current\?\.focus\(\);/);
  assert.match(BLOCK, /<Button ref=\{addRef\}/);
});
