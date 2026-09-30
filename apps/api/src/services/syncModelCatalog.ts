/**
 * Upsert the in-code model catalog into the `models` table at boot.
 *
 * POST /api/deployments requires a `models` row, and the only writer used
 * to be the dev seed script, which no deploy path runs: on a fresh
 * production database every model deployment answered 400 "Model not
 * found". Rows not in the catalog are left alone (existing deployments
 * may reference them).
 */
import { MODEL_CATALOG, type CatalogModel } from "../config/modelCatalog.js";

export interface ModelCatalogDb {
  model: {
    upsert(args: {
      where: { id: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export function toModelRow(m: CatalogModel): Record<string, unknown> {
  return {
    id: m.id,
    hfId: m.hfId,
    ollamaModelId: m.ollamaModelId ?? null,
    displayName: m.displayName,
    description: m.description ?? null,
    parameters: m.parameters != null ? BigInt(m.parameters) : null,
    minGpuTier: m.minGpuTier,
    supportedEngines: [...m.supportedEngines],
    defaultEngine: m.defaultEngine,
    contextLength: m.contextLength,
    license: m.license ?? null,
    tags: [...m.tags],
    pricingTier: m.pricingTier,
    isActive: true,
  };
}

export async function syncModelCatalog(
  db: ModelCatalogDb,
  catalog: readonly CatalogModel[] = MODEL_CATALOG,
): Promise<number> {
  for (const m of catalog) {
    const row = toModelRow(m);
    const { id, ...fields } = row;
    await db.model.upsert({ where: { id: id as string }, create: row, update: fields });
  }
  return catalog.length;
}
