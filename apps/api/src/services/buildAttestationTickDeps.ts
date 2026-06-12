/**
 * Full dep-wiring for the reputation-attestation BullMQ worker (plan A4)
 * — confirmation discipline (remediation D6b).
 *
 * Composes the layer-by-layer pieces:
 *   recovery (phase 0):
 *     loadSubmittedAttestationsByPrisma → loadSubmittedMirrors
 *     connection.getBlockHeight         → getCurrentBlockHeight
 *     connection.getSignatureStatuses   → getSignatureStatus
 *
 *   attest (phase 1):
 *     loadAgentsForAttestation        → loadAgents
 *     aggregate(row, {now})           → reduces UsageRecord rows since the
 *                                       per-agent cursor into (uptimeΔ,
 *                                       msgCountΔ, score, periodEnd)
 *     prepareOnChainAttestation       → prepare (sign-only, NO broadcast)
 *     persistAttestationIntent        → persistIntent (SUBMITTED mirror)
 *     connection.sendRawTransaction   → broadcast (shared with recovery)
 *     awaitSignatureConfirmation      → confirmSignature
 *
 *   shared:
 *     readAgentReputationFromChain    → readCumulatives (PDA truth)
 *     persistAttestationCursor        → persistMirrorConfirmed
 *                                       (CONFIRMED + observedAt + cursor)
 *     persistAttestationMirrorFailed  → persistMirrorFailed
 *
 * The aggregator translates the existing loadUsageRecordsForReputation +
 * computeReputationScore stack into the on-chain ix shape:
 *
 *   uptimeSecondsDelta  = Σ computeSeconds across records in window
 *   messageCountDelta   = Σ requestCount across records in window
 *   score (int 0..=100) = round(computeReputationScore(...))
 *   periodEnd           = now (cursor advance target — ON CONFIRMATION)
 *
 * Window:
 *   periodStart = row.lastOnChainAttestationAt ?? (now - 6h)
 *   periodEnd   = now
 *
 *   The 6h default mirrors the cron interval — first-time agents only
 *   contribute the last 6h, not their lifetime.
 *
 * Caller injects the attestor keypair; this builder doesn't load it
 * from env (separation of concerns: the env wiring belongs in the
 * BullMQ shell).
 */

import type { PrismaClient } from "@prisma/client";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";

import { awaitSignatureConfirmation } from "./awaitSignatureConfirmation.js";
import { computeReputationScore } from "./reputationAggregation.js";
import {
  loadAgentsForAttestation,
  type AttestableAgentLoadedRow,
} from "./loadAgentsForAttestation.js";
import { loadSubmittedAttestationsByPrisma } from "./loadSubmittedAttestationsByPrisma.js";
import { loadUsageRecordsForReputation } from "./loadUsageRecordsForReputation.js";
import { persistAttestationCursor } from "./persistAttestationCursor.js";
import { persistAttestationIntent } from "./persistAttestationIntent.js";
import { persistAttestationMirrorFailed } from "./persistAttestationMirrorFailed.js";
import { prepareOnChainAttestation } from "./prepareOnChainAttestation.js";
import { readAgentReputationFromChain } from "./readAgentReputationFromChain.js";
import type {
  AttestationAggregate,
  AttestationTickDeps,
  CumulativeReputationReadback,
} from "./runAttestationTick.js";

const DEFAULT_INITIAL_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_CONFIRM_TIMEOUT_MS = 8_000;
const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SUBMITTED_MIRROR_LIMIT = 100;

type PrismaSurface = Pick<
  PrismaClient,
  "agentToken" | "agent" | "usageRecord" | "onChainAttestation" | "$transaction"
>;

export interface BuildAttestationTickDepsInput {
  prisma: PrismaSurface;
  connection: Pick<
    Connection,
    | "getLatestBlockhash"
    | "sendRawTransaction"
    | "getSignatureStatuses"
    | "getBlockHeight"
    | "getAccountInfo"
  >;
  /** Platform attestor keypair; must be in the on-chain whitelist. */
  attestorKeypair: Keypair;
  /** Override the first-time lookback window (default 6h). */
  initialLookbackMs?: number;
  /** Same-tick confirmation budget (default 8s; <=0 = single check). */
  confirmTimeoutMs?: number;
  confirmPollIntervalMs?: number;
  /** Wall-clock provider (overridable in tests) — stamps observedAt. */
  now?: () => Date;
}

export function buildAttestationTickDeps(
  input: BuildAttestationTickDepsInput,
): AttestationTickDeps {
  const attestorAddress = input.attestorKeypair.publicKey.toBase58();
  const lookbackMs = input.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS;
  const now = input.now ?? (() => new Date());

  const getSignatureStatus = async (txSignature: string) => {
    const response = await input.connection.getSignatureStatuses(
      [txSignature],
      { searchTransactionHistory: true },
    );
    const value = response.value[0];
    if (!value) return null;
    return {
      confirmationStatus: value.confirmationStatus ?? null,
      err: value.err,
    };
  };

  return {
    attestorAddress,

    // ---------- phase 0: recovery ----------

    loadSubmittedMirrors: ({ now: tickNow }) =>
      loadSubmittedAttestationsByPrisma(
        { now: tickNow, limit: DEFAULT_SUBMITTED_MIRROR_LIMIT },
        { prisma: input.prisma as never },
      ),

    getCurrentBlockHeight: async () =>
      BigInt(await input.connection.getBlockHeight("confirmed")),

    getSignatureStatus,

    broadcast: async (signedTxB64: string) => {
      const raw = new Uint8Array(Buffer.from(signedTxB64, "base64"));
      await input.connection.sendRawTransaction(raw);
    },

    // ---------- phase 1: attest ----------

    loadAgents: ({ now: tickNow }) =>
      loadAgentsForAttestation(
        { now: tickNow },
        { prisma: input.prisma as never },
      ) as Promise<AttestableAgentLoadedRow[]> as never,

    aggregate: async (
      row,
      { now: tickNow },
    ): Promise<AttestationAggregate | null> => {
      const loaded = row as AttestableAgentLoadedRow;
      const periodStart =
        loaded.lastOnChainAttestationAt ??
        new Date(tickNow.getTime() - lookbackMs);
      const periodEnd = tickNow;
      if (periodEnd.getTime() <= periodStart.getTime()) return null;

      const records = await loadUsageRecordsForReputation(
        {
          agentId: loaded.agentId,
          orgId: loaded.orgId,
          periodStart,
          periodEnd,
        },
        { prisma: input.prisma as never },
      );

      // computeSeconds is a BigInt; sum into BigInt first then expose as
      // BigInt for the on-chain u64. The reputation-score helper wants
      // a Number; floor the BigInt for that conversion.
      let uptimeBig = BigInt(0);
      let totalRequests = 0;
      let errorCount = 0;
      for (const r of records) {
        uptimeBig += r.computeSeconds;
        totalRequests += r.requestCount;
        errorCount += r.errorCount;
      }

      const periodSeconds = Math.max(
        1,
        Math.floor((periodEnd.getTime() - periodStart.getTime()) / 1000),
      );
      const uptimeForScore = Number(uptimeBig);
      const rawScore = computeReputationScore({
        totalRequestCount: totalRequests,
        errorCount,
        uptimeSeconds: uptimeForScore,
        periodSeconds,
      });
      const score = Math.max(0, Math.min(100, Math.round(rawScore)));

      return {
        uptimeSecondsDelta: uptimeBig,
        messageCountDelta: BigInt(totalRequests),
        score,
        periodEnd,
      };
    },

    prepare: (row, aggregate) => {
      const loaded = row as AttestableAgentLoadedRow;
      return prepareOnChainAttestation(
        {
          mint: new PublicKey(loaded.mintAddress),
          attestor: input.attestorKeypair.publicKey,
          uptimeSecondsDelta: aggregate.uptimeSecondsDelta,
          messageCountDelta: aggregate.messageCountDelta,
          score: aggregate.score,
          unixTs: BigInt(Math.floor(aggregate.periodEnd.getTime() / 1000)),
        },
        {
          attestorKeypair: input.attestorKeypair,
          fetchLatestBlockhash: async () => {
            const r = await input.connection.getLatestBlockhash("confirmed");
            return {
              blockhash: r.blockhash,
              lastValidBlockHeight: r.lastValidBlockHeight,
            };
          },
        },
      );
    },

    persistIntent: (row, aggregate, artifact, attestor) => {
      const loaded = row as AttestableAgentLoadedRow;
      return persistAttestationIntent(
        {
          tokenId: loaded.tokenId,
          attestorAddress: attestor,
          uptimeSecondsDelta: aggregate.uptimeSecondsDelta,
          messageCountDelta: aggregate.messageCountDelta,
          score: aggregate.score,
          attestorUnixTs: BigInt(
            Math.floor(aggregate.periodEnd.getTime() / 1000),
          ),
          artifact,
        },
        { prisma: input.prisma as never },
      );
    },

    confirmSignature: (txSignature) =>
      awaitSignatureConfirmation(txSignature, {
        getSignatureStatus,
        timeoutMs: input.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
        pollIntervalMs:
          input.confirmPollIntervalMs ?? DEFAULT_CONFIRM_POLL_INTERVAL_MS,
      }),

    // ---------- shared ----------

    readCumulatives: async (
      mintAddress,
    ): Promise<CumulativeReputationReadback | null> => {
      const onChain = await readAgentReputationFromChain(
        { mint: new PublicKey(mintAddress) },
        { connection: input.connection },
      );
      if (!onChain) return null;
      return {
        cumulativeUptimeSeconds: onChain.cumulativeUptimeSeconds,
        cumulativeMessageCount: onChain.cumulativeMessageCount,
        attestationCount: onChain.attestationCount,
      };
    },

    persistMirrorConfirmed: ({ mirrorId, tokenId, cursor, cumulatives }) =>
      persistAttestationCursor(
        {
          mirrorId,
          tokenId,
          cursor,
          observedAt: now(),
          cumulatives,
        },
        { prisma: input.prisma as never },
      ),

    persistMirrorFailed: (mirrorId) =>
      persistAttestationMirrorFailed(mirrorId, {
        prisma: input.prisma as never,
      }),
  };
}
