/**
 * Sign-only PREPARE orchestrator for the inflow path
 * (agent_treasury::fee_receive) — claim-first protocol (remediation D6a).
 *
 * Counterpart to submitFeeReceive.ts but WITHOUT the broadcast, exactly
 * like prepareTreasuryPaymentViaProgram.ts on the outflow side:
 *
 *   1. fetchLatestBlockhash                  (Solana RPC)
 *   2. buildFeeReceiveTx                     (pure)
 *   3. tx.sign([fromKeypair])                (in-memory)
 *   4. return { txSignature, lastValidBlockHeight, signedTxB64 }
 *
 * The fee-router driver persists these artifacts on the FeeRoutingBatch
 * via the CLAIMED → SUBMITTED compare-and-set BEFORE broadcasting, so a
 * crash or replica overlap can only ever re-broadcast the SAME bytes
 * (same signature ⇒ the cluster dedupes ⇒ no double-deposit).
 *
 * Errors mapped (same tags as the other prepare/submit orchestrators):
 *   - blockhash fetch throw → `blockhash_unavailable: <upstream>`
 *   - buildFeeReceiveTx throws propagate as-is (config mistakes)
 */

import bs58 from "bs58";
import type { Keypair, PublicKey } from "@solana/web3.js";

import { buildFeeReceiveTx } from "./feeReceiveTx.js";

export interface PrepareFeeReceiveInput {
  mint: PublicKey;
  /** Depositor pubkey; must equal `fromKeypair.publicKey`. */
  from: PublicKey;
  amountLamports: bigint;
}

export interface PrepareFeeReceiveDeps {
  fromKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export interface SignedFeeReceiveArtifact {
  txSignature: string;
  lastValidBlockHeight: bigint;
  signedTxB64: string;
}

export async function prepareFeeReceive(
  input: PrepareFeeReceiveInput,
  deps: PrepareFeeReceiveDeps,
): Promise<SignedFeeReceiveArtifact> {
  if (deps.fromKeypair.publicKey.toBase58() !== input.from.toBase58()) {
    throw new Error("prepareFeeReceive: fromKeypair/from mismatch");
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

  const tx = buildFeeReceiveTx({
    mint: input.mint,
    from: input.from,
    amountLamports: input.amountLamports,
    recentBlockhash: blockhash,
  });
  tx.sign([deps.fromKeypair]);

  return {
    txSignature: bs58.encode(tx.signatures[0]!),
    lastValidBlockHeight: BigInt(lastValidBlockHeight),
    signedTxB64: Buffer.from(tx.serialize()).toString("base64"),
  };
}
