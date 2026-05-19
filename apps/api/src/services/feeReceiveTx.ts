/**
 * Pure tx builder for the inflow side of plan A2/A3.
 *
 * The fee-router worker (the BullMQ job that watches Raydium V4 trade
 * events for each tokenized agent and computes the 1% fee owed) calls
 * this builder once per fee event to produce an unsigned
 * VersionedTransaction wrapping `agent_treasury::fee_receive(amount)`.
 *
 * Signing + RPC submission live in `submitFeeReceive.ts`; this module
 * stays pure so the unit tests run with no Solana dep.
 */

import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { buildFeeReceiveIx } from "../lib/programs/agentTreasury.js";

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

export interface BuildFeeReceiveTxInput {
  /** SPL mint that owns the destination treasury PDA. */
  mint: PublicKey;
  /** Depositor; signs and pays out. The platform fee-router wallet in
   * production; can be any wallet for tipping. */
  from: PublicKey;
  amountLamports: bigint;
  recentBlockhash: string;
}

export function buildFeeReceiveTx(
  input: BuildFeeReceiveTxInput,
): VersionedTransaction {
  if (input.amountLamports <= BigInt(0)) {
    throw new Error(
      `buildFeeReceiveTx: amountLamports must be positive, got ${input.amountLamports}`,
    );
  }
  if (input.amountLamports > U64_MAX) {
    throw new Error(
      `buildFeeReceiveTx: amountLamports overflows u64 (got ${input.amountLamports})`,
    );
  }
  if (!input.recentBlockhash || input.recentBlockhash.length === 0) {
    throw new Error("buildFeeReceiveTx: recentBlockhash is required");
  }

  const ix = buildFeeReceiveIx({
    mint: input.mint,
    from: input.from,
    amountLamports: input.amountLamports,
  });

  const message = new TransactionMessage({
    // Depositor pays the tx fee AND signs the program ix's `from` slot.
    payerKey: input.from,
    recentBlockhash: input.recentBlockhash,
    instructions: [ix],
  }).compileToV0Message();

  return new VersionedTransaction(message);
}
