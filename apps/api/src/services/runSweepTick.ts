/**
 * One run of the sweep worker (payments pass, batch 6): what customers
 * paid is moved off their deposit addresses, to the hot wallet while it is
 * under its float and to the proven treasury otherwise, and the hot
 * wallet's excess goes to the treasury. Pure orchestration; every IO
 * surface is an argument (services/buildSweepTickDeps.ts binds them). What
 * may move and where is decided by services/sweepPlan.ts.
 *
 * One run:
 *   0. Nothing at all while sweeps are off, the interval is 0, or the node
 *      is not on the configured cluster.
 *   1. EVERY "sent" ROW IS SETTLED FROM THE CHAIN FIRST. landed_ok ends it
 *      as landed and landed_failed as failed, each only once its block is
 *      FINALIZED (until then the row stays "sent", so the plan, which
 *      reads at "finalized", cannot sign for the same money again); dead
 *      ends it as dead; in_flight sends the SAME stored bytes again;
 *      unknown changes nothing.
 *   2. The deposit addresses of this chain whose stored address is the one
 *      this server derives are read at "finalized", with the hot wallet,
 *      the proven treasury and the SOL price, and the plan is made.
 *   3. CLAIM FIRST. Each planned transfer is signed, its row written as
 *      "sent" with the signature, the signed bytes and the last block
 *      height they can land at, and only then broadcast. A row the
 *      database refuses (another worker has that money) sends nothing. A
 *      send that throws changes nothing: the next run asks the chain.
 *
 * The rules this file keeps:
 *   - A new signature is made only for money no "sent" row holds. A row
 *     that was "sent" when this run began is not planned again in this
 *     run, whatever became of it: a later run does that.
 *   - No transfer is signed for a destination other than the hot wallet
 *     and the proven treasury.
 *   - One row or one address that throws does not stop the others.
 */

import type { ChainLabel } from "./depositTypes.js";
import type { SignatureFateAnswer, SignatureFateInput } from "./signatureFate.js";
import type { SolPriceResult } from "./solPrice.js";
import {
  planSweeps,
  type PlannedTransfer,
  type SweepAddressFacts,
  type SweepHold,
  type SweepSettings,
} from "./sweepPlan.js";

/** One getMultipleAccounts call takes 100 keys: 50 addresses and their
 * 50 USDC accounts. */
export const SWEEP_READ_CHUNK = 50;

/** A chain_transfers row that is "sent". */
export interface SentTransferRow {
  id: string;
  kind: string;
  asset: string;
  fromAddress: string;
  toAddress: string;
  amountRaw: bigint;
  txSignature: string;
  signedTxB64: string;
  lastValidBlockHeight: bigint;
}

/** USDC has 6 decimals: one cent is 10,000 base units. */
const USDC_RAW_PER_CENT = 10_000n;

/** The columns of deposit_addresses the sweep reads. */
export interface SweepAddressRow {
  orgId: string;
  address: string;
  network: string;
  lastSeenLamports: bigint;
  lastSeenUsdcRaw: bigint;
}

/** What an address holds at "finalized". */
export interface SweepBalance {
  lamports: bigint;
  usdcRaw: bigint;
}

/** A signed transfer that has NOT been sent: what the claim stores. */
export interface SignedSweepArtifact {
  txSignature: string;
  signedTxB64: string;
  lastValidBlockHeight: bigint;
}

export type SweepSettledAs = "landed" | "failed" | "dead";

export type SweepEvent =
  | { event: "settled"; as: SweepSettledAs; id: string; kind: string; asset: string; signature: string; detail: string }
  | { event: "resent"; id: string; signature: string }
  | { event: "resend_error"; id: string; signature: string; detail: string }
  | { event: "fate_unknown"; id: string; signature: string; detail: string }
  /** It reached the chain and its block is not finalized: the row stays. */
  | { event: "not_final_yet"; id: string; signature: string; detail: string }
  | { event: "held"; hold: SweepHold }
  | { event: "claimed"; transfer: PlannedTransfer; signature: string }
  | { event: "claim_lost"; transfer: PlannedTransfer }
  | { event: "send_error"; transfer: PlannedTransfer; signature: string; detail: string }
  | { event: "error"; orgId?: string; address?: string; id?: string; detail: string };

export interface SweepTickDeps {
  /** `{ ok: true }` only when the node is on the configured cluster. */
  checkCluster: () => Promise<{ ok: boolean; reason?: string }>;

  // ---- transfers that are out ----
  /** Every "sent" row of this chain, oldest first. */
  loadSent: () => Promise<SentTransferRow[]>;
  /** services/buildSignatureFateDeps.ts readSignatureFate. Never throws. */
  readFate: (input: SignatureFateInput) => Promise<SignatureFateAnswer>;
  /** Compare-and-set "sent" -> the outcome, on that signature. False: the
   * row had already moved. */
  settle: (
    row: SentTransferRow,
    as: SweepSettledAs,
    reason: string | null,
  ) => Promise<boolean>;
  /** Sends stored bytes as they are. A throw proves nothing either way. */
  broadcast: (signedTxB64: string) => Promise<void>;

  // ---- the facts a plan is made from ----
  /** The rows of this chain that hold something by the scan's account. */
  loadAddresses: () => Promise<SweepAddressRow[]>;
  /** The address this server derives for an organization. May throw. */
  deriveAddress: (orgId: string) => string;
  /** ONE call at "finalized" for up to SWEEP_READ_CHUNK addresses and
   * their USDC accounts. Answers in the order asked. */
  readBalances: (addresses: string[]) => Promise<SweepBalance[]>;
  /** The hot wallet: its address and what it holds. Throws when the node
   * cannot be read. */
  readHotWallet: () => Promise<{ address: string; lamports: bigint; usdcRaw: bigint }>;
  /** The proven treasury's address, or null (services/sweepPlan.ts
   * treasuryVerdict). */
  readTreasury: () => Promise<string | null>;
  /** services/buildSolPriceDeps.ts getSolQuote. */
  getSolQuote: () => Promise<SolPriceResult>;
  /** What payouts to a wallet that are still open need from the hot
   * wallet, in cents by asset, already capped. Throws when it cannot be
   * read. */
  readOpenPayouts: () => Promise<{ usdcCents: bigint; solCents: bigint }>;

  // ---- the claim and the send ----
  /** A fresh blockhash, the transfer built and SIGNED. Sends nothing.
   * Throws when it cannot, or when the transfer is not one it may sign. */
  prepare: (
    transfer: PlannedTransfer,
    allowed: { hotWallet: string; treasury: string | null },
  ) => Promise<SignedSweepArtifact>;
  /** Writes the "sent" row. False when the database refuses it (P2002):
   * another worker has that money, and nothing may be sent. */
  claim: (
    transfer: PlannedTransfer,
    artifact: SignedSweepArtifact,
  ) => Promise<boolean>;

  log?: (event: SweepEvent) => void;
}

export interface SweepTickInput {
  /** SWEEPS_ENABLED. */
  enabled: boolean;
  /** SWEEP_INTERVAL_MS; 0 turns the worker off. */
  intervalMs: number;
  network: ChainLabel;
  settings: SweepSettings;
}

export interface SweepTickResult {
  ran: boolean;
  /** Why the run did nothing. */
  reason?: "disabled" | "chain_unavailable";
  /** "sent" rows this run ended, by outcome. */
  settled: { landed: number; failed: number; dead: number };
  /** Stored transfers broadcast again, unchanged. */
  resent: number;
  /** "sent" rows this run left as they are. */
  left: number;
  /** Deposit addresses read. */
  addressesRead: number;
  /** Transfers the plan held. */
  planned: number;
  /** Transfers whose row was written (and so were handed to the network). */
  sent: number;
  /** Planned transfers another worker already had: nothing was sent. */
  skipped: number;
  /** Money that qualifies and stays where it is for now (the log says why). */
  held: number;
  errors: number;
}

/** The worker runs only when sweeps are on and it has an interval. */
export function sweepsEnabled(settings: {
  sweepsEnabled: boolean;
  intervalMs: number;
}): boolean {
  return (
    settings.sweepsEnabled === true &&
    Number.isFinite(settings.intervalMs) &&
    settings.intervalMs > 0
  );
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

function emptyResult(): SweepTickResult {
  return {
    ran: false,
    settled: { landed: 0, failed: 0, dead: 0 },
    resent: 0,
    left: 0,
    addressesRead: 0,
    planned: 0,
    sent: 0,
    skipped: 0,
    held: 0,
    errors: 0,
  };
}

export async function runSweepTick(
  input: SweepTickInput,
  deps: SweepTickDeps,
): Promise<SweepTickResult> {
  const result = emptyResult();
  if (!sweepsEnabled({ sweepsEnabled: input.enabled, intervalMs: input.intervalMs })) {
    result.reason = "disabled";
    return result;
  }

  let cluster: { ok: boolean };
  try {
    cluster = await deps.checkCluster();
  } catch {
    cluster = { ok: false };
  }
  if (!cluster.ok) {
    result.reason = "chain_unavailable";
    return result;
  }
  result.ran = true;

  const log = (event: SweepEvent) => {
    try {
      deps.log?.(event);
    } catch {
      // A log line that cannot be written never changes what money does.
    }
  };

  // ---- 1. Every "sent" row, settled from the chain ----

  let sentAtStart: SentTransferRow[];
  try {
    sentAtStart = await deps.loadSent();
  } catch (err) {
    // Without knowing what is out, nothing new may be signed.
    result.errors += 1;
    log({ event: "error", detail: `the transfers that are out could not be read: ${errorText(err)}` });
    return result;
  }

  const stillSent: SentTransferRow[] = [];
  for (const row of sentAtStart) {
    try {
      const fate = await deps.readFate({
        signature: row.txSignature,
        lastValidBlockHeight: row.lastValidBlockHeight,
      });
      let as: SweepSettledAs | null = null;
      let reason: string | null = null;
      let detail = "";
      // A transfer that reached the chain ends its row only once its block
      // is FINALIZED. The plan reads what an address holds at "finalized":
      // ending the row sooner would leave a run in which the old balance is
      // still read and no row is out, and the same money would be signed
      // for again (a transfer that can only fail, and its fee).
      const landed = fate.fate === "landed_ok" || fate.fate === "landed_failed";
      if (landed && fate.detail.confirmationStatus !== "finalized") {
        stillSent.push(row);
        result.left += 1;
        log({
          event: "not_final_yet",
          id: row.id,
          signature: row.txSignature,
          detail: "it reached the chain; its block is not finalized yet",
        });
        continue;
      }
      if (fate.fate === "landed_ok") {
        as = "landed";
        detail = "it landed";
      } else if (fate.fate === "landed_failed") {
        as = "failed";
        reason = `it failed on the chain: ${fate.error ?? fate.reason}`;
        detail = reason;
      } else if (fate.fate === "dead") {
        as = "dead";
        reason = `it can no longer land (${fate.reason})`;
        detail = reason;
      }

      if (as !== null) {
        const won = await deps.settle(row, as, reason);
        if (won) {
          result.settled[as] += 1;
          log({
            event: "settled",
            as,
            id: row.id,
            kind: row.kind,
            asset: row.asset,
            signature: row.txSignature,
            detail,
          });
        }
        // Lost: another worker ended it. Either way it is no longer out.
        continue;
      }

      stillSent.push(row);
      if (fate.fate === "in_flight") {
        try {
          // The same bytes, so the same signature: the chain takes it
          // once however often it is sent.
          await deps.broadcast(row.signedTxB64);
          result.resent += 1;
          log({ event: "resent", id: row.id, signature: row.txSignature });
        } catch (err) {
          result.left += 1;
          log({
            event: "resend_error",
            id: row.id,
            signature: row.txSignature,
            detail: errorText(err),
          });
        }
      } else {
        result.left += 1;
        log({
          event: "fate_unknown",
          id: row.id,
          signature: row.txSignature,
          detail: fate.error ?? fate.reason,
        });
      }
    } catch (err) {
      // The row is as it was: still "sent", and a later run asks again.
      stillSent.push(row);
      result.errors += 1;
      log({ event: "error", id: row.id, detail: `a sent transfer threw: ${errorText(err)}` });
    }
  }

  // ---- 2. The facts, and the plan ----

  let hotWallet: { address: string; lamports: bigint; usdcRaw: bigint };
  try {
    hotWallet = await deps.readHotWallet();
  } catch (err) {
    result.errors += 1;
    log({ event: "error", detail: `the hot wallet could not be read: ${errorText(err)}` });
    return result;
  }

  let treasury: string | null = null;
  try {
    treasury = await deps.readTreasury();
  } catch (err) {
    // No treasury that can be read is no treasury.
    result.errors += 1;
    log({ event: "error", detail: `the treasury could not be read: ${errorText(err)}` });
  }
  if (treasury !== null && treasury === hotWallet.address) treasury = null;

  let quote = null;
  try {
    const price = await deps.getSolQuote();
    if (price.ok) quote = price.quote;
  } catch {
    quote = null;
  }

  // What open payouts need. Without it the hot wallet's excess cannot be
  // told from money a payout is waiting for, so nothing is planned.
  let openPayouts: { usdcRaw: bigint; solCents: bigint };
  try {
    const owed = await deps.readOpenPayouts();
    openPayouts = {
      usdcRaw: (owed.usdcCents > 0n ? owed.usdcCents : 0n) * USDC_RAW_PER_CENT,
      solCents: owed.solCents > 0n ? owed.solCents : 0n,
    };
  } catch (err) {
    result.errors += 1;
    log({ event: "error", detail: `the open payouts could not be read: ${errorText(err)}` });
    return result;
  }

  let rows: SweepAddressRow[] = [];
  try {
    rows = await deps.loadAddresses();
  } catch (err) {
    result.errors += 1;
    log({ event: "error", detail: `the deposit addresses could not be read: ${errorText(err)}` });
  }

  // Only a row of this chain whose stored address is the one this server
  // derives for its organization. Any other is never touched.
  const mine: SweepAddressRow[] = [];
  for (const row of rows) {
    if (row.network !== input.network) continue;
    let derived: string;
    try {
      derived = deps.deriveAddress(row.orgId);
    } catch (err) {
      result.errors += 1;
      log({
        event: "error",
        orgId: row.orgId,
        detail: `the address could not be derived: ${errorText(err)}`,
      });
      continue;
    }
    if (derived !== row.address) {
      result.errors += 1;
      log({
        event: "error",
        orgId: row.orgId,
        address: row.address,
        detail:
          "the stored address is not the one this server derives for the " +
          "organization; nothing is moved from it. It needs an operator.",
      });
      continue;
    }
    mine.push(row);
  }

  const addresses: SweepAddressFacts[] = [];
  for (let start = 0; start < mine.length; start += SWEEP_READ_CHUNK) {
    const chunk = mine.slice(start, start + SWEEP_READ_CHUNK);
    try {
      const balances = await deps.readBalances(chunk.map((row) => row.address));
      if (balances.length !== chunk.length) {
        throw new Error("the node did not answer for every address");
      }
      chunk.forEach((row, i) => {
        const balance = balances[i] as SweepBalance;
        addresses.push({
          orgId: row.orgId,
          address: row.address,
          lamports: balance.lamports,
          usdcRaw: balance.usdcRaw,
          lastSeenLamports: row.lastSeenLamports,
          lastSeenUsdcRaw: row.lastSeenUsdcRaw,
        });
      });
      result.addressesRead += chunk.length;
    } catch (err) {
      // Nothing was read, so nothing of this chunk is planned.
      result.errors += 1;
      log({
        event: "error",
        detail: `the read of ${chunk.length} addresses failed: ${errorText(err)}`,
      });
    }
  }

  const plan = planSweeps({
    settings: input.settings,
    addresses,
    sent: stillSent,
    alsoBusy: sentAtStart,
    hotWallet,
    treasury,
    quote,
    openPayouts,
  });
  result.planned = plan.transfers.length;
  result.held = plan.held.length;
  for (const hold of plan.held) log({ event: "held", hold });

  // ---- 3. Claim, then send ----

  const derivedByAddress = new Map(mine.map((row) => [row.address, row.orgId]));
  for (const transfer of plan.transfers) {
    try {
      // Fail closed, whatever the plan says: only the hot wallet and the
      // proven treasury are ever sent to, and only from an address this
      // run derived or from the hot wallet.
      const toHot = transfer.toAddress === hotWallet.address;
      const toTreasury = treasury !== null && transfer.toAddress === treasury;
      const fromHot = transfer.fromAddress === hotWallet.address;
      const destinationOk =
        (transfer.kind === "sweep_to_hot" && toHot) ||
        (transfer.kind === "sweep_to_treasury" && toTreasury) ||
        (transfer.kind === "hot_to_treasury" && toTreasury);
      const sourceOk =
        transfer.kind === "hot_to_treasury"
          ? fromHot && transfer.orgId === null
          : !fromHot &&
            transfer.orgId !== null &&
            derivedByAddress.get(transfer.fromAddress) === transfer.orgId;
      if (!destinationOk || !sourceOk || transfer.amountRaw <= 0n) {
        throw new Error("the plan held a transfer this server may not sign");
      }

      const artifact = await deps.prepare(transfer, {
        hotWallet: hotWallet.address,
        treasury,
      });
      const claimed = await deps.claim(transfer, artifact);
      if (!claimed) {
        // The transfer just signed is dropped unsent: it is stored
        // nowhere and can never be broadcast.
        result.skipped += 1;
        log({ event: "claim_lost", transfer });
        continue;
      }
      result.sent += 1;
      log({ event: "claimed", transfer, signature: artifact.txSignature });

      try {
        await deps.broadcast(artifact.signedTxB64);
      } catch (err) {
        // It may have reached the chain all the same. The bytes are on
        // the row; the next run asks the chain what became of them.
        log({
          event: "send_error",
          transfer,
          signature: artifact.txSignature,
          detail: errorText(err),
        });
      }
    } catch (err) {
      result.errors += 1;
      log({
        event: "error",
        ...(transfer.orgId !== null ? { orgId: transfer.orgId } : {}),
        address: transfer.fromAddress,
        detail: `a ${transfer.asset} transfer could not be signed or stored: ${errorText(err)}`,
      });
    }
  }

  return result;
}
