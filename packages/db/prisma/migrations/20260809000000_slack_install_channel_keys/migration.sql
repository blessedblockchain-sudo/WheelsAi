-- Slack distributed-install support (W2).
--
-- A distributed Slack app has exactly ONE Events Request URL, so inbound
-- events identify themselves only by team_id. Resolving which deployment
-- an event belongs to is therefore impossible unless the install records
-- the workspace id.

ALTER TABLE "openclaw_channels" ADD COLUMN "external_id" TEXT;
ALTER TABLE "openclaw_channels" ADD COLUMN "external_name" TEXT;

-- The resolver used findFirst with no ordering, so duplicate
-- (deployment, platform) rows made channel resolution arbitrary — and a
-- disabled duplicate could shadow a live one. Collapse any duplicates,
-- keeping the most recently updated row, before enforcing uniqueness.
DELETE FROM "openclaw_channels" a
  USING "openclaw_channels" b
  WHERE a."deployment_id" = b."deployment_id"
    AND a."platform" = b."platform"
    AND (a."updated_at" < b."updated_at"
         OR (a."updated_at" = b."updated_at" AND a."ctid" < b."ctid"));

CREATE UNIQUE INDEX "openclaw_channels_deployment_id_platform_key"
  ON "openclaw_channels" ("deployment_id", "platform");

-- One workspace installs into at most one deployment; the second install
-- refuses by name rather than silently capturing the first one's events.
-- Postgres allows many NULLs here, so manually-configured rows (which
-- have no external_id) are unaffected.
CREATE UNIQUE INDEX "openclaw_channels_platform_external_id_key"
  ON "openclaw_channels" ("platform", "external_id");
