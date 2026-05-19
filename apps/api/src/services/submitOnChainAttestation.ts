/**
 * Side-effect orchestrator for the reputation-oracle submit_attestation
 * ix (plan A4).
 *
 * Mirrors submitFeeReceive: fetch blockhash → build tx → sign → send →
 * return tx signature. All IO injected so unit tests run without an
 * RPC.
 *
 * Errors mapped:
 *   - blockhash fetch throw → `blockhash_unavailable: <upstream>`
 *   - sendRawTransaction throw → `rpc_submit: <upstream>`
 *
 * The keypair/attestor mismatch check fails loudly at the call site
 * (mis-wired dep-builder), not silently on the wire.
 */

import type { Keypair, PublicKey } from "@solana/web3.js";

import { buildSubmitAttestationTx } from "./submitAttestationTx.js";

export interface SubmitOnChainAttestationInput {
  mint: PublicKey;
  /** Whitelisted attestor pubkey; must equal `attestorKeypair.publicKey`. */
  attestor: PublicKey;
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  score: number;
  unixTs: bigint;
}

export interface SubmitOnChainAttestationDeps {
  attestorKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
}

export interface SubmitOnChainAttestationResult {
  txSignature: string;
}

export async function submitOnChainAttestation(
  input: SubmitOnChainAttestationInput,
  deps: SubmitOnChainAttestationDeps,
): Promise<SubmitOnChainAttestationResult> {
  if (
    deps.attestorKeypair.publicKey.toBase58() !== input.attestor.toBase58()
  ) {
    throw new Error("submitOnChainAttestation: attestorKeypair/attestor mismatch");
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

  const tx = buildSubmitAttestationTx({
    mint: input.mint,
    attestor: input.attestor,
    uptimeSecondsDelta: input.uptimeSecondsDelta,
    messageCountDelta: input.messageCountDelta,
    score: input.score,
    unixTs: input.unixTs,
    recentBlockhash: blockhash,
  });
  tx.sign([deps.attestorKeypair]);

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
