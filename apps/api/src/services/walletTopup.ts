/**
 * Wallet top-up rail: Solana payments for credits, signed by whichever
 * wallet the customer connects, with no key of theirs on our side.
 *
 * /prepare builds the FULL unsigned transaction server-side (recipient,
 * amount, blockhash, and a memo carrying the top-up row id) and stores its
 * exact message bytes on the WalletTopUp row. /submit accepts a signed
 * transaction only if it is that transfer: the same bytes, or the same
 * instructions with nothing added but a wallet's own fee setting and guard
 * (see acceptSignedTopupTransaction). Nothing the client says about the
 * amount or the recipient is ever believed.
 *
 * The memo instruction pins the row id INSIDE the signed message, which
 * makes every prepared message unique (two rows can never share a
 * signature, so the txSignature UNIQUE constraint never fights honest
 * traffic) and makes the on-chain transfer self-describing in explorers.
 *
 * Two assets:
 *   - USDC: 1 USDC = $1, so no price exists in this code path at all.
 *     SPL transferChecked to the org's deposit ATA (created idempotently,
 *     fee paid by the payer). Cents times 10,000 is base units, exactly.
 *   - SOL: priced by a live quote (services/solPrice.ts) and by nothing
 *     else. No quote, no SOL top-up; there is no fallback price. The
 *     price the amount was worked out from is recorded on the row.
 *
 * Credits are granted ONLY after on-chain confirmation, by
 * `makeCreditTopup`: a status CAS (submitting|submitted → credited), the
 * receipt of the transfer (onchain_receipts) and the grantCredits call
 * inside ONE database transaction. The CAS is the idempotency barrier — a
 * submit/reconcile race grants exactly once — and the receipt's unique
 * index is the same barrier against the scan of the deposit address.
 */

import { randomUUID } from "node:crypto";

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { MEMO_PROGRAM_ID } from "../lib/memoProgram.js";
import { createLogger } from "../utils/logger.js";
import {
  grantCredits,
  type CreditGrantTxClient,
} from "./creditGrant.js";
import { bonusForAmount, validatePurchaseAmount } from "./creditPackages.js";
import {
  lamportsToCollectForCents,
  solMicroUsdRate,
  solUsdRate,
  type SolQuote,
} from "./solPrice.js";

const logger = createLogger("wallet-topup");

export const USDC_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * How long a prepared top-up may wait for its signature, by the wall
 * clock. A SOL top-up holds its price for 60 seconds and no longer. A USDC
 * one has no price to hold; 120 seconds is deliberately past the chain's
 * own horizon (lastValidBlockHeight, about 60 to 90 seconds).
 */
export const TOPUP_SOL_TTL_SECONDS = 60;
export const TOPUP_USDC_TTL_SECONDS = 120;

export function topupTtlSeconds(asset: "SOL" | "USDC"): number {
  return asset === "SOL" ? TOPUP_SOL_TTL_SECONDS : TOPUP_USDC_TTL_SECONDS;
}

export function topupMemo(topupId: string): string {
  return `wheelsai-topup:${topupId}`;
}

export function newTopupId(): string {
  return randomUUID();
}

// ============================================
// Amount math
// ============================================

export type CheckTopupAmountResult =
  | { ok: true; amountUsdCents: bigint; bonusCents: bigint }
  | { ok: false; detail: string };

/**
 * The purchase amount as whole cents, with its bonus. The one place the
 * dollars a buyer typed become a whole number; everything after is bigint.
 */
export function checkTopupAmount(amountUsd: number): CheckTopupAmountResult {
  const amountError = validatePurchaseAmount(amountUsd);
  if (amountError) return { ok: false, detail: amountError };
  const cents = Math.round(amountUsd * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return { ok: false, detail: "Amount is not a usable number of cents" };
  }
  return {
    ok: true,
    amountUsdCents: BigInt(cents),
    bonusCents: BigInt(bonusForAmount(amountUsd) * 100),
  };
}

export interface ComputeTopupAmountsInput {
  asset: "SOL" | "USDC";
  /** Purchase amount in DOLLARS, as entered by the buyer. */
  amountUsd: number;
  /** Required for SOL; ignored for USDC. */
  quote?: SolQuote | null;
  /** The margin a SOL quote carries, basis points. Ignored for USDC. */
  marginBps?: number;
}

export type ComputeTopupAmountsResult =
  | {
      ok: true;
      amountUsdCents: bigint;
      bonusCents: bigint;
      /** Base units: lamports (SOL) or 6dp units (USDC), as a string. */
      amountRaw: string;
      /** SOL only: dollars per SOL, for the screen. Never an input. */
      quotedSolPriceUsd?: number;
      /** SOL only: the price the lamports were worked out from. */
      quotePriceMicroUsd?: bigint;
      quotePublishTime?: Date;
      quoteSource?: string;
    }
  | {
      ok: false;
      code: "invalid_amount" | "price_unavailable";
      /** For the log. Never sent to a customer. */
      detail: string;
    };

export function computeTopupAmounts(
  input: ComputeTopupAmountsInput,
): ComputeTopupAmountsResult {
  const amount = checkTopupAmount(input.amountUsd);
  if (!amount.ok) {
    return { ok: false, code: "invalid_amount", detail: amount.detail };
  }
  const { amountUsdCents, bonusCents } = amount;

  if (input.asset === "USDC") {
    // 1 USDC = $1 exactly; cents → 6dp base units is *10^4. Integer math
    // end to end — no float ever touches the USDC amount.
    return {
      ok: true,
      amountUsdCents,
      bonusCents,
      amountRaw: (amountUsdCents * 10_000n).toString(),
    };
  }

  // SOL: a quote or nothing. The helpers value the customer's SOL low and
  // round the lamports up, in whole numbers.
  const quote = input.quote;
  if (!quote) {
    return { ok: false, code: "price_unavailable", detail: "no SOL quote" };
  }
  const marginBps = input.marginBps ?? 0;
  const lamports = lamportsToCollectForCents(quote, amountUsdCents, marginBps);
  if (!lamports.ok) {
    return { ok: false, code: "price_unavailable", detail: lamports.code };
  }
  const shown = solUsdRate(quote, "in", marginBps);
  const exact = solMicroUsdRate(quote, "in", marginBps);
  if (!shown.ok || !exact.ok) {
    return {
      ok: false,
      code: "price_unavailable",
      detail: !shown.ok ? shown.code : !exact.ok ? exact.code : "no_value",
    };
  }
  return {
    ok: true,
    amountUsdCents,
    bonusCents,
    amountRaw: lamports.lamports.toString(),
    quotedSolPriceUsd: shown.usdPerSol,
    quotePriceMicroUsd: exact.microUsdPerSol,
    quotePublishTime: new Date(quote.publishTime * 1000),
    quoteSource: quote.source,
  };
}

// ============================================
// The payer
// ============================================

export type CheckPayerAddressResult =
  | { ok: true; address: string }
  | { ok: false; reason: "not_an_address" | "off_curve" | "platform_address" };

/**
 * A payer is a wallet: 32 bytes of base58 that are a point on the curve
 * (an address off the curve belongs to a program and cannot sign), and
 * never one of the platform's own addresses.
 */
export function checkPayerAddress(
  address: string,
  platformAddresses: readonly string[],
): CheckPayerAddressResult {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(address.trim());
  } catch {
    return { ok: false, reason: "not_an_address" };
  }
  if (bytes.length !== 32) return { ok: false, reason: "not_an_address" };
  if (!PublicKey.isOnCurve(bytes)) return { ok: false, reason: "off_curve" };
  const normalized = new PublicKey(bytes).toBase58();
  if (platformAddresses.includes(normalized)) {
    return { ok: false, reason: "platform_address" };
  }
  return { ok: true, address: normalized };
}

// ============================================
// Transaction building (prepare)
// ============================================

export interface BuildTopupTransactionInput {
  asset: "SOL" | "USDC";
  payerAddress: string;
  depositAddress: string;
  /** Base units as a string (from computeTopupAmounts). */
  amountRaw: string;
  /** Row id — pinned inside the signed message via memo. */
  topupId: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Required for USDC (network-specific mint); ignored for SOL. */
  usdcMint?: string;
}

export interface BuiltTopupTransaction {
  /** Wire transaction with an empty signature slot, base64. */
  unsignedTxBase64: string;
  /** Exact message bytes the wallet must sign, base64. */
  unsignedMessageB64: string;
}

export function buildTopupTransaction(
  input: BuildTopupTransactionInput,
): BuiltTopupTransaction {
  const payer = new PublicKey(input.payerAddress);
  const deposit = new PublicKey(input.depositAddress);
  const amount = BigInt(input.amountRaw);

  const tx = new Transaction({
    feePayer: payer,
    blockhash: input.blockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  });

  if (input.asset === "SOL") {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: deposit,
        lamports: amount,
      }),
    );
  } else {
    if (!input.usdcMint) {
      throw new Error("buildTopupTransaction: usdcMint required for USDC");
    }
    const mint = new PublicKey(input.usdcMint);
    const payerAta = getAssociatedTokenAddressSync(mint, payer);
    const depositAta = getAssociatedTokenAddressSync(mint, deposit);
    tx.add(
      // Idempotent: a no-op when the deposit ATA already exists, so the
      // second top-up from any org costs no extra rent logic.
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        depositAta,
        deposit,
        mint,
      ),
      createTransferCheckedInstruction(
        payerAta,
        mint,
        depositAta,
        payer,
        amount,
        USDC_DECIMALS,
      ),
    );
  }

  // The memo makes this message unique to THIS row and attributes the
  // transfer in explorers. No keys → no extra signer required.
  tx.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(topupMemo(input.topupId), "utf8"),
    }),
  );

  return {
    unsignedTxBase64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    unsignedMessageB64: tx.serializeMessage().toString("base64"),
  };
}

/**
 * Recovers the blockhash pinned inside prepared message bytes — used by
 * the confirm step, which needs {blockhash, lastValidBlockHeight}
 * without trusting anything client-supplied.
 */
export function blockhashFromMessageB64(messageB64: string): string {
  return VersionedMessage.deserialize(Buffer.from(messageB64, "base64"))
    .recentBlockhash;
}

// ============================================
// What submit accepts
// ============================================

/**
 * The only programs a wallet may add instructions of. Both are things
 * wallets add on their own before asking for a signature: a fee setting,
 * and a guard that makes the transaction fail if it would do anything
 * other than what was shown.
 */
export const WALLET_ADDED_PROGRAM_IDS: readonly string[] = [
  "ComputeBudget111111111111111111111111111111",
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95",
];

export type AcceptSignedTopupRefusal =
  | "unparseable"
  | "prepared_unreadable"
  | "missing_signature"
  | "signer_count"
  | "lookup_tables"
  | "fee_payer"
  | "blockhash"
  | "instructions"
  | "invalid_signature";

export type AcceptSignedTopupResult =
  | {
      ok: true;
      /** The transaction's signature, base58. */
      txSignatureB58: string;
      /** The signed transaction as it will be broadcast, base64. */
      rawTxBase64: string;
      /** True when the signed message is the prepared one byte for byte. */
      exact: boolean;
      /** How many instructions the wallet added (0 when exact). */
      addedInstructions: number;
      /** The program of each instruction the wallet added, in order. For
       * the log: it is how an operator learns what a wallet really adds. */
      addedPrograms: string[];
    }
  | {
      ok: false;
      /** The answer's code. */
      code: "unreadable_transaction" | "message_mismatch";
      /** What exactly was wrong, for the log. */
      reason: AcceptSignedTopupRefusal;
      /** With reason "instructions": the program of the first instruction
       * that is neither a prepared one nor one a wallet may add. For the
       * log. */
      program?: string;
    };

interface FlatInstruction {
  programId: string;
  accounts: string[];
  dataB64: string;
}

/**
 * A message's instructions with every index resolved to its key and that
 * key's signer and writable flags. null when an index points outside the
 * message's own keys.
 */
function flattenInstructions(message: VersionedMessage): FlatInstruction[] | null {
  const keys = message.staticAccountKeys;
  const describe = (index: number): string | null => {
    const key = keys[index];
    if (!key) return null;
    const signer = message.isAccountSigner(index) ? "s" : "-";
    const writable = message.isAccountWritable(index) ? "w" : "-";
    return `${key.toBase58()}:${signer}${writable}`;
  };
  const out: FlatInstruction[] = [];
  for (const ix of message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program) return null;
    const accounts: string[] = [];
    for (const index of ix.accountKeyIndexes) {
      const described = describe(index);
      if (described === null) return null;
      accounts.push(described);
    }
    out.push({
      programId: program.toBase58(),
      accounts,
      dataB64: Buffer.from(ix.data).toString("base64"),
    });
  }
  return out;
}

function sameInstruction(a: FlatInstruction, b: FlatInstruction): boolean {
  return (
    a.programId === b.programId &&
    a.dataB64 === b.dataB64 &&
    a.accounts.length === b.accounts.length &&
    a.accounts.every((account, i) => account === b.accounts[i])
  );
}

/**
 * Is this signed transaction the transfer we prepared?
 *
 * Yes when its message is the prepared message byte for byte. Also yes
 * when a wallet rebuilt the message around it, provided ALL of:
 *   - the same fee payer and the same recent blockhash;
 *   - exactly one required signature, and no address lookup tables;
 *   - every prepared instruction present, in the original order, with the
 *     same program, the same accounts (same keys, same signer and
 *     writable flags) and the same data;
 *   - every other instruction belongs to WALLET_ADDED_PROGRAM_IDS.
 * Anything else is message_mismatch.
 *
 * The payer's signature is then verified over the bytes the wallet
 * actually signed (the submitted message, not the prepared one).
 *
 * Returns the base58 transaction signature — recorded on the row BEFORE
 * broadcast, so a crash mid-submit is always recoverable by looking the
 * signature up on-chain. Pure; never throws.
 */
export function acceptSignedTopupTransaction(args: {
  signedTxBase64: string;
  unsignedMessageB64: string;
  payerAddress: string;
}): AcceptSignedTopupResult {
  const unreadable = (reason: AcceptSignedTopupRefusal): AcceptSignedTopupResult => ({
    ok: false,
    code: "unreadable_transaction",
    reason,
  });
  const mismatch = (
    reason: AcceptSignedTopupRefusal,
    program?: string,
  ): AcceptSignedTopupResult => ({
    ok: false,
    code: "message_mismatch",
    reason,
    ...(program !== undefined ? { program } : {}),
  });

  let vtx: VersionedTransaction;
  let messageBytes: Uint8Array;
  try {
    vtx = VersionedTransaction.deserialize(
      Buffer.from(args.signedTxBase64, "base64"),
    );
    messageBytes = vtx.message.serialize();
  } catch {
    return unreadable("unparseable");
  }

  const exact =
    Buffer.from(messageBytes).toString("base64") === args.unsignedMessageB64;
  let addedInstructions = 0;
  const addedPrograms: string[] = [];

  if (!exact) {
    const message = vtx.message;
    if (message.addressTableLookups.length > 0) return mismatch("lookup_tables");
    if (message.header.numRequiredSignatures !== 1) return mismatch("signer_count");

    let prepared: VersionedMessage;
    let preparedIxs: FlatInstruction[] | null;
    let signedIxs: FlatInstruction[] | null;
    try {
      prepared = VersionedMessage.deserialize(
        Buffer.from(args.unsignedMessageB64, "base64"),
      );
      preparedIxs = flattenInstructions(prepared);
      signedIxs = flattenInstructions(message);
    } catch {
      return mismatch("prepared_unreadable");
    }
    if (!preparedIxs) return mismatch("prepared_unreadable");
    if (!signedIxs) return mismatch("instructions");

    const feePayer = message.staticAccountKeys[0];
    const preparedFeePayer = prepared.staticAccountKeys[0];
    if (!feePayer || !preparedFeePayer || !feePayer.equals(preparedFeePayer)) {
      return mismatch("fee_payer");
    }
    if (message.recentBlockhash !== prepared.recentBlockhash) {
      return mismatch("blockhash");
    }

    // Walk the signed instructions once. Each is either the next prepared
    // instruction or one a wallet is allowed to add.
    let next = 0;
    for (const ix of signedIxs) {
      const wanted = preparedIxs[next];
      if (wanted && sameInstruction(ix, wanted)) {
        next += 1;
      } else if (WALLET_ADDED_PROGRAM_IDS.includes(ix.programId)) {
        addedInstructions += 1;
        addedPrograms.push(ix.programId);
      } else {
        return mismatch("instructions", ix.programId);
      }
    }
    if (next !== preparedIxs.length) return mismatch("instructions");
  }

  if (vtx.signatures.length !== 1) return mismatch("signer_count");
  const signature = vtx.signatures[0];
  if (!signature || signature.length !== 64 || signature.every((b) => b === 0)) {
    return unreadable("missing_signature");
  }

  let payerKey: PublicKey;
  try {
    payerKey = new PublicKey(args.payerAddress);
  } catch {
    return mismatch("invalid_signature");
  }
  const feePayerKey = vtx.message.staticAccountKeys[0];
  if (!feePayerKey || !feePayerKey.equals(payerKey)) {
    return mismatch("fee_payer");
  }
  let verified = false;
  try {
    verified = nacl.sign.detached.verify(
      messageBytes,
      signature,
      payerKey.toBytes(),
    );
  } catch {
    verified = false;
  }
  if (!verified) return mismatch("invalid_signature");

  return {
    ok: true,
    txSignatureB58: bs58.encode(signature),
    rawTxBase64: Buffer.from(vtx.serialize()).toString("base64"),
    exact,
    addedInstructions,
    addedPrograms,
  };
}

/**
 * The signature a signed transaction carries, without judging it: used to
 * tell "the same transfer sent again" from "a different one" for a top-up
 * already in flight. null when the bytes are not a transaction.
 */
export function signatureOfSignedTransaction(signedTxBase64: string): string | null {
  try {
    const vtx = VersionedTransaction.deserialize(
      Buffer.from(signedTxBase64, "base64"),
    );
    const signature = vtx.signatures[0];
    if (!signature || signature.length !== 64 || signature.every((b) => b === 0)) {
      return null;
    }
    return bs58.encode(signature);
  } catch {
    return null;
  }
}

// ============================================
// Crediting (the only money-moving step)
// ============================================

/** What a receipt of one on-chain transfer is written with. The table's
 * unique index on (network, txSignature, asset) is what makes a second
 * credit of the same transfer impossible. */
export interface OnchainReceiptCreateData {
  id?: string;
  network: string;
  txSignature: string;
  asset: string;
  orgId: string;
  depositAddress: string;
  /** Base units: lamports, or USDC with 6 decimals. */
  amountRaw: bigint;
  slot?: bigint | null;
  blockTime?: Date | null;
  senderAddresses: string[];
  source: "prepared" | "direct";
  topupId?: string | null;
  status: "detected" | "credited" | "ignored";
  ignoredReason?: string | null;
  amountUsdCents?: bigint | null;
  bonusCents?: bigint;
  quotePriceMicroUsd?: bigint | null;
  quotePublishTime?: Date | null;
  quoteSource?: string | null;
  creditedAt?: Date | null;
}

/** The columns of a top-up its receipt is written from. */
export interface TopupReceiptSourceRow {
  id: string;
  orgId: string;
  asset: string;
  network: string;
  amountUsdCents: bigint;
  bonusCents: bigint;
  /** Base units as a string, as wallet_topups stores them. */
  amountRaw: string;
  payerAddress: string;
  depositAddress: string;
  txSignature: string | null;
  quotePriceMicroUsd?: bigint | null;
  quotePublishTime?: Date | null;
  quoteSource?: string | null;
}

export interface TopupCreditTxClient extends CreditGrantTxClient {
  walletTopUp: {
    updateMany: (args: {
      where: {
        id: string;
        status: { in: string[] };
        txSignature: { not: null };
      };
      data: { status: string; creditedAt: Date };
    }) => Promise<{ count: number }>;
    findUnique: (args: {
      where: { id: string };
    }) => Promise<TopupReceiptSourceRow | null>;
  };
  onchainReceipt: {
    create: (args: { data: OnchainReceiptCreateData }) => Promise<unknown>;
  };
}

export interface TopupCreditDb {
  $transaction: <T>(fn: (tx: TopupCreditTxClient) => Promise<T>) => Promise<T>;
}

export interface CreditTopupArgs {
  topupId: string;
  orgId: string;
  amountUsdCents: bigint;
  bonusCents: bigint;
  asset: string;
  /** 'solana:devnet' | 'solana:mainnet' — devnet grants get labeled. */
  network: string;
  now?: () => Date;
}

export type CreditTopupResult =
  | { credited: true; balanceAfterCents: bigint; grantedCents: bigint }
  | { credited: false };

/** Prisma's code for a unique index refusing a write. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Grants the credits for a confirmed top-up, exactly once.
 *
 * The status CAS (submitting|submitted → credited), the receipt of the
 * transfer and the grant run in ONE database transaction: losing the CAS
 * means someone else already credited this row (submit vs reconcile
 * race, double-delivered request) and NO grant happens; winning it
 * commits the flip, the receipt and the ledger rows atomically — a crash
 * can never leave a credited row without its grant or a grant without
 * its flip.
 *
 * The receipt (onchain_receipts, one per network, signature and asset) is
 * the second barrier: the scan of the deposit address
 * (services/depositCredit.ts) writes the same receipt for the same
 * transfer, so whichever commits first is the only one that grants. A
 * unique violation aborts the transaction, so it is turned into
 * `credited: false` out here, after the rollback. It should never happen
 * on this path (the scan credits a prepared transfer through its row, so
 * the CAS is lost first), which is why it is logged as an error.
 *
 * A row with no signature is never credited here: there is no transfer
 * to write a receipt for.
 */
export function makeCreditTopup(db: TopupCreditDb) {
  return async function creditTopup(
    args: CreditTopupArgs,
  ): Promise<CreditTopupResult> {
    const now = args.now ?? (() => new Date());
    try {
      return await db.$transaction(async (tx): Promise<CreditTopupResult> => {
        const creditedAt = now();
        const claimed = await tx.walletTopUp.updateMany({
          where: {
            id: args.topupId,
            status: { in: ["submitting", "submitted"] },
            txSignature: { not: null },
          },
          data: { status: "credited", creditedAt },
        });
        if (claimed.count === 0) {
          return { credited: false };
        }
        const row = await tx.walletTopUp.findUnique({
          where: { id: args.topupId },
        });
        if (!row || !row.txSignature) {
          // Throwing rolls the status change back: nothing is credited
          // without the transfer it stands on.
          throw new Error("creditTopup: the claimed top-up could not be read");
        }
        await tx.onchainReceipt.create({
          data: {
            network: row.network,
            txSignature: row.txSignature,
            asset: row.asset,
            orgId: row.orgId,
            depositAddress: row.depositAddress,
            amountRaw: BigInt(row.amountRaw),
            senderAddresses: [row.payerAddress],
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
        const granted = await grantCredits(tx, {
          orgId: args.orgId,
          amountCents: args.amountUsdCents,
          bonusCents: args.bonusCents,
          referenceId: args.topupId,
          description: `Wallet top-up (${args.asset})`,
          labelPrefix:
            args.network === "solana:devnet" ? "[devnet] " : undefined,
        });
        return {
          credited: true,
          balanceAfterCents: granted.balanceAfterCents,
          grantedCents: granted.grantedCents,
        };
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      logger.error(
        { topupId: args.topupId, orgId: args.orgId },
        "Top-up not credited: its transfer already has a receipt. This should never happen.",
      );
      return { credited: false };
    }
  };
}
