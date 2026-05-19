/**
 * Build the SubmitTreasuryPaymentDeps for the BullMQ submit-payment
 * driver.
 *
 * Wraps a Solana Connection-like into the two RPC closures the
 * orchestrator (submitTreasuryPayment) needs:
 *   - fetchLatestBlockhash → connection.getLatestBlockhash("confirmed")
 *   - sendRawTransaction   → connection.sendRawTransaction
 *
 * Commitment choice: "confirmed" is the right balance — finalized
 * costs too much latency on payment txs; processed is too racy and
 * a forked blockhash would silently fail the send.
 *
 * Both closures bubble RPC errors. The driver above translates them
 * into ComputePayment lifecycle transitions (markFailed) — swallowing
 * here would leave payments stuck in PENDING.
 */

import type { Connection, Keypair } from "@solana/web3.js";

import type { SubmitTreasuryPaymentDeps } from "./submitTreasuryPayment.js";

type ConnectionLike = Pick<
  Connection,
  "getLatestBlockhash" | "sendRawTransaction"
>;

export interface BuildSubmitTreasuryPaymentDepsInput {
  connection: ConnectionLike;
  signerKeypair: Keypair;
}

export function buildSubmitTreasuryPaymentDeps(
  input: BuildSubmitTreasuryPaymentDepsInput,
): SubmitTreasuryPaymentDeps {
  return {
    signerKeypair: input.signerKeypair,
    fetchLatestBlockhash: async () => {
      const result = await input.connection.getLatestBlockhash("confirmed");
      return {
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight,
      };
    },
    sendRawTransaction: (raw: Uint8Array) =>
      input.connection.sendRawTransaction(raw),
  };
}
