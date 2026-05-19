/**
 * Pure tx builder for the reputation-oracle program's submit_attestation
 * instruction (plan A4).
 *
 * Wraps `buildSubmitAttestationIx` in a VersionedTransaction. The signer
 * is the attestor key (must be in the program's whitelist) AND pays the
 * tx fee. Signing + RPC submission live in `submitOnChainAttestation.ts`.
 *
 * Why bigint for deltas + score-as-number: the on-chain program treats
 * deltas as u64 (cumulative-friendly) and score as u32 (0..=100, can fit
 * in a JS number). Mirroring those types here keeps the wire format
 * obvious at the call site.
 */

import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { buildSubmitAttestationIx } from "../lib/programs/reputationOracle.js";

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const I64_MIN = -((BigInt(1) << BigInt(63)));
const I64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);

export interface BuildSubmitAttestationTxInput {
  /** SPL mint identifying the agent — derives the AgentReputation PDA. */
  mint: PublicKey;
  /** Whitelisted attestor pubkey; signs the tx + pays its fee. */
  attestor: PublicKey;
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  /** 0..=100. The on-chain program rejects anything outside this range. */
  score: number;
  /** Attestor-claimed unix timestamp (must be ≥ last recorded). */
  unixTs: bigint;
  recentBlockhash: string;
}

export function buildSubmitAttestationTx(
  input: BuildSubmitAttestationTxInput,
): VersionedTransaction {
  if (input.uptimeSecondsDelta < BigInt(0)) {
    throw new Error(
      `buildSubmitAttestationTx: uptimeSecondsDelta must be >= 0, got ${input.uptimeSecondsDelta}`,
    );
  }
  if (input.uptimeSecondsDelta > U64_MAX) {
    throw new Error(
      `buildSubmitAttestationTx: uptimeSecondsDelta overflows u64`,
    );
  }
  if (input.messageCountDelta < BigInt(0)) {
    throw new Error(
      `buildSubmitAttestationTx: messageCountDelta must be >= 0, got ${input.messageCountDelta}`,
    );
  }
  if (input.messageCountDelta > U64_MAX) {
    throw new Error(
      `buildSubmitAttestationTx: messageCountDelta overflows u64`,
    );
  }
  if (!Number.isInteger(input.score) || input.score < 0 || input.score > 100) {
    throw new Error(
      `buildSubmitAttestationTx: score must be an integer in 0..=100, got ${input.score}`,
    );
  }
  if (input.unixTs < I64_MIN || input.unixTs > I64_MAX) {
    throw new Error(`buildSubmitAttestationTx: unixTs out of i64 range`);
  }
  if (!input.recentBlockhash || input.recentBlockhash.length === 0) {
    throw new Error("buildSubmitAttestationTx: recentBlockhash is required");
  }

  const ix = buildSubmitAttestationIx({
    mint: input.mint,
    attestor: input.attestor,
    uptimeSecondsDelta: input.uptimeSecondsDelta,
    messageCountDelta: input.messageCountDelta,
    score: input.score,
    unixTs: input.unixTs,
  });

  const message = new TransactionMessage({
    // Attestor signs the ix AND pays the tx fee in one slot.
    payerKey: input.attestor,
    recentBlockhash: input.recentBlockhash,
    instructions: [ix],
  }).compileToV0Message();

  return new VersionedTransaction(message);
}
