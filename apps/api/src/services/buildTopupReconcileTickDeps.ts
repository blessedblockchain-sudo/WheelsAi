/**
 * Composition root for the top-up reconcile worker (payments pass,
 * batch 2): binds the pure runTopupReconcileTick to Prisma and to the
 * chain reads it is given.
 *
 * The money rules live elsewhere; this file only wires them:
 *   - creditTopup: makeCreditTopup (services/walletTopup.ts), the one
 *     way a top-up grants credits. Its status change and the ledger rows
 *     commit together.
 *   - endFromChain: compare-and-set submitting|submitted -> failed or
 *     expired, on the row that holds this exact signature.
 *   - expireUnsigned: compare-and-set prepared -> expired, only while
 *     the row has no signature. A submit that claims the row first
 *     (prepared -> submitting, storing the signature) makes this lose.
 *   - resendSignedBytes: the stored bytes, unchanged. They are checked
 *     to carry the stored signature first, so what goes out is provably
 *     the transaction the row already answers for.
 *
 * The chain reads are arguments so that no Connection is made here
 * (lib/solana.ts owns the only one) and a test can pass stand-ins.
 */

import type { PrismaClient } from "@prisma/client";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

import type { SignatureFateAnswer } from "./signatureFate.js";
import type {
  ReconcilableTopupRow,
  TopupReconcileEvent,
  TopupReconcileTickDeps,
} from "./runTopupReconcileTick.js";
import { makeCreditTopup, type TopupCreditDb } from "./walletTopup.js";

const IN_FLIGHT = ["submitting", "submitted"];

export interface BuildTopupReconcileTickDepsInput {
  prisma: PrismaClient;
  /** The row label of the chain the settings name ('solana:devnet' or
   * 'solana:mainnet'). Only top-ups made on that chain are loaded: a
   * signature from another chain is absent on this one, and "absent"
   * must never be read as "it can no longer land". */
  network: string;
  /** lib/solana.ts ensureSolanaCluster. */
  checkCluster: () => Promise<{ ok: boolean; reason?: string }>;
  /** services/buildSignatureFateDeps.ts readSignatureFate. */
  readFate: (args: {
    signature: string;
    lastValidBlockHeight: bigint;
  }) => Promise<SignatureFateAnswer>;
  /** Hands the wire bytes to the node, as the submit route does. A throw
   * is "not taken", never "failed". */
  sendRawTransaction: (rawTransaction: Buffer) => Promise<unknown>;
  log?: (event: TopupReconcileEvent) => void;
}

/** The base58 signature in the first slot of a signed transaction, or
 * null when the bytes cannot be read. */
function firstSignatureOf(rawTransaction: Buffer): string | null {
  try {
    const signature =
      VersionedTransaction.deserialize(rawTransaction).signatures[0];
    return signature ? bs58.encode(signature) : null;
  } catch {
    return null;
  }
}

export function buildTopupReconcileTickDeps(
  input: BuildTopupReconcileTickDepsInput,
): TopupReconcileTickDeps {
  const { prisma } = input;

  return {
    checkCluster: input.checkCluster,
    readFate: input.readFate,
    log: input.log,

    loadTopups: async ({ limit, now }) => {
      const rows = await prisma.walletTopUp.findMany({
        where: {
          network: input.network,
          OR: [
            { status: { in: IN_FLIGHT } },
            { status: "prepared", expiresAt: { lt: now } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map(
        (r): ReconcilableTopupRow => ({
          id: r.id,
          orgId: r.orgId,
          asset: r.asset,
          network: r.network,
          amountUsdCents: r.amountUsdCents,
          bonusCents: r.bonusCents,
          status: r.status,
          txSignature: r.txSignature,
          signedTxB64: r.signedTxB64,
          lastValidBlockHeight: r.lastValidBlockHeight,
          expiresAt: r.expiresAt,
        }),
      );
    },

    creditTopup: makeCreditTopup(prisma as unknown as TopupCreditDb),

    endFromChain: async ({ id, txSignature, to, failureCode, failureReason }) => {
      const res = await prisma.walletTopUp.updateMany({
        // The signature in `where`: the chain's answer was about this
        // signature, so it may only end the row that still holds it.
        where: { id, txSignature, status: { in: IN_FLIGHT } },
        data: { status: to, failureCode, failureReason },
      });
      return res.count === 1;
    },

    expireUnsigned: async ({ id, failureCode }) => {
      const res = await prisma.walletTopUp.updateMany({
        where: { id, status: "prepared", txSignature: null },
        data: { status: "expired", failureCode },
      });
      return res.count === 1;
    },

    resendSignedBytes: async ({ signedTxB64, txSignature }) => {
      const raw = Buffer.from(signedTxB64, "base64");
      if (firstSignatureOf(raw) !== txSignature) {
        return {
          ok: false,
          detail: "stored signed bytes do not carry the stored signature",
        };
      }
      try {
        await input.sendRawTransaction(raw);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },

    markSubmitted: async ({ id }) => {
      const res = await prisma.walletTopUp.updateMany({
        where: { id, status: "submitting" },
        data: { status: "submitted" },
      });
      return res.count === 1;
    },
  };
}
