// The rule an organization's name must pass (packages/shared, reached through
// services/organizationName.ts as the routes reach it): cleaning, each refusal
// in its order, the platform's own name, and lengths counted in code points.
import assert from "node:assert/strict";
import test from "node:test";
import {
  NAME_SENTENCES,
  checkOrganizationName,
  cleanOrganizationName,
  formatUtcMoment,
  nameChangeLimitSentence,
  readsAsThePlatform,
} from "../services/organizationName.js";

const MARKUP = "A name cannot contain line breaks, < or >.";
const INVISIBLE = "A name cannot contain invisible characters.";
const LENGTH = "Give your organization a name of 2 to 60 characters.";
const EMPTY = "A name needs at least one letter or number.";
const RESERVED = "That name is reserved. Choose another.";

const accepted = (input: string) => {
  const result = checkOrganizationName(input);
  assert.equal(result.ok, true, `${JSON.stringify(input)} should be accepted`);
  return (result as { name: string }).name;
};
const refused = (input: string) => {
  const result = checkOrganizationName(input);
  assert.equal(result.ok, false, `${JSON.stringify(input)} should be refused`);
  const { code, message } = result as { code: string; message: string };
  return { code, message };
};

test("the sentences are the ones the rules give", () => {
  assert.deepEqual(NAME_SENTENCES, {
    markup: MARKUP,
    invisible: INVISIBLE,
    length: LENGTH,
    empty: EMPTY,
    reserved: RESERVED,
    taken: "Another seller already uses that name. Choose another.",
  });
});

test("a plain name is stored as it was typed", () => {
  assert.equal(accepted("Northwind AI Labs"), "Northwind AI Labs");
  assert.equal(accepted("blessedbiello"), "blessedbiello");
  assert.equal(accepted("O'Neil & Sons, Ltd."), "O'Neil & Sons, Ltd.");
  assert.equal(accepted("\u00DCn\u00EFcode \u00C7ompany \u682A\u5F0F\u4F1A\u793E"), "\u00DCn\u00EFcode \u00C7ompany \u682A\u5F0F\u4F1A\u793E");
});

test("cleaning trims and turns every run of whitespace into one space", () => {
  assert.equal(accepted("  Northwind   AI  "), "Northwind AI");
  assert.equal(accepted("Northwind\t\tAI"), "Northwind AI");
  assert.equal(accepted("Northwind\u00A0\u2003AI"), "Northwind AI");
  assert.equal(accepted("\u3000Northwind AI\u3000"), "Northwind AI");
  // A line break is whitespace, so cleaning makes it a space before the check.
  assert.equal(accepted("Northwind\r\nAI\n"), "Northwind AI");
  assert.equal(accepted("Northwind\u2028AI"), "Northwind AI");
  assert.equal(cleanOrganizationName(" \t a  b \n"), "a b");
  assert.equal(cleanOrganizationName("   "), "");
});

test("cleaning is Unicode NFKC", () => {
  // Full-width letters, a ligature, and a letter with a separate accent.
  assert.equal(accepted("\uFF2E\uFF4F\uFF52\uFF54\uFF48\uFF57\uFF49\uFF4E\uFF44"), "Northwind");
  assert.equal(accepted("Of\uFB01ce Labs"), "Office Labs");
  assert.equal(accepted("Cafe\u0301 Nord"), "Caf\u00E9 Nord");
  assert.equal(accepted("Cafe\u0301 Nord"), accepted("Caf\u00E9 Nord"));
});

test("a control character, a line break left after cleaning, < and > are refused", () => {
  for (const input of [
    "North\u0000wind",
    "North\u0007wind",
    "North\u001Bwind",
    "North\u007Fwind",
    "North\u0085wind", // NEL, a line break that is not whitespace to the cleaning
    "North\u009Fwind",
    "<b>Northwind</b>",
    "North < wind",
    "Northwind>",
    "<",
    // NFKC turns the full-width signs into the plain ones.
    "\uFF1Cscript\uFF1E",
  ]) {
    assert.deepEqual(refused(input), { code: "invalid_name", message: MARKUP }, JSON.stringify(input));
  }
});

test("every invisible character the rules list is refused, wherever it stands", () => {
  const listed: number[] = [0x00ad, 0xfeff];
  for (let c = 0x200b; c <= 0x200f; c++) listed.push(c);
  for (let c = 0x202a; c <= 0x202e; c++) listed.push(c);
  for (let c = 0x2060; c <= 0x2064; c++) listed.push(c);
  for (let c = 0x2066; c <= 0x2069; c++) listed.push(c);
  assert.equal(listed.length, 21);

  for (const code of listed) {
    const ch = String.fromCodePoint(code);
    const hex = code.toString(16);
    for (const input of [`North${ch}wind`, `${ch}Northwind`, `Northwind${ch}`]) {
      assert.deepEqual(refused(input), { code: "invalid_name", message: INVISIBLE }, `U+${hex}`);
    }
  }
  // The neighbours of the ranges are not on the list.
  assert.equal(accepted("North\u2010wind"), "North\u2010wind");
  assert.equal(accepted("North\u2065wind"), "North\u2065wind");
});

test("half of a surrogate pair is refused, and a whole pair is not", () => {
  for (const input of ["North\uD800wind", "\uDC00Northwind", "Northwind\uD83D", "ab\uDE80\uD83D"]) {
    assert.deepEqual(refused(input), { code: "invalid_name", message: INVISIBLE }, JSON.stringify(input));
  }
  assert.equal(accepted("Northwind \uD83D\uDE80"), "Northwind \u{1F680}");
});

test("cleaning a cleaned name changes nothing", () => {
  for (const input of ["  Of\uFB01ce   Labs\n", "\u00A8 x", "Cafe\u0301\u3000Nord", "\uFDFA 1"]) {
    const once = cleanOrganizationName(input);
    assert.equal(cleanOrganizationName(once), once, JSON.stringify(input));
    assert.ok(!/^ | $| {2}/.test(once), JSON.stringify(once));
  }
});

test("a control character is reported before an invisible one", () => {
  assert.equal(refused("North\u200B<wind").message, MARKUP);
});

test("an invisible character is reported before the length", () => {
  assert.equal(refused("\u200B").message, INVISIBLE);
  assert.equal(refused(`${"a".repeat(80)}\u200B`).message, INVISIBLE);
});

test("fewer than 2 or more than 60 characters is refused, counted after cleaning", () => {
  for (const input of ["", " ", "\n\t", "a", "  a  ", "7", "a".repeat(61), "a".repeat(5000)]) {
    assert.deepEqual(refused(input), { code: "invalid_name", message: LENGTH }, JSON.stringify(input));
  }
  assert.equal(accepted("ab"), "ab");
  assert.equal(accepted("a1"), "a1");
  assert.equal(accepted("a".repeat(60)), "a".repeat(60));
  // 60 after the spaces around it are gone, and after a run inside is one space.
  assert.equal(accepted(`   ${"a".repeat(60)}   `), "a".repeat(60));
  assert.equal(accepted(`${"a".repeat(30)}     ${"b".repeat(29)}`).length, 60);
  assert.equal(refused(`${"a".repeat(30)} ${"b".repeat(30)}`).message, LENGTH);
});

test("length is counted in code points, not in UTF-16 units", () => {
  // NFKC leaves an astral CJK character as it is.
  const cjk = "\u{20000}";
  assert.equal(cjk.normalize("NFKC"), cjk);
  assert.equal(accepted(cjk.repeat(60)), cjk.repeat(60));
  assert.equal(cjk.repeat(60).length, 120);
  assert.equal(refused(cjk.repeat(61)).message, LENGTH);
  assert.equal(refused(cjk).message, LENGTH);
  assert.equal(accepted(cjk.repeat(2)), cjk.repeat(2));
  // An emoji counts once and a name of 31 of them with a letter passes.
  assert.equal(accepted(`a${"\u{1F680}".repeat(31)}`), `a${"\u{1F680}".repeat(31)}`);
});

test("a name with no letter and no number is refused", () => {
  for (const input of ["--", "...", "!?", "& & &", "\u{1F680}\u{1F680}", "__", "( )"]) {
    assert.deepEqual(refused(input), { code: "invalid_name", message: EMPTY }, JSON.stringify(input));
  }
  assert.equal(accepted("-7-"), "-7-");
  assert.equal(accepted("42"), "42");
  assert.equal(accepted("\u0661\u0662"), "\u0661\u0662"); // Arabic-Indic digits are numbers
  assert.equal(accepted("\u{1F680} X"), "\u{1F680} X");
  assert.equal(accepted("\u65E5\u672C"), "\u65E5\u672C");
});

test("the length is reported before the missing letter or number", () => {
  assert.equal(refused("-").message, LENGTH);
  assert.equal(refused("-".repeat(61)).message, LENGTH);
});

test("a name that reads as the platform is reserved", () => {
  for (const input of [
    "WheelsAI",
    "wheelsai",
    "Wheels AI",
    "WHEELS  AI",
    "Wheels-AI",
    "W.h.e.e.l.s.A.I",
    "Wheels AI Labs",
    "WheelsAI Support",
    "wheels_ai_official",
    "(Wheels) AI!",
    "\uFF37\uFF48\uFF45\uFF45\uFF4C\uFF53\uFF21\uFF29",
    "  wheelsai2  ",
    "Wheels AI 2",
    // Anywhere in the name, as a word of its own.
    "My WheelsAI fans",
    "Official Wheels-AI",
    // Letters spelled apart read as one word.
    "W h e e l s A I",
    "Wheels A I",
  ]) {
    assert.deepEqual(refused(input), { code: "name_reserved", message: RESERVED }, JSON.stringify(input));
  }
});

test("a word that only begins like the platform's name is another word", () => {
  for (const input of [
    "Wheels",
    "Wheels A",
    "Wheels Aid",
    "Wheels Airlines",
    "WheelsAir Cargo",
    "AI Wheels",
    "Wheels and AI",
    "Wheels AB",
    "Wheels A.I.D.",
    "WheelsAI2x",
  ]) {
    assert.equal(accepted(input), input);
  }
  assert.equal(readsAsThePlatform("WheelsAI Support"), true);
  assert.equal(readsAsThePlatform("Wheels Aid"), false);
});

test("the reserved check comes last: a reserved name that breaks an earlier rule gets that rule's sentence", () => {
  assert.equal(refused("<WheelsAI>").message, MARKUP);
  assert.equal(refused("Wheels\u200BAI").message, INVISIBLE);
  assert.equal(refused(`WheelsAI ${"x".repeat(60)}`).message, LENGTH);
});

test("the limit sentence says the moment it lifts, in UTC", () => {
  assert.equal(formatUtcMoment(new Date("2026-11-14T00:00:00.000Z")), "00:00 UTC on 14 November 2026");
  assert.equal(formatUtcMoment(new Date("2026-11-14T23:59:59.999Z")), "23:59 UTC on 14 November 2026");
  assert.equal(formatUtcMoment(new Date("2027-01-01T09:05:00.000Z")), "09:05 UTC on 1 January 2027");
  assert.equal(formatUtcMoment(new Date("2026-02-28T12:00:00.000+14:00")), "22:00 UTC on 27 February 2026");
  assert.equal(
    nameChangeLimitSentence(new Date("2026-11-14T08:30:00.000Z")),
    "An organization's name can be changed 3 times in 30 days. It can be changed again after 08:30 UTC on 14 November 2026.",
  );
});

test("what cannot be seen cannot tell two names apart", () => {
  // A variation selector only picks how the character before it is drawn: it is dropped.
  assert.equal(accepted("Acme\uFE0F"), "Acme");
  assert.equal(accepted("Ac\u{E0101}me"), "Acme");
  // The blank braille cell looks like a space and is cleaned as one.
  assert.equal(accepted("Acme\u2800\u2800Labs"), "Acme Labs");
  assert.equal(refused("\u2800\u2800").message, LENGTH);
  // Fillers that count as letters and draw nothing, joiners, private-use and broken characters.
  for (const hidden of ["\u3164", "\u115F", "\u1160", "\uFFA0", "\u034F", "\u200D", "\u061C", "\u180E", "\uE000", "\u{E0041}", "\uD800"]) {
    assert.deepEqual(refused(`North${hidden}wind`), { code: "invalid_name", message: INVISIBLE }, JSON.stringify(hidden));
  }
  // A name of nothing but blank letters is no name.
  assert.equal(refused("\u3164\u3164").message, INVISIBLE);
});

test("no sentence has an em dash or an exclamation mark", () => {
  const sentences = [...Object.values(NAME_SENTENCES), nameChangeLimitSentence(new Date("2026-11-14T08:30:00Z"))];
  for (const sentence of sentences) {
    assert.ok(!sentence.includes("\u2014") && !sentence.includes("!"), sentence);
    assert.match(sentence, /\.$/);
  }
});
