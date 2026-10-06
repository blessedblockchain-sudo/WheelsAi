import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "12345678901234567890123456789012";

import {
  generatedWorkflowSlugRoot,
  MAX_WORKFLOW_SLUG_ROOT,
  pickWorkflowSlug,
  workflowSlugRoot,
} from "../services/workflowSlug.js";
import {
  workflowApiEndpoints,
  workflowEndpoint,
  workflowOpenAiBaseUrl,
  workflowOpenAiModel,
} from "../services/publicEndpoints.js";

// A workflow's slug is its address under /v1. It has to exist for every
// workflow, be unique inside the organization, and stay put.

test("the slug is derived from the name by the rule agents use", () => {
  assert.equal(workflowSlugRoot("Nightly Report"), "nightly-report");
  assert.equal(workflowSlugRoot("  Lead triage (v2)!  "), "lead-triage-v2");
  assert.equal(workflowSlugRoot("a__b--c"), "a-b-c");
  assert.equal(workflowSlugRoot("Ünïcödé résumé"), "n-c-d-r-sum");
});

test("a name with no ASCII letter or digit derives nothing, and gets a generated root", () => {
  assert.equal(workflowSlugRoot("日本語のワークフロー"), "");
  assert.equal(workflowSlugRoot("---"), "");
  assert.equal(generatedWorkflowSlugRoot("a1b2c3"), "workflow-a1b2c3");
});

test("a long name is cut to the limit without leaving a trailing dash", () => {
  const root = workflowSlugRoot(`${"a".repeat(MAX_WORKFLOW_SLUG_ROOT - 1)} tail of the name`);
  assert.equal(root.length, MAX_WORKFLOW_SLUG_ROOT - 1);
  assert.doesNotMatch(root, /-$/);
});

test("a taken slug gets the next free number", () => {
  assert.equal(pickWorkflowSlug("daily", []), "daily");
  assert.equal(pickWorkflowSlug("daily", ["daily-report"]), "daily");
  assert.equal(pickWorkflowSlug("daily", ["daily"]), "daily-2");
  assert.equal(pickWorkflowSlug("daily", ["daily", "daily-2", "daily-4"]), "daily-3");
});

test("workflow endpoints are built from PUBLIC_API_URL and are null without it", () => {
  const base = "https://api.example.com/";
  assert.equal(workflowOpenAiModel("nightly-report"), "workflow/nightly-report");
  assert.equal(workflowOpenAiBaseUrl("nightly-report", base), "https://api.example.com/v1/workflows/nightly-report");
  assert.equal(
    workflowEndpoint("nightly-report", base),
    "https://api.example.com/v1/workflows/nightly-report/chat/completions",
  );
  assert.deepEqual(workflowApiEndpoints("nightly-report", undefined), {
    apiEndpoint: null,
    openaiBaseUrl: null,
    openaiModel: "workflow/nightly-report",
  });
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

const migration = readFileSync(
  new URL(
    "../../../../packages/db/prisma/migrations/20261008100000_workflow_api_slug_usage_version_entrypoint/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("the migration backfills every row before the column becomes required and unique", () => {
  const add = migration.indexOf('ADD COLUMN "slug" TEXT;');
  const backfill = migration.indexOf('UPDATE "orchestrations" AS o');
  const notNull = migration.indexOf('ALTER COLUMN "slug" SET NOT NULL');
  const unique = migration.indexOf('CREATE UNIQUE INDEX "orchestrations_org_id_slug_key" ON "orchestrations"("org_id", "slug")');
  assert.ok(add >= 0 && backfill > add && notNull > backfill && unique > notNull);
  // Colliding names are separated per organization, oldest first.
  assert.match(migration, /PARTITION BY "org_id", root ORDER BY "created_at", "id"/);
  // The same derivation as workflowSlugRoot.
  assert.match(migration, /regexp_replace\(lower\("name"\), '\[\^a-z0-9\]\+', '-', 'g'\)/);
  assert.ok(migration.includes(`${MAX_WORKFLOW_SLUG_ROOT}\n`), "cut to the same length");
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const definition = (name: string) => ({
  name,
  executionMode: "sequential" as const,
  steps: [{ name: "only", agentId: AGENT_ID, promptTemplate: "{{input.prompt}}" }],
});

async function withOrchestrations<T>(
  fake: Record<string, unknown>,
  body: (svc: typeof import("../services/orchestration.js")) => Promise<T>,
): Promise<T> {
  const { prisma } = (await import("../lib/prisma.js")) as unknown as { prisma: Record<string, any> };
  const svc = await import("../services/orchestration.js");
  const saved = { orchestration: prisma.orchestration, agent: prisma.agent, deployment: prisma.deployment, knowledgeBase: prisma.knowledgeBase };
  const owned = { findMany: async ({ where }: any) => where.id.in.map((id: string) => ({ id })) };
  Object.assign(prisma, { orchestration: fake, agent: owned, deployment: owned, knowledgeBase: owned });
  try {
    return await body(svc);
  } finally {
    Object.assign(prisma, saved);
  }
}

const uniqueViolation = (target: string[]) =>
  Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });

test("create sets the slug from the name, scoped to the organization, and returns where the workflow is served", async () => {
  const creates: any[] = [];
  const lookups: any[] = [];
  const created = await withOrchestrations(
    {
      findMany: async (args: any) => {
        lookups.push(args.where);
        return [{ slug: "nightly-report" }, { slug: "nightly-report-2" }];
      },
      create: async ({ data }: any) => {
        creates.push(data);
        return { id: "wf-1", ...data, steps: [] };
      },
    },
    (svc) => svc.createOrchestration("org-1", definition("Nightly Report") as never),
  );
  assert.deepEqual(lookups, [{ orgId: "org-1", slug: { startsWith: "nightly-report" } }]);
  assert.equal(creates[0].slug, "nightly-report-3");
  assert.equal(creates[0].orgId, "org-1");
  assert.equal(created.slug, "nightly-report-3");
  assert.equal(created.openaiModel, "workflow/nightly-report-3");
  assert.equal("apiEndpoint" in created && "openaiBaseUrl" in created, true);
});

test("two creates that picked the same free slug: the loser reads again and takes the next", async () => {
  let attempts = 0;
  const slugs: string[] = [];
  const created = await withOrchestrations(
    {
      findMany: async () => (attempts === 0 ? [] : [{ slug: "daily" }]),
      create: async ({ data }: any) => {
        slugs.push(data.slug);
        if (attempts++ === 0) throw uniqueViolation(["org_id", "slug"]);
        return { id: "wf-1", ...data, steps: [] };
      },
    },
    (svc) => svc.createOrchestration("org-1", definition("Daily") as never),
  );
  assert.deepEqual(slugs, ["daily", "daily-2"]);
  assert.equal(created.slug, "daily-2");
});

test("a taken NAME is not retried: it propagates for the route's 409 name_taken", async () => {
  let creates = 0;
  await assert.rejects(
    withOrchestrations(
      {
        findMany: async () => [],
        create: async () => {
          creates += 1;
          throw uniqueViolation(["org_id", "name"]);
        },
      },
      (svc) => svc.createOrchestration("org-1", definition("Daily") as never),
    ),
    (err: { code?: string }) => err.code === "P2002",
  );
  assert.equal(creates, 1);
});

test("a name that derives no slug gets a generated one", async () => {
  const created = await withOrchestrations(
    {
      findMany: async () => [],
      create: async ({ data }: any) => ({ id: "wf-1", ...data, steps: [] }),
    },
    (svc) => svc.createOrchestration("org-1", definition("夜間レポート") as never),
  );
  assert.match(created.slug, /^workflow-[0-9a-f]{6}$/);
});

test("renaming a workflow does not move its endpoint", async () => {
  const updates: any[] = [];
  const renamed = await withOrchestrations(
    {
      updateMany: async ({ data }: any) => {
        updates.push(data);
        return { count: 1 };
      },
      findFirstOrThrow: async () => ({ id: "wf-1", name: "Renamed", slug: "nightly-report" }),
    },
    (svc) => svc.updateOrchestration("wf-1", "org-1", { name: "Renamed" }),
  );
  assert.deepEqual(updates, [{ name: "Renamed" }]);
  assert.equal(renamed.openaiModel, "workflow/nightly-report");
});
