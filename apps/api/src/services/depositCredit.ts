/**
 * The ways a transfer found at a deposit address is credited (payments
 * pass, batch 5). Each is ONE database transaction, and each is guarded by
 * the unique index of onchain_receipts on (network, tx_signature, asset):
 * a transfer is credited once, whoever finds it and however often.
 *
 *   1. It belongs to a prepared top-up of THIS organization (its signature
 *      is that row's, or its memo names that row), the row is not credited
 *      yet whatever status it is in, and what arrived is exactly the row's
 *      amount of the row's asset (and, for a SOL row the transfer only
 *      names, it landed while the row's price was held). It is credited
 *      THROUGH the row: the row
 *      goes to `credited` by compare-and-set, the receipt is written
 *      (source "prepared") and the row's own amounts are granted, with the
 *      description a top-up's grant has (services/walletTopup.ts).
 *   2. Otherwise it was sent straight to the address ("direct"). USDC is
 *      exact: base units divided by 10,000, rounded down, is cents. SOL is
 *      valued by the live quote and by nothing else; with no price the
 *      receipt is written "detected" and nothing is granted. Worth less
 *      than one cent: "ignored".
 *   3. A "detected" receipt is credited later at the price it then gets:
 *      compare-and-set detected -> credited with the grant.
 *
 * A unique violation aborts a Postgres transaction, so it is never caught
 * inside one: the transaction rolls back and the violation becomes
 * "already" out here, and only when the receipt is really there. A
 * transfer that already has a receipt is skipped silently: that is the
 * guard working.
 *
 * Nothing here judges who sent a transfer.
 */

import { randomUUID } from "node:crypto";

import { grantCredits, type CreditGrantTxClient } from "./creditGrant.js";
import { bonusForAmount } from "./creditPackages.js";
import type { ChainLabel, DepositAsset } from "./depositTypes.js";
import {
  centsToCreditForLamports,
  solMicroUsdRate,
  type SolPriceResult,
  type SolQuote,
} from "./solPrice.js";
import type { OnchainReceiptCreateData } from "./walletTopup.js";

/** USDC has 6 decimals: 10,000 base units are one cent. */
export const USDC_RAW_PER_CENT = 10_000n;

export const IGNORED_BELOW_ONE_CENT = "below_one_cent";

/** Every status a top-up can be credited from by a transfer found on the
 * chain: a customer who broadcast it themselves, or a row the older code
 * gave up on, still paid. */
export const UNCREDITED_TOPUP_STATUSES: readonly string[] = [
  "prepared",
  "submitting",
  "submitted",
  "failed",
  "expired",
];

/** One asset of one transaction that arrived at a deposit address. */
export interface FoundTransfer {
  orgId: string;
  depositAddress: string;
  asset: DepositAsset;
  /** Base units: lamports, or USDC with 6 decimals. Above zero. */
  amountRaw: bigint;
  txSignature: string;
  /** The top-up the transaction's memo names, if any. */
  topupId: string | null;
  slot: bigint | null;
  blockTime: Date | null;
  /** The transaction's signers, for the record only. */
  senderAddresses: string[];
}

export type FoundTransferOutcome =
  | {
      outcome: "credited";
      source: "prepared" | "direct";
      creditedCents: bigint;
      bonusCents: bigint;
    }
  /** Recorded, waiting for a price. */
  | { outcome: "waiting" }
  /** Recorded, too small to credit. */
  | { outcome: "ignored" }
  /** It already has a receipt: nothing was written. */
  | { outcome: "already" };

/** A receipt still waiting for a price. */
export interface DetectedReceipt {
  id: string;
  orgId: string;
  asset: string;
  amountRaw: bigint;
  txSignature: string;
}

export type DetectedReceiptOutcome =
  | { outcome: "credited"; creditedCents: bigint; bonusCents: bigint }
  | { outcome: "waiting" }
  | { outcome: "ignored" }
  /** Another run settled it first. */
  | { outcome: "already" };

/** The columns of a top-up the match is made on. */
export interface TopupCandidateRow {
  id: string;
  orgId: string;
  asset: string;
  network: string;
  status: string;
  amountUsdCents: bigint;
  bonusCents: bigint;
  amountRaw: string;
  depositAddress: string;
  txSignature: string | null;
  /** Until when the row's price was held. */
  expiresAt?: Date | null;
  quotePriceMicroUsd?: bigint | null;
  quotePublishTime?: Date | null;
  quoteSource?: string | null;
}

/**
 * How long after a SOL row's hold ended a transfer that only NAMES the row
 * (its memo; the row holds no signature) may still land and be credited at
 * the row's price. The prepared transfer itself cannot land later than
 * this: its blockhash is dead by then. Anything later was built afresh,
 * and is credited at the price of the day it is seen, as a transfer sent
 * straight to the address. Without this a prepared SOL row would be a
 * free option on the price, open for ever.
 */
export const SOL_ROW_PRICE_GRACE_MS = 120_000;

export interface DepositCreditTxClient extends CreditGrantTxClient {
  walletTopUp: {
    updateMany: (args: {
      where: {
        id: string;
        orgId: string;
        status: { in: string[] };
        txSignature: string | null;
      };
      data: {
        status: string;
        creditedAt: Date;
        txSignature: string;
        failureCode: null;
      };
    }) => Promise<{ count: number }>;
  };
  onchainReceipt: {
    create: (args: { data: OnchainReceiptCreateData }) => Promise<unknown>;
    updateMany: (args: {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface DepositCreditDb {
  $transaction: <T>(fn: (tx: DepositCreditTxClient) => Promise<T>) => Promise<T>;
  walletTopUp: {
    findFirst: (args: {
      where:
        | { orgId: string; network: string; txSignature: string }
        | { orgId: string; network: string; id: string };
    }) => Promise<TopupCandidateRow | null>;
  };
  onchainReceipt: {
    findUnique: (args: {
      where: {
        network_txSignature_asset: {
          network: string;
          txSignature: string;
          asset: string;
        };
      };
    }) => Promise<{ id: string } | null>;
  };
}

export interface DepositCreditSettings {
  /** The label of the chain the settings name. */
  network: ChainLabel;
  /** services/buildSolPriceDeps.ts getSolQuote. */
  getSolQuote: () => Promise<SolPriceResult>;
  /** services/buildSolPriceDeps.ts getSolQuoteMarginBps. */
  solMarginBps: () => number;
  now?: () => Date;
}

export interface DepositCredit {
  creditFoundTransfer: (found: FoundTransfer) => Promise<FoundTransferOutcome>;
  creditDetectedReceipt: (
    receipt: DetectedReceipt,
  ) => Promise<DetectedReceiptOutcome>;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/** The bonus for a credit, in cents: the ladder on the whole dollars. */
export function depositBonusCents(creditedCents: bigint): bigint {
  if (creditedCents <= 0n) return 0n;
  const wholeDollars = creditedCents / 100n;
  // Past any tier there is; keeps the number exact as a float.
  const dollars = wholeDollars > 1_000_000n ? 1_000_000 : Number(wholeDollars);
  return BigInt(bonusForAmount(dollars) * 100);
}

type Valuation =
  | {
      kind: "credit";
      cents: bigint;
      bonusCents: bigint;
      quotePriceMicroUsd: bigint | null;
      quotePublishTime: Date | null;
      quoteSource: string | null;
    }
  | { kind: "no_price" }
  | { kind: "below_one_cent" };

function valueWithQuote(
  lamports: bigint,
  quote: SolQuote,
  marginBps: number,
): Valuation {
  const cents = centsToCreditForLamports(quote, lamports, marginBps);
  if (!cents.ok) {
    // Only "it rounds to zero" says the transfer is too small. Anything
    // else says this quote cannot price it: wait for one that can.
    return cents.code === "rounds_to_zero"
      ? { kind: "below_one_cent" }
      : { kind: "no_price" };
  }
  const rate = solMicroUsdRate(quote, "in", marginBps);
  if (!rate.ok) return { kind: "no_price" };
  return {
    kind: "credit",
    cents: cents.cents,
    bonusCents: depositBonusCents(cents.cents),
    quotePriceMicroUsd: rate.microUsdPerSol,
    quotePublishTime: new Date(quote.publishTime * 1000),
    quoteSource: quote.source,
  };
}

export function makeDepositCredit(
  db: DepositCreditDb,
  settings: DepositCreditSettings,
): DepositCredit {
  const now = settings.now ?? (() => new Date());
  const labelPrefix =
    settings.network === "solana:devnet" ? "[devnet] " : undefined;

  /** What a transfer is worth now. No number without a quote. */
  async function valueOf(asset: string, amountRaw: bigint): Promise<Valuation> {
    if (asset === "USDC") {
      const cents = amountRaw / USDC_RAW_PER_CENT;
      if (cents <= 0n) return { kind: "below_one_cent" };
      return {
        kind: "credit",
        cents,
        bonusCents: depositBonusCents(cents),
        quotePriceMicroUsd: null,
        quotePublishTime: null,
        quoteSource: null,
      };
    }
    if (asset !== "SOL") return { kind: "no_price" };
    let price: SolPriceResult;
    try {
      price = await settings.getSolQuote();
    } catch {
      return { kind: "no_price" };
    }
    if (!price.ok) return { kind: "no_price" };
    return valueWithQuote(amountRaw, price.quote, settings.solMarginBps());
  }

  function receiptOf(found: FoundTransfer) {
    return db.onchainReceipt.findUnique({
      where: {
        network_txSignature_asset: {
          network: settings.network,
          txSignature: found.txSignature,
          asset: found.asset,
        },
      },
    });
  }

  /**
   * The prepared top-up this transfer pays ("use"); "paid" when a row of
   * this organization is already credited for this very signature and
   * asset; "none" when it is one sent straight to the address.
   */
  async function matchingTopup(
    found: FoundTransfer,
  ): Promise<
    { kind: "use"; row: TopupCandidateRow } | { kind: "paid" } | { kind: "none" }
  > {
    const none = { kind: "none" } as const;
    let row = await db.walletTopUp.findFirst({
      where: {
        orgId: found.orgId,
        network: settings.network,
        txSignature: found.txSignature,
      },
    });
    if (
      row &&
      row.orgId === found.orgId &&
      row.network === settings.network &&
      row.txSignature === found.txSignature &&
      row.status === "credited" &&
      row.asset === found.asset
    ) {
      // This transfer was credited through its row. Its receipt should be
      // there and stop a second credit at the unique index; when it is not
      // (a row credited by code older than the receipts), the row itself
      // says so, and the transfer is never credited again as a direct one.
      return { kind: "paid" };
    }
    if (!row && found.topupId) {
      row = await db.walletTopUp.findFirst({
        where: {
          orgId: found.orgId,
          network: settings.network,
          id: found.topupId,
        },
      });
    }
    if (!row) return none;
    // The reads are scoped, and checked again: a row of another
    // organization or chain is never used.
    if (row.orgId !== found.orgId || row.network !== settings.network) return none;
    if (!UNCREDITED_TOPUP_STATUSES.includes(row.status)) return none;
    if (row.asset !== found.asset) return none;
    if (row.depositAddress !== found.depositAddress) return none;
    // A row that answers for another signature is ended by that one.
    if (row.txSignature !== null && row.txSignature !== found.txSignature) {
      return none;
    }
    let wanted: bigint;
    try {
      wanted = BigInt(row.amountRaw);
    } catch {
      return none;
    }
    if (wanted !== found.amountRaw) return none;
    if (row.amountUsdCents <= 0n || row.bonusCents < 0n) return none;
    // A SOL row holds a price. A transfer that only names the row gets
    // that price only when it landed while the price was held (and the
    // little after it that the prepared transfer could still land in).
    if (row.asset === "SOL" && row.txSignature === null) {
      if (!(row.expiresAt instanceof Date) || found.blockTime === null) return none;
      if (
        found.blockTime.getTime() >
        row.expiresAt.getTime() + SOL_ROW_PRICE_GRACE_MS
      ) {
        return none;
      }
    }
    return { kind: "use", row };
  }

  /** null when the row's compare-and-set was lost: it is not used. */
  async function creditThroughTopup(
    found: FoundTransfer,
    row: TopupCandidateRow,
  ): Promise<FoundTransferOutcome | null> {
    return db.$transaction(async (tx): Promise<FoundTransferOutcome | null> => {
      const creditedAt = now();
      const claimed = await tx.walletTopUp.updateMany({
        where: {
          id: row.id,
          orgId: found.orgId,
          status: { in: [...UNCREDITED_TOPUP_STATUSES] },
          // The value that was read: null (it is stored now) or this one.
          txSignature: row.txSignature,
        },
        data: {
          status: "credited",
          creditedAt,
          txSignature: found.txSignature,
          // It paid: whatever ended the row before no longer describes it.
          failureCode: null,
        },
      });
      if (claimed.count !== 1) return null;
      await tx.onchainReceipt.create({
        data: {
          network: settings.network,
          txSignature: found.txSignature,
          asset: found.asset,
          orgId: found.orgId,
          depositAddress: found.depositAddress,
          amountRaw: found.amountRaw,
          slot: found.slot,
          blockTime: found.blockTime,
          senderAddresses: found.senderAddresses,
          source: "prepared",
          topupId: row.id,
          status: "credited",
          amountUsdCents: row.amountUsdCents,
          bonusCents: row.bonusCents,
          quotePriceMicroUsd: row.quotePriceMicroUsd ?? null,
          quotePublishTime: row.quotePublishTime ?? null,
          quoteSource: row.quoteSource ?? null,
          creditedAt,
        },
      });
      await grantCredits(tx, {
        orgId: found.orgId,
        amountCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
        referenceId: row.id,
        description: `Wallet top-up (${row.asset})`,
        labelPrefix,
      });
      return {
        outcome: "credited",
        source: "prepared",
        creditedCents: row.amountUsdCents,
        bonusCents: row.bonusCents,
      };
    });
  }

  async function creditDirect(
    found: FoundTransfer,
  ): Promise<FoundTransferOutcome> {
    const value = await valueOf(found.asset, found.amountRaw);
    const receiptId = randomUUID();
    return db.$transaction(async (tx): Promise<FoundTransferOutcome> => {
      const base: OnchainReceiptCreateData = {
        id: receiptId,
        network: settings.network,
        txSignature: found.txSignature,
        asset: found.asset,
        orgId: found.orgId,
        depositAddress: found.depositAddress,
        amountRaw: found.amountRaw,
        slot: found.slot,
        blockTime: found.blockTime,
        senderAddresses: found.senderAddresses,
        source: "direct",
        status: "detected",
      };
      if (value.kind === "no_price") {
        await tx.onchainReceipt.create({ data: base });
        return { outcome: "waiting" };
      }
      if (value.kind === "below_one_cent") {
        await tx.onchainReceipt.create({
          data: {
            ...base,
            status: "ignored",
            ignoredReason: IGNORED_BELOW_ONE_CENT,
          },
        });
        return { outcome: "ignored" };
      }
      await tx.onchainReceipt.create({
        data: {
          ...base,
          status: "credited",
          amountUsdCents: value.cents,
          bonusCents: value.bonusCents,
          quotePriceMicroUsd: value.quotePriceMicroUsd,
          quotePublishTime: value.quotePublishTime,
          quoteSource: value.quoteSource,
          creditedAt: now(),
        },
      });
      await grantCredits(tx, {
        orgId: found.orgId,
        amountCents: value.cents,
        bonusCents: value.bonusCents,
        referenceId: receiptId,
        description: `Deposit (${found.asset})`,
        labelPrefix,
      });
      return {
        outcome: "credited",
        source: "direct",
        creditedCents: value.cents,
        bonusCents: value.bonusCents,
      };
    });
  }

  return {
    creditFoundTransfer: async (found) => {
      if (found.amountRaw <= 0n) {
        throw new Error("creditFoundTransfer: nothing arrived");
      }
      // The common repeat (a transaction in both histories, a run after a
      // crash) ends here without a write. The unique index is still what
      // decides when two writers meet.
      if (await receiptOf(found)) return { outcome: "already" };

      try {
        // A lost compare-and-set means the row moved between the read and
        // the write (a submit stored this signature, or credited it). It
        // is read again, so a transfer that is the row's is never credited
        // as a direct one while the row can still take it.
        let rowStillMatches = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const match = await matchingTopup(found);
          if (match.kind === "paid") return { outcome: "already" };
          rowStillMatches = match.kind === "use";
          if (match.kind !== "use") break;
          const through = await creditThroughTopup(found, match.row);
          if (through) return through;
        }
        if (rowStillMatches) {
          // Never guessed at: the transfer is tried again on a later run.
          throw new Error("creditFoundTransfer: the top-up row kept moving");
        }
        // Whoever moved the row to credited wrote this transfer's receipt
        // in the same transaction, so this stops at the unique index.
        return await creditDirect(found);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // The transaction rolled back. It is "already credited" only when
        // the receipt is really there; any other unique index refusing is
        // a fault, and the transfer is tried again on a later run.
        if (await receiptOf(found)) return { outcome: "already" };
        throw err;
      }
    },

    creditDetectedReceipt: async (receipt) => {
      if (receipt.amountRaw <= 0n) return { outcome: "waiting" };
      const value = await valueOf(receipt.asset, receipt.amountRaw);
      if (value.kind === "no_price") return { outcome: "waiting" };

      if (value.kind === "below_one_cent") {
        const ended = await db.$transaction((tx) =>
          tx.onchainReceipt.updateMany({
            where: { id: receipt.id, status: "detected" },
            data: { status: "ignored", ignoredReason: IGNORED_BELOW_ONE_CENT },
          }),
        );
        return { outcome: ended.count === 1 ? "ignored" : "already" };
      }

      return db.$transaction(async (tx): Promise<DetectedReceiptOutcome> => {
        const claimed = await tx.onchainReceipt.updateMany({
          where: { id: receipt.id, status: "detected" },
          data: {
            status: "credited",
            amountUsdCents: value.cents,
            bonusCents: value.bonusCents,
            quotePriceMicroUsd: value.quotePriceMicroUsd,
            quotePublishTime: value.quotePublishTime,
            quoteSource: value.quoteSource,
            creditedAt: now(),
          },
        });
        if (claimed.count !== 1) return { outcome: "already" };
        await grantCredits(tx, {
          orgId: receipt.orgId,
          amountCents: value.cents,
          bonusCents: value.bonusCents,
          referenceId: receipt.id,
          description: `Deposit (${receipt.asset})`,
          labelPrefix,
        });
        return {
          outcome: "credited",
          creditedCents: value.cents,
          bonusCents: value.bonusCents,
        };
      });
    },
  };
}
