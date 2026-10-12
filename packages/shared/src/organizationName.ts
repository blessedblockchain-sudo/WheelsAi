/**
 * The rule an organization's name must pass, shared by the API and the web
 * so the field in the dashboard and the route behind it cannot disagree.
 *
 * The name is what teammates see and what buyers see on everything the
 * organization sells, so the rule also keeps out what would let one seller
 * pass for another or for the platform: text nobody can see, and names that
 * read as WheelsAI itself.
 *
 * Self-contained on purpose (no imports), like payouts.ts and revenue.ts: it
 * must run in a browser.
 */

export const ORGANIZATION_NAME_MIN = 2;
export const ORGANIZATION_NAME_MAX = 60;

/** How often a name may change: this many times in this many days. */
export const ORGANIZATION_NAME_CHANGES = 3;
export const ORGANIZATION_NAME_CHANGE_DAYS = 30;

/** The sentence for each refusal. The API answers with them; the field shows them. */
export const ORGANIZATION_NAME_SENTENCES = {
  markup: "A name cannot contain line breaks, < or >.",
  invisible: "A name cannot contain invisible characters.",
  length: "Give your organization a name of 2 to 60 characters.",
  noLetterOrNumber: "A name needs at least one letter or number.",
  reserved: "That name is reserved. Choose another.",
} as const;

export type OrganizationNameRefusal = "invalid_name" | "name_reserved";

export type OrganizationNameCheck =
  | { ok: true; name: string }
  | { ok: false; code: OrganizationNameRefusal; message: string };

// Whitespace as JavaScript's \s has it, without U+FEFF: that one is invisible
// and is refused below, so the cleaning must leave it in place. The blank
// braille cell (U+2800) looks like a space and is cleaned as one.
const WHITESPACE_RUN = /(?:[^\S\uFEFF]|\u2800)+/gu;
// Variation selectors only pick how the character before them is drawn. They
// are dropped, so a name cannot differ from another by one alone.
const VARIATION_SELECTORS = /[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu;
// Control characters that are not whitespace (those were cleaned away), and markup.
const CONTROL_OR_MARKUP = /[\p{Cc}\u2028\u2029<>]/u;
// Characters that take no room on the screen: format characters (soft hyphen,
// zero-width and direction marks, U+FEFF), private-use and broken characters,
// the joiners and selectors that are not format characters, and the blank
// Hangul fillers, which count as letters.
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cs}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFFA0]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const NOT_LETTER_OR_NUMBER_RUN = /[^\p{L}\p{N}]+/gu;
// The platform's name as a word of its own, written together or apart, with
// or without a number after it: "WheelsAI", "wheels-ai", "Wheels AI 2".
const PLATFORM_NAME = /(^| )wheels ?ai ?\d*( |$)/;

/**
 * What is stored for what was typed: NFKC, variation selectors dropped, every
 * run of whitespace one space, none at either end.
 */
export function cleanOrganizationName(raw: string): string {
  return raw.normalize("NFKC").replace(VARIATION_SELECTORS, "").replace(WHITESPACE_RUN, " ").replace(/^ | $/g, "");
}

/**
 * Whether a cleaned name carries the platform's own name as a word:
 * "WheelsAI Support", "Official Wheels-AI" and "W h e e l s A I" do,
 * "Wheels Aid" does not.
 */
export function readsAsThePlatform(cleaned: string): boolean {
  const words = cleaned.toLowerCase().replace(NOT_LETTER_OR_NUMBER_RUN, " ").trim();
  if (PLATFORM_NAME.test(words)) return true;

  // Letters spelled apart read as one word.
  const joined: string[] = [];
  let spelled = "";
  for (const word of words.split(" ")) {
    if (Array.from(word).length === 1) {
      spelled += word;
      continue;
    }
    if (spelled) joined.push(spelled);
    spelled = "";
    joined.push(word);
  }
  if (spelled) joined.push(spelled);
  return PLATFORM_NAME.test(joined.join(" "));
}

/**
 * Clean, then check, in this order: control characters and markup, invisible
 * characters, the length in code points, a letter or number, the platform's
 * own name.
 * The cleaned name is the one to store.
 */
export function checkOrganizationName(raw: string): OrganizationNameCheck {
  const name = cleanOrganizationName(raw);
  const invalid = (message: string): OrganizationNameCheck => ({ ok: false, code: "invalid_name", message });

  if (CONTROL_OR_MARKUP.test(name)) return invalid(ORGANIZATION_NAME_SENTENCES.markup);
  if (INVISIBLE.test(name)) return invalid(ORGANIZATION_NAME_SENTENCES.invisible);

  const length = Array.from(name).length;
  if (length < ORGANIZATION_NAME_MIN || length > ORGANIZATION_NAME_MAX) {
    return invalid(ORGANIZATION_NAME_SENTENCES.length);
  }
  if (!LETTER_OR_NUMBER.test(name)) return invalid(ORGANIZATION_NAME_SENTENCES.noLetterOrNumber);

  if (readsAsThePlatform(name)) {
    return { ok: false, code: "name_reserved", message: ORGANIZATION_NAME_SENTENCES.reserved };
  }
  return { ok: true, name };
}
