/**
 * Program-mode treasury payment PREPARE orchestrator (plan A2/A3;
 * claim-first protocol, remediation D3).
 *
 * Counterpart to prepareTreasuryPayment.ts (system::transfer mode). Both
 * build + sign WITHOUT broadcasting:
 *
 *   1. fetchLatestBlockhash                          (Solana RPC)
 *   2. buildTreasuryProgramTransferTx                (pure)
 *   3. tx.sign([platformAuthorityKeypair])           (in-memory)
 *   4. return { txSignature, lastValidBlockHeight, signedTxB64 }
 *
 * The difference is at step 2: the tx wraps an `agent_treasury::pay_nosana`
 * instruction targeted at the deployed program, instead of a bare
 * SystemProgram.transfer. The on-chain program enforces:
 *   - `has_one = platform_authority` (signer must match recorded authority)
 *   - amount > 0
 *   - recipient is not the system-program zero pubkey
 *   - treasury balance stays >= rent reserve
 *
 * The caller persists the returned artifacts in the PENDING → SUBMITTING
 * compare-and-set claim and broadcasts the stored bytes afterwards; see
 * prepareTreasuryPayment.ts for why sign and send are split.
 *
 * Errors mapped:
 *   - blockhash fetch throw → `blockhash_unavailable: <upstream>`
 * Same shape as prepareTreasuryPayment.ts so the BullMQ submit driver can
 * map both flavours into per-row transitions uniformly.
 */

import bs58 from "bs58";
import type { Keypair, PublicKey } from "@solana/web3.js";

import { buildTreasuryProgramTransferTx } from "./treasuryProgramTransferTx.js";
import type { ComputePaymentState } from "./computePaymentLifecycle.js";
import type { PreparedTreasuryPayment } from "./prepareTreasuryPayment.js";

export interface PrepareTreasuryPaymentViaProgramInput {
  payment: ComputePaymentState;
  /** SPL mint that owns the treasury PDA. */
  mint: PublicKey;
  /** Recorded `platform_authority` pubkey. Must match signer.publicKey. */
  platformAuthority: PublicKey;
  /** Nosana host pubkey to pay. */
  recipient: PublicKey;
  amountLamports: bigint;
}

export interface PrepareTreasuryPaymentViaProgramDeps {
  platformAuthorityKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
}

export async function prepareTreasuryPaymentViaProgram(
  input: PrepareTreasuryPaymentViaProgramInput,
  deps: PrepareTreasuryPaymentViaProgramDeps,
): Promise<PreparedTreasuryPayment> {
  if (input.payment.status !== "PENDING") {
    throw new Error(
      `prepareTreasuryPaymentViaProgram: payment is ${input.payment.status}, not PENDING — refusing to double-submit`,
    );
  }
  if (
    deps.platformAuthorityKeypair.publicKey.toBase58() !==
    input.platformAuthority.toBase58()
  ) {
    throw new Error(
      "prepareTreasuryPaymentViaProgram: keypair/platformAuthority mismatch",
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

  const tx = buildTreasuryProgramTransferTx({
    mint: input.mint,
    platformAuthority: input.platformAuthority,
    recipient: input.recipient,
    amountLamports: input.amountLamports,
    recentBlockhash: blockhash,
  });
  tx.sign([deps.platformAuthorityKeypair]);

  return {
    txSignature: bs58.encode(tx.signatures[0]!),
    lastValidBlockHeight: BigInt(lastValidBlockHeight),
    signedTxB64: Buffer.from(tx.serialize()).toString("base64"),
  };
}
