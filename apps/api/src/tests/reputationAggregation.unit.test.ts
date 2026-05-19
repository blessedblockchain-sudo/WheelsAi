import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

// Drives apps/api/src/services/reputationAggregation.ts — closes A4's
// issuer loop. Two pure pieces:
//
//   computeReputationScore({totalRequestCount, errorCount, uptimeSeconds, periodSeconds})
//     → number in [0, 100]
//
//   aggregateReputationPeriod({agentId, agentSlug, periodStart, periodEnd,
//                              usageRecords, uptimeSeconds, attesterPubkey, issuedAt})
//     → ReputationAttestationInput  (fed straight into buildReputationAttestation)
//
// Reputation score policy (encoded in tests):
//   - Baseline 0, scale to 100 across three weighted dimensions
//   - Uptime ratio (uptime / period)        → up to 50 points
//   - Request volume (saturates at 1k)      → up to 25 points
//   - Error rate (1 - errors/requests)      → up to 25 points
//   - No requests → no error contribution; score reflects uptime only
//   - Always clamped to [0, 100]

const PERIOD_START = new Date("2026-04-26T12:00:00Z");
const PERIOD_END = new Date("2026-04-27T12:00:00Z"); // 24h
const PERIOD_SECONDS = 86_400;

// ============================================
// computeReputationScore — pinned formula
// ============================================

test("computeReputationScore returns 100 for an agent with full uptime, 1k+ requests, zero errors", async () => {
  setupEnv();
  const { computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  const score = computeReputationScore({
    totalRequestCount: 5000,
    errorCount: 0,
    uptimeSeconds: PERIOD_SECONDS,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.equal(score, 100);
});

test("computeReputationScore returns ~50 for full uptime + zero requests (uptime alone)", async () => {
  // No requests means no error-rate signal — the score reflects uptime only.
  // 50 is our cap for the uptime dimension.
  const { computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  const score = computeReputationScore({
    totalRequestCount: 0,
    errorCount: 0,
    uptimeSeconds: PERIOD_SECONDS,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.equal(score, 50);
});

test("computeReputationScore returns 0 for zero uptime + zero requests", async () => {
  const { computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  const score = computeReputationScore({
    totalRequestCount: 0,
    errorCount: 0,
    uptimeSeconds: 0,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.equal(score, 0);
});

test("computeReputationScore drops error contribution to 0 when every request errored", async () => {
  // Full uptime (50) + full request volume (25) + 0 from errors = 75.
  const { computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  const score = computeReputationScore({
    totalRequestCount: 5000,
    errorCount: 5000,
    uptimeSeconds: PERIOD_SECONDS,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.equal(score, 75);
});

test("computeReputationScore is clamped to [0, 100] even on weird inputs", async () => {
  const { computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  // Uptime > period (clock drift) shouldn't drive score over 100.
  const a = computeReputationScore({
    totalRequestCount: 1_000_000,
    errorCount: 0,
    uptimeSeconds: PERIOD_SECONDS * 2,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.equal(a, 100);

  // errorCount > requestCount (data corruption) → error ratio capped at 1.
  const b = computeReputationScore({
    totalRequestCount: 100,
    errorCount: 9999,
    uptimeSeconds: PERIOD_SECONDS,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.ok(b >= 0 && b <= 100, `expected score in [0,100], got ${b}`);
});

test("computeReputationScore weights request volume linearly to 1k then saturates", async () => {
  const { computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  // Half-saturation @ 500 requests with 0 errors:
  //   uptime(0) + volume(500/1k * 25 = 12.5) + errorFree(25) = 37.5
  const halfVolume = computeReputationScore({
    totalRequestCount: 500,
    errorCount: 0,
    uptimeSeconds: 0,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.ok(
    Math.abs(halfVolume - 37.5) < 0.6,
    `expected ~37.5 (12.5 volume + 25 error-free), got ${halfVolume}`,
  );

  // 1k+ requests, all errors → only the volume dimension contributes:
  //   uptime(0) + volume(25 saturated) + errorFree(0) = 25
  const fullVolumeAllErrors = computeReputationScore({
    totalRequestCount: 100_000,
    errorCount: 100_000,
    uptimeSeconds: 0,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.equal(Math.round(fullVolumeAllErrors), 25);

  // Crossing the 1k saturation point shouldn't keep growing:
  //   1k requests vs 100k requests with same error rate → same score.
  const at1k = computeReputationScore({
    totalRequestCount: 1000,
    errorCount: 0,
    uptimeSeconds: 0,
    periodSeconds: PERIOD_SECONDS,
  });
  const at100k = computeReputationScore({
    totalRequestCount: 100_000,
    errorCount: 0,
    uptimeSeconds: 0,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.equal(at1k, at100k);
});

test("computeReputationScore throws on non-positive periodSeconds (caller bug)", async () => {
  const { computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  for (const v of [0, -1]) {
    assert.throws(
      () =>
        computeReputationScore({
          totalRequestCount: 0,
          errorCount: 0,
          uptimeSeconds: 0,
          periodSeconds: v,
        }),
      /periodSeconds/i,
    );
  }
});

// ============================================
// aggregateReputationPeriod
// ============================================

interface FakeUsageRecord {
  periodStart: Date;
  periodEnd: Date;
  requestCount: number;
  errorCount: number;
  computeSeconds: bigint;
}

function record(start: string, requests: number, errors: number, hours = 1): FakeUsageRecord {
  const startD = new Date(start);
  const endD = new Date(startD.getTime() + hours * 3_600_000);
  return {
    periodStart: startD,
    periodEnd: endD,
    requestCount: requests,
    errorCount: errors,
    computeSeconds: BigInt(hours * 3600),
  };
}

const aggregationInput = (overrides: Partial<any> = {}) => {
  const attester = Keypair.generate();
  return {
    agentId: "agent_1",
    agentSlug: "eliza",
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    usageRecords: [
      record("2026-04-26T13:00:00Z", 100, 1),
      record("2026-04-26T14:00:00Z", 200, 3),
    ],
    uptimeSeconds: PERIOD_SECONDS,
    attesterPubkey: attester.publicKey.toBase58(),
    issuedAt: PERIOD_END,
    ...overrides,
  };
};

test("aggregateReputationPeriod sums request + error counts across UsageRecord rows", async () => {
  const { aggregateReputationPeriod } = await import(
    "../services/reputationAggregation.js"
  );
  const result = aggregateReputationPeriod(aggregationInput());
  assert.equal(result.totalRequestCount, 300);
  assert.equal(result.errorCount, 4);
});

test("aggregateReputationPeriod filters out UsageRecord rows OUTSIDE the period", async () => {
  const { aggregateReputationPeriod } = await import(
    "../services/reputationAggregation.js"
  );
  const result = aggregateReputationPeriod(
    aggregationInput({
      usageRecords: [
        record("2026-04-26T13:00:00Z", 100, 1), // inside
        record("2026-04-25T13:00:00Z", 5000, 9999), // BEFORE periodStart
        record("2026-04-27T13:00:00Z", 5000, 9999), // AFTER periodEnd
      ],
    }),
  );
  assert.equal(result.totalRequestCount, 100);
  assert.equal(result.errorCount, 1);
});

test("aggregateReputationPeriod includes a row that PARTIALLY overlaps the period", async () => {
  // A row whose periodEnd extends past our periodEnd is still relevant —
  // we want every record that touched the window. Caller is responsible
  // for any pro-rata math; the aggregator just sums.
  const { aggregateReputationPeriod } = await import(
    "../services/reputationAggregation.js"
  );
  const partial = record("2026-04-27T11:30:00Z", 50, 0, 2); // 11:30 → 13:30
  const result = aggregateReputationPeriod(
    aggregationInput({ usageRecords: [partial] }),
  );
  assert.equal(result.totalRequestCount, 50);
});

test("aggregateReputationPeriod computes reputationScore using computeReputationScore", async () => {
  const { aggregateReputationPeriod, computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  const result = aggregateReputationPeriod(aggregationInput());
  const expected = computeReputationScore({
    totalRequestCount: 300,
    errorCount: 4,
    uptimeSeconds: PERIOD_SECONDS,
    periodSeconds: PERIOD_SECONDS,
  });
  assert.equal(result.reputationScore, expected);
});

test("aggregateReputationPeriod result is a valid input to buildReputationAttestation", async () => {
  const { aggregateReputationPeriod } = await import(
    "../services/reputationAggregation.js"
  );
  const { buildReputationAttestation } = await import(
    "../services/reputationAttestation.js"
  );
  const aggregated = aggregateReputationPeriod(aggregationInput());
  // Should not throw and should produce a payload.
  const { payload } = buildReputationAttestation(aggregated);
  assert.equal(payload.agentId, "agent_1");
  assert.equal(payload.agentSlug, "eliza");
  assert.equal(payload.totalRequestCount, 300);
  assert.equal(payload.errorCount, 4);
});

test("aggregateReputationPeriod throws when periodEnd <= periodStart (delegated up to builder, but caught earlier here)", async () => {
  const { aggregateReputationPeriod } = await import(
    "../services/reputationAggregation.js"
  );
  assert.throws(
    () =>
      aggregateReputationPeriod({
        ...aggregationInput(),
        periodStart: PERIOD_END,
        periodEnd: PERIOD_START,
      }),
    /period/i,
  );
});

test("aggregateReputationPeriod accepts an empty UsageRecord list (uptime-only attestation)", async () => {
  const { aggregateReputationPeriod, computeReputationScore } = await import(
    "../services/reputationAggregation.js"
  );
  const result = aggregateReputationPeriod(
    aggregationInput({ usageRecords: [] }),
  );
  assert.equal(result.totalRequestCount, 0);
  assert.equal(result.errorCount, 0);
  assert.equal(
    result.reputationScore,
    computeReputationScore({
      totalRequestCount: 0,
      errorCount: 0,
      uptimeSeconds: PERIOD_SECONDS,
      periodSeconds: PERIOD_SECONDS,
    }),
  );
});
