/**
 * Treasury-settlement orchestration (plan A3).
 *
 * This module is the pure decision layer for the BullMQ worker that pays
 * each tokenized agent's Nosana compute bill from its treasury PDA. Side
 * effects — fetching compute cost, recording ComputePayment rows, submitting
 * Solana transactions — are dependency-injected so the logic is testable
 * without Solana, Prisma, or BullMQ.
 *
 * The worker itself is a thin shell that wires real implementations of the
 * injected deps and calls runSettlementTick on an interval. Any new policy
 * (backoff, partial payments, idle suspension) belongs here.
 */

import { shouldSettleNow } from "./treasury.js";

// ============================================
// Types
// ============================================

export interface DeploymentForSettlement {
  id: string;
  orgId: string;
  gpuTier: string;
  nosanaJobIds: string[];
  replicas: number;
  agentTokenId: string;
}

export interface TreasuryForSettlement {
  id: string;
  tokenId: string;
  treasuryPdaAddress: string;
  solBalanceLamports: bigint;
  lastComputeBillAt: Date | null;
}

export interface ComputeCostResult {
  computeSeconds: number;
  costUsd: number;
}

/** Billing window for delta metering (remediation D2). `start: null`
 * means the treasury has never been billed — meter from each job's own
 * start time. */
export interface BillingWindow {
  start: Date | null;
  end: Date;
}

export type SettlementDecision =
  | {
      action: "skip";
      reason: "interval_not_elapsed" | "no_measurable_compute";
    }
  | {
      action: "settle";
      computeSeconds: number;
      costUsd: number;
      amountLamports: bigint;
      insufficientFunds: boolean;
      treasuryBalanceLamports: bigint;
      /** Window this bill charges for. periodStart pins the treasury's
       * lastComputeBillAt cursor at decision time (epoch when null) so the
       * (treasuryId, nosanaJobId, periodStart) unique key dedupes
       * crash-replays; periodEnd becomes the new cursor. */
      periodStart: Date;
      periodEnd: Date;
    };

export interface DecideInput {
  deployment: DeploymentForSettlement;
  treasury: TreasuryForSettlement;
  now: Date;
  intervalMs: number;
  solPriceUsd: number;
  getComputeCost: (
    deployment: DeploymentForSettlement,
    window: BillingWindow,
  ) => Promise<ComputeCostResult>;
}

// ============================================
// decideTreasurySettlement
// ============================================

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** periodStart for a treasury's first-ever bill (lastComputeBillAt null).
 * The metering window itself is unbounded below (clamped to each job's
 * start), but the persisted row needs a deterministic non-null periodStart
 * so the composite unique key dedupes a crash-replayed first window. */
export const FIRST_BILL_PERIOD_START = new Date(0);

export async function decideTreasurySettlement(
  input: DecideInput,
): Promise<SettlementDecision> {
  const { deployment, treasury, now, intervalMs, solPriceUsd, getComputeCost } =
    input;

  if (!(solPriceUsd > 0)) {
    throw new Error(`solPriceUsd must be positive, got ${solPriceUsd}`);
  }

  if (
    !shouldSettleNow({
      lastSettledAt: treasury.lastComputeBillAt,
      intervalMs,
      now,
    })
  ) {
    return { action: "skip", reason: "interval_not_elapsed" };
  }

  // Delta billing (D2): meter only [lastComputeBillAt, now]. A null
  // cursor means "never billed" — the metering layer clamps to each
  // job's own start time.
  const window: BillingWindow = {
    start: treasury.lastComputeBillAt,
    end: now,
  };

  const cost = await getComputeCost(deployment, window);
  if (cost.computeSeconds <= 0 || cost.costUsd <= 0) {
    return { action: "skip", reason: "no_measurable_compute" };
  }

  // costUsd / solPriceUsd = SOL owed. Convert to lamports via
  // LAMPORTS_PER_SOL and round down so we never overcharge the treasury.
  const solOwed = cost.costUsd / solPriceUsd;
  const amountLamports = BigInt(Math.floor(solOwed * Number(LAMPORTS_PER_SOL)));

  return {
    action: "settle",
    computeSeconds: cost.computeSeconds,
    costUsd: cost.costUsd,
    amountLamports,
    insufficientFunds: treasury.solBalanceLamports < amountLamports,
    treasuryBalanceLamports: treasury.solBalanceLamports,
    periodStart: treasury.lastComputeBillAt ?? FIRST_BILL_PERIOD_START,
    periodEnd: now,
  };
}

// ============================================
// runSettlementTick
// ============================================

export interface ComputePaymentRecord {
  treasuryId: string;
  nosanaJobId: string;
  amountLamports: bigint;
  computeSeconds: number;
  status: "PENDING" | "FAILED";
  errorMessage?: string;
  scheduledFor: Date;
  /** Billing window (D2). Always set on new rows; periodStart feeds the
   * (treasuryId, nosanaJobId, periodStart) unique key and periodEnd is
   * the cursor target persistComputePayments compare-and-sets onto
   * AgentTreasury.lastComputeBillAt — for FAILED (insufficient_funds)
   * rows too: the bill for the window exists, and re-billing the same
   * window once funds arrive would double-charge. */
  periodStart: Date;
  periodEnd: Date;
}

export interface TickInput {
  deployments: DeploymentForSettlement[];
  // keyed by agentTokenId — the canonical link between a deployment and its treasury
  treasuries: Map<string, TreasuryForSettlement>;
  now: Date;
  intervalMs: number;
  solPriceUsd: number;
  getComputeCost: (
    deployment: DeploymentForSettlement,
    window: BillingWindow,
  ) => Promise<ComputeCostResult>;
  recordComputePayment: (record: ComputePaymentRecord) => Promise<void>;
}

export async function runSettlementTick(input: TickInput): Promise<void> {
  const {
    deployments,
    treasuries,
    now,
    intervalMs,
    solPriceUsd,
    getComputeCost,
    recordComputePayment,
  } = input;

  for (const deployment of deployments) {
    const treasury = treasuries.get(deployment.agentTokenId);
    if (!treasury) continue;

    const decision = await decideTreasurySettlement({
      deployment,
      treasury,
      now,
      intervalMs,
      solPriceUsd,
      getComputeCost,
    });

    if (decision.action === "skip") continue;

    const status: "PENDING" | "FAILED" = decision.insufficientFunds
      ? "FAILED"
      : "PENDING";

    await recordComputePayment({
      treasuryId: treasury.id,
      // Attributing to the first job is a stand-in until multi-job settlement
      // lands; amountLamports already aggregates across every job on the
      // deployment via getComputeCost.
      nosanaJobId: deployment.nosanaJobIds[0] ?? "",
      amountLamports: decision.amountLamports,
      computeSeconds: decision.computeSeconds,
      status,
      errorMessage: decision.insufficientFunds ? "insufficient_funds" : undefined,
      scheduledFor: now,
      periodStart: decision.periodStart,
      periodEnd: decision.periodEnd,
    });
  }
}
