/**
 * Program-mode treasury payment submission orchestrator (plan A2/A3).
 *
 * Counterpart to submitTreasuryPayment.ts (system::transfer mode). Both
 * compose the same five-step pipeline:
 *
 *   1. fetchLatestBlockhash                          (Solana RPC)
 *   2. buildTreasuryProgramTransferTx                (pure)
 *   3. tx.sign([platformAuthorityKeypair])
 *   4. sendRawTransaction                            (Solana RPC)
 *   5. markSubmitted(payment, txSignature)           (pure)
 *
 * The difference is at step 2: the tx wraps an `agent_treasury::pay_nosana`
 * instruction targeted at the deployed program, instead of a bare
 * SystemProgram.transfer. The on-chain program enforces:
 *   - `has_one = platform_authority` (signer must match recorded authority)
 *   - amount > 0
 *   - recipient is not the system-program zero pubkey
 *   - treasury balance stays >= rent reserve
 *
 * Errors mapped:
 *   - blockhash fetch throw → `blockhash_unavailable: <upstream>`
 *   - sendRawTransaction throw → `rpc_submit: <upstream>`
 * Same shape as submitTreasuryPayment.ts so the BullMQ submit driver can
 * map both flavours into FAILED rows uniformly.
 */

import type { Keypair, PublicKey } from "@solana/web3.js";

import { buildTreasuryProgramTransferTx } from "./treasuryProgramTransferTx.js";
import {
  markSubmitted,
  type ComputePaymentState,
} from "./computePaymentLifecycle.js";

export interface SubmitTreasuryPaymentViaProgramInput {
  payment: ComputePaymentState;
  /** SPL mint that owns the treasury PDA. */
  mint: PublicKey;
  /** Recorded `platform_authority` pubkey. Must match signer.publicKey. */
  platformAuthority: PublicKey;
  /** Nosana host pubkey to pay. */
  recipient: PublicKey;
  amountLamports: bigint;
}

export interface SubmitTreasuryPaymentViaProgramDeps {
  platformAuthorityKeypair: Keypair;
  fetchLatestBlockhash: () => Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }>;
  sendRawTransaction: (raw: Uint8Array) => Promise<string>;
}

export interface SubmitTreasuryPaymentViaProgramResult {
  payment: ComputePaymentState;
  txSignature: string;
}

export async function submitTreasuryPaymentViaProgram(
  input: SubmitTreasuryPaymentViaProgramInput,
  deps: SubmitTreasuryPaymentViaProgramDeps,
): Promise<SubmitTreasuryPaymentViaProgramResult> {
  if (input.payment.status !== "PENDING") {
    throw new Error(
      `submitTreasuryPaymentViaProgram: payment is ${input.payment.status}, not PENDING — refusing to double-submit`,
    );
  }
  if (
    deps.platformAuthorityKeypair.publicKey.toBase58() !==
    input.platformAuthority.toBase58()
  ) {
    throw new Error(
      "submitTreasuryPaymentViaProgram: keypair/platformAuthority mismatch",
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

  const tx = buildTreasuryProgramTransferTx({
    mint: input.mint,
    platformAuthority: input.platformAuthority,
    recipient: input.recipient,
    amountLamports: input.amountLamports,
    recentBlockhash: blockhash,
  });
  tx.sign([deps.platformAuthorityKeypair]);

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
