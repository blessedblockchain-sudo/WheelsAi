/**
 * Drives apps/api/src/services/buildSignatureFateDeps.ts, the binding of
 * services/signatureFate.ts to a Connection and the settings.
 *
 * Pinning, against a stand-in connection (no network):
 *   - connection.getEpochInfo("finalized")           → getFinalizedPosition
 *   - connection.getSignatureStatuses([sig],
 *       { searchTransactionHistory: true })          → getSignatureStatus
 *   - connection.isBlockhashValid(blockhash,
 *       { commitment: "finalized" })                 → isBlockhashValid
 *   - the margin is env.CHAIN_EXPIRY_MARGIN_BLOCKS unless one is given
 *   - the answers are mapped correctly, and an RPC error passes through
 *     as a throw (the core turns it into "unknown")
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { env } from "../config/env.js";
import { buildSignatureFateDeps } from "../services/buildSignatureFateDeps.js";
import { signatureFate } from "../services/signatureFate.js";

const SIG = "5".repeat(88);
const BLOCKHASH = "9".repeat(44);

type Call = { method: string; args: unknown[] };

function makeConnection(opts: {
  epochInfo?: unknown;
  statuses?: unknown;
  blockhash?: unknown;
  fail?: "getEpochInfo" | "getSignatureStatuses" | "isBlockhashValid";
}) {
  const calls: Call[] = [];
  const answer = (method: Call["method"], args: unknown[], value: unknown) => {
    calls.push({ method, args });
    if (opts.fail === method) throw new Error(`${method} failed`);
    return value;
  };
  const connection = {
    async getEpochInfo(...args: unknown[]) {
      return answer(
        "getEpochInfo",
        args,
        opts.epochInfo ?? {
          epoch: 700,
          slotIndex: 10,
          slotsInEpoch: 432_000,
          absoluteSlot: 5_000,
          blockHeight: 2_000,
        },
      );
    },
    async getSignatureStatuses(...args: unknown[]) {
      return answer(
        "getSignatureStatuses",
        args,
        opts.statuses ?? { context: { slot: 5_010 }, value: [null] },
      );
    },
    async isBlockhashValid(...args: unknown[]) {
      return answer(
        "isBlockhashValid",
        args,
        opts.blockhash ?? { context: { slot: 5_002 }, value: false },
      );
    },
  };
  return { connection: connection as never, calls };
}

test("the margin comes from env.CHAIN_EXPIRY_MARGIN_BLOCKS unless one is given", () => {
  const { connection } = makeConnection({});
  assert.equal(
    buildSignatureFateDeps({ connection }).marginBlocks,
    env.CHAIN_EXPIRY_MARGIN_BLOCKS,
  );
  assert.equal(
    buildSignatureFateDeps({ connection, marginBlocks: 7 }).marginBlocks,
    7,
  );
  assert.equal(
    buildSignatureFateDeps({ connection, marginBlocks: 0 }).marginBlocks,
    0,
  );
});

test("getFinalizedPosition is one getEpochInfo call at finalized", async () => {
  const { connection, calls } = makeConnection({});
  const deps = buildSignatureFateDeps({ connection });
  assert.deepEqual(await deps.getFinalizedPosition(), {
    slot: 5_000,
    blockHeight: 2_000,
  });
  assert.deepEqual(calls, [{ method: "getEpochInfo", args: ["finalized"] }]);
});

test("getFinalizedPosition throws when the node reports no block height", async () => {
  const { connection } = makeConnection({
    epochInfo: { epoch: 1, slotIndex: 1, slotsInEpoch: 1, absoluteSlot: 5_000 },
  });
  const deps = buildSignatureFateDeps({ connection });
  await assert.rejects(deps.getFinalizedPosition(), /no blockHeight/);
});

test("getSignatureStatus asks for the one signature with the full history search", async () => {
  const { connection, calls } = makeConnection({});
  const deps = buildSignatureFateDeps({ connection });
  assert.deepEqual(await deps.getSignatureStatus(SIG), {
    status: null,
    contextSlot: 5_010,
  });
  assert.deepEqual(calls, [
    {
      method: "getSignatureStatuses",
      args: [[SIG], { searchTransactionHistory: true }],
    },
  ]);
});

test("getSignatureStatus throws when the answer has no entry for the signature", async () => {
  // Only an explicit null means absent. An empty or oversized list is a
  // broken answer and must not read as "the node has no record".
  for (const value of [[], [null, null], [undefined], undefined]) {
    const { connection } = makeConnection({
      statuses: { context: { slot: 5_010 }, value },
    });
    const deps = buildSignatureFateDeps({ connection, marginBlocks: 32 });
    await assert.rejects(deps.getSignatureStatus(SIG), /no entry/);
    const answer = await signatureFate(
      { signature: SIG, lastValidBlockHeight: 1n },
      deps,
    );
    assert.equal(answer.fate, "unknown");
    assert.equal(answer.reason, "status_read_failed");
  }
});

test("getSignatureStatus maps a present status and its context slot", async () => {
  const err = { InstructionError: [0, { Custom: 1 }] };
  const { connection } = makeConnection({
    statuses: {
      context: { slot: 5_020 },
      value: [
        { slot: 4_990, confirmations: 3, err, confirmationStatus: "confirmed" },
      ],
    },
  });
  const deps = buildSignatureFateDeps({ connection });
  assert.deepEqual(await deps.getSignatureStatus(SIG), {
    status: { confirmationStatus: "confirmed", err, slot: 4_990 },
    contextSlot: 5_020,
  });
});

test("getSignatureStatus: no level given is finalized only when rooted", async () => {
  const mk = (confirmations: number | null | undefined) =>
    buildSignatureFateDeps({
      connection: makeConnection({
        statuses: {
          context: { slot: 5_020 },
          value: [{ slot: 4_990, confirmations, err: null }],
        },
      }).connection,
    });
  // confirmations: null is the RPC's word for rooted.
  assert.equal(
    (await mk(null).getSignatureStatus(SIG)).status?.confirmationStatus,
    "finalized",
  );
  assert.equal(
    (await mk(4).getSignatureStatus(SIG)).status?.confirmationStatus,
    null,
  );
  assert.equal(
    (await mk(undefined).getSignatureStatus(SIG)).status?.confirmationStatus,
    null,
  );
});

test("getSignatureStatus: a missing err is null, and processed stays processed", async () => {
  const { connection } = makeConnection({
    statuses: {
      context: { slot: 5_020 },
      value: [{ slot: 5_019, confirmations: 0, confirmationStatus: "processed" }],
    },
  });
  const deps = buildSignatureFateDeps({ connection });
  assert.deepEqual(await deps.getSignatureStatus(SIG), {
    status: { confirmationStatus: "processed", err: null, slot: 5_019 },
    contextSlot: 5_020,
  });
});

test("isBlockhashValid asks at finalized and maps the value and the slot", async () => {
  const { connection, calls } = makeConnection({
    blockhash: { context: { slot: 5_003 }, value: true },
  });
  const deps = buildSignatureFateDeps({ connection });
  assert.ok(deps.isBlockhashValid);
  assert.deepEqual(await deps.isBlockhashValid(BLOCKHASH), {
    valid: true,
    contextSlot: 5_003,
  });
  assert.deepEqual(calls, [
    {
      method: "isBlockhashValid",
      args: [BLOCKHASH, { commitment: "finalized" }],
    },
  ]);
});

test("an RPC error passes through each dependency as a throw", async () => {
  for (const fail of [
    "getEpochInfo",
    "getSignatureStatuses",
    "isBlockhashValid",
  ] as const) {
    const deps = buildSignatureFateDeps({
      connection: makeConnection({ fail }).connection,
    });
    const run =
      fail === "getEpochInfo"
        ? deps.getFinalizedPosition()
        : fail === "getSignatureStatuses"
          ? deps.getSignatureStatus(SIG)
          : deps.isBlockhashValid!(BLOCKHASH);
    await assert.rejects(run, new RegExp(`${fail} failed`));
  }
});

// The core and the binding together, still against the stand-in.

test("end to end: the three calls in order, and a dead answer", async () => {
  const { connection, calls } = makeConnection({
    epochInfo: { absoluteSlot: 5_000, blockHeight: 2_000 },
    statuses: { context: { slot: 5_010 }, value: [null] },
    blockhash: { context: { slot: 5_002 }, value: false },
  });
  const deps = buildSignatureFateDeps({ connection, marginBlocks: 32 });

  const byHeight = await signatureFate(
    { signature: SIG, lastValidBlockHeight: 1_967n },
    deps,
  );
  assert.equal(byHeight.fate, "dead");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["getEpochInfo", "getSignatureStatuses"],
  );

  calls.length = 0;
  const byBlockhash = await signatureFate(
    { signature: SIG, lastValidBlockHeight: null, blockhash: BLOCKHASH },
    deps,
  );
  assert.equal(byBlockhash.fate, "dead");
  assert.deepEqual(
    calls.map((c) => c.method),
    ["getEpochInfo", "getSignatureStatuses", "isBlockhashValid"],
  );
});

test("end to end: one block short of the margin is in_flight", async () => {
  const { connection } = makeConnection({
    epochInfo: { absoluteSlot: 5_000, blockHeight: 2_000 },
  });
  const deps = buildSignatureFateDeps({ connection, marginBlocks: 32 });
  const answer = await signatureFate(
    { signature: SIG, lastValidBlockHeight: 1_968n },
    deps,
  );
  assert.equal(answer.fate, "in_flight");
});

test("end to end: an RPC error at any call is unknown", async () => {
  for (const fail of [
    "getEpochInfo",
    "getSignatureStatuses",
    "isBlockhashValid",
  ] as const) {
    const deps = buildSignatureFateDeps({
      connection: makeConnection({ fail }).connection,
      marginBlocks: 32,
    });
    const answer = await signatureFate(
      { signature: SIG, lastValidBlockHeight: null, blockhash: BLOCKHASH },
      deps,
    );
    assert.equal(answer.fate, "unknown", fail);
  }
});
