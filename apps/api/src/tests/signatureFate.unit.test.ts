/**
 * Drives apps/api/src/services/signatureFate.ts, the strict shared answer
 * to "what happened to this signature".
 *
 * Pinning:
 *   - every fate: landed_ok, landed_failed, in_flight, dead, unknown
 *   - the read order: the finalized position FIRST, the status SECOND
 *     (and the blockhash, when asked at all, third)
 *   - dead needs all three of: status absent, the status node at or past
 *     the finalized slot, the finalized height above
 *     lastValidBlockHeight + margin. Each one removed gives in_flight
 *   - a status that is only "processed" is in_flight, error or not
 *   - the blockhash form for a transaction we did not build
 *   - no height and no blockhash is never dead
 *   - any throwing dependency gives unknown; nothing ever throws
 *   - a height given as a bigint and as a number
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeSignatureFate,
  signatureFate,
  type BlockhashValidityReading,
  type FinalizedPosition,
  type SignatureFateDeps,
  type SignatureFateInput,
  type SignatureStatusReading,
} from "../services/signatureFate.js";

const SIG = "5".repeat(88);
const BLOCKHASH = "9".repeat(44);
const MARGIN = 32;
const LAST_VALID = 1_000n;

type Step<T> = T | Error | (() => T);

function resolve<T>(step: Step<T>): T {
  if (step instanceof Error) throw step;
  return typeof step === "function" ? (step as () => T)() : step;
}

/** Stand-in dependencies that record the order they were asked in. */
function makeDeps(opts: {
  finalized?: Step<FinalizedPosition>;
  status?: Step<SignatureStatusReading>;
  blockhash?: Step<BlockhashValidityReading> | "absent";
  marginBlocks?: number;
}) {
  const calls: string[] = [];
  const deps: SignatureFateDeps = {
    marginBlocks: opts.marginBlocks ?? MARGIN,
    getFinalizedPosition: async () => {
      calls.push("finalized");
      return resolve(opts.finalized ?? { slot: 5_000, blockHeight: 2_000 });
    },
    getSignatureStatus: async (signature) => {
      calls.push(`status:${signature}`);
      return resolve(opts.status ?? { status: null, contextSlot: 5_010 });
    },
  };
  if (opts.blockhash !== "absent") {
    const step = opts.blockhash ?? { valid: false, contextSlot: 5_005 };
    deps.isBlockhashValid = async (blockhash) => {
      calls.push(`blockhash:${blockhash}`);
      return resolve(step);
    };
  }
  return { deps, calls };
}

const built: SignatureFateInput = {
  signature: SIG,
  lastValidBlockHeight: LAST_VALID,
};
const notBuilt: SignatureFateInput = {
  signature: SIG,
  lastValidBlockHeight: null,
  blockhash: BLOCKHASH,
};

function landed(
  confirmationStatus: "processed" | "confirmed" | "finalized" | null,
  err: unknown | null = null,
): SignatureStatusReading {
  return {
    status: { confirmationStatus, err, slot: 4_990 },
    contextSlot: 5_010,
  };
}

// ---------------------------------------------------------------- landed

test("landed_ok: no error, confirmed or finalized", async () => {
  for (const level of ["confirmed", "finalized"] as const) {
    const { deps } = makeDeps({ status: landed(level) });
    const answer = await signatureFate(built, deps);
    assert.equal(answer.fate, "landed_ok", level);
    assert.equal(answer.reason, "status_ok");
    assert.equal(answer.error, undefined);
    assert.equal(answer.detail.confirmationStatus, level);
    assert.equal(answer.detail.landedSlot, 4_990n);
  }
});

test("landed_failed: an error, confirmed or finalized, carries the error", async () => {
  const err = { InstructionError: [0, { Custom: 1 }] };
  for (const level of ["confirmed", "finalized"] as const) {
    const { deps } = makeDeps({ status: landed(level, err) });
    const answer = await signatureFate(built, deps);
    assert.equal(answer.fate, "landed_failed", level);
    assert.equal(answer.reason, "status_err");
    assert.equal(answer.error, JSON.stringify(err));
  }
});

test("a landed status wins even when the height is long past", async () => {
  // Expiry says nothing about a transaction the chain already holds.
  const { deps, calls } = makeDeps({
    finalized: { slot: 9_000, blockHeight: 9_000 },
    status: { ...landed("finalized"), contextSlot: 9_010 },
  });
  const answer = await signatureFate(built, deps);
  assert.equal(answer.fate, "landed_ok");
  assert.deepEqual(calls, ["finalized", `status:${SIG}`]);
});

// ------------------------------------------------------------- processed

test("processed-only is in_flight, with or without an error", async () => {
  for (const err of [null, "AccountInUse"]) {
    const { deps } = makeDeps({
      finalized: { slot: 5_000, blockHeight: 9_000 }, // far past expiry
      status: landed("processed", err),
    });
    const answer = await signatureFate(built, deps);
    assert.equal(answer.fate, "in_flight", String(err));
    assert.equal(answer.reason, "status_processed");
  }
});

test("a status with no level given is in_flight, never landed", async () => {
  for (const err of [null, "AccountInUse"]) {
    const { deps } = makeDeps({ status: landed(null, err) });
    const answer = await signatureFate(built, deps);
    assert.equal(answer.fate, "in_flight");
    assert.equal(answer.reason, "status_processed");
  }
});

// ------------------------------------------------------------ read order

test("the finalized position is read first, the status second", async () => {
  const { deps, calls } = makeDeps({
    finalized: { slot: 5_000, blockHeight: 2_000 },
  });
  await signatureFate(built, deps);
  assert.deepEqual(calls, ["finalized", `status:${SIG}`]);
});

test("the read order holds for every status", async () => {
  const statuses: SignatureStatusReading[] = [
    landed("processed"),
    landed("confirmed"),
    landed("finalized", "boom"),
    { status: null, contextSlot: 5_010 },
  ];
  for (const status of statuses) {
    const { deps, calls } = makeDeps({ status });
    await signatureFate(built, deps);
    assert.equal(calls[0], "finalized");
    assert.equal(calls[1], `status:${SIG}`);
    assert.equal(calls.length, 2, "a known height never asks the blockhash");
  }
});

test("the status is not read before the finalized read has answered", async () => {
  let finalizedDone = false;
  let statusSawFinalizedDone: boolean | null = null;
  const deps: SignatureFateDeps = {
    marginBlocks: MARGIN,
    getFinalizedPosition: async () => {
      await new Promise((r) => setImmediate(r));
      finalizedDone = true;
      return { slot: 5_000, blockHeight: 2_000 };
    },
    getSignatureStatus: async () => {
      statusSawFinalizedDone = finalizedDone;
      return { status: null, contextSlot: 5_010 };
    },
  };
  await signatureFate(built, deps);
  assert.equal(statusSawFinalizedDone, true);
});

// ------------------------------------------------------------------ dead

test("dead: absent, status node at or past finalized, height past the margin", async () => {
  const { deps } = makeDeps({
    finalized: { slot: 5_000, blockHeight: 1_033 }, // 1000 + 32 + 1
    status: { status: null, contextSlot: 5_000 }, // exactly at the slot
  });
  const answer = await signatureFate(built, deps);
  assert.equal(answer.fate, "dead");
  assert.equal(answer.reason, "absent_expired_by_height");
  assert.deepEqual(answer.detail, {
    finalizedSlot: 5_000n,
    finalizedBlockHeight: 1_033n,
    lastValidBlockHeight: 1_000n,
    marginBlocks: 32,
    statusContextSlot: 5_000n,
    confirmationStatus: null,
    landedSlot: null,
    blockhashValid: null,
    blockhashContextSlot: null,
  });
});

test("dead condition 1 removed: a status is present, so it is not dead", async () => {
  const { deps } = makeDeps({
    finalized: { slot: 5_000, blockHeight: 1_033 },
    status: { ...landed("processed"), contextSlot: 5_000 },
  });
  const answer = await signatureFate(built, deps);
  assert.equal(answer.fate, "in_flight");
});

test("dead condition 2 removed: the status node is behind the finalized slot", async () => {
  const { deps } = makeDeps({
    finalized: { slot: 5_000, blockHeight: 1_033 },
    status: { status: null, contextSlot: 4_999 },
  });
  const answer = await signatureFate(built, deps);
  assert.equal(answer.fate, "in_flight");
  assert.equal(answer.reason, "absent_status_node_behind");
});

test("dead condition 3 removed: the height is at the margin, not above it", async () => {
  for (const blockHeight of [900, 1_000, 1_001, 1_032]) {
    const { deps } = makeDeps({
      finalized: { slot: 5_000, blockHeight },
      status: { status: null, contextSlot: 5_000 },
    });
    const answer = await signatureFate(built, deps);
    assert.equal(answer.fate, "in_flight", String(blockHeight));
    assert.equal(answer.reason, "absent_within_window");
  }
});

test("the margin is what is added: zero margin dies one block past", async () => {
  const at = makeDeps({
    marginBlocks: 0,
    finalized: { slot: 5_000, blockHeight: 1_000 },
  });
  assert.equal((await signatureFate(built, at.deps)).fate, "in_flight");
  const past = makeDeps({
    marginBlocks: 0,
    finalized: { slot: 5_000, blockHeight: 1_001 },
  });
  assert.equal((await signatureFate(built, past.deps)).fate, "dead");
});

test("a height given as a bigint and as a number gives the same answer", async () => {
  for (const lastValidBlockHeight of [1_000n, 1_000]) {
    for (const [blockHeight, fate] of [
      [1_032, "in_flight"],
      [1_033, "dead"],
    ] as const) {
      // The dependency may answer in either type too.
      for (const asBigint of [false, true]) {
        const { deps } = makeDeps({
          finalized: asBigint
            ? { slot: 5_000n, blockHeight: BigInt(blockHeight) }
            : { slot: 5_000, blockHeight },
          status: {
            status: null,
            contextSlot: asBigint ? 5_010n : 5_010,
          },
        });
        const answer = await signatureFate(
          { signature: SIG, lastValidBlockHeight },
          deps,
        );
        assert.equal(answer.fate, fate);
        assert.equal(answer.detail.lastValidBlockHeight, 1_000n);
      }
    }
  }
});

test("a height above what a number holds exactly is still compared exactly", async () => {
  const lastValidBlockHeight = 2n ** 60n;
  const mk = (extra: bigint) =>
    makeDeps({
      finalized: {
        slot: 2n ** 61n,
        blockHeight: lastValidBlockHeight + BigInt(MARGIN) + extra,
      },
      status: { status: null, contextSlot: 2n ** 61n },
    }).deps;
  const input = { signature: SIG, lastValidBlockHeight };
  assert.equal((await signatureFate(input, mk(0n))).fate, "in_flight");
  assert.equal((await signatureFate(input, mk(1n))).fate, "dead");
});

test("a known height decides alone: the blockhash is never asked", async () => {
  const { deps, calls } = makeDeps({
    finalized: { slot: 5_000, blockHeight: 1_010 }, // inside the window
    blockhash: { valid: false, contextSlot: 5_005 },
  });
  const answer = await signatureFate({ ...built, blockhash: BLOCKHASH }, deps);
  assert.equal(answer.fate, "in_flight");
  assert.deepEqual(calls, ["finalized", `status:${SIG}`]);
});

// -------------------------------------------------------- blockhash form

test("blockhash form: absent and the blockhash no longer valid is dead", async () => {
  const { deps, calls } = makeDeps({
    finalized: { slot: 5_000, blockHeight: 2_000 },
    status: { status: null, contextSlot: 5_010 },
    blockhash: { valid: false, contextSlot: 5_000 },
  });
  const answer = await signatureFate(notBuilt, deps);
  assert.equal(answer.fate, "dead");
  assert.equal(answer.reason, "absent_expired_by_blockhash");
  assert.equal(answer.detail.blockhashValid, false);
  assert.equal(answer.detail.blockhashContextSlot, 5_000n);
  assert.deepEqual(calls, [
    "finalized",
    `status:${SIG}`,
    `blockhash:${BLOCKHASH}`,
  ]);
});

test("blockhash form: still valid is in_flight", async () => {
  const { deps } = makeDeps({ blockhash: { valid: true, contextSlot: 5_005 } });
  const answer = await signatureFate(notBuilt, deps);
  assert.equal(answer.fate, "in_flight");
  assert.equal(answer.reason, "absent_blockhash_still_valid");
});

test("blockhash form: an answer from behind the finalized slot proves nothing", async () => {
  const { deps } = makeDeps({
    blockhash: { valid: false, contextSlot: 4_999 },
  });
  const answer = await signatureFate(notBuilt, deps);
  assert.equal(answer.fate, "in_flight");
  assert.equal(answer.reason, "absent_blockhash_read_behind");
});

test("blockhash form: an answer from past the status node proves nothing", async () => {
  // It could have landed between the status read and the expiry.
  const { deps } = makeDeps({
    status: { status: null, contextSlot: 5_010 },
    blockhash: { valid: false, contextSlot: 5_011 },
  });
  const answer = await signatureFate(notBuilt, deps);
  assert.equal(answer.fate, "in_flight");
  assert.equal(answer.reason, "absent_blockhash_read_ahead_of_status");
});

test("blockhash form: the status node behind the finalized slot is in_flight, blockhash unasked", async () => {
  const { deps, calls } = makeDeps({
    status: { status: null, contextSlot: 4_999 },
  });
  const answer = await signatureFate(notBuilt, deps);
  assert.equal(answer.fate, "in_flight");
  assert.equal(answer.reason, "absent_status_node_behind");
  assert.deepEqual(calls, ["finalized", `status:${SIG}`]);
});

test("blockhash form: a present status is settled without asking the blockhash", async () => {
  const { deps, calls } = makeDeps({ status: landed("confirmed") });
  assert.equal((await signatureFate(notBuilt, deps)).fate, "landed_ok");
  assert.deepEqual(calls, ["finalized", `status:${SIG}`]);
});

// ------------------------------------------------------------ never dead

test("no height and no blockhash is never dead, however far the chain has moved", async () => {
  for (const blockhash of [undefined, null, ""]) {
    const { deps, calls } = makeDeps({
      finalized: { slot: 9_000_000, blockHeight: 9_000_000 },
      status: { status: null, contextSlot: 9_000_010 },
    });
    const answer = await signatureFate(
      { signature: SIG, lastValidBlockHeight: null, blockhash },
      deps,
    );
    assert.equal(answer.fate, "in_flight");
    assert.equal(answer.reason, "absent_no_expiry_proof");
    assert.deepEqual(calls, ["finalized", `status:${SIG}`]);
  }
});

test("a blockhash with no way to ask about it is never dead", async () => {
  const { deps } = makeDeps({ blockhash: "absent" });
  const answer = await signatureFate(notBuilt, deps);
  assert.equal(answer.fate, "in_flight");
  assert.equal(answer.reason, "absent_no_expiry_proof");
});

test("a height that is not a whole number is treated as no height", async () => {
  for (const bad of [-1, 1.5, Number.NaN, -1n]) {
    const { deps } = makeDeps({
      finalized: { slot: 9_000, blockHeight: 9_000 },
      status: { status: null, contextSlot: 9_010 },
    });
    const answer = await signatureFate(
      { signature: SIG, lastValidBlockHeight: bad },
      deps,
    );
    assert.equal(answer.fate, "in_flight", String(bad));
    assert.equal(answer.reason, "absent_no_expiry_proof");
  }
});

// --------------------------------------------------------------- unknown

test("a throwing finalized read is unknown, and the status is not read", async () => {
  const { deps, calls } = makeDeps({ finalized: new Error("rpc down") });
  const answer = await signatureFate(built, deps);
  assert.equal(answer.fate, "unknown");
  assert.equal(answer.reason, "finalized_read_failed");
  assert.equal(answer.error, "rpc down");
  assert.deepEqual(calls, ["finalized"]);
});

test("a throwing status read is unknown, even past the expiry", async () => {
  const { deps } = makeDeps({
    finalized: { slot: 5_000, blockHeight: 9_000 },
    status: new Error("429"),
  });
  const answer = await signatureFate(built, deps);
  assert.equal(answer.fate, "unknown");
  assert.equal(answer.reason, "status_read_failed");
  assert.equal(answer.detail.finalizedBlockHeight, 9_000n);
});

test("a throwing blockhash read is unknown", async () => {
  const { deps } = makeDeps({ blockhash: new Error("timeout") });
  const answer = await signatureFate(notBuilt, deps);
  assert.equal(answer.fate, "unknown");
  assert.equal(answer.reason, "blockhash_read_failed");
});

test("a dependency that throws something that is not an Error is unknown", async () => {
  const deps: SignatureFateDeps = {
    marginBlocks: MARGIN,
    getFinalizedPosition: () => {
      // A synchronous throw of a bare value.
      throw "nope";
    },
    getSignatureStatus: async () => ({ status: null, contextSlot: 1 }),
  };
  const answer = await signatureFate(built, deps);
  assert.equal(answer.fate, "unknown");
  assert.equal(answer.error, "nope");
});

test("a reading that is not a whole number is unknown, never a proof", async () => {
  const cases: Array<Parameters<typeof makeDeps>[0]> = [
    { finalized: { slot: Number.NaN, blockHeight: 9_000 } },
    { finalized: { slot: 5_000, blockHeight: -1 } },
    // A dependency that answers with nothing at all.
    { finalized: (() => undefined) as never },
    {
      finalized: { slot: 5_000, blockHeight: 9_000 },
      status: { status: null, contextSlot: 1.5 },
    },
  ];
  for (const opts of cases) {
    const { deps } = makeDeps(opts);
    const answer = await signatureFate(built, deps);
    assert.equal(answer.fate, "unknown");
    assert.equal(answer.reason, "bad_reading");
  }
  const { deps } = makeDeps({
    blockhash: { valid: false, contextSlot: Number.NaN },
  });
  const answer = await signatureFate(notBuilt, deps);
  assert.equal(answer.fate, "unknown");
  assert.equal(answer.reason, "bad_reading");
});

test("a status reading that does not say absent or present is unknown, never dead", async () => {
  // Everything else here would prove death; only the status is broken.
  for (const status of [undefined, "none", 0]) {
    const { deps } = makeDeps({
      finalized: { slot: 5_000, blockHeight: 9_000 },
      status: { status, contextSlot: 5_010 } as never,
    });
    const answer = await signatureFate(built, deps);
    assert.equal(answer.fate, "unknown", String(status));
    assert.equal(answer.reason, "bad_reading");
    assert.equal(answer.error, "status");
  }
});

test("a margin that is not a whole number at or above zero is unknown, with no read", async () => {
  for (const marginBlocks of [-1, 1.5, Number.NaN]) {
    const { deps, calls } = makeDeps({
      finalized: { slot: 5_000, blockHeight: 9_000 },
    });
    deps.marginBlocks = marginBlocks;
    const answer = await signatureFate(built, deps);
    assert.equal(answer.fate, "unknown");
    assert.equal(answer.reason, "bad_margin");
    assert.deepEqual(calls, []);
  }
});

// ------------------------------------------------------------------- log

test("describeSignatureFate gives a line any logger can write", async () => {
  const { deps } = makeDeps({
    finalized: { slot: 5_000, blockHeight: 1_033 },
    status: { status: null, contextSlot: 5_000 },
  });
  const answer = await signatureFate(built, deps);
  const line = describeSignatureFate(answer);
  assert.deepEqual(JSON.parse(JSON.stringify(line)), {
    signature: SIG,
    fate: "dead",
    reason: "absent_expired_by_height",
    error: null,
    finalizedSlot: "5000",
    finalizedBlockHeight: "1033",
    lastValidBlockHeight: "1000",
    marginBlocks: 32,
    statusContextSlot: "5000",
    confirmationStatus: null,
    landedSlot: null,
    blockhashValid: null,
    blockhashContextSlot: null,
  });
});
