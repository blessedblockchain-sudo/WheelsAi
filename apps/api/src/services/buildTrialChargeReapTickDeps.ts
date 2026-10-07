/**
 * Composition root for the trial-charge reaper
 * (services/runTrialChargeReapTick.ts): the stale-charge query and the
 * refund, on Prisma.
 */

import { prisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import type { TrialChargeReapTickDeps } from "./runTrialChargeReapTick.js";
import { createTrialFunding, type TrialFundingDb } from "./trialFunding.js";

const logger = createLogger("trial-charge-reaper");

export interface TrialChargeReapPrisma extends TrialFundingDb {
  trialCharge: TrialFundingDb["trialCharge"] & {
    findMany(args: {
      where: { status: "held"; createdAt: { lt: Date } };
      orderBy: { createdAt: "asc" };
      take: number;
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
}

export function bindTrialChargeReapTickDeps(db: TrialChargeReapPrisma): TrialChargeReapTickDeps {
  // A refund pays back what the charge recorded, so the price of a message
  // today is never read here.
  const funding = createTrialFunding(db, { messageCents: () => 0n });
  return {
    findStaleHeld: async ({ createdBefore, take }) => {
      const rows = await db.trialCharge.findMany({
        where: { status: "held", createdAt: { lt: createdBefore } },
        orderBy: { createdAt: "asc" },
        take,
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },
    refund: (chargeId, reason) => funding.refund(chargeId, reason),
    logger,
  };
}

export function buildTrialChargeReapTickDeps(): TrialChargeReapTickDeps {
  return bindTrialChargeReapTickDeps(prisma as unknown as TrialChargeReapPrisma);
}
