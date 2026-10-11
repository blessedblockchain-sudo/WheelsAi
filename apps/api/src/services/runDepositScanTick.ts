/**
 * The deposit scan (payments pass, batch 5): finds transfers sent to an
 * organization's deposit address and has each credited once. Pure
 * orchestration; every IO surface is an argument
 * (services/buildDepositScanTickDeps.ts binds them).
 *
 * One run:
 *   1. Every receipt still waiting for a price ("detected") is tried
 *      again, oldest first.
 *   2. THE CHEAP WATCH. The addresses of this chain are read 50 at a time
 *      in one call (each with its USDC account). An address has its
 *      history read only when what it holds differs from what the scan
 *      last saw there, or when its owner asked ("Check now").
 *   3. THE HISTORY. The signatures since the cursor, for the address and
 *      for its USDC account, each read once at "finalized", oldest first,
 *      and handed to services/depositScan.ts (what did it do here?) and
 *      services/depositCredit.ts (credit it once).
 *
 * The rules this file keeps:
 *   - NO TRANSFER IS SKIPPED. A cursor moves only past what was
 *     processed. A transaction that cannot be loaded, or a credit that
 *     throws, stops that address for this run with its cursor where the
 *     last processed signature left it.
 *   - lastSeenLamports and lastSeenUsdcRaw are THE BALANCE AS OF THE
 *     CURSOR: what the newest processed transaction left there, from that
 *     transaction's own balances, never the figure the watch read. A node
 *     that answers the watch ahead of the history then costs one more read
 *     on the next run and can never hide a transfer.
 *   - More than DEPOSIT_HISTORY_MAX_PAGES pages for one account: stop,
 *     log an error, change nothing for that address.
 *   - A row whose stored address is not the one this server derives for
 *     its organization is never read. Nor is a row of another chain.
 *   - One address that throws does not stop the others.
 *   - A transfer OUT of a deposit address gets no receipt; it is logged.
 *   - A balance the history does not explain (the node is behind, or does
 *     not serve the address's history) is logged on every run it lasts.
 *     Nothing is credited from a balance alone.
 */

import type {
  DetectedReceipt,
  DetectedReceiptOutcome,
  FoundTransfer,
  FoundTransferOutcome,
} from "./depositCredit.js";
import { depositEffect, type TransactionFacts } from "./depositScan.js";
import type {
  ChainLabel,
  CheckDepositsResult,
  CreditedTransfer,
  DepositAsset,
  WaitingTransfer,
} from "./depositTypes.js";

/** One getMultipleAccounts call takes 100 keys: 50 addresses and their
 * 50 USDC accounts. */
export const DEPOSIT_WATCH_CHUNK = 50;
/** The most pages of one account's history a run reads. */
export const DEPOSIT_HISTORY_MAX_PAGES = 20;
/** Signatures a page of history holds (the node's own limit). */
export const DEPOSIT_HISTORY_PAGE_SIZE = 1000;
/** Receipts waiting for a price that one run tries again. */
export const DEPOSIT_DETECTED_RETRY_LIMIT = 100;

/** The columns of deposit_addresses the scan reads. */
export interface WatchedAddressRow {
  orgId: string;
  address: string;
  network: string;
  usdcAccountOpenedAt: Date | null;
  lastSolSignature: string | null;
  lastUsdcSignature: string | null;
  lastSeenLamports: bigint;
  lastSeenUsdcRaw: bigint;
  scanRequestedAt: Date | null;
}

/** What the watch read for one address. */
export interface AddressSnapshot {
  lamports: bigint;
  usdcAccountExists: boolean;
  usdcRaw: bigint;
}

export type DepositScanEventKind =
  | "credited"
  | "waiting"
  | "ignored"
  | "transfer_out"
  /** The address holds a balance nothing in its history explains yet. */
  | "unexplained"
  | "error";

/** One thing a run did or met, for the log. Never sent to a customer. */
export interface DepositScanEvent {
  kind: DepositScanEventKind;
  orgId?: string;
  address?: string;
  signature?: string;
  asset?: string;
  detail?: string;
}

export interface DepositScanDeps {
  /** `{ ok: true }` only when the node is on the configured cluster. */
  checkCluster: () => Promise<{ ok: boolean; reason?: string }>;
  /** The address this server derives for an organization. May throw. */
  deriveAddress: (orgId: string) => string;
  /** The associated token account of an address for our USDC mint. */
  usdcAccountOf: (address: string) => string;
  usdcMint: string;

  /** Receipts of this chain still "detected", oldest first. */
  loadDetected: (args: {
    limit: number;
    orgId?: string;
  }) => Promise<DetectedReceipt[]>;
  /** Rows of this chain: those whose owner asked first, then the least
   * recently scanned. */
  loadAddresses: (args: { limit: number }) => Promise<WatchedAddressRow[]>;
  /** One organization's row, whatever chain it is labelled for. */
  loadAddress: (orgId: string) => Promise<WatchedAddressRow | null>;

  /** ONE call at "finalized" for up to DEPOSIT_WATCH_CHUNK addresses and
   * their USDC accounts. Answers in the order asked. */
  watch: (
    targets: Array<{ address: string; usdcAccount: string }>,
  ) => Promise<AddressSnapshot[]>;
  /** One page of an account's signatures at "finalized", newest first. */
  listSignatures: (args: {
    account: string;
    before?: string;
    until?: string;
    limit: number;
  }) => Promise<string[]>;
  /** One finalized transaction's facts; null when it cannot be loaded. */
  loadTransaction: (signature: string) => Promise<TransactionFacts | null>;

  creditFoundTransfer: (found: FoundTransfer) => Promise<FoundTransferOutcome>;
  creditDetectedReceipt: (
    receipt: DetectedReceipt,
  ) => Promise<DetectedReceiptOutcome>;

  /** lastScannedAt for every address of a chunk with nothing to read, in
   * ONE write. */
  markWatched: (args: { orgIds: string[]; now: Date }) => Promise<void>;
  /** Sets usdcAccountOpenedAt while it is still null. */
  markUsdcAccountOpen: (args: { orgId: string; now: Date }) => Promise<void>;
  /** Writes what was processed: each cursor with the balance its
   * transaction left, and lastScannedAt. `answeredRequestAt` clears
   * scanRequestedAt when it still holds that value. */
  saveProgress: (args: {
    orgId: string;
    sol?: { signature: string; lamports: bigint };
    usdc?: { signature: string; usdcRaw: bigint };
    answeredRequestAt: Date | null;
    now: Date;
  }) => Promise<void>;

  log?: (event: DepositScanEvent) => void;
  /** For tests: a smaller page. */
  historyPageSize?: number;
}

export interface DepositScanTickInput {
  /** DEPOSITS_ENABLED. */
  enabled: boolean;
  /** DEPOSIT_SCAN_INTERVAL_MS; 0 turns the worker off. */
  intervalMs: number;
  network: ChainLabel;
  /** DEPOSIT_SCAN_MAX_ADDRESSES. */
  maxAddresses: number;
  now?: () => Date;
}

export interface DepositScanTickResult {
  ran: boolean;
  skipped?: "disabled" | "chain_unavailable";
  /** Addresses the watch read. */
  addressesWatched: number;
  /** Addresses whose history was read. */
  historiesRead: number;
  credited: number;
  waiting: number;
  ignored: number;
  transfersOut: number;
  errors: number;
}

/** The worker runs only when deposits are on and it has an interval. */
export function depositScanEnabled(settings: {
  depositsEnabled: boolean;
  intervalMs: number;
}): boolean {
  return (
    settings.depositsEnabled === true &&
    Number.isFinite(settings.intervalMs) &&
    settings.intervalMs > 0
  );
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : String(err);
}

function emptyResult(): DepositScanTickResult {
  return {
    ran: false,
    addressesWatched: 0,
    historiesRead: 0,
    credited: 0,
    waiting: 0,
    ignored: 0,
    transfersOut: 0,
    errors: 0,
  };
}

/** What a pass over one address, or over the waiting receipts, did. */
interface Tally {
  credited: CreditedTransfer[];
  waiting: number;
  ignored: number;
  transfersOut: number;
  errors: number;
}

function newTally(): Tally {
  return { credited: [], waiting: 0, ignored: 0, transfersOut: 0, errors: 0 };
}

function addTally(result: DepositScanTickResult, tally: Tally): void {
  result.credited += tally.credited.length;
  result.waiting += tally.waiting;
  result.ignored += tally.ignored;
  result.transfersOut += tally.transfersOut;
  result.errors += tally.errors;
}

function assetOf(value: string): DepositAsset {
  return value === "USDC" ? "USDC" : "SOL";
}

/** Tries every waiting receipt again. One that throws is left waiting. */
async function retryDetected(
  deps: DepositScanDeps,
  tally: Tally,
  orgId?: string,
): Promise<void> {
  const receipts = await deps.loadDetected({
    limit: DEPOSIT_DETECTED_RETRY_LIMIT,
    ...(orgId !== undefined ? { orgId } : {}),
  });
  for (const receipt of receipts) {
    try {
      const outcome = await deps.creditDetectedReceipt(receipt);
      if (outcome.outcome === "credited") {
        tally.credited.push({
          asset: assetOf(receipt.asset),
          amountRaw: receipt.amountRaw,
          creditedCents: outcome.creditedCents,
          bonusCents: outcome.bonusCents,
          txSignature: receipt.txSignature,
        });
        deps.log?.({
          kind: "credited",
          orgId: receipt.orgId,
          signature: receipt.txSignature,
          asset: receipt.asset,
          detail: "a waiting transfer got its price",
        });
      } else if (outcome.outcome === "waiting") {
        tally.waiting += 1;
      } else if (outcome.outcome === "ignored") {
        tally.ignored += 1;
        deps.log?.({
          kind: "ignored",
          orgId: receipt.orgId,
          signature: receipt.txSignature,
          asset: receipt.asset,
        });
      }
    } catch (err) {
      tally.errors += 1;
      deps.log?.({
        kind: "error",
        orgId: receipt.orgId,
        signature: receipt.txSignature,
        detail: `a waiting receipt threw: ${errorText(err)}`,
      });
    }
  }
}

/**
 * The signatures of an account newer than its cursor, oldest first.
 * "too_many_pages" when the cursor (or the start of the history) was not
 * reached within the page limit.
 */
async function signaturesSince(
  deps: DepositScanDeps,
  account: string,
  cursor: string | null,
): Promise<string[] | "too_many_pages"> {
  const limit = deps.historyPageSize ?? DEPOSIT_HISTORY_PAGE_SIZE;
  const found: string[] = [];
  let before: string | undefined;
  for (let page = 0; page < DEPOSIT_HISTORY_MAX_PAGES; page += 1) {
    const signatures = await deps.listSignatures({
      account,
      limit,
      ...(before !== undefined ? { before } : {}),
      ...(cursor !== null ? { until: cursor } : {}),
    });
    for (const signature of signatures) {
      // A node that ignores `until` still stops here.
      if (cursor !== null && signature === cursor) return found.reverse();
      found.push(signature);
    }
    if (signatures.length < limit) return found.reverse();
    before = signatures[signatures.length - 1];
  }
  return "too_many_pages";
}

interface AddressScan {
  /** False when something could not be read or credited: the address is
   * tried again on a later run. */
  complete: boolean;
  /** Signatures newer than the cursors, in both histories together. */
  signaturesFound: number;
  tally: Tally;
}

/** Reads one address's history since its cursors and credits what it
 * finds. Writes the cursors once, at the end, as far as it got. */
async function scanAddress(
  row: WatchedAddressRow,
  deps: DepositScanDeps,
  now: Date,
): Promise<AddressScan> {
  const tally = newTally();
  const usdcAccount = deps.usdcAccountOf(row.address);

  const solSignatures = await signaturesSince(
    deps,
    row.address,
    row.lastSolSignature,
  );
  const usdcSignatures =
    solSignatures === "too_many_pages"
      ? solSignatures
      : await signaturesSince(deps, usdcAccount, row.lastUsdcSignature);
  if (solSignatures === "too_many_pages" || usdcSignatures === "too_many_pages") {
    tally.errors += 1;
    deps.log?.({
      kind: "error",
      orgId: row.orgId,
      address: row.address,
      detail:
        `more than ${DEPOSIT_HISTORY_MAX_PAGES} pages of history since the ` +
        "cursor; nothing was changed. It needs an operator.",
    });
    return { complete: false, signaturesFound: 0, tally };
  }

  // Each transaction is read once and credited once in this pass, even
  // when it is in both histories.
  const done = new Map<string, ReturnType<typeof depositEffect>>();
  let stopped = false;

  const process = async (signature: string) => {
    const seen = done.get(signature);
    if (seen) return seen;
    let facts: TransactionFacts | null;
    try {
      facts = await deps.loadTransaction(signature);
    } catch (err) {
      deps.log?.({
        kind: "error",
        orgId: row.orgId,
        address: row.address,
        signature,
        detail: `the transaction could not be loaded: ${errorText(err)}`,
      });
      return null;
    }
    if (!facts) {
      deps.log?.({
        kind: "error",
        orgId: row.orgId,
        address: row.address,
        signature,
        detail: "the transaction could not be loaded",
      });
      return null;
    }
    const effect = depositEffect(facts, {
      address: row.address,
      usdcAccount,
      usdcMint: deps.usdcMint,
    });

    const arrivals: Array<{ asset: DepositAsset; amountRaw: bigint }> = [];
    if (effect.usdcIn > 0n) arrivals.push({ asset: "USDC", amountRaw: effect.usdcIn });
    if (effect.lamportsIn > 0n) arrivals.push({ asset: "SOL", amountRaw: effect.lamportsIn });

    const outcomes: Array<{
      asset: DepositAsset;
      amountRaw: bigint;
      outcome: FoundTransferOutcome;
    }> = [];
    try {
      for (const arrival of arrivals) {
        outcomes.push({
          ...arrival,
          outcome: await deps.creditFoundTransfer({
            orgId: row.orgId,
            depositAddress: row.address,
            asset: arrival.asset,
            amountRaw: arrival.amountRaw,
            txSignature: signature,
            topupId: effect.topupId,
            slot: effect.slot,
            blockTime: effect.blockTime,
            senderAddresses: effect.signers,
          }),
        });
      }
    } catch (err) {
      deps.log?.({
        kind: "error",
        orgId: row.orgId,
        address: row.address,
        signature,
        detail: `the transfer could not be credited: ${errorText(err)}`,
      });
      // What was credited before the throw is committed and counted; the
      // cursor stays, and the next pass skips it at its receipt.
      countOutcomes(signature, outcomes);
      return null;
    }
    countOutcomes(signature, outcomes);

    if (effect.lamportsOut > 0n || effect.usdcOut > 0n) {
      tally.transfersOut += 1;
      deps.log?.({
        kind: "transfer_out",
        orgId: row.orgId,
        address: row.address,
        signature,
        detail:
          `left the address: ${effect.lamportsOut.toString()} lamports, ` +
          `${effect.usdcOut.toString()} USDC base units. No receipt is written.`,
      });
    }
    done.set(signature, effect);
    return effect;
  };

  function countOutcomes(
    signature: string,
    outcomes: Array<{
      asset: DepositAsset;
      amountRaw: bigint;
      outcome: FoundTransferOutcome;
    }>,
  ): void {
    for (const { asset, amountRaw, outcome } of outcomes) {
      if (outcome.outcome === "credited") {
        tally.credited.push({
          asset,
          amountRaw,
          creditedCents: outcome.creditedCents,
          bonusCents: outcome.bonusCents,
          txSignature: signature,
        });
        deps.log?.({
          kind: "credited",
          orgId: row.orgId,
          address: row.address,
          signature,
          asset,
          detail: outcome.source,
        });
      } else if (outcome.outcome === "waiting") {
        tally.waiting += 1;
        deps.log?.({ kind: "waiting", orgId: row.orgId, address: row.address, signature, asset });
      } else if (outcome.outcome === "ignored") {
        tally.ignored += 1;
        deps.log?.({ kind: "ignored", orgId: row.orgId, address: row.address, signature, asset });
      }
      // "already": the guard working. Nothing to count, nothing to say.
    }
  }
  let sol: { signature: string; lamports: bigint } | undefined;
  let usdc: { signature: string; usdcRaw: bigint } | undefined;

  for (const signature of solSignatures) {
    const effect = await process(signature);
    if (!effect) {
      stopped = true;
      break;
    }
    sol = {
      signature,
      lamports: effect.lamportsAfter ?? sol?.lamports ?? row.lastSeenLamports,
    };
  }
  if (!stopped) {
    for (const signature of usdcSignatures) {
        const effect = await process(signature);
      if (!effect) {
        stopped = true;
        break;
      }
      usdc = {
        signature,
        usdcRaw: effect.usdcAfter ?? usdc?.usdcRaw ?? row.lastSeenUsdcRaw,
      };
    }
  }

  if (stopped) tally.errors += 1;
  await deps.saveProgress({
    orgId: row.orgId,
    ...(sol ? { sol } : {}),
    ...(usdc ? { usdc } : {}),
    // Only a run that read everything has answered "Check now".
    answeredRequestAt: stopped ? null : row.scanRequestedAt,
    now,
  });
  return {
    complete: !stopped,
    signaturesFound: solSignatures.length + usdcSignatures.length,
    tally,
  };
}

/** Is this row one this server may read? Logs why not. */
function readable(
  row: WatchedAddressRow,
  network: ChainLabel,
  deps: DepositScanDeps,
): "ok" | "other_network" | "wrong_address" {
  if (row.network !== network) return "other_network";
  let derived: string;
  try {
    derived = deps.deriveAddress(row.orgId);
  } catch (err) {
    deps.log?.({
      kind: "error",
      orgId: row.orgId,
      detail: `the address could not be derived: ${errorText(err)}`,
    });
    return "wrong_address";
  }
  if (derived !== row.address) {
    deps.log?.({
      kind: "error",
      orgId: row.orgId,
      address: row.address,
      detail:
        "the stored address is not the one this server derives for the " +
        "organization; it was not read. It needs an operator.",
    });
    return "wrong_address";
  }
  return "ok";
}

export async function runDepositScanTick(
  input: DepositScanTickInput,
  deps: DepositScanDeps,
): Promise<DepositScanTickResult> {
  const result = emptyResult();
  if (
    !depositScanEnabled({
      depositsEnabled: input.enabled,
      intervalMs: input.intervalMs,
    })
  ) {
    result.skipped = "disabled";
    return result;
  }

  let cluster: { ok: boolean };
  try {
    cluster = await deps.checkCluster();
  } catch {
    cluster = { ok: false };
  }
  if (!cluster.ok) {
    result.skipped = "chain_unavailable";
    return result;
  }
  result.ran = true;
  const now = (input.now ?? (() => new Date()))();

  // 1. Receipts waiting for a price.
  const waitingTally = newTally();
  try {
    await retryDetected(deps, waitingTally);
  } catch (err) {
    waitingTally.errors += 1;
    deps.log?.({
      kind: "error",
      detail: `the waiting receipts could not be read: ${errorText(err)}`,
    });
  }
  addTally(result, waitingTally);

  // 2. The addresses of this chain that this server may read.
  const loaded = await deps.loadAddresses({ limit: input.maxAddresses });
  const rows: WatchedAddressRow[] = [];
  for (const row of loaded.slice(0, input.maxAddresses)) {
    const verdict = readable(row, input.network, deps);
    if (verdict === "ok") rows.push(row);
    else if (verdict === "wrong_address") result.errors += 1;
  }

  for (let start = 0; start < rows.length; start += DEPOSIT_WATCH_CHUNK) {
    const chunk = rows.slice(start, start + DEPOSIT_WATCH_CHUNK);
    let snapshots: AddressSnapshot[];
    try {
      snapshots = await deps.watch(
        chunk.map((row) => ({
          address: row.address,
          usdcAccount: deps.usdcAccountOf(row.address),
        })),
      );
      if (snapshots.length !== chunk.length) {
        throw new Error("the node did not answer for every address");
      }
    } catch (err) {
      // Nothing was read, so nothing is written: every address of the
      // chunk is left exactly as it was.
      result.errors += 1;
      deps.log?.({
        kind: "error",
        detail: `the watch of ${chunk.length} addresses failed: ${errorText(err)}`,
      });
      continue;
    }
    result.addressesWatched += chunk.length;

    const nothingToRead: string[] = [];
    for (let i = 0; i < chunk.length; i += 1) {
      const row = chunk[i] as WatchedAddressRow;
      const snapshot = snapshots[i] as AddressSnapshot;
      try {
        if (snapshot.usdcAccountExists && row.usdcAccountOpenedAt === null) {
          await deps.markUsdcAccountOpen({ orgId: row.orgId, now });
        }
        const differs =
          snapshot.lamports !== row.lastSeenLamports ||
          snapshot.usdcRaw !== row.lastSeenUsdcRaw;
        if (!differs && row.scanRequestedAt === null) {
          nothingToRead.push(row.orgId);
          continue;
        }
        result.historiesRead += 1;
        const scan = await scanAddress(row, deps, now);
        addTally(result, scan.tally);
        if (differs && scan.complete && scan.signaturesFound === 0) {
          // The watch shows a balance and the history shows nothing new.
          // A node a little behind does this for a run or two. One that
          // keeps doing it is not serving the address's history, and a
          // transfer there is waiting to be credited: say so every run.
          deps.log?.({
            kind: "unexplained",
            orgId: row.orgId,
            address: row.address,
            detail:
              `holds ${snapshot.lamports.toString()} lamports and ` +
              `${snapshot.usdcRaw.toString()} USDC base units; its history ` +
              `explains ${row.lastSeenLamports.toString()} and ` +
              `${row.lastSeenUsdcRaw.toString()}. Nothing new was found in ` +
              "its history. Nothing was credited and nothing was skipped.",
          });
        }
      } catch (err) {
        result.errors += 1;
        deps.log?.({
          kind: "error",
          orgId: row.orgId,
          address: row.address,
          detail: `the address threw and was left as it was: ${errorText(err)}`,
        });
      }
    }

    if (nothingToRead.length > 0) {
      try {
        await deps.markWatched({ orgIds: nothingToRead, now });
      } catch (err) {
        result.errors += 1;
        deps.log?.({
          kind: "error",
          detail: `the scan time could not be written: ${errorText(err)}`,
        });
      }
    }
  }

  return result;
}

export interface DepositCheckInput {
  /** DEPOSITS_ENABLED. */
  enabled: boolean;
  network: ChainLabel;
  now?: () => Date;
}

/**
 * "Check now" for one organization: the same steps as a run, reading the
 * address's history whatever its balance and trying its waiting receipts
 * again. Answers what THIS call credited and every transfer of the
 * organization still waiting. Never throws.
 */
export async function runDepositCheck(
  orgId: string,
  input: DepositCheckInput,
  deps: DepositScanDeps,
): Promise<CheckDepositsResult> {
  if (!input.enabled) return { outcome: "chain_unavailable" };
  try {
    let cluster: { ok: boolean };
    try {
      cluster = await deps.checkCluster();
    } catch {
      cluster = { ok: false };
    }
    if (!cluster.ok) return { outcome: "chain_unavailable" };

    const row = await deps.loadAddress(orgId);
    if (!row || row.orgId !== orgId) return { outcome: "not_issued" };
    const verdict = readable(row, input.network, deps);
    if (verdict === "other_network") return { outcome: "not_issued" };
    if (verdict === "wrong_address") return { outcome: "chain_unavailable" };

    const now = (input.now ?? (() => new Date()))();
    const credited: CreditedTransfer[] = [];
    let complete = true;

    const waitingTally = newTally();
    await retryDetected(deps, waitingTally, orgId);
    credited.push(...waitingTally.credited);

    try {
      const usdcAccount = deps.usdcAccountOf(row.address);
      const snapshots = await deps.watch([{ address: row.address, usdcAccount }]);
      const snapshot = snapshots[0];
      if (snapshots.length !== 1 || !snapshot) {
        throw new Error("the node did not answer for the address");
      }
      if (snapshot.usdcAccountExists && row.usdcAccountOpenedAt === null) {
        await deps.markUsdcAccountOpen({ orgId, now });
      }
      const scan = await scanAddress(row, deps, now);
      credited.push(...scan.tally.credited);
      complete = scan.complete;
    } catch (err) {
      complete = false;
      deps.log?.({
        kind: "error",
        orgId,
        address: row.address,
        detail: `the check could not read the address: ${errorText(err)}`,
      });
    }

    // What was credited is committed: it is answered even when a later
    // read failed. With nothing credited, a failed read is said as such.
    if (!complete && credited.length === 0) {
      return { outcome: "chain_unavailable" };
    }

    const still = await deps.loadDetected({
      limit: DEPOSIT_DETECTED_RETRY_LIMIT,
      orgId,
    });
    const waiting: WaitingTransfer[] = still.map((receipt) => ({
      asset: assetOf(receipt.asset),
      amountRaw: receipt.amountRaw,
      txSignature: receipt.txSignature,
    }));
    return { outcome: "scanned", credited, waiting };
  } catch (err) {
    deps.log?.({
      kind: "error",
      orgId,
      detail: `the check threw: ${errorText(err)}`,
    });
    return { outcome: "chain_unavailable" };
  }
}
