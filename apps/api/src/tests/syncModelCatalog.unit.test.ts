import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_CATALOG } from "../config/modelCatalog.js";
import { syncModelCatalog, toModelRow } from "../services/syncModelCatalog.js";

// POST /api/deployments needs a models row, and only the dev seed wrote
// them: a fresh production database 400'd every model deployment.

test("every catalog model is upserted with bigint parameters", async () => {
  const calls: any[] = [];
  const n = await syncModelCatalog({ model: { upsert: async (args) => void calls.push(args) } });
  assert.equal(n, MODEL_CATALOG.length);
  assert.equal(calls.length, MODEL_CATALOG.length);
  for (const c of calls) {
    assert.equal(c.where.id, c.create.id);
    assert.equal("id" in c.update, false);
    assert.equal(c.create.isActive, true);
    if (c.create.parameters !== null) assert.equal(typeof c.create.parameters, "bigint");
  }
});

test("rows carry exactly the columns the models table has", () => {
  const row = toModelRow(MODEL_CATALOG[0]!);
  assert.deepEqual(Object.keys(row).sort(), [
    "contextLength",
    "defaultEngine",
    "description",
    "displayName",
    "hfId",
    "id",
    "isActive",
    "license",
    "minGpuTier",
    "ollamaModelId",
    "parameters",
    "pricingTier",
    "supportedEngines",
    "tags",
  ]);
});

test("the catalog has the 21 models the landing page states", () => {
  assert.equal(MODEL_CATALOG.length, 21);
  assert.equal(new Set(MODEL_CATALOG.map((m) => m.id)).size, 21);
});
