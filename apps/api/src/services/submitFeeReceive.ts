/**
 * Side-effect orchestrator for the inflow path
 * (agent_treasury::fee_receive).
 *
 * Counterpart to submitTreasuryPaymentViaProgram.ts (outflow). Composes:
 *   1. fetchLatestBlockhash
 *   2. buildFeeReceiveTx
 *   3. tx.sign([fromKeypair])
 *   4. sendRawTransaction
 *
 * Used by the BullMQ fee-router worker (one tick = one trade-event-derived
 * fee). Returns the tx signature so the worker can record it and advance
 * the per-treasury "last_fee_routed_at" cursor.
 *
 * Errors mapped (same shape as the outflow orchestrator):
 *   - blockhash fetch throw → `blockhash_unavailable: <upstream>`
 *   - sendRawTransaction throw → `rpc_submit: <upstream>`
 */

import type { Keypair, PublicKey } from "@solana/web3.js";

import { buildFeeReceiveTx } from "./feeReceiveTx.js";

export interface SubmitFeeReceiveInput {
  mint: PublicKey;
  /** Depositor pubkey; must equal `fromKeypair.publicKey`. */
  from: PublicKey;
  amountLamports: bigint;
}

export interface SubmitFeeReceiveDeps {
  fromKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
}

export interface SubmitFeeReceiveResult {
  txSignature: string;
}

export async function submitFeeReceive(
  input: SubmitFeeReceiveInput,
  deps: SubmitFeeReceiveDeps,
): Promise<SubmitFeeReceiveResult> {
  if (deps.fromKeypair.publicKey.toBase58() !== input.from.toBase58()) {
    throw new Error(
      "submitFeeReceive: fromKeypair/from mismatch",
    );
  }

  let blockhash: string;
  try {
    const fetched = await deps.fetchLatestBlockhash();
    blockhash = fetched.blockhash;
  } catch (err) {
    throw new Error(
      `blockhash_unavailable: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  // buildFeeReceiveTx throws synchronously on amount/blockhash issues —
  // those propagate up as-is (no need to wrap in a tagged error since
  // they're configuration mistakes, not retryable RPC failures).
  const tx = buildFeeReceiveTx({
    mint: input.mint,
    from: input.from,
    amountLamports: input.amountLamports,
    recentBlockhash: blockhash,
  });
  tx.sign([deps.fromKeypair]);

  let txSignature: string;
  try {
    txSignature = await deps.sendRawTransaction(tx.serialize());
  } catch (err) {
    throw new Error(
      `rpc_submit: ${(err as Error).message ?? "unknown"}`,
      { cause: err as Error },
    );
  }

  return { txSignature };
}
