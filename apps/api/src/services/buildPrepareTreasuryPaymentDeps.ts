/**
 * Build the PrepareTreasuryPaymentDeps for the BullMQ submit-payment
 * driver.
 *
 * Wraps a Solana Connection-like into the single RPC closure the
 * prepare orchestrators (prepareTreasuryPayment / ...ViaProgram) need:
 *   - fetchLatestBlockhash → connection.getLatestBlockhash("confirmed")
 *
 * Broadcast deliberately does NOT live here: under the claim-first
 * protocol (D3) the signed bytes are persisted in the PENDING →
 * SUBMITTING claim before any send, and the broadcast closure is wired
 * separately in buildSubmitPaymentsTickDeps so recovery can re-send the
 * exact same bytes.
 *
 * Commitment choice: "confirmed" is the right balance — finalized
 * costs too much latency on payment txs; processed is too racy and
 * a forked blockhash would silently fail the send.
 *
 * The closure bubbles RPC errors. The orchestrator above translates
 * them into `blockhash_unavailable: …` — swallowing here would leave
 * payments stuck in PENDING.
 */

import type { Connection, Keypair } from "@solana/web3.js";

import type { PrepareTreasuryPaymentDeps } from "./prepareTreasuryPayment.js";

type ConnectionLike = Pick<Connection, "getLatestBlockhash">;

export interface BuildPrepareTreasuryPaymentDepsInput {
  connection: ConnectionLike;
  signerKeypair: Keypair;
}

export function buildPrepareTreasuryPaymentDeps(
  input: BuildPrepareTreasuryPaymentDepsInput,
): PrepareTreasuryPaymentDeps {
  return {
    signerKeypair: input.signerKeypair,
    fetchLatestBlockhash: async () => {
      const result = await input.connection.getLatestBlockhash("confirmed");
      return {
        blockhash: result.blockhash,
        lastValidBlockHeight: result.lastValidBlockHeight,
      };
    },
  };
}
