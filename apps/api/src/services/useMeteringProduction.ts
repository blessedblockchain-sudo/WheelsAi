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
 *
 * `install: null` is a subscribed use: `beginMetering` answers null, and
 * nothing is charged or reserved.
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
import { platformUsageOf } from "./buildJobRunnerDeps.js";
import { platformModelCostMicros } from "./jobRunner.js";
import type { MarketplaceCharge, MeteredInstall } from "./marketplaceMetering.js";
import type { BeginMeteringResult, MeteringHandle } from "./marketplaceMeteringProduction.js";
import {
  chargeUse,
  refundUse,
  settleUse,
  type UseChargeResult,
  type UseMeteringDeps,
  type UseMeteringTx,
  type UseUnit,
} from "./useMetering.js";

const logger = createLogger("use-metering");

export interface UseMeteringProductionDeps {
  metering: UseMeteringDeps;
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
  /** From resolveUseBilling's `billable`; null for a subscribed use. */
  install: MeteredInstall | null;
  /** The API key that is paying, when one is. */
  apiKeyId?: string | null;
  unit?: UseUnit;
}

export interface UseMeteringBinding {
  beginMetering: AgentChatDeps["beginMetering"];
  /** Why the charge was refused; null when it was not (or has not been asked for). */
  refusal(): Exclude<UseChargeResult, { ok: true }> | null;
  /** The charge that was taken; null when none was. */
  charge(): MarketplaceCharge | null;
  /** Notes what the run used. Call before the session's meter settles. */
  noteRun(run: { platformModel: boolean; usage: unknown; content: string; promptChars: number }): void;
}

let production: UseMeteringProductionDeps | null = null;

function productionDeps(): UseMeteringProductionDeps {
  return (production ??= {
    metering: {
      transaction: (fn) => prisma.$transaction((tx) => fn(tx as unknown as UseMeteringTx)),
    },
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
  let refusal: Exclude<UseChargeResult, { ok: true }> | null = null;
  let charge: MarketplaceCharge | null = null;
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

  return {
    beginMetering: async ({ agentId }): Promise<BeginMeteringResult> => {
      // One licence, one charge, one agent. Anything else is a fault of
      // ours, and it must not become a second debit or a free run.
      if (asked) throw new Error("a paid use asked for its charge twice");
      asked = true;
      if (agentId !== args.agentId) throw new Error("a paid use asked to charge for another agent");

      const { install } = args;
      // Inside a paid month: nothing is charged and nothing is reserved.
      if (!install) return null;

      const result = await chargeUse(deps.metering, { install, apiKeyId: args.apiKeyId ?? null, unit: args.unit });
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
    },
    refusal: () => refusal,
    charge: () => charge,
    noteRun: (run) => {
      const usage = platformUsageOf(
        { usage: run.usage, platformModel: run.platformModel, content: run.content },
        run.promptChars,
      );
      modelCostMicros = usage ? platformModelCostMicros(usage, deps.rates) : 0n;
    },
  };
}
