/**
 * Creator payout settlement (W2 money keystone) — the executor half of
 * the marketplace revenue loop. `requestPayout` reserves a publisher's
 * pending balance into a `pending` CreatorPayout row; this is what turns
 * that row into delivered money.
 *
 * This is the re-entry gate for the "90% revenue" claim: the claim
 * returns when the first real CreatorPayout completes.
 *
 * Two payout methods, both exactly-once:
 *
 *   credits — the publisher takes earnings as platform credits. A status
 *     CAS (processing → completed) and grantCredits run in ONE database
 *     transaction, so a crash can never complete the row without granting
 *     or grant without completing. Zero external dependencies — this is
 *     the path that de-risks the claim.
 *
 *   crypto_sol / crypto_usdc — an on-chain transfer from the single
 *     platform payout wallet to the publisher's address. The signature is
 *     recorded on the row BEFORE broadcast (unique constraint =
 *     double-send guard), so a crash is recoverable by looking the
 *     signature up on-chain rather than re-sending. Exactly-once
 *     completion comes from the processing → completed CAS after
 *     confirmation.
 *
 * A payout that fails for a real reason (unsupported method, chain
 * rejection) is moved to `failed` AND its amount restored to the
 * publisher's pendingPayoutCents in one transaction — the reservation is
 * released so the creator can request again. Nothing is silently dropped.
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import {
  grantCredits,
  type CreditGrantTxClient,
} from "./creditGrant.js";

export const USDC_DECIMALS = 6;
const LAMPORTS_PER_SOL = 1_000_000_000;

export type PayoutSettleResult =
  | { outcome: "completed"; txSignature?: string; balanceAfterCents?: bigint }
  /** A prior tick already completed this payout — no money moved here. */
  | { outcome: "already_settled" }
  /** Broadcast but not yet confirmed; stays `processing` for a later tick. */
  | { outcome: "pending_confirmation"; txSignature: string }
  /** Unrecoverable — the tick fails the row and restores the reservation. */
  | { outcome: "failed"; reason: string };

// ============================================
// Credits payout
// ============================================

export interface PayoutCreditsTxClient extends CreditGrantTxClient {
  creatorPayout: {
    updateMany: (args: {
      where: { id: string; status: string };
      data: { status: string; processedAt: Date };
    }) => Promise<{ count: number }>;
  };
}

export interface PayoutCreditsDb {
  $transaction: <T>(fn: (tx: PayoutCreditsTxClient) => Promise<T>) => Promise<T>;
}

export interface SettleCreditsInput {
  payoutId: string;
  publisherId: string;
  amountCents: bigint;
  now?: () => Date;
}

/**
 * Grants a credits payout exactly once. The processing → completed CAS
 * and the grant commit together; losing the CAS (another tick already
 * settled it) grants nothing.
 */
export function makeSettleCreditsPayout(db: PayoutCreditsDb) {
  return async function settleCreditsPayout(
    input: SettleCreditsInput,
  ): Promise<PayoutSettleResult> {
    const now = input.now ?? (() => new Date());
    return db.$transaction(async (tx) => {
      const claimed = await tx.creatorPayout.updateMany({
        where: { id: input.payoutId, status: "processing" },
        data: { status: "completed", processedAt: now() },
      });
      if (claimed.count === 0) {
        return { outcome: "already_settled" };
      }
      const granted = await grantCredits(tx, {
        orgId: input.publisherId,
        amountCents: input.amountCents,
        referenceId: input.payoutId,
        description: "Creator payout (credits)",
      });
      return {
        outcome: "completed",
        balanceAfterCents: granted.balanceAfterCents,
      };
    });
  };
}

// ============================================
// Crypto payout (transaction building)
// ============================================

export interface BuildPayoutTransferInput {
  method: "crypto_sol" | "crypto_usdc";
  payer: PublicKey;
  recipient: PublicKey;
  /** Payout value in USD cents. */
  amountCents: bigint;
  /** SOL/USD quote — required for crypto_sol, ignored for crypto_usdc. */
  solPriceUsd?: number;
  /** Network-appropriate USDC mint — required for crypto_usdc. */
  usdcMint?: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
}

export function buildPayoutTransfer(input: BuildPayoutTransferInput): Transaction {
  const tx = new Transaction({
    feePayer: input.payer,
    blockhash: input.blockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
  });

  if (input.method === "crypto_sol") {
    if (!input.solPriceUsd || input.solPriceUsd <= 0) {
      throw new Error("buildPayoutTransfer: solPriceUsd required for crypto_sol");
    }
    const lamports = Math.round(
      (Number(input.amountCents) / 100 / input.solPriceUsd) * LAMPORTS_PER_SOL,
    );
    if (lamports <= 0) {
      throw new Error("buildPayoutTransfer: computed lamports <= 0");
    }
    tx.add(
      SystemProgram.transfer({
        fromPubkey: input.payer,
        toPubkey: input.recipient,
        lamports,
      }),
    );
    return tx;
  }

  // crypto_usdc: 1 USDC = $1, so cents → 6dp base units is *10^4. Integer
  // math throughout — no float touches the USDC amount.
  if (!input.usdcMint) {
    throw new Error("buildPayoutTransfer: usdcMint required for crypto_usdc");
  }
  const baseUnits = input.amountCents * 10_000n;
  const payerAta = getAssociatedTokenAddressSync(input.usdcMint, input.payer);
  const recipientAta = getAssociatedTokenAddressSync(
    input.usdcMint,
    input.recipient,
  );
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      input.payer,
      recipientAta,
      input.recipient,
      input.usdcMint,
    ),
    createTransferCheckedInstruction(
      payerAta,
      input.usdcMint,
      recipientAta,
      input.payer,
      baseUnits,
      USDC_DECIMALS,
    ),
  );
  return tx;
}

// ============================================
// Crypto payout (send + confirm + settle)
// ============================================

export interface CryptoPayoutRow {
  id: string;
  publisherId: string;
  amountCents: bigint;
  payoutMethod: string;
  payoutAddress: string | null;
  txSignature: string | null;
}

export interface SettleCryptoDeps {
  connection: Pick<
    Connection,
    | "getLatestBlockhash"
    | "sendRawTransaction"
    | "confirmTransaction"
    | "getSignatureStatuses"
  >;
  payoutWallet: Keypair;
  solPriceUsd?: number;
  usdcMint?: PublicKey;
  /** Records the tx signature on the row, guarded by the unique index. */
  recordSignature: (
    payoutId: string,
    signature: string,
  ) => Promise<"recorded" | "duplicate">;
  /** processing → completed CAS; false = already settled. */
  markCompleted: (payoutId: string, signature: string) => Promise<boolean>;
}

/**
 * Sends and confirms a crypto payout, exactly once.
 *
 * Order: sign (deterministic signature) → record the signature on the row
 * (unique-constrained, so a concurrent tick can't also send) → broadcast
 * → confirm → complete. A crash after recording is recovered by a later
 * tick re-confirming the recorded signature, never re-sending.
 */
export async function settleCryptoPayout(
  row: CryptoPayoutRow,
  deps: SettleCryptoDeps,
): Promise<PayoutSettleResult> {
  if (!row.payoutAddress) {
    return { outcome: "failed", reason: "missing payout address" };
  }
  const method = row.payoutMethod as "crypto_sol" | "crypto_usdc";

  let recipient: PublicKey;
  try {
    recipient = new PublicKey(row.payoutAddress);
  } catch {
    return { outcome: "failed", reason: "invalid payout address" };
  }

  // Recovery: the row already carries a signature from a prior interrupted
  // tick. Re-confirm it rather than sending a second transfer.
  if (row.txSignature) {
    const statuses = await deps.connection.getSignatureStatuses(
      [row.txSignature],
      { searchTransactionHistory: true },
    );
    const status = statuses.value[0];
    if (status?.err) {
      return {
        outcome: "failed",
        reason: `prior payout tx failed on-chain: ${JSON.stringify(status.err)}`,
      };
    }
    if (
      status &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      const done = await deps.markCompleted(row.id, row.txSignature);
      return done
        ? { outcome: "completed", txSignature: row.txSignature }
        : { outcome: "already_settled" };
    }
    // Recorded but not yet confirmed — a later tick re-checks.
    return { outcome: "pending_confirmation", txSignature: row.txSignature };
  }

  const { blockhash, lastValidBlockHeight } =
    await deps.connection.getLatestBlockhash("confirmed");

  let tx: Transaction;
  try {
    tx = buildPayoutTransfer({
      method,
      payer: deps.payoutWallet.publicKey,
      recipient,
      amountCents: row.amountCents,
      solPriceUsd: deps.solPriceUsd,
      usdcMint: deps.usdcMint,
      blockhash,
      lastValidBlockHeight,
    });
  } catch (err) {
    return { outcome: "failed", reason: (err as Error).message };
  }

  tx.sign(deps.payoutWallet);
  if (!tx.signature) {
    return { outcome: "failed", reason: "payout tx did not sign" };
  }
  const sigB58 = bs58.encode(tx.signature);

  const recorded = await deps.recordSignature(row.id, sigB58);
  if (recorded === "duplicate") {
    // Another tick already owns this signature — let it finish.
    return { outcome: "already_settled" };
  }

  try {
    await deps.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    const confirmation = await deps.connection.confirmTransaction(
      { signature: sigB58, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    if (confirmation.value.err) {
      return {
        outcome: "failed",
        reason: `payout tx failed on-chain: ${JSON.stringify(confirmation.value.err)}`,
      };
    }
  } catch {
    // Broadcast/confirm error. The signature is on the row, so a later
    // tick re-confirms rather than re-sends — do NOT restore the balance
    // (the transfer may still land). Row stays `processing`.
    return { outcome: "pending_confirmation", txSignature: sigB58 };
  }

  const done = await deps.markCompleted(row.id, sigB58);
  return done
    ? { outcome: "completed", txSignature: sigB58 }
    : { outcome: "already_settled" };
}
