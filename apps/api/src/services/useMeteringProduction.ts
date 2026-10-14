/**
 * Composition root for the charge of one paid use (services/useMetering.ts).
 *
 * The chat core takes its charge from `deps.beginMetering`
 * (services/agentChat.ts, step 5). For a buyer's copy that is
 * beginMarketplaceMetering, which looks the licence up from the agent that
 * is running. A paid use runs the CREATOR's agent, which has no licence to
 * look up, so the paid service decides the charge first (resolveUseBilling)
 * and hands the core a `beginMetering` bound to that ONE licence and that
 * ONE decided charge:
 *
 *   beginUseMetering({ agentId, install, apiKeyId, unit })
 *     .beginMetering   what the core calls, once, as its last step that can
 *                      refuse: chargeUse (the debit, the pending row and its
 *                      ledger line, then the key's reservation, in one
 *                      transaction).
 *     .refusal()       why the charge was refused, exactly as chargeUse said
 *                      it. The core's own refusal type has room only for
 *                      "cannot pay", so a key's cap travels there as one and
 *                      is read back from here.
 *     .charge()        the charge that was taken.
 *     .noteRun(...)    what the run used. The handle's settle repays the
 *                      model cost from it: platformModelCostMicros over
 *                      platformUsageOf, and only when the run used the
 *                      platform's model keys. An agent on the creator's own
 *                      key repays nothing.
 *     .notePlatformUsage(...)
 *                      the same for a run of many model calls (a paid run of
 *                      a workflow): the READY sum of what its steps used on
 *                      the platform's keys, or null when none ran on them.
 *                      The settle takes the model cost from it exactly as it
 *                      does after noteRun.
 *
 * `install: null` is a subscribed use: `beginMetering` answers null, and
 * nothing is charged or reserved.
 *
 * `plan` is a use on a plan (a subscription with a count of uses). The same
 * last step takes ONE included use (services/planUse.ts) instead of money,
 * and the handle it returns gives that use back on `refund`, so every ending
 * that would refund a charge returns the use. A take that changed nothing is
 * not proof the plan is used up: the row is read again, and only a row still
 * in the same period, on the same terms, with every use gone, is used up.
 * Then the use is charged at the extra price the buyer agreed to (the same
 * chargeUse as any priced use), or, when they agreed to none, refused with
 * nothing charged. That charge claims the row first, inside its own
 * transaction: a compare-and-set on the period, the terms and the count that
 * were just read, which changes nothing and holds the row until the charge
 * commits. A renewal that got in first makes the claim miss and nothing is
 * charged; one that comes after waits for the charge. A row that changed (a
 * renewal, a move to another plan) is decided once more from the fresh row,
 * and only ever as an included use.
 *   .planUse()       how the use was paid for, and the plan's count for the
 *                    reply; null when the use is not on a plan, or none ran.
 *
 * Fail closed: the binding charges once, for the agent it was made for. A
 * second call, or a call for another agent, throws before anything is
 * written, so the core refuses and no model is called.
 *
 * Settlement failures never fail the caller's request, as in
 * services/marketplaceMeteringProduction.ts: a settle that could not commit
 * leaves the revenue row `pending`, which is queryable and recoverable, and
 * is logged loudly here.
 */

import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { createLogger } from "../utils/logger.js";
import type { AgentChatDeps } from "./agentChat.js";
import { platformModelCostMicros, type TokenUsage } from "./jobRunner.js";
import type { MarketplaceCharge, MeteredInstall } from "./marketplaceMetering.js";
import type { BeginMeteringResult, MeteringHandle } from "./marketplaceMeteringProduction.js";
import { giveBackIncludedUse, takeIncludedUse, type PlanUseTx } from "./planUse.js";
import {
  chargeUse,
  refundUse,
  settleUse,
  type UseChargeResult,
  type UseMeteringDeps,
  type UseMeteringTx,
  type UsePlan,
  type UsePlanCount,
  type UsePlanRefusal,
  type UsePlanUse,
  type UseUnit,
} from "./useMetering.js";
import { platformUsageOf } from "./watchedWorkflowExecutor.js";

const logger = createLogger("use-metering");

/** The columns of a plan's subscription row the count is decided from. */
export const PLAN_COUNT_COLUMNS = {
  id: true,
  status: true,
  planId: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  includedUses: true,
  usedInPeriod: true,
  carriedUses: true,
  extraUsePriceCents: true,
} as const;

export interface PlanCountRow {
  id: string;
  status: string;
  planId: string | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  includedUses: number | null;
  usedInPeriod: number;
  carriedUses: number;
  extraUsePriceCents: bigint | null;
}

/** What the count of a plan needs of the database. Prisma's client satisfies it. */
export interface PlanCountDb {
  agentSubscription: PlanUseTx["agentSubscription"] & {
    findUnique(args: { where: { id: string }; select: typeof PLAN_COUNT_COLUMNS }): Promise<PlanCountRow | null>;
  };
}

/** The statuses takeIncludedUse takes from (services/planUse.ts). */
const OPEN_STATUSES = ["active", "past_due"];

/**
 * The claim an extra-price charge makes on the plan's row, in the charge's
 * own transaction: the row exactly as it was read, with every use gone.
 */
export interface PlanExtraClaimTx {
  agentSubscription: {
    updateMany(args: {
      where: {
        id: string;
        currentPeriodStart: Date;
        status: { in: string[] };
        planId: string | null;
        includedUses: number;
        carriedUses: number;
        extraUsePriceCents: bigint | null;
        usedInPeriod: { gte: number };
      };
      data: { usedInPeriod: { increment: 0 } };
    }): Promise<{ count: number }>;
  };
}

/** The plan's row was not what the extra price was decided on. Thrown inside the charge's transaction, which rolls back. */
class PlanRowMovedError extends Error {
  constructor() {
    super("the plan's row changed before its extra use was charged");
    this.name = "PlanRowMovedError";
  }
}

/** Why the use was refused at its last step: a refused charge, or a plan with nothing to take. */
export type UseMeteringRefusal = Exclude<UseChargeResult, { ok: true }> | UsePlanRefusal;

export interface UseMeteringProductionDeps {
  metering: UseMeteringDeps;
  /** Where a plan's count is taken from, given back to and read. Its own statements: each is one compare-and-set. */
  plan: PlanCountDb;
  /** Cents per million tokens on the platform's model keys (JOB_PLATFORM_MODEL_*). */
  rates: { inputCentsPerMTok: number; outputCentsPerMTok: number };
  logger?: {
    info(obj: unknown, msg: string): void;
    warn(obj: unknown, msg: string): void;
    error(obj: unknown, msg: string): void;
  };
}

export interface BeginUseMeteringArgs {
  /** The creator's agent this use runs. The core must ask for this one. */
  agentId: string;
  /** From resolveUseBilling's `billable`; null for a subscribed use and for a use on a plan. */
  install: MeteredInstall | null;
  /**
   * From resolveUseBilling's `plan`: the row as it was read, and the charge
   * target of a use past the count (null = the plan stops). Never with `install`.
   */
  plan?: { read: UsePlan; extraInstall: MeteredInstall | null } | null;
  /** The API key that is paying, when one is. */
  apiKeyId?: string | null;
  unit?: UseUnit;
}

export interface UseMeteringBinding {
  beginMetering: AgentChatDeps["beginMetering"];
  /** Why the charge was refused; null when it was not (or has not been asked for). */
  refusal(): UseMeteringRefusal | null;
  /** The charge that was taken; null when none was. */
  charge(): MarketplaceCharge | null;
  /** On a plan: how this use was paid for. Null off a plan, and until a use was taken or charged. */
  planUse(): UsePlanUse | null;
  /** Notes what the run used. Call before the session's meter settles. */
  noteRun(run: { platformModel: boolean; usage: unknown; content: string; promptChars: number }): void;
  /**
   * Notes the sum of what a run of several model calls used on the
   * platform's keys, already added up; null when none of them ran on those
   * keys. Call before the handle settles. The last note of either kind wins.
   */
  notePlatformUsage(usage: TokenUsage | null): void;
}

let production: UseMeteringProductionDeps | null = null;

function productionDeps(): UseMeteringProductionDeps {
  return (production ??= {
    metering: {
      transaction: (fn) => prisma.$transaction((tx) => fn(tx as unknown as UseMeteringTx)),
    },
    plan: prisma as unknown as PlanCountDb,
    rates: {
      inputCentsPerMTok: env.JOB_PLATFORM_MODEL_INPUT_CENTS_PER_MTOK,
      outputCentsPerMTok: env.JOB_PLATFORM_MODEL_OUTPUT_CENTS_PER_MTOK,
    },
    logger,
  });
}

export function beginUseMetering(
  args: BeginUseMeteringArgs,
  deps: UseMeteringProductionDeps = productionDeps(),
): UseMeteringBinding {
  const log = deps.logger;
  let asked = false;
  let refusal: UseMeteringRefusal | null = null;
  let charge: MarketplaceCharge | null = null;
  let planUse: UsePlanUse | null = null;
  let modelCostMicros = 0n;

  const handleOf = (taken: MarketplaceCharge): MeteringHandle => ({
    charge: taken,
    settle: async () => {
      try {
        const result = await settleUse(deps.metering, {
          charge: taken,
          ...(modelCostMicros > 0n && { modelCostMicros }),
        });
        if (!result.settled) {
          log?.warn({ revenueId: taken.revenueId, reason: result.reason }, "paid use charge was no longer pending at settle");
        }
      } catch (err) {
        log?.error(
          { err, revenueId: taken.revenueId, buyerId: taken.install.buyerId },
          "paid use settle failed: the revenue row stays pending (buyer debited, creator not yet credited)",
        );
      }
    },
    refund: async (reason: string) => {
      try {
        const result = await refundUse(deps.metering, { charge: taken, reason });
        if (!result.refunded) {
          log?.warn({ revenueId: taken.revenueId, reason: result.reason }, "paid use charge was no longer pending at refund");
        }
      } catch (err) {
        log?.error(
          { err, revenueId: taken.revenueId, buyerId: taken.install.buyerId },
          "paid use refund failed: the buyer was charged for a use that did not deliver",
        );
      }
    },
  });

  /** One priced use: the debit, its pending row and the key's reservation. */
  const chargeFor = async (
    install: MeteredInstall,
    metering: UseMeteringDeps = deps.metering,
  ): Promise<BeginMeteringResult> => {
    const result = await chargeUse(metering, { install, apiKeyId: args.apiKeyId ?? null, unit: args.unit });
    if (!result.ok) {
      refusal = result;
      // The core can only say "cannot pay". What was refused, and why,
      // is read back through refusal().
      return {
        ok: false,
        reason: "insufficient_credits",
        requiredCents: result.reason === "insufficient_credits" ? result.requiredCents : install.pricePerRequestCents,
        balanceCents: result.reason === "insufficient_credits" ? result.balanceCents : 0n,
        listingTitle: install.listingTitle,
      };
    }
    charge = result.charge;
    log?.info(
      {
        revenueId: charge.revenueId,
        listingId: install.listingId,
        buyerId: install.buyerId,
        grossCents: String(charge.grossCents),
      },
      "paid use charged",
    );
    return { ok: true, handle: handleOf(charge) };
  };

  const readPlanRow = (id: string): Promise<PlanCountRow | null> =>
    deps.plan.agentSubscription.findUnique({ where: { id }, select: PLAN_COUNT_COLUMNS });

  /** The count for the reply: the row as it is now, or what this use knew of it when it cannot be read. */
  const planCountFrom =
    (known: UsePlanCount, subscriptionId: string, periodStart: Date) => async (): Promise<UsePlanCount> => {
      try {
        const row = await readPlanRow(subscriptionId);
        if (row && row.includedUses !== null && row.currentPeriodStart.getTime() === periodStart.getTime()) {
          return {
            planId: row.planId,
            includedUses: row.includedUses,
            usedInPeriod: row.usedInPeriod,
            carriedUses: row.carriedUses,
            extraUsePriceCents: row.extraUsePriceCents,
            periodEnd: row.currentPeriodEnd,
          };
        }
      } catch (err) {
        log?.warn({ err, subscriptionId }, "a plan's count could not be read for the reply");
      }
      return known;
    };

  /**
   * The handle of an included use: nothing to settle, and one use to give
   * back. There is no status in the database to make a second give-back a
   * no-op (as a refund's is), so the first call of either wins here.
   */
  const includedHandle = (taken: { subscriptionId: string; periodStart: Date }): MeteringHandle => {
    let closed = false;
    return {
      settle: async () => {
        closed = true;
      },
      refund: async () => {
        if (closed) return;
        closed = true;
        try {
          const result = await giveBackIncludedUse(deps.plan, taken);
          if (!result.givenBack) {
            log?.warn({ subscriptionId: taken.subscriptionId }, "an included use was not given back: its period is over");
          }
        } catch (err) {
          log?.error(
            { err, subscriptionId: taken.subscriptionId },
            "giving an included use back failed: the plan counts a use that did not deliver",
          );
        }
      },
    };
  };

  /** The core is told "cannot pay"; why is read back through refusal(). */
  const planRefused = (why: UsePlanRefusal, listingTitle: string): BeginMeteringResult => {
    refusal = why;
    return { ok: false, reason: "insufficient_credits", requiredCents: 0n, balanceCents: 0n, listingTitle };
  };

  const beginPlanUse = async (plan: NonNullable<BeginUseMeteringArgs["plan"]>): Promise<BeginMeteringResult> => {
    const { read, extraInstall } = plan;
    const subscriptionId = read.subscriptionId;
    const title = extraInstall?.listingTitle ?? "";

    const included = (
      terms: Pick<UsePlanCount, "planId" | "includedUses" | "carriedUses" | "extraUsePriceCents" | "periodEnd">,
      usedBefore: number,
      periodStart: Date,
    ): BeginMeteringResult => {
      planUse = {
        use: "included",
        subscriptionId,
        periodStart,
        count: planCountFrom(
          {
            planId: terms.planId,
            includedUses: terms.includedUses,
            usedInPeriod: usedBefore + 1,
            carriedUses: terms.carriedUses,
            extraUsePriceCents: terms.extraUsePriceCents,
            periodEnd: terms.periodEnd,
          },
          subscriptionId,
          periodStart,
        ),
      };
      return { ok: true, handle: includedHandle({ subscriptionId, periodStart }) };
    };

    const first = await takeIncludedUse(deps.plan, {
      subscriptionId,
      periodStart: read.periodStart,
      includedUses: read.includedUses,
      carriedUses: read.carriedUses,
    });
    if (first.taken) return included(read, read.usedInPeriod, first.periodStart);

    // No use was taken. That alone says nothing about why, so nothing is
    // charged and nobody is told "used up" until the row has been read again.
    const fresh = await readPlanRow(subscriptionId);
    if (!fresh || fresh.includedUses === null || !OPEN_STATUSES.includes(fresh.status)) {
      return planRefused({ ok: false, reason: "plan_changed" }, title);
    }
    const includedUses = fresh.includedUses;
    const sameRow =
      fresh.currentPeriodStart.getTime() === read.periodStart.getTime() &&
      fresh.planId === read.planId &&
      includedUses === read.includedUses &&
      fresh.carriedUses === read.carriedUses &&
      fresh.extraUsePriceCents === read.extraUsePriceCents;
    if (sameRow && fresh.usedInPeriod >= includedUses + fresh.carriedUses) {
      // Used up, in the period and on the terms the buyer's request was
      // decided on. The extra price is the one on those terms.
      if (!extraInstall) {
        return planRefused(
          {
            ok: false,
            reason: "plan_used_up",
            periodEnd: fresh.currentPeriodEnd,
            includedUses,
            carriedUses: fresh.carriedUses,
          },
          title,
        );
      }
      // The charge is bound to the row it was decided on: the claim is the
      // first statement of the charge's transaction, and a miss rolls it back
      // before anything is debited.
      const claiming: UseMeteringDeps = {
        ...deps.metering,
        transaction: (fn) =>
          deps.metering.transaction(async (tx) => {
            const claimed = await (tx as unknown as PlanExtraClaimTx).agentSubscription.updateMany({
              where: {
                id: subscriptionId,
                currentPeriodStart: fresh.currentPeriodStart,
                status: { in: OPEN_STATUSES },
                planId: fresh.planId,
                includedUses,
                carriedUses: fresh.carriedUses,
                extraUsePriceCents: fresh.extraUsePriceCents,
                usedInPeriod: { gte: includedUses + fresh.carriedUses },
              },
              data: { usedInPeriod: { increment: 0 } },
            });
            if (claimed.count !== 1) throw new PlanRowMovedError();
            return fn(tx);
          }),
      };
      let charged: BeginMeteringResult;
      try {
        charged = await chargeFor(extraInstall, claiming);
      } catch (err) {
        if (err instanceof PlanRowMovedError) return planRefused({ ok: false, reason: "plan_changed" }, title);
        throw err;
      }
      if (charged?.ok) {
        planUse = {
          use: "extra",
          subscriptionId,
          periodStart: fresh.currentPeriodStart,
          count: planCountFrom(
            {
              planId: fresh.planId,
              includedUses,
              usedInPeriod: fresh.usedInPeriod,
              carriedUses: fresh.carriedUses,
              extraUsePriceCents: fresh.extraUsePriceCents,
              periodEnd: fresh.currentPeriodEnd,
            },
            subscriptionId,
            fresh.currentPeriodStart,
          ),
        };
      }
      return charged;
    }

    // The row is not what was read: it renewed, moved to another plan, or a
    // use came back. Decided once more from the fresh row, and only as an
    // included use: an extra price is never charged on a row that changed
    // under the request.
    const second = await takeIncludedUse(deps.plan, {
      subscriptionId,
      periodStart: fresh.currentPeriodStart,
      includedUses,
      carriedUses: fresh.carriedUses,
    });
    if (second.taken) {
      return included(
        {
          planId: fresh.planId,
          includedUses,
          carriedUses: fresh.carriedUses,
          extraUsePriceCents: fresh.extraUsePriceCents,
          periodEnd: fresh.currentPeriodEnd,
        },
        fresh.usedInPeriod,
        second.periodStart,
      );
    }
    return planRefused({ ok: false, reason: "plan_changed" }, title);
  };

  return {
    beginMetering: async ({ agentId }): Promise<BeginMeteringResult> => {
      // One licence, one charge, one agent. Anything else is a fault of
      // ours, and it must not become a second debit or a free run.
      if (asked) throw new Error("a paid use asked for its charge twice");
      asked = true;
      if (agentId !== args.agentId) throw new Error("a paid use asked to charge for another agent");

      const { install } = args;
      if (args.plan) {
        // One use is paid for one way.
        if (install) throw new Error("a paid use was given both a price and a plan");
        return beginPlanUse(args.plan);
      }
      // Inside a paid month: nothing is charged and nothing is reserved.
      if (!install) return null;
      return chargeFor(install);
    },
    refusal: () => refusal,
    charge: () => charge,
    planUse: () => planUse,
    noteRun: (run) => {
      const usage = platformUsageOf(
        { usage: run.usage, platformModel: run.platformModel, content: run.content },
        run.promptChars,
      );
      modelCostMicros = usage ? platformModelCostMicros(usage, deps.rates) : 0n;
    },
    notePlatformUsage: (usage) => {
      modelCostMicros = usage ? platformModelCostMicros(usage, deps.rates) : 0n;
    },
  };
}

/**
 * The metering of one use at a listing's x402 door (services/paidUseX402.ts):
 * the payer pays from a wallet, after the answer, so the chat core's charge
 * is nothing at all. What the use cost on the platform's model keys is noted
 * exactly as beginUseMetering notes it, and handed to the door's sale
 * (services/x402Sale.ts), which takes it from the creator's share as a
 * settle does.
 */
export interface X402UseMeteringBinding {
  /** What the core calls, once, for this agent: it answers null, so nothing is charged or reserved. */
  beginMetering: AgentChatDeps["beginMetering"];
  /** Notes what the run used, as beginUseMetering's noteRun does. */
  noteRun(run: { platformModel: boolean; usage: unknown; content: string; promptChars: number }): void;
  /** The same for a ready sum, as beginUseMetering's notePlatformUsage does. */
  notePlatformUsage(usage: TokenUsage | null): void;
  /** What the use cost on the platform's model keys, in millionths of a cent; 0 when nothing ran on them. */
  modelCostMicros(): bigint;
}

export function beginX402Metering(
  args: { agentId: string },
  deps: Pick<UseMeteringProductionDeps, "rates"> = productionDeps(),
): X402UseMeteringBinding {
  let asked = false;
  let modelCostMicros = 0n;
  return {
    beginMetering: async ({ agentId }) => {
      // One use, one agent, as for a buyer's use. Anything else is a fault of
      // ours: the core then refuses and no model is called.
      if (asked) throw new Error("a use at the x402 door asked for its metering twice");
      asked = true;
      if (agentId !== args.agentId) throw new Error("a use at the x402 door asked to meter another agent");
      // Paid from a wallet after the answer: nothing is charged here.
      return null;
    },
    // The model cost as beginUseMetering computes it, line for line.
    noteRun: (run) => {
      const usage = platformUsageOf(
        { usage: run.usage, platformModel: run.platformModel, content: run.content },
        run.promptChars,
      );
      modelCostMicros = usage ? platformModelCostMicros(usage, deps.rates) : 0n;
    },
    notePlatformUsage: (usage) => {
      modelCostMicros = usage ? platformModelCostMicros(usage, deps.rates) : 0n;
    },
    modelCostMicros: () => modelCostMicros,
  };
}
