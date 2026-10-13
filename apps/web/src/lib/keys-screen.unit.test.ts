/**
 * What each key spent today, read off the keys page's source: the line and
 * the note about the day are the pure file's (lib/jobs.ts), and the page
 * works out no amount of its own.
 * Run with:
 *   cd apps/web && npx tsx --test src/lib/keys-screen.unit.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { KEY_SPEND_WORDS } from "./jobs";

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(here, "..", "app/(dashboard)/dashboard/keys/page.tsx"), "utf8");

test("each key's spend is drawn under its caps, from the pure file's line", () => {
  assert.match(PAGE, /const spentToday = keySpentTodayLine\(apiKey\);/);
  assert.match(PAGE, /\{spentToday && <p [^>]*>\{spentToday\}<\/p>\}/);
  // The page reads the spend nowhere else and formats no amount for it.
  assert.equal(PAGE.includes("spentTodayCents"), false);
  assert.equal(PAGE.includes("Spent today"), false);
});

test("a key with no caps is what it was", () => {
  assert.match(PAGE, /\) : \(\s+<span className="text-sm text-muted-foreground">Cannot hire<\/span>/);
});

test("the day is said once, under the list, in the pure file's words", () => {
  assert.match(PAGE, /const spendDayNote = keySpendDayNote\(apiKeys\);/);
  assert.equal(PAGE.split("{spendDayNote}").length, 2);
  assert.match(PAGE, /\{spendDayNote && <p [^>]*>\{spendDayNote\}<\/p>\}/);
  assert.equal(PAGE.includes(KEY_SPEND_WORDS.dayNote), false);
  assert.equal(PAGE.includes("today (UTC)"), false);
});
