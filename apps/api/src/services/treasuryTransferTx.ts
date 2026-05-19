/**
 * Pure treasury-transfer transaction builder (plan A3).
 *
 * Until the agent-treasury Anchor program ships (plan A2), the settlement
 * worker pays each Nosana host directly via SystemProgram.transfer from the
 * WheelsAI master keypair, with treasury balances tracked off-chain in
 * Postgres. This module produces the *unsigned* VersionedTransaction so the
 * signing + RPC submission live in a separate side-effect layer and these
 * tests stay 100% pure.
 */

import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

const U64_MAX = (1n << 64n) - 1n;

export interface BuildTreasuryTransferInput {
  fromPubkey: string;
  toPubkey: string;
  amountLamports: bigint;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}

function parsePubkey(label: "fromPubkey" | "toPubkey", value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`buildTreasuryTransferTx: invalid pubkey for ${label}`);
  }
}

export function buildTreasuryTransferTx(
  input: BuildTreasuryTransferInput,
): VersionedTransaction {
  if (input.amountLamports <= 0n) {
    throw new Error(
      `buildTreasuryTransferTx: amountLamports must be positive, got ${input.amountLamports}`,
    );
  }
  if (input.amountLamports > U64_MAX) {
    throw new Error(
      `buildTreasuryTransferTx: amountLamports overflows u64 (got ${input.amountLamports})`,
    );
  }
  if (!input.recentBlockhash || input.recentBlockhash.length === 0) {
    throw new Error("buildTreasuryTransferTx: recentBlockhash is required");
  }

  const from = parsePubkey("fromPubkey", input.fromPubkey);
  const to = parsePubkey("toPubkey", input.toPubkey);

  if (from.equals(to)) {
    throw new Error(
      "buildTreasuryTransferTx: from and to pubkeys must differ (same account)",
    );
  }

  // SystemProgram.transfer accepts number or bigint. We've already validated
  // the bigint fits in u64; pass it through as bigint to preserve precision.
  const ix = SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: to,
    lamports: input.amountLamports as unknown as number,
  });

  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: input.recentBlockhash,
    instructions: [ix],
  }).compileToV0Message();

  return new VersionedTransaction(message);
}
