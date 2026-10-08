-- One public address per agent, and the key that lets people use it there.
--
--   agents.public_handle   the name in /a/<handle>, unique across the
--                          platform (a slug is unique only inside one
--                          organization, so two organizations could each
--                          have a "support-bot" and one address could mean
--                          either). NULL until the agent is first public.
--   agents.public_results  a scheduled agent's latest results are shown on
--                          its public page only when its owner turns this on.
--   widget_keys.page_of_agent_id
--                          set on the ONE key that serves an agent's public
--                          page, to that agent's id. Unique, so an agent has
--                          at most one page key. Cleared on revoke.
--
-- Two switches make a page usable, and both are needed: is_public shows the
-- page, and a page key lets people use the agent from it. THIS MIGRATION
-- CREATES AND CHANGES NO WIDGET KEY. Agents that are public today get a
-- handle and nothing else, so their pages stay view-only and nobody starts
-- using them unasked.
--
-- The handle rule: 3 to 40 characters, lower-case letters, digits and
-- hyphens, starting and ending with a letter or a digit. The pattern in
-- agents_public_handle_check is, character for character,
-- HANDLE_PATTERN_SOURCE in apps/api/src/services/publicHandle.ts. Names of
-- the platform's own pages are refused by the API when a handle is chosen;
-- the CHECK does not carry that list, so the list can grow without a
-- migration.
--
-- THE BACKFILL IS handleCandidates() OF THAT FILE, IN SQL, step for step:
-- the same letters lowered (A to Z only, by translate(), so the answer never
-- depends on the database's locale), the same runs replaced by one hyphen,
-- the same trim, the same cuts (40, and 31 before the suffix), the same
-- 'agent' stand-in, the same pattern and the same reserved list.
-- apps/api/src/tests/publicHandle.unit.test.ts reads this file and holds the
-- pattern and the reserved list of the two together.

-- AlterTable
ALTER TABLE "agents"
  ADD COLUMN "public_handle" TEXT,
  ADD COLUMN "public_results" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "agents" ADD CONSTRAINT "agents_public_handle_check" CHECK ("public_handle" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');

-- CreateIndex
CREATE UNIQUE INDEX "agents_public_handle_key" ON "agents"("public_handle");

-- AlterTable
ALTER TABLE "widget_keys" ADD COLUMN "page_of_agent_id" UUID;

-- A page key serves the page of the agent it answers for, never another's.
ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_page_of_agent_check" CHECK ("page_of_agent_id" IS NULL OR "page_of_agent_id" = "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "widget_keys_page_of_agent_id_key" ON "widget_keys"("page_of_agent_id");

-- AddForeignKey
-- CASCADE, as widget_keys.agent_id has: a key goes with its agent.
ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_page_of_agent_id_fkey" FOREIGN KEY ("page_of_agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================
-- Backfill: a handle for every agent that is public today
-- ============================================
--
-- Private agents are not touched and stay NULL. Every statement below
-- writes only where public_handle IS NULL and only a handle nobody has, so
-- running the backfill again changes nothing.
--
-- How each kind of slug is handled:
--
--   an ordinary slug     the earliest public agent with it (by created_at,
--   ("support-bot")      then id) keeps the slug as its handle. Later ones
--                        get "<slug>-<first 8 characters of the id>".
--   other characters     upper-case A to Z are lowered and every run of
--                        anything that is not a-z, 0-9 or a hyphen becomes
--                        one hyphen; hyphens at either end are dropped. Two
--                        slugs that come out the same count as one slug:
--                        the earliest keeps it, the others are suffixed.
--   too long             cut to 40 for the slug form; cut to 31 for the
--                        suffixed form, so "-" and 8 characters still fit in
--                        40. A hyphen left hanging by a cut is dropped.
--   too short            fewer than 3 usable characters has no slug form
--                        (the pattern refuses it) and gets the suffixed
--                        form: "ab" becomes "ab-1a2b3c4d".
--   nothing usable       'agent' stands in: "agent-1a2b3c4d".
--   a reserved name      has no slug form and gets the suffixed form:
--                        "docs" becomes "docs-1a2b3c4d".
--   a clash on the       (two agents whose suffixed forms are equal, or a
--   suffixed form        suffixed form another agent's slug already took)
--                        the later agent gets "agent-<its whole id>", which
--                        only it can produce.
--
-- Nothing here can break the CHECK or the unique index: each pass keeps only
-- candidates the pattern accepts, gives a candidate to one agent at most,
-- and skips a candidate some agent already holds. An agent that every pass
-- had to skip would be left NULL rather than fail the migration. After a
-- clean run this counts none:
--   SELECT count(*) FROM agents WHERE is_public AND public_handle IS NULL;

DROP TABLE IF EXISTS "_reserved_public_handles";
CREATE TEMPORARY TABLE "_reserved_public_handles" ("name" TEXT PRIMARY KEY);

-- reserved-handles:start (the same names as RESERVED_HANDLES in publicHandle.ts)
INSERT INTO "_reserved_public_handles" ("name") VALUES
  ('a'), ('api'), ('contact'), ('docs'), ('explore'), ('marketplace'), ('dashboard'),
  ('login'), ('register'), ('forgot-password'), ('reset-password'), ('verify-email'),
  ('invite'), ('about'), ('blog'), ('careers'), ('changelog'), ('privacy'), ('status'),
  ('templates'), ('terms'),
  ('agents'), ('analytics'), ('billing'), ('deployments'), ('domains'), ('integrations'),
  ('jobs'), ('keys'), ('knowledge'), ('memory'), ('models'), ('monitoring'), ('openclaw'),
  ('orchestrations'), ('playground'), ('scheduler'), ('settings'), ('testing'), ('training'),
  ('v1'), ('new'), ('admin'), ('agent'), ('app'), ('www'), ('home'), ('help'), ('support'),
  ('pricing'), ('account'), ('auth'), ('signin'), ('signup'), ('sign-in'), ('sign-up'),
  ('logout'), ('widget'), ('embed'), ('leaderboard'), ('wheelsai'), ('null'), ('undefined');
-- reserved-handles:end

-- Each public agent without a handle, with its slug as handle characters
-- ("base") and the first 8 characters of its id.
DROP TABLE IF EXISTS "_agent_public_handle_backfill";
CREATE TEMPORARY TABLE "_agent_public_handle_backfill" AS
SELECT
  a."id",
  a."created_at",
  btrim(
    regexp_replace(
      translate(a."slug", 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
      '[^a-z0-9-]+', '-', 'g'
    ),
    '-'
  ) AS "base",
  left(replace(a."id"::text, '-', ''), 8) AS "id8"
FROM "agents" a
WHERE a."is_public" = true AND a."public_handle" IS NULL;

-- Pass 1: the slug form, to the earliest agent per form.
UPDATE "agents" a
SET "public_handle" = c."handle"
FROM (
  SELECT
    s."id",
    s."handle",
    row_number() OVER (PARTITION BY s."handle" ORDER BY s."created_at", s."id") AS "rank"
  FROM (
    SELECT b."id", b."created_at", rtrim(left(b."base", 40), '-') AS "handle"
    FROM "_agent_public_handle_backfill" b
  ) s
  WHERE s."handle" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
    AND NOT EXISTS (SELECT 1 FROM "_reserved_public_handles" r WHERE r."name" = s."handle")
) c
WHERE a."id" = c."id"
  AND c."rank" = 1
  AND a."public_handle" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "agents" o WHERE o."public_handle" = c."handle");

-- Pass 2: "<slug>-<first 8 of the id>" for every agent pass 1 left without
-- one (a later agent with the same slug, or a slug with no slug form).
UPDATE "agents" a
SET "public_handle" = c."handle"
FROM (
  SELECT
    s."id",
    s."handle",
    row_number() OVER (PARTITION BY s."handle" ORDER BY s."created_at", s."id") AS "rank"
  FROM (
    SELECT
      b."id",
      b."created_at",
      COALESCE(NULLIF(rtrim(left(b."base", 31), '-'), ''), 'agent') || '-' || b."id8" AS "handle"
    FROM "_agent_public_handle_backfill" b
    JOIN "agents" x ON x."id" = b."id"
    WHERE x."public_handle" IS NULL
  ) s
  WHERE s."handle" ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'
    AND NOT EXISTS (SELECT 1 FROM "_reserved_public_handles" r WHERE r."name" = s."handle")
) c
WHERE a."id" = c."id"
  AND c."rank" = 1
  AND a."public_handle" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "agents" o WHERE o."public_handle" = c."handle");

-- Pass 3: "agent-<the whole id>" (6 + 32 characters) for an agent whose
-- suffixed form was taken too. Unique by construction: the id is.
UPDATE "agents" a
SET "public_handle" = 'agent-' || replace(a."id"::text, '-', '')
FROM "_agent_public_handle_backfill" b
WHERE a."id" = b."id"
  AND a."public_handle" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "agents" o WHERE o."public_handle" = 'agent-' || replace(a."id"::text, '-', '')
  );

DROP TABLE "_agent_public_handle_backfill";
DROP TABLE "_reserved_public_handles";
