/**
 * The sweep's plan (payments pass, batch 6): from plain facts, what may
 * move off the deposit addresses and out of the hot wallet in one run, and
 * where each transfer goes. Pure: no clock, no settings, no chain, no
 * database. services/runSweepTick.ts gathers the facts and carries the plan
 * out.
 *
 * The rules this file keeps:
 *   - ONLY WHAT HAS BEEN READ IS MOVED. An asset leaves an address only
 *     when what the address holds of it is exactly what the deposit scan
 *     last accounted for, and no transfer of that asset from that address
 *     is still out.
 *   - USDC: the whole balance, once it is SWEEP_MIN_USD dollars. The hot
 *     wallet pays, so none moves while the hot wallet is under
 *     HOT_WALLET_MIN_SOL.
 *   - SOL: what the address holds less 890,880 lamports and less its own
 *     fee, once that is worth SWEEP_MIN_USD by the quote. No quote, no SOL.
 *   - WHERE IT GOES. To the hot wallet while the hot wallet holds less
 *     than its float of that asset PLUS WHAT PAYOUTS WAITING TO BE SENT
 *     NEED OF IT, counting what is already on its way and what this plan
 *     has given it. Otherwise to the treasury. With no proven treasury it
 *     stays where it is. A payout larger than the float is thereby paid
 *     from the deposits that come next, with nobody refilling the wallet.
 *   - Largest first, at most SWEEP_MAX_PER_RUN transfers off deposit
 *     addresses.
 *   - THE HOT WALLET'S EXCESS. Holding more than twice a float on top of
 *     what open payouts need (those waiting and those being sent), it
 *     sends what it holds above the float and that need to the proven
 *     treasury: one transfer an asset, never while another from it for
 *     that asset is out. Of its SOL it always keeps HOT_WALLET_MIN_SOL
 *     after every fee it pays in the same plan.
 *   - TWO READINGS OF THE HOT WALLET. What is on its way in or out is
 *     counted from "sent" rows, and a row is ended at "finalized": so
 *     that count starts from what the wallet holds at "finalized", and
 *     each row is counted once. What has left it at "confirmed" and is in
 *     no row (a payout) is taken off as well: it is gone, final or not.
 *     The excess is worked out from the LOWER of what it holds at
 *     "confirmed" and at "finalized": never from money a payout has just
 *     taken, never from money that is not final yet.
 *   - No transfer in a plan has a destination other than the hot wallet
 *     or the proven treasury.
 *
 * A dollar value of SOL is `centsToCreditForLamports` on the quote with no
 * margin: SOL counted low (the price less its stated uncertainty), the way
 * money coming in is counted everywhere else.
 */

import { readWalletAddress } from "./payoutRules.js";
import {
  centsToCreditForLamports,
  lamportsToCollectForCents,
  type SolQuote,
} from "./solPrice.js";

/** The default of TREASURY_WALLET_ADDRESS: the System Program's address,
 * which nobody holds a key for. It means "no treasury". */
export const NO_TREASURY_ADDRESS = "11111111111111111111111111111111";

/** What an account with no data must keep to stay open. A swept address
 * keeps it, so any later amount can still arrive. */
export const SWEEP_KEEP_LAMPORTS = 890_880n;
/** The chain's fee for each signature on a transaction. */
export const SWEEP_FEE_PER_SIGNATURE_LAMPORTS = 5_000n;

const USDC_RAW_PER_DOLLAR = 1_000_000n;
const USDC_RAW_PER_CENT = 10_000n;

export type ChainTransferKind =
  | "sweep_to_hot"
  | "sweep_to_treasury"
  | "hot_to_treasury";
export type SweepAsset = "USDC" | "SOL";

// ============================================
// The treasury
// ============================================

export type TreasuryRefusal =
  /** TREASURY_WALLET_ADDRESS is unset or still its default. */
  | "not_set"
  /** It is not an ordinary wallet address. */
  | "not_a_wallet"
  | "is_hot_wallet"
  | "is_deposit_address"
  /** No platform_wallets row for this chain. */
  | "not_proven"
  /** The row proves another address than the setting names. */
  | "proven_for_another_address";

export type TreasuryAddressReading =
  | { ok: true; address: string }
  | { ok: false; reason: TreasuryRefusal };

/**
 * TREASURY_WALLET_ADDRESS as an address money could ever be sent to: an
 * ordinary wallet address that is not the default, not the hot wallet and
 * not a deposit address. `isDepositAddress` is asked with the canonical
 * form of the address.
 */
export function readTreasuryAddress(facts: {
  setting: string | null | undefined;
  hotWalletAddress: string;
  isDepositAddress: (address: string) => boolean;
}): TreasuryAddressReading {
  const text = typeof facts.setting === "string" ? facts.setting.trim() : "";
  if (text.length === 0 || text === NO_TREASURY_ADDRESS) {
    return { ok: false, reason: "not_set" };
  }
  const address = readWalletAddress(text);
  if (address === null) return { ok: false, reason: "not_a_wallet" };
  if (address === NO_TREASURY_ADDRESS) return { ok: false, reason: "not_set" };
  if (address === facts.hotWalletAddress) {
    return { ok: false, reason: "is_hot_wallet" };
  }
  if (facts.isDepositAddress(address)) {
    return { ok: false, reason: "is_deposit_address" };
  }
  return { ok: true, address };
}

export type TreasuryVerdict =
  | { proven: true; address: string }
  | { proven: false; reason: TreasuryRefusal };

/**
 * THE TREASURY IS PROVEN only when the setting is an address money could
 * be sent to (readTreasuryAddress) AND the platform_wallets row for this
 * chain names exactly that address. Anything else is "no treasury".
 */
export function treasuryVerdict(facts: {
  setting: string | null | undefined;
  /** The address on the row with role "treasury" for this chain. */
  provenAddress: string | null | undefined;
  hotWalletAddress: string;
  isDepositAddress: (address: string) => boolean;
}): TreasuryVerdict {
  const reading = readTreasuryAddress(facts);
  if (!reading.ok) return { proven: false, reason: reading.reason };
  if (typeof facts.provenAddress !== "string" || facts.provenAddress.length === 0) {
    return { proven: false, reason: "not_proven" };
  }
  if (facts.provenAddress !== reading.address) {
    return { proven: false, reason: "proven_for_another_address" };
  }
  return { proven: true, address: reading.address };
}

// ============================================
// The plan
// ============================================

export interface SweepSettings {
  /** SWEEP_MIN_USD, whole dollars. */
  minUsd: number;
  /** SWEEP_MAX_PER_RUN. */
  maxPerRun: number;
  /** HOT_WALLET_FLOAT_USDC, whole dollars. */
  floatUsdc: number;
  /** HOT_WALLET_FLOAT_SOL_USD, whole dollars. */
  floatSolUsd: number;
  /** HOT_WALLET_MIN_SOL, in lamports. */
  hotWalletMinLamports: bigint;
}

/** One deposit address: what it holds at "finalized", and what the scan
 * last accounted for. */
export interface SweepAddressFacts {
  orgId: string;
  address: string;
  lamports: bigint;
  usdcRaw: bigint;
  lastSeenLamports: bigint;
  lastSeenUsdcRaw: bigint;
}

/** A chain_transfers row that is still "sent". */
export interface SentTransferFacts {
  fromAddress: string;
  toAddress: string;
  asset: string;
  amountRaw: bigint;
}

export interface SweepPlanFacts {
  settings: SweepSettings;
  addresses: SweepAddressFacts[];
  /** Transfers still out: their money is on its way and is not planned
   * again. */
  sent: SentTransferFacts[];
  /** Further (address, asset) pairs that are not planned in this run: a
   * transfer of theirs ended a moment ago. */
  alsoBusy?: Array<{ fromAddress: string; asset: string }>;
  hotWallet: {
    address: string;
    /** What it can spend: the lower of what it holds at "confirmed" and
     * at "finalized". Its excess is worked out from these. */
    lamports: bigint;
    usdcRaw: bigint;
    /** What it holds at "finalized" alone: where the count of what is on
     * its way in and out starts. Absent: the figures above. */
    finalized?: { lamports: bigint; usdcRaw: bigint };
  };
  /** The proven treasury (treasuryVerdict), or null. */
  treasury: string | null;
  /** The SOL price, or null when there is none. */
  quote: SolQuote | null;
  /** What payouts to a wallet need from the hot wallet: USDC in base
   * units, SOL in cents. Absent: nothing. The caller caps both (a day's
   * payout limit), so the hot wallet never rests above twice its floats
   * and that. */
  openPayouts?: {
    /** Requested and not yet signed for. The hot wallet is FILLED to its
     * float plus this. One being sent is not here: its money is in the
     * wallet or has left it, and either way nothing is to be added. */
    waiting: { usdcRaw: bigint; solCents: bigint };
    /** Those, and the ones being sent. The EXCESS leaves this in the
     * wallet: a payout being sent may not have taken its money yet. */
    open: { usdcRaw: bigint; solCents: bigint };
  };
}

export interface PlannedTransfer {
  kind: ChainTransferKind;
  asset: SweepAsset;
  fromAddress: string;
  toAddress: string;
  /** The organization whose deposit address it leaves; null from the hot
   * wallet. */
  orgId: string | null;
  /** Base units: lamports, or USDC with 6 decimals. */
  amountRaw: bigint;
  feeLamports: bigint;
  feePayer: string;
  /** What it is worth, in cents: what "largest first" orders by. */
  valueCents: bigint;
}

export type SweepHoldReason =
  /** The address holds something the scan has not accounted for yet. */
  | "unaccounted"
  /** A transfer of this asset from this address is still out. */
  | "in_flight"
  /** The hot wallet is under HOT_WALLET_MIN_SOL and could not pay. */
  | "hot_wallet_low_sol"
  /** The hot wallet has its float and no treasury is proven. */
  | "no_treasury"
  /** SWEEP_MAX_PER_RUN was reached; a later run takes it. */
  | "over_run_limit"
  /** There is no SOL price, so no SOL moves in this run. */
  | "no_price";

/** Money that qualifies by its amount and stays where it is, and why. */
export interface SweepHold {
  reason: SweepHoldReason;
  address?: string;
  orgId?: string;
  asset: SweepAsset;
}

export interface SweepPlan {
  transfers: PlannedTransfer[];
  held: SweepHold[];
}

function dollarsToCents(dollars: number): bigint {
  if (!Number.isSafeInteger(dollars) || dollars <= 0) return 0n;
  return BigInt(dollars) * 100n;
}

/** Lamports in cents by the quote, rounded down. 0 for nothing, for an
 * amount worth less than a cent, and for a quote that gives no value. */
export function lamportsWorthCents(quote: SolQuote, lamports: bigint): bigint {
  if (lamports <= 0n) return 0n;
  const sum = centsToCreditForLamports(quote, lamports, 0);
  return sum.ok ? sum.cents : 0n;
}

/** The lamports a dollar float is, by the same valuation, rounded up.
 * null when the quote gives no value. */
function centsAsLamports(quote: SolQuote, cents: bigint): bigint | null {
  if (cents <= 0n) return 0n;
  const sum = lamportsToCollectForCents(quote, cents, 0);
  return sum.ok ? sum.lamports : null;
}

function busyKey(address: string, asset: string): string {
  return `${address}|${asset}`;
}

function maxOf(...values: bigint[]): bigint {
  return values.reduce((a, b) => (a > b ? a : b));
}

/** An amount owed: nothing for a missing or a negative one. */
function positive(value: bigint | undefined): bigint {
  return typeof value === "bigint" && value > 0n ? value : 0n;
}

function least(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function planSweeps(facts: SweepPlanFacts): SweepPlan {
  const { settings, hotWallet, treasury, quote } = facts;
  const transfers: PlannedTransfer[] = [];
  const held: SweepHold[] = [];

  const minCents = dollarsToCents(settings.minUsd);
  const minUsdcRaw = minCents * USDC_RAW_PER_CENT;
  const floatUsdcRaw =
    Number.isSafeInteger(settings.floatUsdc) && settings.floatUsdc > 0
      ? BigInt(settings.floatUsdc) * USDC_RAW_PER_DOLLAR
      : 0n;
  const floatSolCents = dollarsToCents(settings.floatSolUsd);
  const hotCanPay = hotWallet.lamports >= settings.hotWalletMinLamports;
  // What payouts need. The hot wallet's float is what it holds besides
  // this, so both the filling and the excess are measured above it: the
  // filling above what waits to be sent, the excess above all that is open.
  const keepUsdcRaw = positive(facts.openPayouts?.open.usdcRaw);
  const keepSolCents = positive(facts.openPayouts?.open.solCents);
  // Never filled for more than is kept for: a deposit sent to the hot
  // wallet for a payout would otherwise be sent on as excess in the same
  // plan. (The two can part when each was capped on its own.)
  const fillUsdcRaw = least(positive(facts.openPayouts?.waiting.usdcRaw), keepUsdcRaw);
  const fillSolCents = least(positive(facts.openPayouts?.waiting.solCents), keepSolCents);

  const busy = new Set<string>();
  for (const row of facts.sent) busy.add(busyKey(row.fromAddress, row.asset));
  for (const row of facts.alsoBusy ?? []) {
    busy.add(busyKey(row.fromAddress, row.asset));
  }

  // ---- what could leave each deposit address ----

  interface Candidate {
    asset: SweepAsset;
    orgId: string;
    address: string;
    amountRaw: bigint;
    valueCents: bigint;
  }
  const candidates: Candidate[] = [];
  let solWithoutPrice = false;

  for (const row of facts.addresses) {
    // Never a wallet the money is meant to end up in.
    if (row.address === hotWallet.address) continue;
    if (treasury !== null && row.address === treasury) continue;

    if (minUsdcRaw > 0n && row.usdcRaw >= minUsdcRaw) {
      const hold = (reason: SweepHoldReason) =>
        held.push({ reason, address: row.address, orgId: row.orgId, asset: "USDC" });
      if (busy.has(busyKey(row.address, "USDC"))) hold("in_flight");
      else if (row.usdcRaw !== row.lastSeenUsdcRaw) hold("unaccounted");
      else if (!hotCanPay) hold("hot_wallet_low_sol");
      else {
        candidates.push({
          asset: "USDC",
          orgId: row.orgId,
          address: row.address,
          amountRaw: row.usdcRaw,
          valueCents: row.usdcRaw / USDC_RAW_PER_CENT,
        });
      }
    }

    const lamports =
      row.lamports - SWEEP_KEEP_LAMPORTS - SWEEP_FEE_PER_SIGNATURE_LAMPORTS;
    if (lamports > 0n) {
      if (quote === null) {
        solWithoutPrice = true;
      } else {
        const valueCents = lamportsWorthCents(quote, lamports);
        if (minCents > 0n && valueCents >= minCents) {
          const hold = (reason: SweepHoldReason) =>
            held.push({ reason, address: row.address, orgId: row.orgId, asset: "SOL" });
          if (busy.has(busyKey(row.address, "SOL"))) hold("in_flight");
          else if (row.lamports !== row.lastSeenLamports) hold("unaccounted");
          else {
            candidates.push({
              asset: "SOL",
              orgId: row.orgId,
              address: row.address,
              amountRaw: lamports,
              valueCents,
            });
          }
        }
      }
    }
  }
  if (solWithoutPrice) held.push({ reason: "no_price", asset: "SOL" });

  // Largest first; the same order every time for equal values.
  candidates.sort((a, b) => {
    if (a.valueCents !== b.valueCents) return a.valueCents > b.valueCents ? -1 : 1;
    if (a.address !== b.address) return a.address < b.address ? -1 : 1;
    return a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0;
  });

  // ---- where each goes ----

  // What the hot wallet holds, with what is already on its way to it and
  // less what is already on its way out of it. From what is FINAL: a row
  // is "sent" until its block is final, so each is counted exactly once.
  const final = hotWallet.finalized ?? hotWallet;
  let hotUsdcRaw = final.usdcRaw;
  let hotLamports = final.lamports;
  let outUsdcRaw = 0n;
  let outLamports = 0n;
  for (const row of facts.sent) {
    if (row.toAddress === hotWallet.address) {
      if (row.asset === "USDC") hotUsdcRaw += row.amountRaw;
      else if (row.asset === "SOL") hotLamports += row.amountRaw;
    }
    if (row.fromAddress === hotWallet.address) {
      if (row.asset === "USDC") {
        hotUsdcRaw -= row.amountRaw;
        outUsdcRaw += row.amountRaw;
      } else if (row.asset === "SOL") {
        hotLamports -= row.amountRaw;
        outLamports += row.amountRaw;
      }
    }
  }
  // What is final and no longer confirmed has left the wallet. Whatever of
  // that the rows above do not account for was a payout: it is in no row
  // of this table, and it is gone whether or not its block is final yet.
  const goneUsdcRaw = final.usdcRaw - hotWallet.usdcRaw - outUsdcRaw;
  if (goneUsdcRaw > 0n) hotUsdcRaw -= goneUsdcRaw;
  const goneLamports = final.lamports - hotWallet.lamports - outLamports;
  if (goneLamports > 0n) hotLamports -= goneLamports;

  const maxPerRun =
    Number.isSafeInteger(settings.maxPerRun) && settings.maxPerRun > 0
      ? settings.maxPerRun
      : 0;

  for (const candidate of candidates) {
    const hold = (reason: SweepHoldReason) =>
      held.push({
        reason,
        address: candidate.address,
        orgId: candidate.orgId,
        asset: candidate.asset,
      });
    if (transfers.length >= maxPerRun) {
      hold("over_run_limit");
      continue;
    }
    const underFloat =
      candidate.asset === "USDC"
        ? hotUsdcRaw < floatUsdcRaw + fillUsdcRaw
        : quote !== null &&
          lamportsWorthCents(quote, hotLamports) < floatSolCents + fillSolCents;

    let kind: ChainTransferKind;
    let toAddress: string;
    if (underFloat) {
      kind = "sweep_to_hot";
      toAddress = hotWallet.address;
    } else if (treasury !== null) {
      kind = "sweep_to_treasury";
      toAddress = treasury;
    } else {
      hold("no_treasury");
      continue;
    }

    const usdc = candidate.asset === "USDC";
    transfers.push({
      kind,
      asset: candidate.asset,
      fromAddress: candidate.address,
      toAddress,
      orgId: candidate.orgId,
      amountRaw: candidate.amountRaw,
      // USDC: the hot wallet pays and the address signs as the owner, two
      // signatures. SOL: the address pays its own fee, one signature.
      feeLamports: usdc
        ? 2n * SWEEP_FEE_PER_SIGNATURE_LAMPORTS
        : SWEEP_FEE_PER_SIGNATURE_LAMPORTS,
      feePayer: usdc ? hotWallet.address : candidate.address,
      valueCents: candidate.valueCents,
    });
    if (kind === "sweep_to_hot") {
      if (usdc) hotUsdcRaw += candidate.amountRaw;
      else hotLamports += candidate.amountRaw;
    }
  }

  // ---- the hot wallet's excess ----

  if (treasury !== null && treasury !== hotWallet.address) {
    const fee = SWEEP_FEE_PER_SIGNATURE_LAMPORTS;

    if (
      !busy.has(busyKey(hotWallet.address, "USDC")) &&
      hotCanPay &&
      hotWallet.usdcRaw > 2n * floatUsdcRaw + keepUsdcRaw
    ) {
      const amountRaw = hotWallet.usdcRaw - floatUsdcRaw - keepUsdcRaw;
      if (minUsdcRaw > 0n && amountRaw >= minUsdcRaw) {
        transfers.push({
          kind: "hot_to_treasury",
          asset: "USDC",
          fromAddress: hotWallet.address,
          toAddress: treasury,
          orgId: null,
          amountRaw,
          feeLamports: fee,
          feePayer: hotWallet.address,
          valueCents: amountRaw / USDC_RAW_PER_CENT,
        });
      }
    }

    if (quote !== null && !busy.has(busyKey(hotWallet.address, "SOL"))) {
      const floatLamports = centsAsLamports(quote, floatSolCents + keepSolCents);
      if (
        floatLamports !== null &&
        lamportsWorthCents(quote, hotWallet.lamports) > 2n * floatSolCents + keepSolCents
      ) {
        // It keeps its float and what open payouts need, and never less
        // than HOT_WALLET_MIN_SOL or than an account needs to stay open,
        // after paying this fee AND every other fee this plan has it pay
        // (a USDC transfer off an address, its own USDC excess): without
        // those it would end a few thousand lamports under its minimum
        // and stop paying for USDC sweeps.
        const fees =
          fee +
          transfers
            .filter((planned) => planned.feePayer === hotWallet.address)
            .reduce((sum, planned) => sum + planned.feeLamports, 0n);
        const keep = maxOf(
          floatLamports,
          settings.hotWalletMinLamports + fees,
          SWEEP_KEEP_LAMPORTS + fees,
        );
        const amountRaw = hotWallet.lamports - keep;
        const valueCents = amountRaw > 0n ? lamportsWorthCents(quote, amountRaw) : 0n;
        if (amountRaw > 0n && minCents > 0n && valueCents >= minCents) {
          transfers.push({
            kind: "hot_to_treasury",
            asset: "SOL",
            fromAddress: hotWallet.address,
            toAddress: treasury,
            orgId: null,
            amountRaw,
            feeLamports: fee,
            feePayer: hotWallet.address,
            valueCents,
          });
        }
      }
    }
  }

  return { transfers, held };
}
