/**
 * An organization's name in the dashboard: the rule as the field applies it
 * (the rule itself is the shared package's) and the words about it. Run with:
 *   cd apps/web && npx tsx --test src/lib/organization-name.unit.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ORGANIZATION_CARD_ID,
  ORGANIZATION_NAME_SENTENCES,
  ORGANIZATION_SETTINGS_HREF,
  ORGANIZATION_WORDS,
  checkOrganizationName,
  cleanOrganizationName,
  nameChangeLimitLine,
  organizationNameField,
  organizationRenamedOf,
  organizationRenamedToast,
  retryAtOf,
  soldByLine,
  withOrganizationRenamed,
} from "./organization-name";

const refused = (raw: string) => {
  const check = checkOrganizationName(raw);
  assert.equal(check.ok, false, `expected "${raw}" to be refused`);
  return check.ok ? null : { code: check.code, message: check.message };
};

test("a name is cleaned before it is checked: NFKC, trimmed, one space between words", () => {
  assert.equal(cleanOrganizationName("  Northwind   AI\tLabs  "), "Northwind AI Labs");
  // Full-width letters and a no-break space become their plain forms.
  assert.equal(cleanOrganizationName("\uFF2E\uFF4F\uFF52\uFF54\uFF48\u00A0wind"), "North wind");
  assert.deepEqual(checkOrganizationName("  Northwind   AI Labs "), { ok: true, name: "Northwind AI Labs" });
});

test("whitespace is cleaned as the API cleans it: a tab or a line break between words is one space", () => {
  assert.equal(cleanOrganizationName("Northwind\t\tAI"), "Northwind AI");
  assert.equal(cleanOrganizationName("Northwind\r\nAI\n"), "Northwind AI");
  assert.equal(cleanOrganizationName("Northwind\u2028AI"), "Northwind AI");
  assert.equal(cleanOrganizationName("Northwind\u000B\u000CAI"), "Northwind AI");
  assert.equal(cleanOrganizationName(" \t a  b \n"), "a b");
  assert.deepEqual(checkOrganizationName("North\nwind"), { ok: true, name: "North wind" });
  // U+FEFF is whitespace to JavaScript, and is kept so that it is refused as invisible.
  assert.equal(cleanOrganizationName("North\uFEFFwind"), "North\uFEFFwind");
});

test("control characters, a line break the cleaning leaves, < and > are refused", () => {
  for (const raw of ["North\u0000wind", "North\u0085wind", "North\u007Fwind", "<b>Northwind</b>", "North > wind"]) {
    assert.deepEqual(refused(raw), { code: "invalid_name", message: "A name cannot contain line breaks, < or >." });
  }
});

test("invisible characters are refused", () => {
  for (const hidden of ["\u00AD", "\u200B", "\u200F", "\u202A", "\u202E", "\u2060", "\u2064", "\u2066", "\u2069", "\uFEFF"]) {
    assert.deepEqual(refused(`North${hidden}wind`), {
      code: "invalid_name",
      message: "A name cannot contain invisible characters.",
    });
  }
  // The edges of the ranges are not swept up with them.
  assert.equal(checkOrganizationName("North\u2010wind").ok, true);
});

test("a name has 2 to 60 characters, counted in code points after cleaning", () => {
  const length = { code: "invalid_name", message: "Give your organization a name of 2 to 60 characters." };
  assert.deepEqual(refused(""), length);
  assert.deepEqual(refused("   "), length);
  assert.deepEqual(refused(" a "), length);
  assert.equal(checkOrganizationName("ab").ok, true);
  assert.equal(checkOrganizationName("a".repeat(60)).ok, true);
  assert.deepEqual(refused("a".repeat(61)), length);
  // One emoji is one character, though it is two code units.
  assert.equal(checkOrganizationName(`${"a".repeat(59)}\u{1F680}`).ok, true);
  assert.deepEqual(refused("\u{1F680}"), length);
  // Spaces that are cleaned away do not count.
  assert.equal(checkOrganizationName(`  ${"a".repeat(60)}  `).ok, true);
});

test("a name needs a letter or a number", () => {
  assert.deepEqual(refused("--"), { code: "invalid_name", message: "A name needs at least one letter or number." });
  assert.deepEqual(refused("\u{1F680}\u{1F680}"), {
    code: "invalid_name",
    message: "A name needs at least one letter or number.",
  });
  assert.equal(checkOrganizationName("42").ok, true);
  assert.equal(checkOrganizationName("\u00C9cole").ok, true);
  assert.equal(checkOrganizationName("\u6771\u4EAC").ok, true);
});

test("a name that reads as the platform is reserved", () => {
  const reserved = { code: "name_reserved", message: "That name is reserved. Choose another." };
  for (const raw of ["WheelsAI", "wheels ai", "Wheels.AI Labs", "W-h-e-e-l-s A.I. Support", "\uFF37heelsAI"]) {
    assert.deepEqual(refused(raw), reserved);
  }
  // Anywhere in the name, as a word of its own.
  assert.deepEqual(refused("Built on WheelsAI"), reserved);
  assert.deepEqual(refused("Wheels AI 2"), reserved);
  // A word that only begins like it is another word.
  assert.equal(checkOrganizationName("Wheels Aid").ok, true);
  assert.equal(checkOrganizationName("WheelsAir Cargo").ok, true);
  assert.equal(checkOrganizationName("Wheels and Deals").ok, true);
});

test("the checks run in the rule's order", () => {
  // Markup before length, invisible before length, length before letters.
  assert.equal(refused("<")?.message, ORGANIZATION_NAME_SENTENCES.markup);
  assert.equal(refused("<\u200B")?.message, ORGANIZATION_NAME_SENTENCES.markup);
  assert.equal(refused("\u200B")?.message, ORGANIZATION_NAME_SENTENCES.invisible);
  assert.equal(refused("-")?.message, ORGANIZATION_NAME_SENTENCES.length);
});

test("Save is offered only for a name that differs from the stored one and passes the rule", () => {
  // Untouched: nothing to save, nothing said.
  assert.deepEqual(organizationNameField("demo", "demo", false), { name: "demo", differs: false, error: null, canSave: false });
  // Only spaces were added: the stored name would not change.
  assert.equal(organizationNameField("  demo  ", "demo", true).canSave, false);
  assert.equal(organizationNameField("  demo  ", "demo", true).error, null);
  // Capitals are a change.
  assert.equal(organizationNameField("Demo", "demo", true).canSave, true);
  assert.deepEqual(organizationNameField(" Northwind  AI ", "demo", true), {
    name: "Northwind AI",
    differs: true,
    error: null,
    canSave: true,
  });
});

test("the rule's sentence shows once the field was used", () => {
  assert.equal(organizationNameField("a", "demo", false).error, null);
  assert.equal(organizationNameField("a", "demo", false).canSave, false);
  assert.equal(organizationNameField("a", "demo", true).error, "Give your organization a name of 2 to 60 characters.");
  assert.equal(organizationNameField("", "demo", true).error, "Give your organization a name of 2 to 60 characters.");
  assert.equal(organizationNameField("WheelsAI", "demo", true).error, "That name is reserved. Choose another.");
  assert.equal(organizationNameField("WheelsAI", "demo", true).canSave, false);
});

test("the toast names what buyers see only for an organization that sells", () => {
  assert.equal(organizationRenamedToast("Northwind AI Labs", false), "Organization renamed.");
  assert.equal(organizationRenamedToast("Northwind AI Labs", true), "Organization renamed. Buyers now see Northwind AI Labs.");
});

test("the Sell tab's line links to the card for someone who can rename, and only says the name to anyone else", () => {
  assert.deepEqual(soldByLine("Northwind AI Labs", true), {
    sentence: "Buyers see this as sold by Northwind AI Labs.",
    action: { label: "Change the name", href: "/dashboard/settings#organization" },
  });
  assert.deepEqual(soldByLine("Northwind AI Labs", false), {
    sentence: "Buyers see this as sold by Northwind AI Labs.",
    action: null,
  });
  assert.equal(ORGANIZATION_SETTINGS_HREF, `/dashboard/settings#${ORGANIZATION_CARD_ID}`);
});

test("the words have no em dash and no exclamation mark", () => {
  const all = [
    ...Object.values(ORGANIZATION_WORDS),
    ...Object.values(ORGANIZATION_NAME_SENTENCES),
    organizationRenamedToast("N", true),
    soldByLine("N", true).sentence,
    soldByLine("N", true).action?.label ?? "",
  ];
  for (const words of all) assert.doesNotMatch(words, /[\u2014\u2013!]/, words);
  assert.equal(ORGANIZATION_WORDS.label, "Organization name");
  assert.equal(ORGANIZATION_WORDS.hint, "Teammates see this name. Buyers see it on anything this organization sells.");
  assert.equal(ORGANIZATION_WORDS.readOnly, "Only an owner or admin can change the name.");
  assert.equal(ORGANIZATION_WORDS.save, "Save name");
  assert.equal(ORGANIZATION_WORDS.saving, "Saving...");
});

test("the limit of changes is said with the reader's own clock", () => {
  const retryAt = "2026-11-14T08:30:00.000Z";
  assert.equal(
    nameChangeLimitLine(retryAt, "Africa/Lagos"),
    "An organization's name can be changed 3 times in 30 days. You can change it again after 09:30 on 14 November 2026.",
  );
  assert.equal(
    nameChangeLimitLine(retryAt, "America/Los_Angeles"),
    "An organization's name can be changed 3 times in 30 days. You can change it again after 00:30 on 14 November 2026.",
  );
  // Past midnight where the reader is: their day, not the API's.
  assert.equal(
    nameChangeLimitLine("2026-11-14T20:30:00.000Z", "Asia/Tokyo"),
    "An organization's name can be changed 3 times in 30 days. You can change it again after 05:30 on 15 November 2026.",
  );
  // Not a time: the caller shows the API's sentence.
  assert.equal(nameChangeLimitLine(undefined), null);
  assert.equal(nameChangeLimitLine("soon"), null);
  assert.equal(nameChangeLimitLine(1731573000000), null);
});

test("a refusal's retryAt is read from its body", () => {
  assert.equal(retryAtOf({ status: 429, data: { error: "name_change_limit", retryAt: "2026-11-14T08:30:00.000Z" } }), "2026-11-14T08:30:00.000Z");
  assert.equal(retryAtOf({ status: 409, data: { error: "name_taken" } }), undefined);
  assert.equal(retryAtOf(new Error("offline")), undefined);
  assert.equal(retryAtOf(null), undefined);
});

test("a rename event's detail is read only when it is whole", () => {
  assert.deepEqual(organizationRenamedOf({ id: "o1", name: "Northwind" }), { id: "o1", name: "Northwind" });
  assert.equal(organizationRenamedOf(null), null);
  assert.equal(organizationRenamedOf("o1"), null);
  assert.equal(organizationRenamedOf({ id: "o1" }), null);
  assert.equal(organizationRenamedOf({ id: "", name: "Northwind" }), null);
  assert.equal(organizationRenamedOf({ id: "o1", name: 7 }), null);
});

test("the switcher's list takes the new name for that organization only", () => {
  const orgs = [
    { id: "o1", name: "demo", role: "owner", current: true },
    { id: "o2", name: "Other", role: "member", current: false },
  ];
  assert.deepEqual(withOrganizationRenamed(orgs, { id: "o1", name: "Northwind" }), [
    { id: "o1", name: "Northwind", role: "owner", current: true },
    { id: "o2", name: "Other", role: "member", current: false },
  ]);
  // Nothing to change: the same list, so nothing is drawn again.
  assert.equal(withOrganizationRenamed(orgs, { id: "o3", name: "Northwind" }), orgs);
  assert.equal(withOrganizationRenamed(orgs, { id: "o1", name: "demo" }), orgs);
});
