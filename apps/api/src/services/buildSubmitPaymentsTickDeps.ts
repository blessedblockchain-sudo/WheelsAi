/**
 * Full dep-wiring for the submit-payments BullMQ worker (claim-first
 * protocol, remediation D3/D5).
 *
 * Composes the entire submit pipeline from raw infra into the deps
 * shape runSubmitPaymentsTick consumes:
 *
 *   recovery (phase 0):
 *     loadSubmittingPaymentsByPrisma  → loadSubmittingBatch
 *     connection.getBlockHeight       → getCurrentBlockHeight
 *     connection.getSignatureStatuses → hasSignatureLanded
 *     persistRecoveryTransition       → persistRecoveryTransition
 *
 *   submit (phase 1):
 *     loadPendingPaymentsByPrisma     → loadPendingBatch
 *     injected resolveRecipient       → resolveRecipient (per row, D5)
 *     prepareTreasuryPayment(+ViaProgram) → prepare (sign-only)
 *     claimPendingPayment             → claim (CAS PENDING→SUBMITTING)
 *     connection.sendRawTransaction   → broadcast (shared with recovery)
 *     persistSubmitTransition         → persistTransition
 *
 * Per-row recipient resolution: the loader returns the DB-direct shape
 * (treasury joined, nosanaJobId + resolutionAttempts included). The
 * DRIVER calls resolveRecipient(nosanaJobId) per row and contains a
 * failure to that row — resolution must NOT happen in the loader, where
 * a single deleted Nosana job would abort the whole batch forever.
 * Production wiring passes a Nosana-SDK-backed resolver; tests inject
 * stubs.
 *
 * Per-treasury signer: different agents own different treasury PDAs
 * with different authority keypairs. treasurySignerFor(treasuryId)
 * routes to the right keypair per row.
 *
 * prepare THROWS on any failure (authority_mismatch, missing mint,
 * blockhash_unavailable, signer mismatch) — the driver catches and
 * records the per-row FAILED transition. Nothing has been claimed or
 * broadcast at that point, so FAILED is accurate.
 *
 * Program-mode rows additionally verify (once per treasury per tick)
 * that the on-chain Treasury's platform_authority equals the derived
 * signer's pubkey BEFORE SIGNING — hijacked/misconfigured treasuries
 * fail loudly with `authority_mismatch` instead of burning tx fees on
 * guaranteed has_one rejections.
 */

import type { PrismaClient } from "@prisma/client";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";

import { deriveTreasuryPda } from "../lib/programs/agentTreasury.js";
import { buildPrepareTreasuryPaymentDeps } from "./buildPrepareTreasuryPaymentDeps.js";
import { claimPendingPayment } from "./claimPendingPayment.js";
import { readTreasuryPlatformAuthority } from "./isPdaAccountInitialized.js";
import { loadPendingPaymentsByPrisma } from "./loadPendingPaymentsByPrisma.js";
import { loadSubmittingPaymentsByPrisma } from "./loadSubmittingPaymentsByPrisma.js";
import { persistRecoveryTransition } from "./persistRecoveryTransition.js";
import { persistSubmitTransition } from "./persistSubmitTransition.js";
import { prepareTreasuryPayment } from "./prepareTreasuryPayment.js";
import { prepareTreasuryPaymentViaProgram } from "./prepareTreasuryPaymentViaProgram.js";
import type {
  PaymentTransition,
  RecoveryTransition,
  SignedPaymentArtifact,
  SubmitPaymentsTickDeps,
} from "./runSubmitPaymentsTick.js";

type PrismaSurface = Pick<PrismaClient, "computePayment">;

export interface BuildSubmitPaymentsTickDepsInput {
  prisma: PrismaSurface;
  connection: Pick<
    Connection,
    | "getLatestBlockhash"
    | "sendRawTransaction"
    | "getAccountInfo"
    | "getSignatureStatuses"
    | "getBlockHeight"
  >;
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
  // Per-tick cache of positively-verified treasury authorities (C1/C2
  // defense-in-depth). Keyed by treasuryId; cleared at the top of each
  // loadPendingBatch (once per tick), so a batch with N payments against
  // the same treasury costs exactly one getAccountInfo read — but a NEW
  // tick re-verifies, so a rotation/hijack between ticks is still caught.
  // Only positive verifications are cached; failures throw per-row.
  const verifiedAuthorities = new Set<string>();

  const fetchLatestBlockhash = async () => {
    const r = await input.connection.getLatestBlockhash("confirmed");
    return {
      blockhash: r.blockhash,
      lastValidBlockHeight: r.lastValidBlockHeight,
    };
  };

  return {
    // ---------- phase 0: recovery ----------

    loadSubmittingBatch: async () =>
      loadSubmittingPaymentsByPrisma(
        { limit: input.batchLimit },
        { prisma: input.prisma as never },
      ),

    getCurrentBlockHeight: async () =>
      BigInt(await input.connection.getBlockHeight("confirmed")),

    hasSignatureLanded: async (txSignature: string) => {
      const response = await input.connection.getSignatureStatuses(
        [txSignature],
        { searchTransactionHistory: true },
      );
      return response.value[0] != null;
    },

    broadcast: async (signedTxB64: string) => {
      const raw = new Uint8Array(Buffer.from(signedTxB64, "base64"));
      await input.connection.sendRawTransaction(raw);
    },

    persistRecoveryTransition: async (
      id: string,
      transition: RecoveryTransition,
    ) =>
      persistRecoveryTransition(id, transition, {
        prisma: input.prisma as never,
        now: input.now(),
      }),

    // ---------- phase 1: submit ----------

    loadPendingBatch: async ({ now }) => {
      verifiedAuthorities.clear();
      return loadPendingPaymentsByPrisma(
        { now, limit: input.batchLimit },
        { prisma: input.prisma as never },
      );
    },

    resolveRecipient: (nosanaJobId: string) =>
      input.resolveRecipient(nosanaJobId),

    prepare: async (row, recipientAddress): Promise<SignedPaymentArtifact> => {
      const signerKeypair = input.treasurySignerFor(row.treasuryId);
      const paymentStub = {
        id: row.id,
        status: "PENDING" as const,
        txSignature: null,
        errorMessage: null,
        paidAt: null,
        retryCount: 0,
      };

      if (row.programInitialized) {
        // Program-mode: route through agent-treasury::pay_nosana. The
        // signer (HKDF-derived from WALLET_MASTER_KEY + treasuryId) is
        // ALSO the recorded platform_authority on the on-chain Treasury
        // — the program's has_one constraint enforces this match. If
        // the row is missing the mint we can't derive the PDA, so fail
        // fast rather than sign a tx the program would reject.
        if (!row.mintAddress) {
          throw new Error(
            `program_mode_missing_mint: treasury ${row.treasuryId} has programInitialized=true but no token.mintAddress on the join`,
          );
        }

        // C1/C2 client-side authority verification: BEFORE SIGNING,
        // confirm the on-chain Treasury records OUR derived key as
        // platform_authority. A mismatch means the PDA was hijacked
        // (initialized by someone else) or WALLET_MASTER_KEY is
        // misconfigured — either way, signing would only waste a tx
        // fee on a guaranteed has_one rejection, and silently
        // retrying forever would mask the incident. Throwing here
        // records a FAILED transition with a loud, distinct message.
        if (!verifiedAuthorities.has(row.treasuryId)) {
          const [treasuryPda] = deriveTreasuryPda(
            new PublicKey(row.mintAddress),
          );
          const onChainAuthority = await readTreasuryPlatformAuthority(
            input.connection,
            treasuryPda,
          );
          if (
            !onChainAuthority ||
            !onChainAuthority.equals(signerKeypair.publicKey)
          ) {
            throw new Error(
              `authority_mismatch: on-chain ${
                onChainAuthority ? onChainAuthority.toBase58() : "<missing>"
              } != derived ${signerKeypair.publicKey.toBase58()}`,
            );
          }
          verifiedAuthorities.add(row.treasuryId);
        }

        return prepareTreasuryPaymentViaProgram(
          {
            payment: paymentStub,
            mint: new PublicKey(row.mintAddress),
            platformAuthority: signerKeypair.publicKey,
            recipient: new PublicKey(recipientAddress),
            amountLamports: row.amountLamports,
          },
          {
            platformAuthorityKeypair: signerKeypair,
            fetchLatestBlockhash,
          },
        );
      }

      // Legacy mode: bare SystemProgram.transfer from a server-held
      // wallet whose pubkey == treasuryAddress.
      return prepareTreasuryPayment(
        {
          payment: paymentStub,
          treasuryAddress: row.treasuryAddress,
          recipientAddress,
          amountLamports: row.amountLamports,
        },
        buildPrepareTreasuryPaymentDeps({
          connection: input.connection,
          signerKeypair,
        }),
      );
    },

    claim: async (id: string, artifact: SignedPaymentArtifact) =>
      claimPendingPayment(id, artifact, {
        prisma: input.prisma as never,
      }),

    persistTransition: async (id: string, transition: PaymentTransition) =>
      persistSubmitTransition(id, transition, {
        prisma: input.prisma as never,
        now: input.now(),
      }),
  };
}
