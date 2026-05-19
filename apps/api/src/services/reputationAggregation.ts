/**
 * Reputation period aggregation (plan A4 — issuer side).
 *
 * Closes the loop on the off-chain attestation lifecycle. Two pure pieces:
 *
 *   computeReputationScore({totalRequestCount, errorCount, uptimeSeconds, periodSeconds})
 *     → number in [0, 100]
 *
 *   aggregateReputationPeriod({...})
 *     → ReputationAttestationInput (fed straight into buildReputationAttestation)
 *
 * Score policy (pinned by tests):
 *   - 50 points for uptime ratio (uptime / period, clamped 0..1)
 *   - 25 points for request volume (saturates at 1k requests)
 *   - 25 points for error-free ratio (1 - errors/requests, only when there
 *     are requests; otherwise this dimension is skipped)
 *
 * Net: a never-deployed, never-used agent scores 0; a stable agent with
 * mild traffic scores ~50; a high-volume error-free agent scores 100.
 */

import type { ReputationAttestationInput } from "./reputationAttestation.js";

const UPTIME_WEIGHT = 50;
const REQUEST_VOLUME_WEIGHT = 25;
const REQUEST_VOLUME_SATURATION = 1000;
const ERROR_FREE_WEIGHT = 25;

// ============================================
// computeReputationScore
// ============================================

export interface ComputeScoreInput {
  totalRequestCount: number;
  errorCount: number;
  uptimeSeconds: number;
  periodSeconds: number;
}

export function computeReputationScore(input: ComputeScoreInput): number {
  if (input.periodSeconds <= 0) {
    throw new Error(
      `computeReputationScore: periodSeconds must be positive, got ${input.periodSeconds}`,
    );
  }

  const uptimeRatio = Math.min(
    1,
    Math.max(0, input.uptimeSeconds / input.periodSeconds),
  );
  const uptimeScore = uptimeRatio * UPTIME_WEIGHT;

  const volumeRatio = Math.min(
    1,
    Math.max(0, input.totalRequestCount / REQUEST_VOLUME_SATURATION),
  );
  const volumeScore = volumeRatio * REQUEST_VOLUME_WEIGHT;

  // Error-free dimension only contributes when we have a denominator.
  // Without requests, we have no signal to credit or debit the agent.
  let errorScore = 0;
  if (input.totalRequestCount > 0) {
    const errorRatio = Math.min(
      1,
      Math.max(0, input.errorCount / input.totalRequestCount),
    );
    errorScore = (1 - errorRatio) * ERROR_FREE_WEIGHT;
  }

  const total = uptimeScore + volumeScore + errorScore;
  return Math.max(0, Math.min(100, total));
}

// ============================================
// aggregateReputationPeriod
// ============================================

export interface UsageRecordForAggregation {
  periodStart: Date;
  periodEnd: Date;
  requestCount: number;
  errorCount: number;
  computeSeconds: bigint;
}

export interface AggregateReputationPeriodInput {
  agentId: string;
  agentSlug: string;
  periodStart: Date;
  periodEnd: Date;
  usageRecords: UsageRecordForAggregation[];
  uptimeSeconds: number;
  attesterPubkey: string;
  issuedAt: Date;
}

export function aggregateReputationPeriod(
  input: AggregateReputationPeriodInput,
): ReputationAttestationInput {
  if (input.periodEnd.getTime() <= input.periodStart.getTime()) {
    throw new Error(
      "aggregateReputationPeriod: periodEnd must be strictly after periodStart",
    );
  }

  const periodMs = input.periodEnd.getTime() - input.periodStart.getTime();
  const periodSeconds = Math.floor(periodMs / 1000);

  // Include records that overlap the period (any non-empty intersection).
  const inWindow = input.usageRecords.filter(
    (r) =>
      r.periodEnd.getTime() > input.periodStart.getTime() &&
      r.periodStart.getTime() < input.periodEnd.getTime(),
  );

  const totalRequestCount = inWindow.reduce(
    (sum, r) => sum + r.requestCount,
    0,
  );
  const errorCount = inWindow.reduce((sum, r) => sum + r.errorCount, 0);

  const reputationScore = computeReputationScore({
    totalRequestCount,
    errorCount,
    uptimeSeconds: input.uptimeSeconds,
    periodSeconds,
  });

  return {
    agentId: input.agentId,
    agentSlug: input.agentSlug,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    uptimeSeconds: input.uptimeSeconds,
    totalRequestCount,
    errorCount,
    reputationScore,
    attesterPubkey: input.attesterPubkey,
    issuedAt: input.issuedAt,
  };
}
