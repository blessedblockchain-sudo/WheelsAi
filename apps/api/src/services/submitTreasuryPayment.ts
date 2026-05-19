/**
 * Treasury payment submission orchestrator (plan A3, side-effect side).
 *
 * Composes the existing pure pieces:
 *   1. fetchLatestBlockhash                       (Solana RPC, DI'd)
 *   2. buildTreasuryTransferTx                    (pure, treasuryTransferTx.ts)
 *   3. tx.sign([signerKeypair])
 *   4. sendRawTransaction                         (Solana RPC, DI'd)
 *   5. markSubmitted(payment, txSignature)        (pure, computePaymentLifecycle.ts)
 *
 * Until the agent-treasury Anchor program (plan A2) ships, the "treasury"
 * is simply a server-held wallet. The signer's pubkey must equal the
 * recorded `treasuryAddress` — caught up front to prevent draining the
 * wrong wallet on a row-mapping mistake.
 */

import type { Keypair } from "@solana/web3.js";

import { buildTreasuryTransferTx } from "./treasuryTransferTx.js";
import {
  markSubmitted,
  type ComputePaymentState,
} from "./computePaymentLifecycle.js";

export interface SubmitTreasuryPaymentInput {
  payment: ComputePaymentState;
  treasuryAddress: string;
  recipientAddress: string;
  amountLamports: bigint;
}

export interface SubmitTreasuryPaymentDeps {
  signerKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
}

export interface SubmitTreasuryPaymentResult {
  payment: ComputePaymentState;
  txSignature: string;
}

export async function submitTreasuryPayment(
  input: SubmitTreasuryPaymentInput,
  deps: SubmitTreasuryPaymentDeps,
): Promise<SubmitTreasuryPaymentResult> {
  if (input.payment.status !== "PENDING") {
    throw new Error(
      `submitTreasuryPayment: payment is ${input.payment.status}, not PENDING — refusing to double-submit`,
    );
  }
  if (deps.signerKeypair.publicKey.toBase58() !== input.treasuryAddress) {
    throw new Error(
      "submitTreasuryPayment: signerKeypair/treasuryAddress mismatch",
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

  let txSignature: string;
  try {
    txSignature = await deps.sendRawTransaction(tx.serialize());
  } catch (err) {
    throw new Error(
      `rpc_submit: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  return {
    payment: markSubmitted(input.payment, txSignature),
    txSignature,
  };
}
