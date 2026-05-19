/**
 * Pure tx builder for the program-backed pay path.
 *
 * Mirrors `treasuryTransferTx.ts` (system::transfer model) but produces
 * a VersionedTransaction whose only instruction is
 * `agent_treasury::pay_nosana(amount)` against the deployed program.
 *
 * Migration plan (from the system::transfer flow to this one):
 *   1. Deploy `agent-treasury` program to devnet, get program ID
 *   2. Add `ownerTokenMint` to the AgentTreasury Prisma model so the
 *      submit worker has the seed to derive the PDA
 *   3. Add `platformAuthority` to AgentTreasury (the recorded signer)
 *   4. Swap `buildTreasuryTransferTx` → `buildTreasuryProgramTransferTx`
 *      in the submit-payments worker
 *   5. Schedule a one-time backfill: for every existing AgentTreasury,
 *      call `initialize_treasury` on-chain so the PDA is registered
 *
 * Until step 1 lands, this module produces tx bytes that the program
 * (deployed locally to LiteSVM) accepts; tests in
 * `programs/agent-treasury/tests/integration.rs` plus
 * `agentTreasuryProgram.unit.test.ts` are the contract.
 */

import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { buildPayNosanaIx } from "../lib/programs/agentTreasury.js";

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

export interface BuildTreasuryProgramTransferInput {
  /** SPL mint that owns the treasury PDA. */
  mint: PublicKey;
  /** Wallet that signs the tx (recorded on-chain in Treasury.platform_authority). */
  platformAuthority: PublicKey;
  /** Nosana host pubkey to pay. */
  recipient: PublicKey;
  amountLamports: bigint;
  recentBlockhash: string;
}

export function buildTreasuryProgramTransferTx(
  input: BuildTreasuryProgramTransferInput,
): VersionedTransaction {
  if (input.amountLamports <= BigInt(0)) {
    throw new Error(
      `buildTreasuryProgramTransferTx: amountLamports must be positive, got ${input.amountLamports}`,
    );
  }
  if (input.amountLamports > U64_MAX) {
    throw new Error(
      `buildTreasuryProgramTransferTx: amountLamports overflows u64 (got ${input.amountLamports})`,
    );
  }
  if (!input.recentBlockhash || input.recentBlockhash.length === 0) {
    throw new Error("buildTreasuryProgramTransferTx: recentBlockhash is required");
  }

  const ix = buildPayNosanaIx({
    mint: input.mint,
    platformAuthority: input.platformAuthority,
    recipient: input.recipient,
    amountLamports: input.amountLamports,
  });

  const message = new TransactionMessage({
    // platformAuthority is both the tx-fee payer and the signer for the
    // program's `has_one = platform_authority` constraint. Using a single
    // signer keeps the BullMQ worker side trivial.
    payerKey: input.platformAuthority,
    recentBlockhash: input.recentBlockhash,
    instructions: [ix],
  }).compileToV0Message();

  return new VersionedTransaction(message);
}
