-- Agent endpoints are computed on read from PUBLIC_API_URL
-- (<api>/v1/agents/<slug>). The stored value was a host nothing serves,
-- written at Nosana submit time; clear every such row so no reader of the
-- column can ever show it again.
UPDATE "agent_deployments"
SET "endpoint" = NULL
WHERE "endpoint" LIKE 'https://agents.wheelsai.io/%';

-- A name with no ASCII letters or digits slugified to '' (then '-1', '-2').
-- Those agents have no addressable /v1/agents/<slug> path. Give each one a
-- slug derived from its own id; 12 hex characters of a uuid cannot collide
-- with a name-derived slug inside the org's (org_id, slug) unique index
-- short of a uuid prefix collision.
UPDATE "agents"
SET "slug" = 'agent-' || substr(replace("id"::text, '-', ''), 1, 12)
WHERE "slug" = '' OR "slug" LIKE '-%';
