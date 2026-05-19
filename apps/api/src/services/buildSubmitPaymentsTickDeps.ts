/**
 * Full dep-wiring for the submit-payments BullMQ worker.
 *
 * Composes the entire submit pipeline from raw infra into the deps
 * shape runSubmitPaymentsTick consumes:
 *   loadPendingPaymentsByPrisma     → loadPendingBatch (+ flatten +
 *                                      resolve recipient)
 *   submitTreasuryPayment + RPC     → submit
 *   persistSubmitTransition         → persistTransition
 *
 * Per-row recipient resolution: the loader returns the DB-direct shape
 * (treasury joined for treasuryAddress + nosanaJobId). The driver
 * expects a recipientAddress on each row, so the loadPendingBatch
 * closure here calls injected resolveRecipient(nosanaJobId) per row
 * to build the full PendingPaymentRow. Production wiring passes a
 * Nosana-SDK-backed resolver; tests inject stubs.
 *
 * Per-treasury signer: different agents own different treasury PDAs
 * with different authority keypairs. treasurySignerFor(treasuryId)
 * routes to the right keypair per row.
 *
 * submit returns ok=false on any RPC throw so the driver records the
 * FAILED transition cleanly. The orchestrator's invariant checks
 * (signerKeypair.publicKey === treasuryAddress, payment.status ===
 * PENDING) will throw too — those are caught and translated.
 */

import type { PrismaClient } from "@prisma/client";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";

import { buildSubmitTreasuryPaymentDeps } from "./buildSubmitTreasuryPaymentDeps.js";
import { loadPendingPaymentsByPrisma } from "./loadPendingPaymentsByPrisma.js";
import { persistSubmitTransition } from "./persistSubmitTransition.js";
import {
  submitTreasuryPayment,
} from "./submitTreasuryPayment.js";
import {
  submitTreasuryPaymentViaProgram,
  type SubmitTreasuryPaymentViaProgramDeps,
} from "./submitTreasuryPaymentViaProgram.js";

// Tiny adapter: re-uses the legacy connection-wrapping helper for the
// blockhash + raw-send closures, but swaps the keypair label since the
// program-mode orchestrator names its signer platformAuthorityKeypair.
function buildProgramOrchestratorDeps(input: {
  connection: Pick<Connection, "getLatestBlockhash" | "sendRawTransaction">;
  platformAuthorityKeypair: Keypair;
}): SubmitTreasuryPaymentViaProgramDeps {
  return {
    platformAuthorityKeypair: input.platformAuthorityKeypair,
    fetchLatestBlockhash: async () => {
      const r = await input.connection.getLatestBlockhash("confirmed");
      return {
        blockhash: r.blockhash,
        lastValidBlockHeight: r.lastValidBlockHeight,
      };
    },
    sendRawTransaction: (raw: Uint8Array) =>
      input.connection.sendRawTransaction(raw),
  };
}
import type {
  PaymentTransition,
  PendingPaymentRow,
  SubmitPaymentOutcome,
  SubmitPaymentsTickDeps,
} from "./runSubmitPaymentsTick.js";

type PrismaSurface = Pick<PrismaClient, "computePayment">;

export interface BuildSubmitPaymentsTickDepsInput {
  prisma: PrismaSurface;
  connection: Pick<Connection, "getLatestBlockhash" | "sendRawTransaction">;
  /** Per-treasury keypair lookup. */
  treasurySignerFor: (treasuryId: string) => Keypair;
  /** Resolve the Nosana host pubkey for a given nosanaJobId. */
  resolveRecipient: (nosanaJobId: string) => Promise<string>;
  /** Per-tick batch size. */
  batchLimit: number;
  /** Wall-clock provider (overridable in tests). */
  now: () => Date;
}

export function buildSubmitPaymentsTickDeps(
  input: BuildSubmitPaymentsTickDepsInput,
): SubmitPaymentsTickDeps {
  return {
    loadPendingBatch: async ({ now }) => {
      const rows = await loadPendingPaymentsByPrisma(
        { now, limit: input.batchLimit },
        { prisma: input.prisma as never },
      );
      const enriched: PendingPaymentRow[] = [];
      for (const row of rows) {
        const recipientAddress = await input.resolveRecipient(row.nosanaJobId);
        enriched.push({
          id: row.id,
          treasuryId: row.treasuryId,
          treasuryAddress: row.treasuryAddress,
          recipientAddress,
          amountLamports: row.amountLamports,
          programInitialized: row.programInitialized,
          mintAddress: row.mintAddress,
        });
      }
      return enriched;
    },

    submit: async (row): Promise<SubmitPaymentOutcome> => {
      try {
        const signerKeypair = input.treasurySignerFor(row.treasuryId);
        if (row.programInitialized) {
          // Program-mode: route through agent-treasury::pay_nosana. The
          // signer (HKDF-derived from WALLET_MASTER_KEY + treasuryId) is
          // ALSO the recorded platform_authority on the on-chain Treasury
          // — the program's has_one constraint enforces this match. If
          // the row is missing the mint we can't derive the PDA, so fail
          // fast rather than send a tx the program would reject.
          if (!row.mintAddress) {
            return {
              ok: false,
              error: `program_mode_missing_mint: treasury ${row.treasuryId} has programInitialized=true but no token.mintAddress on the join`,
            };
          }
          const result = await submitTreasuryPaymentViaProgram(
            {
              payment: {
                id: row.id,
                status: "PENDING",
                txSignature: null,
                errorMessage: null,
                paidAt: null,
                retryCount: 0,
              },
              mint: new PublicKey(row.mintAddress),
              platformAuthority: signerKeypair.publicKey,
              recipient: new PublicKey(row.recipientAddress),
              amountLamports: row.amountLamports,
            },
            buildProgramOrchestratorDeps({
              connection: input.connection,
              platformAuthorityKeypair: signerKeypair,
            }),
          );
          return { ok: true, txSignature: result.txSignature };
        }

        // Legacy mode: bare SystemProgram.transfer from a server-held
        // wallet whose pubkey == treasuryAddress.
        const orchestratorDeps = buildSubmitTreasuryPaymentDeps({
          connection: input.connection,
          signerKeypair,
        });
        const result = await submitTreasuryPayment(
          {
            payment: {
              id: row.id,
              status: "PENDING",
              txSignature: null,
              errorMessage: null,
              paidAt: null,
              retryCount: 0,
            },
            treasuryAddress: row.treasuryAddress,
            recipientAddress: row.recipientAddress,
            amountLamports: row.amountLamports,
          },
          orchestratorDeps,
        );
        return { ok: true, txSignature: result.txSignature };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    },

    persistTransition: async (id: string, transition: PaymentTransition) =>
      persistSubmitTransition(id, transition, {
        prisma: input.prisma as never,
        now: input.now(),
      }),
  };
}
