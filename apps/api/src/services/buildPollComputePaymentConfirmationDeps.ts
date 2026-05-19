/**
 * Build the PollDeps for the BullMQ poll-confirmation driver.
 *
 * Wraps Connection.getSignatureStatuses (the plural batch method —
 * Solana has no singular form) into the shape pollComputePaymentConfirmation
 * expects: a function that takes a single sig and returns one
 * { confirmationStatus, err } | null.
 *
 * Two important RPC details:
 *
 *   1. searchTransactionHistory: true — Solana drops sig info from the
 *      cache after ~150 slots. Without this flag, polls older than ~1
 *      minute would misreport "missing" and the payment would languish.
 *
 *   2. confirmationStatus normalization: some providers omit the field
 *      entirely on early-stage txs. Orchestrator checks `=== null`, so
 *      we coerce undefined → null at the boundary.
 */

import type { Connection } from "@solana/web3.js";

import type {
  PollDeps,
  SignatureStatusResult,
} from "./pollComputePaymentConfirmation.js";

type ConnectionLike = Pick<Connection, "getSignatureStatuses">;

export interface BuildPollComputePaymentConfirmationDepsInput {
  connection: ConnectionLike;
}

export function buildPollComputePaymentConfirmationDeps(
  input: BuildPollComputePaymentConfirmationDepsInput,
): PollDeps {
  return {
    getSignatureStatus: async (
      sig: string,
    ): Promise<SignatureStatusResult | null> => {
      const response = await input.connection.getSignatureStatuses([sig], {
        searchTransactionHistory: true,
      });
      const entry = response.value[0];
      if (!entry) return null;
      return {
        confirmationStatus: entry.confirmationStatus ?? null,
        err: entry.err ?? null,
      };
    },
  };
}
