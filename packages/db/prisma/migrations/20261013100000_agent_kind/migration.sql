-- Three kinds of agent: how an agent is used, and the settings that way of
-- using it carries.
--
--   agent_kind   'conversation' (people talk to it), 'task' (a short form
--                in, one result out) or 'scheduled' (it runs on its own).
--                The kind picks the front door and removes nothing: every
--                agent still answers a chat. Not named "kind": /v1/models
--                already answers wheelsai.kind.
--   kind_config  the kind's settings, one key per kind so that changing
--                kind and back loses nothing:
--                  { "task":      { "fields": [ ... ] },
--                    "scheduled": { "schedule": { "cronExpression", "timezone" },
--                                   "prompt": "..." } }
--                A field is { key, label, type, required, help?, options? }.
--                The fields are an array, so their order survives JSONB.
--                The API holds the value to 16 KB (services/agentKind.ts).
--
-- agents           every existing agent becomes 'conversation' by the
--                  default, which is what it was. kind_config is NULL.
-- agent_versions   agent_kind is NULL on versions taken before it was
--                  recorded; a rollback to one makes the agent a
--                  conversation, which is what it was, and leaves its
--                  kind_config as it is.
-- agent_templates  every existing template becomes 'conversation' by the
--                  default. The six seeded templates then get their kind and
--                  their form or suggested schedule, by slug, only where
--                  kind_config IS NULL, so a template an operator has already
--                  given settings is left as it is. customer-support-bot
--                  stays 'conversation' and needs no statement.
--                  packages/db/prisma/seed.ts carries the same values
--                  (apps/api/src/tests/agentKind.unit.test.ts holds the two
--                  together).

-- AlterTable
ALTER TABLE "agents"
  ADD COLUMN "agent_kind" TEXT NOT NULL DEFAULT 'conversation',
  ADD COLUMN "kind_config" JSONB;

ALTER TABLE "agents" ADD CONSTRAINT "agents_agent_kind_check" CHECK ("agent_kind" IN ('conversation', 'task', 'scheduled'));

-- AlterTable
ALTER TABLE "agent_versions"
  ADD COLUMN "agent_kind" TEXT,
  ADD COLUMN "kind_config" JSONB;

ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_kind_check" CHECK ("agent_kind" IS NULL OR "agent_kind" IN ('conversation', 'task', 'scheduled'));

-- AlterTable
ALTER TABLE "agent_templates"
  ADD COLUMN "agent_kind" TEXT NOT NULL DEFAULT 'conversation',
  ADD COLUMN "kind_config" JSONB;

ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_agent_kind_check" CHECK ("agent_kind" IN ('conversation', 'task', 'scheduled'));

-- The seeded templates. Each value is the normalized form the API would
-- store for the same settings.

-- template: code-review-assistant
UPDATE "agent_templates"
SET "agent_kind" = 'task',
    "kind_config" = '{
      "task": {
        "fields": [
          { "key": "code", "label": "Code to review", "type": "long_text", "required": true, "help": "Paste the code or the diff." },
          { "key": "language", "label": "Language", "type": "short_text", "required": false, "help": "For example TypeScript or Python." },
          { "key": "focus", "label": "What to look for", "type": "choice", "required": false, "options": ["Everything", "Bugs", "Security", "Performance", "Style"] }
        ]
      }
    }'::jsonb
WHERE "slug" = 'code-review-assistant' AND "kind_config" IS NULL;

-- template: research-summarizer
UPDATE "agent_templates"
SET "agent_kind" = 'task',
    "kind_config" = '{
      "task": {
        "fields": [
          { "key": "source", "label": "What to summarize", "type": "long_text", "required": true, "help": "Paste the text, or a link to the paper or article." },
          { "key": "length", "label": "Length", "type": "choice", "required": false, "options": ["Short", "Medium", "Detailed"] },
          { "key": "questions", "label": "Questions to answer", "type": "list", "required": false, "help": "One per line." }
        ]
      }
    }'::jsonb
WHERE "slug" = 'research-summarizer' AND "kind_config" IS NULL;

-- template: content-writer
UPDATE "agent_templates"
SET "agent_kind" = 'task',
    "kind_config" = '{
      "task": {
        "fields": [
          { "key": "topic", "label": "Topic", "type": "short_text", "required": true },
          { "key": "format", "label": "Format", "type": "choice", "required": true, "options": ["Blog post", "Social media thread", "Email", "Product description"] },
          { "key": "audience", "label": "Audience", "type": "short_text", "required": false, "help": "Who is it for?" },
          { "key": "tone", "label": "Tone", "type": "short_text", "required": false, "help": "For example friendly, formal or playful." },
          { "key": "keywords", "label": "Keywords", "type": "list", "required": false, "help": "Words to include, one per line." },
          { "key": "length", "label": "Length", "type": "choice", "required": false, "options": ["Short", "Medium", "Long"] }
        ]
      }
    }'::jsonb
WHERE "slug" = 'content-writer' AND "kind_config" IS NULL;

-- template: multi-agent-pipeline
UPDATE "agent_templates"
SET "agent_kind" = 'task',
    "kind_config" = '{
      "task": {
        "fields": [
          { "key": "goal", "label": "Goal", "type": "long_text", "required": true, "help": "What should the finished work achieve?" },
          { "key": "background", "label": "Background", "type": "long_text", "required": false, "help": "Anything the agents should know or use." },
          { "key": "deliverable", "label": "What you want back", "type": "short_text", "required": false, "help": "For example a report, a plan or a comparison." }
        ]
      }
    }'::jsonb
WHERE "slug" = 'multi-agent-pipeline' AND "kind_config" IS NULL;

-- template: trading-signal-agent
UPDATE "agent_templates"
SET "agent_kind" = 'scheduled',
    "kind_config" = '{
      "scheduled": {
        "schedule": { "cronExpression": "0 9 * * *", "timezone": "UTC" },
        "prompt": "Check the market for BTC, ETH and SOL and report today''s trading signals, with the risk for each."
      }
    }'::jsonb
WHERE "slug" = 'trading-signal-agent' AND "kind_config" IS NULL;
