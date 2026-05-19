/**
 * Full dep-wiring for the reputation-attestation BullMQ worker (plan A4).
 *
 * Composes the layer-by-layer pieces:
 *   loadAgentsForAttestation        → loadAgents
 *   aggregate(row, {now})           → reduces UsageRecord rows since the
 *                                      per-agent cursor into (uptimeΔ,
 *                                      msgCountΔ, score, periodEnd)
 *   submitOnChainAttestation        → submit
 *   persistAttestationCursor        → persistCursor
 *
 * The aggregator's job is to translate the existing
 * loadUsageRecordsForReputation + computeReputationScore stack into the
 * on-chain ix shape:
 *
 *   uptimeSecondsDelta  = floor(Σ computeSeconds across records in window)
 *   messageCountDelta   = Σ requestCount across records in window
 *   score (int 0..=100) = round(computeReputationScore(...))
 *   periodEnd           = now (caps the cursor advance target)
 *
 * Window:
 *   periodStart = row.lastOnChainAttestationAt ?? (now - 6h)
 *   periodEnd   = now
 *
 *   The 6h default mirrors the cron interval — first-time agents only
 *   contribute the last 6h, not their lifetime.
 *
 * Skip logic (returns null) when:
 *   - periodEnd <= periodStart (no progress to attest)
 *   - both deltas resolve to zero (covered downstream by runAttestationTick)
 *
 * Caller injects the attestor keypair; this builder doesn't load it
 * from env (separation of concerns: the env wiring belongs in the
 * BullMQ shell).
 */

import type { PrismaClient } from "@prisma/client";
import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";

import { computeReputationScore } from "./reputationAggregation.js";
import {
  loadAgentsForAttestation,
  type AttestableAgentLoadedRow,
} from "./loadAgentsForAttestation.js";
import { loadUsageRecordsForReputation } from "./loadUsageRecordsForReputation.js";
import { persistAttestationCursor } from "./persistAttestationCursor.js";
import {
  submitOnChainAttestation,
  type SubmitOnChainAttestationDeps,
} from "./submitOnChainAttestation.js";
import type {
  AttestationAggregate,
  AttestationSubmitOutcome,
  AttestationTickDeps,
} from "./runAttestationTick.js";

const DEFAULT_INITIAL_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6h

type PrismaSurface = Pick<
  PrismaClient,
  "agentToken" | "agent" | "usageRecord" | "onChainAttestation" | "$transaction"
>;

export interface BuildAttestationTickDepsInput {
  prisma: PrismaSurface;
  connection: Pick<
    Connection,
    "getLatestBlockhash" | "sendRawTransaction"
  >;
  /** Platform attestor keypair; must be in the on-chain whitelist. */
  attestorKeypair: Keypair;
  /** Override the first-time lookback window (default 6h). */
  initialLookbackMs?: number;
}

function buildSubmitDeps(
  input: BuildAttestationTickDepsInput,
): SubmitOnChainAttestationDeps {
  return {
    attestorKeypair: input.attestorKeypair,
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

export function buildAttestationTickDeps(
  input: BuildAttestationTickDepsInput,
): AttestationTickDeps {
  const attestorAddress = input.attestorKeypair.publicKey.toBase58();
  const lookbackMs = input.initialLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS;

  return {
    attestorAddress,

    loadAgents: ({ now }) =>
      loadAgentsForAttestation(
        { now },
        { prisma: input.prisma as never },
      ) as Promise<AttestableAgentLoadedRow[]> as never,

    aggregate: async (
      row,
      { now },
    ): Promise<AttestationAggregate | null> => {
      const loaded = row as AttestableAgentLoadedRow;
      const periodStart =
        loaded.lastOnChainAttestationAt ??
        new Date(now.getTime() - lookbackMs);
      const periodEnd = now;
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

    submit: async (
      row,
      aggregate,
    ): Promise<AttestationSubmitOutcome> => {
      const loaded = row as AttestableAgentLoadedRow;
      try {
        const result = await submitOnChainAttestation(
          {
            mint: new PublicKey(loaded.mintAddress),
            attestor: input.attestorKeypair.publicKey,
            uptimeSecondsDelta: aggregate.uptimeSecondsDelta,
            messageCountDelta: aggregate.messageCountDelta,
            score: aggregate.score,
            unixTs: BigInt(Math.floor(aggregate.periodEnd.getTime() / 1000)),
          },
          buildSubmitDeps(input),
        );
        // Cumulative values aren't read back from the chain in this MVP;
        // we record the *post-attestation* totals as best-effort using
        // the deltas. A future enhancement: read the on-chain
        // AgentReputation account after submit and record its values.
        return {
          ok: true,
          txSignature: result.txSignature,
          // Caller (persistCursor) doesn't read these in the MVP — the
          // real totals are on-chain and the mirror is best-effort
          // post-state. Wire it through anyway so the worker can
          // upgrade to read-after-write without a signature change.
          cumulativeUptimeSeconds: aggregate.uptimeSecondsDelta,
          cumulativeMessageCount: aggregate.messageCountDelta,
          attestationCount: 0,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    },

    persistCursor: async (
      row,
      aggregate,
      outcome,
      attestor,
    ) => {
      const loaded = row as AttestableAgentLoadedRow;
      const unixTs = BigInt(
        Math.floor(aggregate.periodEnd.getTime() / 1000),
      );
      await persistAttestationCursor(
        {
          tokenId: loaded.tokenId,
          cursor: aggregate.periodEnd,
          mirror: {
            tokenId: loaded.tokenId,
            txSignature: outcome.txSignature,
            attestorAddress: attestor,
            uptimeSecondsDelta: aggregate.uptimeSecondsDelta,
            messageCountDelta: aggregate.messageCountDelta,
            score: aggregate.score,
            cumulativeUptimeSeconds: outcome.cumulativeUptimeSeconds,
            cumulativeMessageCount: outcome.cumulativeMessageCount,
            attestationCount: outcome.attestationCount,
            attestorUnixTs: unixTs,
          },
        },
        { prisma: input.prisma as never },
      );
    },
  };
}
