/**
 * Treasury payment PREPARE orchestrator (legacy SystemProgram.transfer
 * mode; claim-first protocol, remediation D3).
 *
 * Builds and signs the transfer WITHOUT broadcasting it:
 *   1. fetchLatestBlockhash                       (Solana RPC, DI'd)
 *   2. buildTreasuryTransferTx                    (pure, treasuryTransferTx.ts)
 *   3. tx.sign([signerKeypair])                   (in-memory)
 *   4. return { txSignature, lastValidBlockHeight, signedTxB64 }
 *
 * The caller (runSubmitPaymentsTick via buildSubmitPaymentsTickDeps)
 * persists these artifacts in the PENDING → SUBMITTING compare-and-set
 * claim, and only THEN broadcasts the stored bytes. Splitting sign from
 * send is what makes a crash between broadcast and DB-write safe: the
 * recovery scan re-broadcasts the SAME bytes (same signature ⇒ at most
 * one effective transfer) instead of re-signing with a fresh blockhash.
 *
 * txSignature is derived locally — bs58 of the signed tx's first
 * signature (the fee payer's) — identical to what sendRawTransaction
 * would have returned, so the claim can record it before any RPC send.
 *
 * Until the agent-treasury Anchor program (plan A2) path is used, the
 * "treasury" is simply a server-held wallet. The signer's pubkey must
 * equal the recorded `treasuryAddress` — caught up front to prevent
 * draining the wrong wallet on a row-mapping mistake.
 */

import bs58 from "bs58";
import type { Keypair } from "@solana/web3.js";

import { buildTreasuryTransferTx } from "./treasuryTransferTx.js";
import type { ComputePaymentState } from "./computePaymentLifecycle.js";

/** Sign-only output: everything the claim write needs. */
export interface PreparedTreasuryPayment {
  /** bs58 of the signed tx's first signature — the on-chain tx id. */
  txSignature: string;
  /** Expiry bound of the blockhash baked into the signed bytes. */
  lastValidBlockHeight: bigint;
  /** Fully signed tx, base64 — broadcast (and re-broadcast) verbatim. */
  signedTxB64: string;
}

export interface PrepareTreasuryPaymentInput {
  payment: ComputePaymentState;
  treasuryAddress: string;
  recipientAddress: string;
  amountLamports: bigint;
}

export interface PrepareTreasuryPaymentDeps {
  signerKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export async function prepareTreasuryPayment(
  input: PrepareTreasuryPaymentInput,
  deps: PrepareTreasuryPaymentDeps,
): Promise<PreparedTreasuryPayment> {
  if (input.payment.status !== "PENDING") {
    throw new Error(
      `prepareTreasuryPayment: payment is ${input.payment.status}, not PENDING — refusing to double-submit`,
    );
  }
  if (deps.signerKeypair.publicKey.toBase58() !== input.treasuryAddress) {
    throw new Error(
      "prepareTreasuryPayment: signerKeypair/treasuryAddress mismatch",
    );
  }

  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    const fetched = await deps.fetchLatestBlockhash();
    blockhash = fetched.blockhash;
    lastValidBlockHeight = fetched.lastValidBlockHeight;
  } catch (err) {
    throw new Error(
      `blockhash_unavailable: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  const tx = buildTreasuryTransferTx({
    fromPubkey: input.treasuryAddress,
    toPubkey: input.recipientAddress,
    amountLamports: input.amountLamports,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
  });

  tx.sign([deps.signerKeypair]);

  return {
    txSignature: bs58.encode(tx.signatures[0]!),
    lastValidBlockHeight: BigInt(lastValidBlockHeight),
    signedTxB64: Buffer.from(tx.serialize()).toString("base64"),
  };
}
