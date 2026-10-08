/**
 * services/publicHandle.ts: which names an agent's public address may have,
 * and which are tried, in what order, for a slug.
 *
 * What is pinned here: the pattern (3 to 40 lower-case letters, digits and
 * hyphens, a letter or digit at each end); reserved names are refused; a
 * slug that is short, long, odd or reserved still gets a handle; every
 * candidate is a valid handle; and the migration that gave handles to the
 * agents that were already public holds the same pattern and the same
 * reserved list, and writes what handleCandidates gives.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  HANDLE_FALLBACK_BASE,
  HANDLE_MAX_LENGTH,
  HANDLE_MESSAGES,
  HANDLE_MIN_LENGTH,
  HANDLE_PATTERN,
  HANDLE_PATTERN_SOURCE,
  HANDLE_SUFFIX_LENGTH,
  RESERVED_HANDLES,
  handleCandidates,
  handleFromSlug,
  handleRefusal,
  isReservedHandle,
  isValidHandle,
} from "../services/publicHandle.js";

const repoPath = (path: string) => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(repoPath(path), "utf8");

const ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const ID_HEX = ID.replace(/-/g, "");

describe("a valid handle", () => {
  it("is 3 to 40 lower-case letters, digits and hyphens", () => {
    for (const handle of ["abc", "support-bot", "a1b", "123", "x-y", "a--b", "a".repeat(40), `a${"-".repeat(38)}b`]) {
      assert.equal(isValidHandle(handle), true, handle);
      assert.equal(handleRefusal(handle), null, handle);
    }
  });

  it("is refused when it is too short, too long, or has anything else in it", () => {
    const bad = [
      "",
      "ab",
      "a".repeat(41),
      "Support-Bot",
      "support bot",
      "support_bot",
      "support.bot",
      "-support",
      "support-",
      "---",
      "bot\n",
      "\nbot",
      "bot/x",
      "böt",
      " bot",
    ];
    for (const handle of bad) {
      assert.equal(isValidHandle(handle), false, JSON.stringify(handle));
      assert.deepEqual(handleRefusal(handle), { code: "invalid_format", message: HANDLE_MESSAGES.invalid_format });
    }
    for (const handle of [undefined, null, 42, {}, ["abc"]]) {
      assert.equal(isValidHandle(handle), false);
      assert.equal(handleRefusal(handle)?.code, "invalid_format");
    }
  });

  it("has limits that agree with the pattern", () => {
    assert.equal(HANDLE_MIN_LENGTH, 3);
    assert.equal(HANDLE_MAX_LENGTH, 40);
    assert.equal(HANDLE_PATTERN.source, HANDLE_PATTERN_SOURCE);
    assert.equal(HANDLE_PATTERN.flags, "");
    assert.equal(HANDLE_PATTERN.test("a".repeat(HANDLE_MIN_LENGTH)), true);
    assert.equal(HANDLE_PATTERN.test("a".repeat(HANDLE_MIN_LENGTH - 1)), false);
    assert.equal(HANDLE_PATTERN.test("a".repeat(HANDLE_MAX_LENGTH)), true);
    assert.equal(HANDLE_PATTERN.test("a".repeat(HANDLE_MAX_LENGTH + 1)), false);
  });
});

describe("reserved names", () => {
  it("are refused, in plain words", () => {
    for (const name of RESERVED_HANDLES) {
      assert.equal(isReservedHandle(name), true, name);
      assert.equal(isValidHandle(name), false, name);
      assert.notEqual(handleRefusal(name), null, name);
      assert.equal(handleFromSlug(name), null, name);
    }
    assert.deepEqual(handleRefusal("dashboard"), { code: "reserved", message: "That address is reserved. Choose another." });
    // Too short to be a handle at all: the format is what is wrong with it.
    assert.equal(handleRefusal("a")?.code, "invalid_format");
  });

  it("include the named ones", () => {
    for (const name of ["new", "api", "admin", "login", "settings", "dashboard", "marketplace", "docs", "a", "v1"]) {
      assert.ok(RESERVED_HANDLES.includes(name), name);
    }
  });

  it("include every top-level page of the web app", () => {
    const names: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(repoPath(dir), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        // A route group "(auth)" is not part of the address; what is inside it is.
        if (/^\(.+\)$/.test(entry.name)) walk(`${dir}/${entry.name}`);
        else if (!/^[[_@]/.test(entry.name)) names.push(entry.name);
      }
    };
    walk("apps/web/src/app");
    assert.ok(names.length >= 10, "the web app's pages were found");
    for (const name of names) assert.ok(RESERVED_HANDLES.includes(name), `"${name}" is a page of the web app`);
  });

  it("are lower case, unique, and never look like a suffixed handle", () => {
    assert.equal(new Set(RESERVED_HANDLES).size, RESERVED_HANDLES.length);
    for (const name of RESERVED_HANDLES) {
      assert.match(name, /^[a-z0-9-]+$/);
      // "<slug>-<8 hex of an id>" can then never be a reserved name.
      assert.doesNotMatch(name, /-[0-9a-f]{8}$/);
    }
  });

  it("leave ordinary names alone", () => {
    for (const name of ["support-bot", "docs-helper", "my-api", "newsletter", "admin-assistant"]) {
      assert.equal(isValidHandle(name), true, name);
    }
  });

  it("have words without codes or dashes that read as punctuation", () => {
    for (const message of Object.values(HANDLE_MESSAGES)) {
      assert.doesNotMatch(message, /[—_]/);
      assert.match(message, /\.$/);
    }
    assert.match(HANDLE_MESSAGES.invalid_format, /^Use 3 to 40 lower-case letters, digits and hyphens/);
  });
});

describe("handleFromSlug", () => {
  it("keeps a slug that already is a handle", () => {
    assert.equal(handleFromSlug("support-bot"), "support-bot");
    assert.equal(handleFromSlug("bot-1"), "bot-1");
  });

  it("cleans a slug with other characters", () => {
    assert.equal(handleFromSlug("Support_Bot"), "support-bot");
    assert.equal(handleFromSlug("  My   Bot!! "), "my-bot");
    assert.equal(handleFromSlug("--a.b.c--"), "a-b-c");
    assert.equal(handleFromSlug("café bot"), "caf-bot");
    // Only A to Z are lowered, so the answer is the same in every locale and in SQL.
    assert.equal(handleFromSlug("İstanbul"), "stanbul");
    assert.equal(handleFromSlug("Kelvin"), "elvin");
  });

  it("cuts a long slug to 40, without a hyphen left at the end", () => {
    assert.equal(handleFromSlug("a".repeat(60)), "a".repeat(40));
    assert.equal(handleFromSlug(`${"a".repeat(39)}-${"b".repeat(10)}`), "a".repeat(39));
  });

  it("is null when no handle can be made", () => {
    for (const slug of ["", "ab", "a", "--", "!!!", "日本語", "docs", "API", "Dashboard"]) {
      assert.equal(handleFromSlug(slug), null, JSON.stringify(slug));
    }
    for (const slug of [undefined, null, 7, {}]) assert.equal(handleFromSlug(slug), null);
  });
});

describe("handleCandidates", () => {
  const SLUGS = [
    "support-bot",
    "ab",
    "a",
    "",
    "---",
    "!!!",
    "docs",
    "API",
    "forgot-password",
    "Support_Bot",
    "日本語",
    "a".repeat(60),
    `${"a".repeat(30)}-${"b".repeat(30)}`,
    `${"a".repeat(39)}-b`,
    "x".repeat(31),
    "x".repeat(32),
  ];

  it("tries the slug form, then the suffixed form, then the id form", () => {
    assert.deepEqual(handleCandidates("support-bot", ID), [
      "support-bot",
      "support-bot-1a2b3c4d",
      `agent-${ID_HEX}`,
    ]);
  });

  it("skips the slug form for a short, empty or reserved slug", () => {
    assert.deepEqual(handleCandidates("ab", ID).slice(0, 1), ["ab-1a2b3c4d"]);
    assert.deepEqual(handleCandidates("docs", ID).slice(0, 1), ["docs-1a2b3c4d"]);
    assert.deepEqual(handleCandidates("API", ID).slice(0, 1), ["api-1a2b3c4d"]);
    assert.deepEqual(handleCandidates("", ID).slice(0, 1), [`${HANDLE_FALLBACK_BASE}-1a2b3c4d`]);
    assert.deepEqual(handleCandidates("!!!", ID).slice(0, 1), ["agent-1a2b3c4d"]);
  });

  it("cuts a long slug so the suffix still fits in 40", () => {
    const [first, second] = handleCandidates("a".repeat(60), ID);
    assert.equal(first, "a".repeat(40));
    assert.equal(second, `${"a".repeat(31)}-1a2b3c4d`);
    assert.equal(second!.length, HANDLE_MAX_LENGTH);

    // A cut that lands on a hyphen drops it.
    assert.equal(handleCandidates(`${"a".repeat(30)}-${"b".repeat(30)}`, ID)[1], `${"a".repeat(30)}-1a2b3c4d`);
  });

  it("gives only valid handles, each once, for every kind of slug", () => {
    for (const slug of SLUGS) {
      const candidates = handleCandidates(slug, ID);
      assert.ok(candidates.length >= 2, JSON.stringify(slug));
      assert.equal(new Set(candidates).size, candidates.length, JSON.stringify(slug));
      for (const candidate of candidates) {
        assert.equal(isValidHandle(candidate), true, `${JSON.stringify(slug)} -> ${candidate}`);
        assert.ok(candidate.length <= HANDLE_MAX_LENGTH);
      }
      // The suffix is the first 8 characters of the id.
      assert.ok(candidates.some((c) => c.endsWith(`-${ID_HEX.slice(0, HANDLE_SUFFIX_LENGTH)}`)));
      // The last resort is the same whatever the slug.
      assert.equal(candidates.at(-1), `agent-${ID_HEX}`);
    }
  });

  it("starts with handleFromSlug whenever the slug has a handle", () => {
    for (const slug of SLUGS) {
      const fromSlug = handleFromSlug(slug);
      if (fromSlug) assert.equal(handleCandidates(slug, ID)[0], fromSlug);
    }
  });

  it("gives two agents with one slug different handles after the first", () => {
    const other = "9f8e7d6c-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const mine = handleCandidates("support-bot", ID);
    const theirs = handleCandidates("support-bot", other);
    assert.equal(mine[0], theirs[0]);
    assert.notEqual(mine[1], theirs[1]);
    assert.notEqual(mine[2], theirs[2]);
  });

  it("never throws for an id or slug that is not text", () => {
    assert.deepEqual(handleCandidates("support-bot", undefined), ["support-bot"]);
    assert.deepEqual(handleCandidates(null, null), []);
    assert.deepEqual(handleCandidates("docs", ""), []);
  });
});

describe("the migration that gave public agents a handle", () => {
  const migration = read("packages/db/prisma/migrations/20261013200000_agent_public_page/migration.sql");
  // Statements only: the comments say what the SQL does, the SQL is what runs.
  const sql = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("holds public_handle to the same pattern, character for character", () => {
    assert.ok(
      sql.includes(
        `ADD CONSTRAINT "agents_public_handle_check" CHECK ("public_handle" ~ '${HANDLE_PATTERN_SOURCE}')`,
      ),
    );
    // And uses no other pattern anywhere: each pass filters by the same one.
    const patterns = [...sql.matchAll(/~ '([^']+)'/g)].map((match) => match[1]);
    assert.equal(patterns.length, 3);
    for (const pattern of patterns) assert.equal(pattern, HANDLE_PATTERN_SOURCE);
  });

  it("carries the same reserved names", () => {
    const block = /-- reserved-handles:start[^\n]*\n([\s\S]*?)-- reserved-handles:end/.exec(migration)?.[1];
    assert.ok(block, "the reserved list is between its two markers");
    const names = [...block.matchAll(/\('([^']+)'\)/g)].map((match) => match[1]!);
    assert.equal(new Set(names).size, names.length);
    // The migration ran once, with the names reserved on that day; the list
    // in the code may grow afterwards and must never lose one of them.
    for (const name of names) assert.ok(RESERVED_HANDLES.includes(name), name);
    // On that day the two were the same list.
    assert.deepEqual(names, RESERVED_HANDLES.slice(0, names.length));
    assert.ok(names.length >= 63);
  });

  it("makes handles by the same steps as handleCandidates", () => {
    // A to Z lowered and nothing else.
    assert.ok(sql.includes(`translate(a."slug", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`));
    assert.doesNotMatch(sql, /\blower\(/i);
    // Runs of anything else become one hyphen; hyphens at the ends go.
    assert.ok(sql.includes(`'[^a-z0-9-]+', '-', 'g'`));
    // The cuts: 40 for the slug form, 31 before "-" and 8 characters.
    assert.ok(sql.includes(`rtrim(left(b."base", ${HANDLE_MAX_LENGTH}), '-')`));
    assert.ok(sql.includes(`rtrim(left(b."base", ${HANDLE_MAX_LENGTH - HANDLE_SUFFIX_LENGTH - 1}), '-')`));
    assert.ok(sql.includes(`left(replace(a."id"::text, '-', ''), ${HANDLE_SUFFIX_LENGTH})`));
    assert.ok(sql.includes(`'${HANDLE_FALLBACK_BASE}') || '-' || b."id8"`));
    assert.ok(sql.includes(`'${HANDLE_FALLBACK_BASE}-' || replace(a."id"::text, '-', '')`));
    // Earliest first.
    assert.equal([...sql.matchAll(/ORDER BY s\."created_at", s\."id"/g)].length, 2);
  });

  it("gives handles to public agents only, and only where there is none", () => {
    assert.ok(sql.includes(`WHERE a."is_public" = true AND a."public_handle" IS NULL`));
    assert.equal([...sql.matchAll(/^UPDATE /gm)].length, 3);
    const updates = sql.split(/^UPDATE (?="agents" a$)/m).slice(1);
    assert.equal(updates.length, 3);
    for (const update of updates) {
      assert.match(update, /^"agents" a\s+SET "public_handle" =/);
      assert.match(update, /a\."public_handle" IS NULL/);
      assert.match(update, /NOT EXISTS \(\s*SELECT 1 FROM "agents" o WHERE o\."public_handle" =/);
      assert.match(update, /"_agent_public_handle_backfill"/);
    }
  });

  it("creates and changes no widget key", () => {
    assert.doesNotMatch(sql, /INSERT INTO "widget_keys"/i);
    assert.doesNotMatch(sql, /UPDATE\s+"widget_keys"/i);
    assert.doesNotMatch(sql, /DELETE FROM/i);
    // The only thing written to agents is the handle.
    assert.deepEqual(
      [...sql.matchAll(/SET "(\w+)"/g)].map((match) => match[1]),
      ["public_handle", "public_handle", "public_handle"],
    );
  });

  it("describes the columns the Prisma schema declares", () => {
    const schema = read("packages/db/prisma/schema.prisma");
    assert.match(schema, /publicHandle\s+String\?\s+@unique\s+@map\("public_handle"\)/);
    assert.match(schema, /publicResults\s+Boolean\s+@default\(false\)\s+@map\("public_results"\)/);
    assert.match(schema, /pageOfAgentId\s+String\?\s+@unique\s+@map\("page_of_agent_id"\)\s+@db\.Uuid/);
    assert.match(
      schema,
      /pageOfAgent\s+Agent\?\s+@relation\("AgentPageKey", fields: \[pageOfAgentId\], references: \[id\], onDelete: Cascade\)/,
    );

    assert.match(sql, /ADD COLUMN "public_handle" TEXT,\s+ADD COLUMN "public_results" BOOLEAN NOT NULL DEFAULT false;/);
    assert.ok(sql.includes(`CREATE UNIQUE INDEX "agents_public_handle_key" ON "agents"("public_handle");`));
    assert.ok(sql.includes(`ALTER TABLE "widget_keys" ADD COLUMN "page_of_agent_id" UUID;`));
    assert.ok(
      sql.includes(`CREATE UNIQUE INDEX "widget_keys_page_of_agent_id_key" ON "widget_keys"("page_of_agent_id");`),
    );
    assert.ok(
      sql.includes(
        `ADD CONSTRAINT "widget_keys_page_of_agent_id_fkey" FOREIGN KEY ("page_of_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      ),
    );
  });
});
