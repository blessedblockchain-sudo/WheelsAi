-- Workflows through the OpenAI-compatible API (POST /v1/chat/completions with
-- model "workflow/<slug>", and /v1/workflows/<slug>/chat/completions).

-- 1. A workflow's slug: its address under /v1, unique inside the organization.
--    Derived from the name by the same rule agents use (lowercase, runs of
--    anything but a-z0-9 become one dash, dashes trimmed), cut to 100
--    characters. It is set once on create and does not follow a rename, so an
--    endpoint a customer has integrated keeps working.
ALTER TABLE "orchestrations" ADD COLUMN "slug" TEXT;

-- Backfill. Inside one organization the oldest workflow of each derived slug
-- keeps it; every later one ("Daily report" and "daily-report" both derive
-- "daily-report") gets the slug plus 8 hex characters of its own id. A name
-- with no ASCII letters or digits derives nothing and gets a slug from its id.
WITH derived AS (
  SELECT
    "id",
    "org_id",
    "created_at",
    trim(BOTH '-' FROM left(
      trim(BOTH '-' FROM regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g')),
      100
    )) AS root
  FROM "orchestrations"
),
ranked AS (
  SELECT
    "id",
    root,
    row_number() OVER (PARTITION BY "org_id", root ORDER BY "created_at", "id") AS position
  FROM derived
)
UPDATE "orchestrations" AS o
SET "slug" = CASE
  WHEN r.root = '' THEN 'workflow-' || substr(replace(o."id"::text, '-', ''), 1, 12)
  WHEN r.position = 1 THEN r.root
  ELSE r.root || '-' || substr(replace(o."id"::text, '-', ''), 1, 8)
END
FROM ranked AS r
WHERE r."id" = o."id";

ALTER TABLE "orchestrations" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "orchestrations_org_id_slug_key" ON "orchestrations"("org_id", "slug");

-- 2. Token usage of one step pass, as the provider or the model server
--    reported it: {"inputTokens": n, "outputTokens": n}. NULL means the call
--    reported none (or the pass made no model call), which is not zero. The
--    /v1 answer sums these; one unreported model call omits usage entirely.
ALTER TABLE "orchestration_step_results" ADD COLUMN "usage" JSONB;

-- 3. An agent version records how the agent answered ('chat' or 'graph') so a
--    rollback restores it with the prompt and the graph. NULL on versions
--    taken before this column existed: a rollback to one leaves the agent's
--    entrypoint as it is rather than guessing.
ALTER TABLE "agent_versions" ADD COLUMN "entrypoint" TEXT;
