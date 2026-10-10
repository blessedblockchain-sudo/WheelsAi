/**
 * A creator's side of a payout: whether payouts are running, requesting
 * one, taking a request back, and what a creator sees of one.
 *
 * Requesting a payout RESERVES the amount out of the creator's earnings
 * into the payout row. Only the payout worker ever moves that row on, so a
 * request made while the worker is off would hold the earnings for ever.
 * Three things keep the earnings safe:
 *
 *   - payoutAvailability: the one rule for "payouts are running now". GET
 *     /api/capabilities answers `payouts.available` with it and POST
 *     /api/marketplace/payouts refuses on it BEFORE anything is reserved.
 *   - requestPayout: every rule is checked first (services/payoutRules.ts),
 *     and only then ONE transaction creates the payout row and takes its
 *     amount through the earnings ledger. A reservation that does not move,
 *     a second open payout (the database allows one per creator), or a day's
 *     total past the limit once the new row is counted, rolls the whole
 *     transaction back: a refusal reserves nothing.
 *   - cancelPayout: a payout that is still pending becomes cancelled and
 *     its amount goes back to the earnings it was taken from, in ONE
 *     transaction, by compare-and-set on the status. It is the mirror of
 *     the worker's failure path: the same two rows, the same guard. The
 *     worker claims by pending → processing and this cancels by pending →
 *     cancelled, so exactly one of "cancelled and restored" or "claimed and
 *     sent" happens; the loser writes nothing.
 *
 * Pure cores: everything they read or write is passed in.
 * buildRequestPayoutDeps and buildCancelPayoutDeps bind them to a Prisma
 * client handed to them, and move the amount through the earnings ledger
 * (services/earningsLedger.ts). Every sentence is in
 * services/payoutSentences.ts.
 */

import { PLATFORM_FEE_PERCENT } from "@wheelsai/shared/revenue";
import { WALLET_PAYOUT_METHODS } from "@wheelsai/shared/payouts";

import { moveEarnings, type EarningsLedgerTx } from "./earningsLedger.js";
import {
  planPayoutRequest,
  payoutLimits,
  startOfUtcDay,
  usdSettingToCents,
  type AddressOnChain,
  type PayoutLimits,
} from "./payoutRules.js";
import { payoutFailureMessage, payoutStatusMessage, type PayoutRefusal } from "./payoutSentences.js";

export {
  payoutFailureMessage,
  PAYOUTS_UNAVAILABLE_CODE,
  PAYOUTS_UNAVAILABLE_MESSAGE,
} from "./payoutSentences.js";

// ============================================
// Availability
// ============================================

/** The two settings that decide whether the payout worker runs. */
export interface PayoutSettings {
  PAYOUTS_ENABLED: boolean;
  PAYOUT_EXECUTOR_INTERVAL_MS: number;
}

/**
 * Payouts are running: the payout switch is on AND the worker that settles
 * payouts is scheduled (the condition queues/payout-executor.queue.ts
 * starts on). Anything else, a missing or unreadable setting included, is
 * not running.
 */
export function payoutsRunning(settings: PayoutSettings): boolean {
  return (
    settings?.PAYOUTS_ENABLED === true &&
    typeof settings.PAYOUT_EXECUTOR_INTERVAL_MS === "number" &&
    settings.PAYOUT_EXECUTOR_INTERVAL_MS > 0
  );
}

/**
 * Whether payouts are running now, read per call. Fails closed: settings
 * that cannot be read answer not available.
 */
export function payoutAvailability(readSettings: () => PayoutSettings): { available: boolean } {
  try {
    return { available: payoutsRunning(readSettings()) };
  } catch {
    return { available: false };
  }
}

// ============================================
// What a creator sees of a payout
// ============================================

/** A creator_payouts row, as the database holds it. */
export interface PayoutRow {
  id: string;
  publisherId: string;
  amountCents: bigint;
  payoutMethod: string;
  payoutAddress: string | null;
  status: string;
  txSignature: string | null;
  grossRevenueCents: bigint;
  platformFeeCents: bigint;
  periodStart: Date;
  periodEnd: Date;
  requestedAt: Date;
  processedAt: Date | null;
  /** The chain's or the node's own words, for operators. Never sent. */
  failureReason: string | null;
  /** Why a failed payout failed, as a code. Absent on older rows. */
  failureCode?: string | null;
  /** Why a pending wallet payout has not been sent yet, as a code. */
  waitingReason?: string | null;
}

/** A payout can be taken back only until the worker has claimed it. */
export function isPayoutCancellable(status: string): boolean {
  return status === "pending";
}

/** A payout as GET /api/marketplace/payouts lists it. */
export interface PayoutView {
  id: string;
  amountCents: number;
  payoutMethod: string;
  payoutAddress: string | null;
  status: string;
  txSignature: string | null;
  grossRevenueCents: number;
  platformFeeCents: number;
  periodStart: Date;
  periodEnd: Date;
  requestedAt: Date;
  processedAt: Date | null;
  /** A plain sentence when the payout failed; null when it did not. */
  failureReason: string | null;
  /** True only while the payout can still be cancelled. */
  cancellable: boolean;
  /**
   * The sentence to show with the payout: that it is waiting, for a pending
   * payout the worker is holding; why it failed, for a failed one; null
   * otherwise.
   */
  message: string | null;
}

export function payoutView(row: PayoutRow): PayoutView {
  return {
    id: row.id,
    amountCents: Number(row.amountCents),
    payoutMethod: row.payoutMethod,
    payoutAddress: row.payoutAddress,
    status: row.status,
    txSignature: row.txSignature,
    grossRevenueCents: Number(row.grossRevenueCents),
    platformFeeCents: Number(row.platformFeeCents),
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    requestedAt: row.requestedAt,
    processedAt: row.processedAt,
    failureReason: row.status === "failed" ? payoutFailureMessage(row.failureReason, row.failureCode) : null,
    cancellable: isPayoutCancellable(row.status),
    message: payoutStatusMessage(row),
  };
}

// ============================================
// Request
// ============================================

/** A request as it arrives: nothing in it is trusted yet. */
export interface PayoutRequestInput {
  orgId: string;
  payoutMethod: unknown;
  payoutAddress?: unknown;
  /** Whole cents. Left out: the largest amount allowed right now. */
  amountCents?: unknown;
}

/** The settings a request is checked against, in cents. */
export interface PayoutRequestSettings {
  perPayoutCents: bigint;
  perDayCents: bigint;
  /** SOL is offered only while it can be priced. */
  solOffered: boolean;
}

/** The setting names a request reads (config/env.ts). */
export interface PayoutLimitEnv {
  PAYOUT_MAX_PER_PAYOUT_USD: number;
  PAYOUT_MAX_PER_DAY_USD: number;
  SOL_PRICE_SOURCE: string;
}

/**
 * The limits as the settings have them now. Fails closed: a limit that is
 * not a whole number of dollars throws, and SOL is offered only when the
 * price source is a known one that is not "off".
 */
export function payoutRequestSettingsFromEnv(e: PayoutLimitEnv): PayoutRequestSettings {
  return {
    perPayoutCents: usdSettingToCents(e.PAYOUT_MAX_PER_PAYOUT_USD),
    perDayCents: usdSettingToCents(e.PAYOUT_MAX_PER_DAY_USD),
    solOffered: e.SOL_PRICE_SOURCE === "pyth" || e.SOL_PRICE_SOURCE === "static",
  };
}

/** The payout row a request writes. */
export interface NewPayout {
  publisherId: string;
  amountCents: bigint;
  payoutMethod: string;
  payoutAddress: string | null;
  grossRevenueCents: bigint;
  platformFeeCents: bigint;
  periodStart: Date;
  periodEnd: Date;
}

/** The two writes of a request, inside one transaction. */
export interface RequestPayoutTx {
  /** Writes the payout row, pending. */
  createPayout(data: NewPayout): Promise<PayoutRow>;
  /**
   * Takes the amount out of the creator's earnings, with a ledger row that
   * names the payout. Answers the balance it left, or null when nothing
   * moved (the balance no longer covers it, or the profile is gone).
   */
  reserveEarnings(orgId: string, amountCents: bigint, payoutId: string): Promise<bigint | null>;
  /**
   * This creator's wallet payouts requested since `since` that are pending,
   * processing or completed, read INSIDE the transaction, so the row this
   * request just wrote is counted with them.
   */
  walletPayoutsSinceCents(orgId: string, since: Date): Promise<bigint>;
}

/**
 * Thrown by `transaction` when the payout row could not be written because
 * the creator already has an open payout (the database allows one).
 */
export class OpenPayoutExistsError extends Error {
  constructor() {
    super("the creator already has an open payout");
    this.name = "OpenPayoutExistsError";
  }
}

/** Thrown inside the transaction to roll the payout row back with it. */
class ReservationDidNotMoveError extends Error {
  constructor() {
    super("the reservation did not move");
    this.name = "ReservationDidNotMoveError";
  }
}

/**
 * Thrown inside the transaction when the day's total, counted with the new
 * row in it, is past the day's limit: a payout finished between this
 * request's checks and its write.
 */
class DayLimitPassedError extends Error {
  constructor() {
    super("the day's limit was passed");
    this.name = "DayLimitPassedError";
  }
}

export interface RequestPayoutDeps {
  now(): Date;
  settings(): PayoutRequestSettings;
  /** What the creator is owed now. Nothing for a creator with no profile. */
  readBalanceCents(orgId: string): Promise<bigint>;
  /** The creator has a payout that is pending or processing. */
  hasOpenPayout(orgId: string): Promise<boolean>;
  /** This creator's wallet payouts requested since `since` that are pending, processing or completed. */
  walletPayoutsSinceCents(orgId: string, since: Date): Promise<bigint>;
  /** The paying wallet, the treasury and this organization's own deposit address. */
  platformAddresses(orgId: string): readonly string[] | Promise<readonly string[]>;
  /** ONE read of the chain for the address. A read that fails answers "unavailable". */
  readAddressOnChain(address: string): Promise<AddressOnChain>;
  /**
   * Runs `fn` in ONE database transaction: both writes commit or neither.
   * Throws OpenPayoutExistsError when the one-open-payout rule refused the row.
   */
  transaction<T>(fn: (tx: RequestPayoutTx) => Promise<T>): Promise<T>;
}

export type RequestPayoutResult =
  | {
      outcome: "requested";
      payout: PayoutRow;
      /** What is left in the creator's earnings. */
      remainingCents: bigint;
      /** The amount is the most one payout to a wallet may be. */
      atCap: boolean;
    }
  | { outcome: "refused"; refusal: PayoutRefusal };

const refused = (refusal: PayoutRefusal): RequestPayoutResult => ({ outcome: "refused", refusal });

/** The amount asked for as whole cents, or "unreadable". Left out is null. */
function readAskedCents(value: unknown): bigint | null | "unreadable" {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value > 0n ? value : "unreadable";
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  return "unreadable";
}

/**
 * What the buyers paid for an amount a creator takes out, and the
 * platform's part of it: the creator's amount is what is left of a sale
 * after the platform's share, so the sale is the amount over that part,
 * rounded half up to a whole cent.
 */
export function payoutRevenueBreakdown(amountCents: bigint): { grossRevenueCents: bigint; platformFeeCents: bigint } {
  const creatorPercent = BigInt(100 - PLATFORM_FEE_PERCENT);
  const grossRevenueCents = (amountCents * 200n + creatorPercent) / (creatorPercent * 2n);
  return { grossRevenueCents, platformFeeCents: grossRevenueCents - amountCents };
}

const PAYOUT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Request a payout. Every rule is checked before anything is written, in
 * the documented order; then ONE transaction writes the payout row and
 * reserves its amount. A refusal reserves nothing. An error this does not
 * expect (the database is down) is thrown as it is: the caller answers
 * with its own fixed sentence and never with the error's text.
 */
export async function requestPayout(
  deps: RequestPayoutDeps,
  input: PayoutRequestInput,
): Promise<RequestPayoutResult> {
  const { orgId } = input;
  const method = input.payoutMethod;
  if (method !== "credits" && !(WALLET_PAYOUT_METHODS as readonly unknown[]).includes(method)) {
    return refused({ code: "invalid_payload" });
  }
  const asked = readAskedCents(input.amountCents);
  if (asked === "unreadable") return refused({ code: "invalid_payload" });
  const rawAddress = input.payoutAddress;
  if (rawAddress !== undefined && rawAddress !== null && typeof rawAddress !== "string") {
    return refused({ code: "invalid_payload" });
  }
  const wallet = method !== "credits";

  const now = deps.now();
  const settings = deps.settings();
  // The method is refused before anything is read.
  if (method === "crypto_sol" && !settings.solOffered) return refused({ code: "payout_method_unavailable" });
  if (await deps.hasOpenPayout(orgId)) return refused({ code: "payout_in_progress" });

  const balanceCents = await deps.readBalanceCents(orgId);
  const facts = {
    method,
    amountCents: asked,
    address: typeof rawAddress === "string" ? rawAddress : null,
    balanceCents,
    perPayoutCents: settings.perPayoutCents,
    perDayCents: settings.perDayCents,
    // Credits have no limit, so nothing is read for them.
    usedTodayCents: wallet ? await deps.walletPayoutsSinceCents(orgId, startOfUtcDay(now)) : 0n,
    solOffered: settings.solOffered,
    hasOpenPayout: false,
    platformAddresses: wallet ? await deps.platformAddresses(orgId) : [],
  };

  let plan = planPayoutRequest({ ...facts, addressOnChain: null });
  if (plan.outcome === "read_address") {
    // Every other check passed: now, and only now, the one chain read.
    let addressOnChain: AddressOnChain;
    try {
      addressOnChain = await deps.readAddressOnChain(plan.address);
    } catch {
      addressOnChain = "unavailable";
    }
    plan = planPayoutRequest({ ...facts, addressOnChain });
  }
  if (plan.outcome === "refuse") return refused(plan.refusal);
  if (plan.outcome !== "reserve") return refused({ code: "payout_check_unavailable" });

  const { amountCents, address, atCap } = plan;
  const payoutMethod = plan.method;
  try {
    const written = await deps.transaction(async (tx) => {
      // The payout row is written first so the ledger row can carry its id.
      const payout = await tx.createPayout({
        publisherId: orgId,
        amountCents,
        payoutMethod,
        payoutAddress: address,
        ...payoutRevenueBreakdown(amountCents),
        periodStart: new Date(now.getTime() - PAYOUT_PERIOD_MS),
        periodEnd: now,
      });
      // The ledger takes the amount only if the balance still covers it. A
      // reservation that does not move throws, which rolls the new payout
      // row back with it: nothing is written.
      const remainingCents = await tx.reserveEarnings(orgId, amountCents, payout.id);
      if (remainingCents === null) throw new ReservationDidNotMoveError();
      // The day's limit, held by the database and not by the read made
      // before the chain was asked: while this request waited, an earlier
      // payout may have been sent and finished, which the one-open-payout
      // rule no longer stops. Only one open payout per creator can exist, so
      // every other payout counted here is committed, and the total with
      // this row in it is exact.
      if (wallet) {
        const usedWithThisCents = await tx.walletPayoutsSinceCents(orgId, startOfUtcDay(now));
        if (usedWithThisCents > settings.perDayCents) throw new DayLimitPassedError();
      }
      return { payout, remainingCents };
    });
    return { outcome: "requested", payout: written.payout, remainingCents: written.remainingCents, atCap };
  } catch (err) {
    // Two requests at once: the database lets one payout row in, and the
    // balance lets one reservation move. The loser wrote nothing.
    if (err instanceof OpenPayoutExistsError) return refused({ code: "payout_in_progress" });
    if (err instanceof ReservationDidNotMoveError) return refused({ code: "payout_reservation_conflict" });
    if (err instanceof DayLimitPassedError) return refused({ code: "payout_daily_limit" });
    throw err;
  }
}

/** The limits a creator is shown before asking: GET /api/marketplace/revenue `payoutLimits`. */
export function payoutLimitsFor(input: {
  balanceCents: bigint;
  usedTodayCents: bigint;
  settings: PayoutRequestSettings;
}): PayoutLimits {
  return payoutLimits({
    balanceCents: input.balanceCents,
    usedTodayCents: input.usedTodayCents,
    perPayoutCents: input.settings.perPayoutCents,
    perDayCents: input.settings.perDayCents,
    solOffered: input.settings.solOffered,
  });
}

// ============================================
// Cancel
// ============================================

export const PAYOUT_NOT_CANCELLABLE_CODE = "payout_not_cancellable";

/** What a creator is told when a payout can no longer be cancelled. */
export function payoutNotCancellableMessage(status: string): string {
  switch (status) {
    case "processing":
      return "This payout is already being sent and can no longer be cancelled.";
    case "completed":
      return "This payout was already sent and can no longer be cancelled.";
    case "cancelled":
      return "This payout was already cancelled. Its amount is back in your earnings.";
    case "failed":
      return "This payout did not go through and its amount is already back in your earnings. There is nothing to cancel.";
    default:
      return "This payout can no longer be cancelled.";
  }
}

/** The two writes of a cancel, inside one transaction. */
export interface CancelPayoutTx {
  /**
   * Compare-and-set pending → cancelled for this organization's payout.
   * True only when THIS call changed the row.
   */
  cancelIfPending(payoutId: string, orgId: string): Promise<boolean>;
  /**
   * Put the payout's amount back on the earnings it was reserved from, with
   * a ledger row that names the payout. Throws when there is no such balance.
   */
  restoreEarnings(orgId: string, amountCents: bigint, payoutId: string): Promise<void>;
}

export interface CancelPayoutDeps {
  /** The organization's own payout, or null (unknown, or another organization's). */
  findPayout(payoutId: string, orgId: string): Promise<PayoutRow | null>;
  /** Runs `fn` in ONE database transaction: both writes commit or neither. */
  transaction<T>(fn: (tx: CancelPayoutTx) => Promise<T>): Promise<T>;
}

export type CancelPayoutResult =
  | { outcome: "cancelled"; payout: PayoutRow }
  | { outcome: "not_found" }
  | { outcome: "not_cancellable"; status: string };

export async function cancelPayout(
  deps: CancelPayoutDeps,
  input: { payoutId: string; orgId: string },
): Promise<CancelPayoutResult> {
  const { payoutId, orgId } = input;

  const row = await deps.findPayout(payoutId, orgId);
  // Another organization's payout is not found, the same as one that does
  // not exist. Checked again here so a lookup that forgot to scope by
  // organization still cannot hand a payout across.
  if (!row || row.publisherId !== orgId) return { outcome: "not_found" };
  if (!isPayoutCancellable(row.status)) return { outcome: "not_cancellable", status: row.status };

  // Fail closed: an amount that is not a whole positive number of cents is
  // never put on a balance.
  if (typeof row.amountCents !== "bigint" || row.amountCents <= 0n) {
    throw new Error("payout amount is not readable; nothing was changed");
  }

  const cancelled = await deps.transaction(async (tx) => {
    const won = await tx.cancelIfPending(payoutId, orgId);
    // Only restore the reservation if THIS call is the one that cancelled
    // the row: never credit the balance twice, and never credit it for a
    // payout the executor has claimed and is sending.
    if (won) await tx.restoreEarnings(orgId, row.amountCents, payoutId);
    return won;
  });

  if (cancelled) return { outcome: "cancelled", payout: { ...row, status: "cancelled" } };

  // Lost the race (the executor claimed it, or another cancel got there
  // first). Nothing was written; say what the payout is now.
  const now = await deps.findPayout(payoutId, orgId);
  if (!now || now.publisherId !== orgId) return { outcome: "not_found" };
  return { outcome: "not_cancellable", status: now.status };
}

// ============================================
// Prisma binding: cancel
// ============================================

/**
 * The part of a Prisma client (or transaction client) a cancel touches: the
 * payout row, and what the earnings ledger needs to put the amount back.
 */
export interface CancelPayoutDbClient extends EarningsLedgerTx {
  creatorPayout: {
    findFirst(args: { where: { id: string; publisherId: string } }): Promise<PayoutRow | null>;
    updateMany(args: {
      where: { id: string; publisherId: string; status: "pending" };
      data: { status: "cancelled" };
    }): Promise<{ count: number }>;
  };
}

export interface CancelPayoutDb extends CancelPayoutDbClient {
  $transaction<T>(fn: (tx: CancelPayoutDbClient) => Promise<T>): Promise<T>;
}

export function buildCancelPayoutDeps(db: CancelPayoutDb): CancelPayoutDeps {
  return {
    findPayout: (payoutId, orgId) =>
      db.creatorPayout.findFirst({ where: { id: payoutId, publisherId: orgId } }),

    transaction: (fn) =>
      db.$transaction((tx) =>
        fn({
          cancelIfPending: async (payoutId, orgId) => {
            const res = await tx.creatorPayout.updateMany({
              where: { id: payoutId, publisherId: orgId, status: "pending" },
              data: { status: "cancelled" },
            });
            return res.count === 1;
          },
          // The balance the request reserved from and the worker's failure
          // gives back to, changed through the earnings ledger. A profile
          // that is gone throws, which rolls the cancel back: the payout
          // stays pending rather than losing its amount.
          restoreEarnings: async (orgId, amountCents, payoutId) => {
            const restored = await moveEarnings(tx, {
              orgId,
              amountCents,
              type: "payout_restored",
              referenceId: payoutId,
              description: "Payout cancelled, amount returned",
            });
            if (!restored.moved) {
              throw new Error(`payout ${payoutId}: earnings could not be restored (${restored.reason})`);
            }
          },
        }),
      ),
  };
}

// ============================================
// Prisma binding: request, list, limits
// ============================================

/** The statuses that count against a creator's day limit. */
const COUNTED_TODAY = ["pending", "processing", "completed"] as const;
/** The statuses of a payout that is not finished. One per creator. */
const OPEN = ["pending", "processing"] as const;

/** How many payouts the history lists. */
export const PAYOUT_HISTORY_LIMIT = 50;

/** The part of a client (or a transaction client) the day's total is read from. */
export interface PayoutDayTotalDb {
  creatorPayout: {
    aggregate(args: {
      where: {
        publisherId: string;
        payoutMethod: { in: string[] };
        status: { in: string[] };
        requestedAt: { gte: Date };
      };
      _sum: { amountCents: true };
    }): Promise<{ _sum: { amountCents: bigint | null } }>;
  };
}

/** The part of a Prisma client the reads of a request, the list and the limits use. */
export interface PayoutReadsDb {
  publisherProfile: {
    findUnique(args: {
      where: { orgId: string };
      select: { pendingPayoutCents: true };
    }): Promise<{ pendingPayoutCents: bigint } | null>;
  };
  creatorPayout: {
    findFirst(args: {
      where: { publisherId: string; status: { in: string[] } };
      select: { id: true };
    }): Promise<{ id: string } | null>;
    findMany(args: {
      where: { publisherId: string };
      orderBy: { requestedAt: "desc" };
      take: number;
    }): Promise<PayoutRow[]>;
    aggregate(args: {
      where: {
        publisherId: string;
        payoutMethod: { in: string[] };
        status: { in: string[] };
        requestedAt: { gte: Date };
      };
      _sum: { amountCents: true };
    }): Promise<{ _sum: { amountCents: bigint | null } }>;
  };
}

/** The part of a transaction client a request writes through. */
export interface RequestPayoutDbClient extends EarningsLedgerTx {
  creatorPayout: {
    create(args: { data: NewPayout & { status: "pending" } }): Promise<PayoutRow>;
    aggregate: PayoutDayTotalDb["creatorPayout"]["aggregate"];
  };
}

export interface RequestPayoutDb extends PayoutReadsDb {
  $transaction<T>(fn: (tx: RequestPayoutDbClient) => Promise<T>): Promise<T>;
}

/**
 * This creator's wallet payouts requested since `since` that are pending,
 * processing or completed, in cents. A cancelled or failed payout gave its
 * amount back and does not count.
 */
export async function walletPayoutsSinceCents(db: PayoutDayTotalDb, orgId: string, since: Date): Promise<bigint> {
  const sum = await db.creatorPayout.aggregate({
    where: {
      publisherId: orgId,
      payoutMethod: { in: [...WALLET_PAYOUT_METHODS] },
      status: { in: [...COUNTED_TODAY] },
      requestedAt: { gte: since },
    },
    _sum: { amountCents: true },
  });
  const used = sum?._sum?.amountCents;
  return typeof used === "bigint" && used > 0n ? used : 0n;
}

/** `payoutLimits` for a creator, read now. `balanceCents` is what they are owed. */
export async function readPayoutLimits(
  db: PayoutReadsDb,
  input: { orgId: string; balanceCents: bigint; settings: PayoutRequestSettings; now: Date },
): Promise<PayoutLimits> {
  return payoutLimitsFor({
    balanceCents: input.balanceCents,
    usedTodayCents: await walletPayoutsSinceCents(db, input.orgId, startOfUtcDay(input.now)),
    settings: input.settings,
  });
}

/** A creator's payouts, newest first. */
export function listPayouts(db: PayoutReadsDb, orgId: string): Promise<PayoutRow[]> {
  return db.creatorPayout.findMany({
    where: { publisherId: orgId },
    orderBy: { requestedAt: "desc" },
    take: PAYOUT_HISTORY_LIMIT,
  });
}

/** The unique index that allows one open payout per creator refused the row. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export function buildRequestPayoutDeps(
  db: RequestPayoutDb,
  bound: Pick<RequestPayoutDeps, "settings" | "platformAddresses" | "readAddressOnChain"> & { now?: () => Date },
): RequestPayoutDeps {
  return {
    now: bound.now ?? (() => new Date()),
    settings: bound.settings,
    platformAddresses: bound.platformAddresses,
    readAddressOnChain: bound.readAddressOnChain,

    readBalanceCents: async (orgId) => {
      const profile = await db.publisherProfile.findUnique({
        where: { orgId },
        select: { pendingPayoutCents: true },
      });
      return profile && typeof profile.pendingPayoutCents === "bigint" ? profile.pendingPayoutCents : 0n;
    },

    // A convenience for the sentence: the database's own rule (one open
    // payout per creator) is what decides when two requests race.
    hasOpenPayout: async (orgId) =>
      (await db.creatorPayout.findFirst({
        where: { publisherId: orgId, status: { in: [...OPEN] } },
        select: { id: true },
      })) !== null,

    walletPayoutsSinceCents: (orgId, since) => walletPayoutsSinceCents(db, orgId, since),

    transaction: async (fn) => {
      try {
        return await db.$transaction((tx) =>
          fn({
            createPayout: (data) => tx.creatorPayout.create({ data: { ...data, status: "pending" } }),
            // Taken through the earnings ledger, and only if the balance
            // still covers it: two requests that read the same balance
            // cannot both take it.
            reserveEarnings: async (orgId, amountCents, payoutId) => {
              const reserved = await moveEarnings(tx, {
                orgId,
                amountCents: -amountCents,
                type: "payout_reserved",
                referenceId: payoutId,
                description: "Payout requested",
              });
              return reserved.moved ? reserved.balanceAfterCents : null;
            },
            walletPayoutsSinceCents: (orgId, since) => walletPayoutsSinceCents(tx, orgId, since),
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw new OpenPayoutExistsError();
        throw err;
      }
    },
  };
}
