/**
 * Sign-only PREPARE orchestrator for the reputation-oracle
 * submit_attestation ix — claim-first protocol (remediation D6b).
 *
 * Counterpart to submitOnChainAttestation.ts but WITHOUT the broadcast
 * (mirrors prepareFeeReceive/prepareTreasuryPaymentViaProgram):
 *
 *   1. fetchLatestBlockhash                  (Solana RPC)
 *   2. buildSubmitAttestationTx              (pure)
 *   3. tx.sign([attestorKeypair])            (in-memory)
 *   4. return { txSignature, lastValidBlockHeight, signedTxB64 }
 *
 * The attestation driver persists these artifacts on the
 * OnChainAttestation mirror row (status SUBMITTED) BEFORE broadcasting,
 * so a crash anywhere afterwards leaves a durable record recovery can
 * settle from on-chain evidence — re-broadcasting the SAME bytes (same
 * signature ⇒ cluster dedupes) instead of re-signing, which is what
 * closes the duplicate-attestation double-count the old worker's
 * KNOWN RISK comment described.
 *
 * Errors mapped:
 *   - blockhash fetch throw → `blockhash_unavailable: <upstream>`
 */

import bs58 from "bs58";
import type { Keypair, PublicKey } from "@solana/web3.js";

import { buildSubmitAttestationTx } from "./submitAttestationTx.js";

export interface PrepareOnChainAttestationInput {
  mint: PublicKey;
  /** Whitelisted attestor pubkey; must equal `attestorKeypair.publicKey`. */
  attestor: PublicKey;
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  score: number;
  unixTs: bigint;
}

export interface PrepareOnChainAttestationDeps {
  attestorKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export interface SignedAttestationArtifact {
  txSignature: string;
  lastValidBlockHeight: bigint;
  signedTxB64: string;
}

export async function prepareOnChainAttestation(
  input: PrepareOnChainAttestationInput,
  deps: PrepareOnChainAttestationDeps,
): Promise<SignedAttestationArtifact> {
  if (
    deps.attestorKeypair.publicKey.toBase58() !== input.attestor.toBase58()
  ) {
    throw new Error(
      "prepareOnChainAttestation: attestorKeypair/attestor mismatch",
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

  return {
    txSignature: bs58.encode(tx.signatures[0]!),
    lastValidBlockHeight: BigInt(lastValidBlockHeight),
    signedTxB64: Buffer.from(tx.serialize()).toString("base64"),
  };
}
