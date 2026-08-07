/**
 * Wallet top-up rail (B2/T5) — Solana payments for credits, without a
 * custodial browser key.
 *
 * The security model is byte-equality: /prepare builds the FULL unsigned
 * transaction server-side (recipient, amount, blockhash, and a memo
 * carrying the topup row id) and stores its exact message bytes on the
 * WalletTopUp row. /submit accepts a signed transaction only if its
 * message bytes equal the stored ones — so the wallet provably signed
 * exactly what the server prepared. There is nothing client-supplied to
 * validate piecemeal; either the bytes match or they don't.
 *
 * The memo instruction pins the row id INSIDE the signed message, which
 * makes every prepared message unique (two rows can never share a
 * signature, so the txSignature UNIQUE constraint never fights honest
 * traffic) and makes the on-chain transfer self-describing in explorers.
 *
 * Two assets:
 *   - USDC: the production rail. 1 USDC = $1, so no price oracle exists
 *     in this code path at all. SPL transferChecked to the org's deposit
 *     ATA (created idempotently, fee paid by the payer).
 *   - SOL: the devnet TEST rail, gated by ALLOW_DEVNET_WALLET_TOPUPS
 *     (boot-fatal in production). Priced by an operator-stated quote
 *     (WALLET_TOPUP_SOL_PRICE_USD) recorded on the row — never a
 *     fabricated default.
 *
 * Credits are granted ONLY after on-chain confirmation, by
 * `makeCreditTopup`: a status CAS (submitting|submitted → credited) and
 * the grantCredits call inside ONE database transaction. The CAS is the
 * idempotency barrier — a submit/reconcile race grants exactly once.
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
import {
  grantCredits,
  type CreditGrantTxClient,
} from "./creditGrant.js";
import { bonusForAmount, validatePurchaseAmount } from "./creditPackages.js";

export const USDC_DECIMALS = 6;
export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Wall-clock horizon shown to the user. The CHAIN truth is
 * lastValidBlockHeight (~150 blocks ≈ 60–90s); 120s is deliberately
 * past it so we never tell a user "expired" while the chain could still
 * accept the transaction.
 */
export const TOPUP_WALLCLOCK_TTL_SECONDS = 120;

export function topupMemo(topupId: string): string {
  return `wheelsai-topup:${topupId}`;
}

export function newTopupId(): string {
  return randomUUID();
}

// ============================================
// Amount math
// ============================================

export interface ComputeTopupAmountsInput {
  asset: "SOL" | "USDC";
  /** Purchase amount in DOLLARS, as entered by the buyer. */
  amountUsd: number;
  /** Required for SOL; ignored for USDC. */
  solPriceUsd?: number;
}

export type ComputeTopupAmountsResult =
  | {
      ok: true;
      amountUsdCents: bigint;
      bonusCents: bigint;
      /** Base units: lamports (SOL) or 6dp units (USDC), as a string. */
      amountRaw: string;
      quotedSolPriceUsd?: number;
    }
  | { ok: false; error: string };

export function computeTopupAmounts(
  input: ComputeTopupAmountsInput,
): ComputeTopupAmountsResult {
  const amountError = validatePurchaseAmount(input.amountUsd);
  if (amountError) {
    return { ok: false, error: amountError };
  }

  const amountUsdCents = BigInt(Math.round(input.amountUsd * 100));
  const bonusCents = BigInt(bonusForAmount(input.amountUsd) * 100);

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

  const price = input.solPriceUsd;
  if (!price || !Number.isFinite(price) || price <= 0) {
    return { ok: false, error: "SOL price quote unavailable" };
  }
  // Bounded by MAX_PURCHASE ($10k) and any sane quote, this stays far
  // below 2^53, so number math is exact enough before the round.
  const lamports = Math.round((input.amountUsd / price) * LAMPORTS_PER_SOL);
  if (lamports <= 0) {
    return { ok: false, error: "Amount too small at the quoted SOL price" };
  }
  return {
    ok: true,
    amountUsdCents,
    bonusCents,
    amountRaw: String(lamports),
    quotedSolPriceUsd: price,
  };
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
// Signed-transaction verification (submit)
// ============================================

export type VerifySignedTopupResult =
  | { ok: true; txSignatureB58: string; rawTxBase64: string }
  | {
      ok: false;
      error:
        | "unparseable"
        | "message_mismatch"
        | "missing_signature"
        | "invalid_signature";
    };

/**
 * The byte-equality gate. Accepts a signed transaction iff:
 *   1. it deserializes,
 *   2. its message bytes EQUAL the prepared message bytes (recipient,
 *      amount, blockhash, memo — everything — provably unaltered),
 *   3. the payer's signature slot is populated and cryptographically
 *      valid over those bytes.
 *
 * Returns the base58 transaction signature — recorded on the row BEFORE
 * broadcast, so a crash mid-submit is always recoverable by looking the
 * signature up on-chain.
 */
export function verifySignedTopupTransaction(args: {
  signedTxBase64: string;
  unsignedMessageB64: string;
  payerAddress: string;
}): VerifySignedTopupResult {
  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(
      Buffer.from(args.signedTxBase64, "base64"),
    );
  } catch {
    return { ok: false, error: "unparseable" };
  }

  const messageBytes = vtx.message.serialize();
  if (Buffer.from(messageBytes).toString("base64") !== args.unsignedMessageB64) {
    return { ok: false, error: "message_mismatch" };
  }

  const signature = vtx.signatures[0];
  if (!signature || signature.every((b) => b === 0)) {
    return { ok: false, error: "missing_signature" };
  }

  let payerKey: PublicKey;
  try {
    payerKey = new PublicKey(args.payerAddress);
  } catch {
    return { ok: false, error: "invalid_signature" };
  }
  const verified = nacl.sign.detached.verify(
    messageBytes instanceof Uint8Array
      ? messageBytes
      : new Uint8Array(messageBytes),
    signature,
    payerKey.toBytes(),
  );
  if (!verified) {
    return { ok: false, error: "invalid_signature" };
  }

  return {
    ok: true,
    txSignatureB58: bs58.encode(signature),
    rawTxBase64: args.signedTxBase64,
  };
}

// ============================================
// Crediting (the only money-moving step)
// ============================================

export interface TopupCreditTxClient extends CreditGrantTxClient {
  walletTopUp: {
    updateMany: (args: {
      where: { id: string; status: { in: string[] } };
      data: { status: string; creditedAt: Date };
    }) => Promise<{ count: number }>;
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

/**
 * Grants the credits for a confirmed top-up, exactly once.
 *
 * The status CAS (submitting|submitted → credited) and the grant run in
 * ONE database transaction: losing the CAS means someone else already
 * credited this row (submit vs reconcile race, double-delivered
 * request) and NO grant happens; winning it commits the flip and the
 * ledger rows atomically — a crash can never leave a credited row
 * without its grant or a grant without its flip.
 */
export function makeCreditTopup(db: TopupCreditDb) {
  return async function creditTopup(
    args: CreditTopupArgs,
  ): Promise<CreditTopupResult> {
    const now = args.now ?? (() => new Date());
    return db.$transaction(async (tx) => {
      const claimed = await tx.walletTopUp.updateMany({
        where: {
          id: args.topupId,
          status: { in: ["submitting", "submitted"] },
        },
        data: { status: "credited", creditedAt: now() },
      });
      if (claimed.count === 0) {
        return { credited: false };
      }
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
  };
}
