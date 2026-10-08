/**
 * An agent's public handle: the name in its public address, /a/<handle>.
 *
 * A slug is unique inside one organization, so two organizations can each
 * have a "support-bot". A handle is unique across the platform, which is
 * what lets one address mean one agent.
 *
 * The rules:
 *
 *   - 3 to 40 characters: lower-case letters, digits and hyphens, starting
 *     and ending with a letter or a digit (HANDLE_PATTERN_SOURCE). The
 *     database holds the same pattern, character for character, in the CHECK
 *     agents_public_handle_check.
 *   - not one of RESERVED_HANDLES: names that are, or could be read as, the
 *     platform's own pages or API words.
 *   - made from the agent's slug. On a clash the next candidate is tried:
 *     the slug form, then "<slug>-<first 8 of the id>" with the slug cut so
 *     the suffix still fits, then "agent-<the id>" as the last resort.
 *
 * THE SAME RULE IN TWO PLACES. The migration that introduced handles
 * (packages/db/prisma/migrations/20261013200000_agent_public_page) gives one
 * to every agent that was already public, in SQL. Its backfill is this
 * file's handleCandidates, step for step: the same letters lowered (A to Z
 * only, so the answer never depends on a locale), the same runs replaced by
 * one hyphen, the same trim, the same cuts (40, and 31 before the suffix),
 * the same "agent" stand-in for a slug with nothing usable in it, the same
 * pattern and the same reserved list. A reserved or too-short slug has no
 * slug form in either place, so it falls to the suffixed form in both.
 * apps/api/src/tests/publicHandle.unit.test.ts reads the migration and holds
 * the pattern and the reserved list of the two together.
 *
 * Pure: no imports, nothing here reads the database or the environment.
 * Whether a handle is free is the caller's question (a unique index answers
 * it); this file says which handles may be asked for and in what order.
 */

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 40;

/**
 * The handle rule as a regular expression source. Written so that it means
 * the same in JavaScript and in PostgreSQL (`~`); the migration's CHECK holds
 * this exact text.
 */
export const HANDLE_PATTERN_SOURCE = "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$";
export const HANDLE_PATTERN = new RegExp(HANDLE_PATTERN_SOURCE);

/** Characters of the agent's id that follow the slug on a clash. */
export const HANDLE_SUFFIX_LENGTH = 8;
/** What stands in for a slug with no letter or digit in it. */
export const HANDLE_FALLBACK_BASE = "agent";

/**
 * Names no agent may take. The first group is the web app's own top-level
 * pages (the directories of apps/web/src/app, route groups opened up); the
 * second its dashboard sections; the third words of the API and of accounts
 * that an address could be mistaken for. "a" and "v1" are too short to be a
 * handle at all and are listed so the list reads whole.
 *
 * Adding a name here never takes a handle away from an agent that has it:
 * the list is asked only when a handle is chosen.
 */
export const RESERVED_HANDLES: readonly string[] = Object.freeze([
  // Pages of the web app
  "a",
  "api",
  "contact",
  "docs",
  "explore",
  "marketplace",
  "dashboard",
  "login",
  "register",
  "forgot-password",
  "reset-password",
  "verify-email",
  "invite",
  "about",
  "blog",
  "careers",
  "changelog",
  "privacy",
  "status",
  "templates",
  "terms",
  // Sections of the dashboard
  "agents",
  "analytics",
  "billing",
  "deployments",
  "domains",
  "integrations",
  "jobs",
  "keys",
  "knowledge",
  "memory",
  "models",
  "monitoring",
  "openclaw",
  "orchestrations",
  "playground",
  "scheduler",
  "settings",
  "testing",
  "training",
  // API and account words
  "v1",
  "new",
  "admin",
  "agent",
  "app",
  "www",
  "home",
  "help",
  "support",
  "pricing",
  "account",
  "auth",
  "signin",
  "signup",
  "sign-in",
  "sign-up",
  "logout",
  "widget",
  "embed",
  "leaderboard",
  "wheelsai",
  "null",
  "undefined",
]);

const RESERVED = new Set(RESERVED_HANDLES);

export function isReservedHandle(handle: string): boolean {
  return RESERVED.has(handle);
}

/** True for a handle an agent may have: the pattern holds and the name is not reserved. */
export function isValidHandle(handle: unknown): handle is string {
  return typeof handle === "string" && HANDLE_PATTERN.test(handle) && !RESERVED.has(handle);
}

// ============================================
// Words
// ============================================

export type HandleProblem = "invalid_format" | "reserved" | "taken";

/** What an owner is told about an address they cannot have. */
export const HANDLE_MESSAGES: Record<HandleProblem, string> = {
  invalid_format: `Use ${HANDLE_MIN_LENGTH} to ${HANDLE_MAX_LENGTH} lower-case letters, digits and hyphens, starting and ending with a letter or a digit.`,
  reserved: "That address is reserved. Choose another.",
  // Not decided here (the database knows who has what); here so the three
  // sentences about an address live together.
  taken: "That address is already in use. Choose another.",
};

export interface HandleRefusal {
  code: Exclude<HandleProblem, "taken">;
  message: string;
}

/**
 * Why a handle an owner typed is refused, in plain words, or null when it
 * may be used. The handle is judged as typed: nothing is trimmed or lowered
 * on the way, so what is stored is exactly what the owner saw accepted.
 */
export function handleRefusal(handle: unknown): HandleRefusal | null {
  if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) {
    return { code: "invalid_format", message: HANDLE_MESSAGES.invalid_format };
  }
  if (RESERVED.has(handle)) return { code: "reserved", message: HANDLE_MESSAGES.reserved };
  return null;
}

// ============================================
// From a slug
// ============================================

/** A to Z lowered and nothing else, so the answer is the same in every locale and in SQL (translate). */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * A slug with only handle characters: A to Z lowered, every run of anything
 * else as one hyphen, no hyphen at either end. "" when nothing is left. Not
 * cut and not checked: handleFromSlug and handleCandidates do that.
 */
function handleBase(slug: unknown): string {
  return lowerAscii(typeof slug === "string" ? slug : "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The first `length` characters, without a hyphen left hanging at the end. */
function cut(base: string, length: number): string {
  return base.slice(0, length).replace(/-+$/g, "");
}

/**
 * The best handle for a slug: the slug itself when it already is one, else
 * the slug cleaned and cut to 40. Null when no handle can be made that way:
 * fewer than 3 usable characters, or a reserved name.
 */
export function handleFromSlug(slug: unknown): string | null {
  const handle = cut(handleBase(slug), HANDLE_MAX_LENGTH);
  return isValidHandle(handle) ? handle : null;
}

/**
 * The handles to try for an agent, in order. The caller takes the first one
 * nobody has:
 *
 *   1. the slug form (handleFromSlug), when the slug has one;
 *   2. "<slug>-<first 8 of the id>", the slug cut to 31 so the whole is at
 *      most 40, and "agent" standing in for a slug with nothing usable;
 *   3. "agent-<the id>" (its letters and digits, at most 34), which only
 *      this agent can produce.
 *
 * Every entry passes isValidHandle, and no entry appears twice. The list is
 * empty only for an id with no letter or digit and a slug with no handle.
 */
export function handleCandidates(slug: unknown, agentId: unknown): string[] {
  const base = handleBase(slug);
  const id = lowerAscii(typeof agentId === "string" ? agentId : "").replace(/[^a-z0-9]+/g, "");

  const candidates: Array<string | null> = [handleFromSlug(slug)];
  if (id) {
    const room = HANDLE_MAX_LENGTH - HANDLE_SUFFIX_LENGTH - 1;
    candidates.push(`${cut(base, room) || HANDLE_FALLBACK_BASE}-${id.slice(0, HANDLE_SUFFIX_LENGTH)}`);
    candidates.push(`${HANDLE_FALLBACK_BASE}-${id.slice(0, HANDLE_MAX_LENGTH - HANDLE_FALLBACK_BASE.length - 1)}`);
  }

  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is string => {
    if (!isValidHandle(candidate) || seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}
