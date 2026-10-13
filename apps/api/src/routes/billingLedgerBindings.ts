/**
 * The Billing page's routes (routes/billingLedger.ts) bound to the database
 * and the clock. Registered in index.ts with the prefix "/api/billing".
 */

import type { FastifyPluginAsync } from "fastify";

import { buildBillingLedgerDeps } from "../services/buildBillingLedgerDeps.js";
import { buildBuyerUsageDeps } from "../services/buildBuyerUsageDeps.js";
import { createBillingLedgerRoutes } from "./billingLedger.js";

export function createBillingLedgerRoutesProduction(): FastifyPluginAsync {
  return createBillingLedgerRoutes({ ledger: buildBillingLedgerDeps(), usage: buildBuyerUsageDeps() });
}
