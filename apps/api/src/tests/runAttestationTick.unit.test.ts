/**
 * Drives apps/api/src/services/runAttestationTick.ts — the pure
 * scan-and-dispatch driver for the reputation-attestation worker.
 *
 * Pinning:
 *   - skipped: rows where aggregate returns null or zero deltas don't
 *     spend tx fees and don't advance the cursor
 *   - failed: submit errors are counted, NOT thrown; cursor stays back
 *   - attested: only counted after persistCursor lands successfully
 *   - persist failure AFTER successful submit: throws (BullMQ retries)
 *   - per-row failure isolation: one bad row doesn't halt the batch
 */

import assert from "node:assert/strict";
import test from "node:test";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}

const NOW = new Date("2026-05-14T10:00:00Z");

function row(overrides: Partial<{
  tokenId: string;
  mintAddress: string;
  lastOnChainAttestationAt: Date | null;
}> = {}) {
  return {
    tokenId: "tok_1",
    mintAddress: "MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    lastOnChainAttestationAt: null,
    ...overrides,
  };
}

function aggregate(overrides: Partial<{
  uptimeSecondsDelta: bigint;
  messageCountDelta: bigint;
  score: number;
  periodEnd: Date;
}> = {}) {
  return {
    uptimeSecondsDelta: BigInt(3600),
    messageCountDelta: BigInt(12),
    score: 80,
    periodEnd: NOW,
    ...overrides,
  };
}

test("runAttestationTick: empty rows → all-zero counts", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const r = await runAttestationTick(
    { now: NOW },
    {
      loadAgents: async () => [],
      aggregate: async () => null,
      submit: async () => ({ ok: false, error: "noop" }),
      persistCursor: async () => {},
      attestorAddress: "ATT",
    },
  );
  assert.deepEqual(r, { attested: 0, failed: 0, skipped: 0 });
});

test("runAttestationTick: row with null aggregate → skipped, no submit, no persist", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  let submitCalled = 0;
  let persistCalled = 0;
  const r = await runAttestationTick(
    { now: NOW },
    {
      loadAgents: async () => [row()],
      aggregate: async () => null,
      submit: async () => {
        submitCalled += 1;
        return { ok: false, error: "x" };
      },
      persistCursor: async () => {
        persistCalled += 1;
      },
      attestorAddress: "ATT",
    },
  );
  assert.deepEqual(r, { attested: 0, failed: 0, skipped: 1 });
  assert.equal(submitCalled, 0);
  assert.equal(persistCalled, 0);
});

test("runAttestationTick: zero deltas → skipped (no tx fee for empty period)", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  let submitCalled = 0;
  const r = await runAttestationTick(
    { now: NOW },
    {
      loadAgents: async () => [row()],
      aggregate: async () =>
        aggregate({
          uptimeSecondsDelta: BigInt(0),
          messageCountDelta: BigInt(0),
        }),
      submit: async () => {
        submitCalled += 1;
        return { ok: false, error: "x" };
      },
      persistCursor: async () => {},
      attestorAddress: "ATT",
    },
  );
  assert.deepEqual(r, { attested: 0, failed: 0, skipped: 1 });
  assert.equal(submitCalled, 0);
});

test("runAttestationTick: non-zero uptime only → still submits", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  let submitCalled = 0;
  let persistCalled = 0;
  const r = await runAttestationTick(
    { now: NOW },
    {
      loadAgents: async () => [row()],
      aggregate: async () =>
        aggregate({
          uptimeSecondsDelta: BigInt(60),
          messageCountDelta: BigInt(0),
        }),
      submit: async () => {
        submitCalled += 1;
        return {
          ok: true,
          txSignature: "sig",
          cumulativeUptimeSeconds: BigInt(60),
          cumulativeMessageCount: BigInt(0),
          attestationCount: 1,
        };
      },
      persistCursor: async () => {
        persistCalled += 1;
      },
      attestorAddress: "ATT",
    },
  );
  assert.deepEqual(r, { attested: 1, failed: 0, skipped: 0 });
  assert.equal(submitCalled, 1);
  assert.equal(persistCalled, 1);
});

test("runAttestationTick: submit error → counted as failed; cursor NOT persisted", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  let persistCalled = 0;
  const r = await runAttestationTick(
    { now: NOW },
    {
      loadAgents: async () => [row()],
      aggregate: async () => aggregate(),
      submit: async () => ({ ok: false, error: "rpc_submit: nope" }),
      persistCursor: async () => {
        persistCalled += 1;
      },
      attestorAddress: "ATT",
    },
  );
  assert.deepEqual(r, { attested: 0, failed: 1, skipped: 0 });
  assert.equal(persistCalled, 0);
});

test("runAttestationTick: submit throw → coerced to failed (per-row isolation)", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  let persistCalled = 0;
  const r = await runAttestationTick(
    { now: NOW },
    {
      loadAgents: async () => [row({ tokenId: "a" }), row({ tokenId: "b" })],
      aggregate: async () => aggregate(),
      submit: async (r) => {
        if (r.tokenId === "a") throw new Error("kaboom");
        return {
          ok: true,
          txSignature: "sig_b",
          cumulativeUptimeSeconds: BigInt(60),
          cumulativeMessageCount: BigInt(1),
          attestationCount: 1,
        };
      },
      persistCursor: async () => {
        persistCalled += 1;
      },
      attestorAddress: "ATT",
    },
  );
  assert.deepEqual(r, { attested: 1, failed: 1, skipped: 0 });
  assert.equal(persistCalled, 1);
});

test("runAttestationTick: persistCursor failure AFTER successful submit → throws", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  await assert.rejects(
    () =>
      runAttestationTick(
        { now: NOW },
        {
          loadAgents: async () => [row()],
          aggregate: async () => aggregate(),
          submit: async () => ({
            ok: true,
            txSignature: "sig",
            cumulativeUptimeSeconds: BigInt(3600),
            cumulativeMessageCount: BigInt(12),
            attestationCount: 1,
          }),
          persistCursor: async () => {
            throw new Error("db down");
          },
          attestorAddress: "ATT",
        },
      ),
    /db down/,
  );
});

test("runAttestationTick: persistCursor invoked with attestorAddress + outcome", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  let observedAttestor = "";
  let observedTxSig = "";
  await runAttestationTick(
    { now: NOW },
    {
      loadAgents: async () => [row()],
      aggregate: async () => aggregate(),
      submit: async () => ({
        ok: true,
        txSignature: "sig_xyz",
        cumulativeUptimeSeconds: BigInt(3600),
        cumulativeMessageCount: BigInt(12),
        attestationCount: 5,
      }),
      persistCursor: async (_r, _a, outcome, attestor) => {
        observedAttestor = attestor;
        if (outcome.ok) observedTxSig = outcome.txSignature;
      },
      attestorAddress: "ATT_PUBKEY",
    },
  );
  assert.equal(observedAttestor, "ATT_PUBKEY");
  assert.equal(observedTxSig, "sig_xyz");
});

test("runAttestationTick: processes mixed batch — skipped + failed + attested counts add up", async () => {
  setupEnv();
  const { runAttestationTick } = await import(
    "../services/runAttestationTick.js"
  );
  const r = await runAttestationTick(
    { now: NOW },
    {
      loadAgents: async () => [
        row({ tokenId: "skip" }),
        row({ tokenId: "fail" }),
        row({ tokenId: "ok" }),
      ],
      aggregate: async (rr) =>
        rr.tokenId === "skip"
          ? aggregate({
              uptimeSecondsDelta: BigInt(0),
              messageCountDelta: BigInt(0),
            })
          : aggregate(),
      submit: async (rr) => {
        if (rr.tokenId === "fail") return { ok: false, error: "x" };
        return {
          ok: true,
          txSignature: "sig",
          cumulativeUptimeSeconds: BigInt(60),
          cumulativeMessageCount: BigInt(1),
          attestationCount: 1,
        };
      },
      persistCursor: async () => {},
      attestorAddress: "ATT",
    },
  );
  assert.deepEqual(r, { attested: 1, failed: 1, skipped: 1 });
});
