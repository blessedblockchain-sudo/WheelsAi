/**
 * Drives services/runTopupReconcileTick.ts, the pure pass of the worker
 * that finishes wallet top-ups (payments pass, batch 2).
 *
 * Pinning, against an in-memory table (no database, no network):
 *   - one outcome per fate: landed_ok credits, landed_failed fails with
 *     failed_on_chain, dead expires with never_landed, in_flight re-sends
 *     the same bytes for a `submitting` row, unknown changes nothing
 *   - a `prepared` row past its time with no signature expires with
 *     unsigned_expired
 *   - a row with a signature is never ended by anything but the chain
 *   - a run racing a submit credits once (the real makeCreditTopup)
 *   - a throwing row does not stop the batch
 *   - the worker is off when the settings say so, and skips a run when
 *     the cluster check is not ok
 *
 * The fates are made by the real signatureFate over stand-in reads, so
 * the answers have the shape production gives.
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  TOPUP_RECONCILE_BATCH_SIZE,
  runTopupReconcileTick,
  topupReconcileEnabled,
  type ReconcilableTopupRow,
  type TopupReconcileEvent,
  type TopupReconcileTickDeps,
} from "../services/runTopupReconcileTick.js";
import {
  signatureFate,
  type SignatureFate,
  type SignatureFateAnswer,
} from "../services/signatureFate.js";
import { makeCreditTopup } from "../services/walletTopup.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);
const LAST_VALID = 1_000n;
const HOSTILE = "RPC says: <script>drop table</script> insufficient lamports";

// ---------- fates, from the real core ----------

async function fateOf(
  kind: SignatureFate,
  signature: string,
): Promise<SignatureFateAnswer> {
  const finalized =
    kind === "dead"
      ? { slot: 9_000, blockHeight: 5_000 }
      : { slot: 900, blockHeight: 900 };
  const answer = await signatureFate(
    { signature, lastValidBlockHeight: LAST_VALID },
    {
      marginBlocks: 10,
      getFinalizedPosition: async () => {
        if (kind === "unknown") throw new Error(HOSTILE);
        return finalized;
      },
      getSignatureStatus: async () => {
        const contextSlot = finalized.slot + 5;
        if (kind === "landed_ok") {
          return {
            status: { confirmationStatus: "confirmed", err: null },
            contextSlot,
          };
        }
        if (kind === "landed_failed") {
          return {
            status: { confirmationStatus: "finalized", err: HOSTILE },
            contextSlot,
          };
        }
        return { status: null, contextSlot };
      },
    },
  );
  assert.equal(answer.fate, kind, "the stand-in reads give the fate asked for");
  return answer;
}

// ---------- an in-memory wallet_topups table ----------

interface StoredTopup extends ReconcilableTopupRow {
  failureCode: string | null;
  failureReason: string | null;
  creditedAt: Date | null;
}

interface LedgerRow {
  orgId: string;
  type: string;
  amountCents: bigint;
  referenceId: string;
  balanceAfter: bigint;
}

function stored(over: Partial<StoredTopup> = {}): StoredTopup {
  return {
    id: "t1",
    orgId: "org_1",
    asset: "USDC",
    network: "solana:devnet",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    status: "submitted",
    txSignature: "sig_t1",
    signedTxB64: Buffer.from("signed bytes of t1").toString("base64"),
    lastValidBlockHeight: LAST_VALID,
    expiresAt: FUTURE,
    failureCode: null,
    failureReason: null,
    creditedAt: null,
    ...over,
  };
}

function makeWorld(
  rows: StoredTopup[],
  fates: Record<string, SignatureFate> = {},
) {
  const table = new Map(rows.map((r) => [r.id, r]));
  const state = {
    balance: 0n,
    ledger: [] as LedgerRow[],
    receipts: [] as string[],
    fateReads: [] as Array<{ signature: string; lastValidBlockHeight: bigint }>,
    sends: [] as Array<{ signedTxB64: string; txSignature: string }>,
    endCalls: [] as unknown[],
    expireCalls: [] as unknown[],
    loadArgs: [] as Array<{ limit: number; now: Date }>,
    clusterChecks: 0,
    events: [] as TopupReconcileEvent[],
  };

  // The same transaction shape Prisma gives makeCreditTopup, with a real
  // compare-and-set on the status.
  const tx = {
    walletTopUp: {
      updateMany: async (args: {
        where: { id: string; status: { in: string[] } };
        data: { status: string; creditedAt: Date };
      }) => {
        const r = table.get(args.where.id);
        if (!r || !args.where.status.in.includes(r.status)) return { count: 0 };
        r.status = args.data.status;
        r.creditedAt = args.data.creditedAt;
        return { count: 1 };
      },
      // What makeCreditTopup reads to write the transfer's receipt.
      findUnique: async (args: { where: { id: string } }) => {
        const r = table.get(args.where.id);
        return r
          ? {
              ...r,
              amountRaw: "50000000",
              payerAddress: "payer",
              depositAddress: "deposit",
            }
          : null;
      },
    },
    onchainReceipt: {
      create: async (args: { data: { txSignature: string } }) => {
        state.receipts.push(args.data.txSignature);
        return {};
      },
    },
    creditBalance: {
      upsert: async (args: { update: { balanceCents: { increment: bigint } } }) => {
        state.balance += args.update.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      update: async (args: { data: { balanceCents: { increment: bigint } } }) => {
        state.balance += args.data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
    },
    creditTransaction: {
      create: async (args: { data: LedgerRow }) => {
        state.ledger.push(args.data);
        return {};
      },
    },
  };
  const creditTopup = makeCreditTopup({
    $transaction: async (fn) => fn(tx),
  });

  const deps: TopupReconcileTickDeps = {
    checkCluster: async () => {
      state.clusterChecks += 1;
      return { ok: true };
    },
    loadTopups: async (args) => {
      state.loadArgs.push(args);
      // A snapshot, as a database read is: later changes do not show.
      return [...table.values()]
        .filter(
          (r) =>
            r.status === "submitting" ||
            r.status === "submitted" ||
            (r.status === "prepared" && r.expiresAt.getTime() < args.now.getTime()),
        )
        .slice(0, args.limit)
        .map((r) => ({ ...r }));
    },
    readFate: async (args) => {
      state.fateReads.push(args);
      return fateOf(fates[args.signature] ?? "unknown", args.signature);
    },
    creditTopup,
    endFromChain: async (args) => {
      state.endCalls.push(args);
      const r = table.get(args.id);
      if (
        !r ||
        r.txSignature !== args.txSignature ||
        (r.status !== "submitting" && r.status !== "submitted")
      ) {
        return false;
      }
      r.status = args.to;
      r.failureCode = args.failureCode;
      r.failureReason = args.failureReason;
      return true;
    },
    expireUnsigned: async (args) => {
      state.expireCalls.push(args);
      const r = table.get(args.id);
      if (!r || r.status !== "prepared" || r.txSignature !== null) return false;
      r.status = "expired";
      r.failureCode = args.failureCode;
      return true;
    },
    resendSignedBytes: async (args) => {
      state.sends.push(args);
      return { ok: true };
    },
    markSubmitted: async ({ id }) => {
      const r = table.get(id);
      if (!r || r.status !== "submitting") return false;
      r.status = "submitted";
      return true;
    },
    log: (event) => {
      state.events.push(event);
    },
  };

  const run = (over: Partial<TopupReconcileTickDeps> = {}) =>
    runTopupReconcileTick(
      { enabled: true, now: () => NOW },
      { ...deps, ...over },
    );

  return { table, state, deps, run, creditTopup };
}

// ---------- one outcome per fate ----------

test("landed_ok credits the top-up once, with its ledger rows", async () => {
  const w = makeWorld([stored()], { sig_t1: "landed_ok" });
  const res = await w.run();

  assert.equal(res.credited, 1);
  assert.equal(w.table.get("t1")?.status, "credited");
  assert.equal(w.state.balance, 5_500n);
  assert.deepEqual(
    w.state.ledger.map((l) => [l.type, l.amountCents, l.referenceId]),
    [
      ["purchase", 5_000n, "t1"],
      ["bonus", 500n, "t1"],
    ],
  );
  assert.deepEqual(w.state.fateReads, [
    { signature: "sig_t1", lastValidBlockHeight: LAST_VALID },
  ]);
});

test("landed_ok also credits a row the send error left in `submitting`", async () => {
  const w = makeWorld([stored({ status: "submitting" })], {
    sig_t1: "landed_ok",
  });
  const res = await w.run();
  assert.equal(res.credited, 1);
  assert.equal(w.table.get("t1")?.status, "credited");
  assert.equal(w.state.sends.length, 0, "a landed transfer is not sent again");
});

test("landed_failed fails the row with failed_on_chain; the chain's text is the operator note", async () => {
  const w = makeWorld([stored()], { sig_t1: "landed_failed" });
  const res = await w.run();

  assert.equal(res.failed, 1);
  const row = w.table.get("t1");
  assert.equal(row?.status, "failed");
  assert.equal(row?.failureCode, "failed_on_chain");
  assert.equal(row?.failureReason, HOSTILE);
  assert.equal(w.state.ledger.length, 0);
});

test("dead expires the row with never_landed", async () => {
  const w = makeWorld([stored({ status: "submitting" })], { sig_t1: "dead" });
  const res = await w.run();

  assert.equal(res.expiredNeverLanded, 1);
  const row = w.table.get("t1");
  assert.equal(row?.status, "expired");
  assert.equal(row?.failureCode, "never_landed");
  assert.match(row?.failureReason ?? "", /absent_expired_by_height/);
  assert.equal(w.state.sends.length, 0, "a dead transfer is not sent again");
  assert.equal(w.state.ledger.length, 0);
});

test("in_flight: a `submitting` row's own signed bytes are sent again, unchanged, and it becomes `submitted`", async () => {
  const bytes = Buffer.from("the exact bytes the wallet returned").toString("base64");
  const w = makeWorld([stored({ status: "submitting", signedTxB64: bytes })], {
    sig_t1: "in_flight",
  });
  const res = await w.run();

  assert.equal(res.resent, 1);
  assert.equal(w.state.sends.length, 1);
  assert.equal(w.state.sends[0]?.signedTxB64, bytes);
  assert.equal(w.state.sends[0]?.txSignature, "sig_t1");
  assert.equal(w.table.get("t1")?.status, "submitted");
});

test("in_flight: a `submitted` row is left to land; nothing is sent", async () => {
  const w = makeWorld([stored({ status: "submitted" })], { sig_t1: "in_flight" });
  const res = await w.run();
  assert.equal(res.waiting, 1);
  assert.equal(w.state.sends.length, 0);
  assert.equal(w.table.get("t1")?.status, "submitted");
});

test("in_flight: a `submitting` row with no stored bytes is left alone", async () => {
  const w = makeWorld([stored({ status: "submitting", signedTxB64: null })], {
    sig_t1: "in_flight",
  });
  const res = await w.run();
  assert.equal(res.waiting, 1);
  assert.equal(w.state.sends.length, 0);
  assert.equal(w.table.get("t1")?.status, "submitting");
});

test("in_flight: a re-send the node does not take, or that throws, ends nothing", async () => {
  for (const resendSignedBytes of [
    async () => ({ ok: false as const, detail: HOSTILE }),
    async () => {
      throw new Error(HOSTILE);
    },
  ]) {
    const w = makeWorld([stored({ status: "submitting", expiresAt: PAST })], {
      sig_t1: "in_flight",
    });
    const res = await w.run({ resendSignedBytes });
    assert.equal(res.waiting, 1);
    assert.equal(res.errors, 0);
    const row = w.table.get("t1");
    assert.equal(row?.status, "submitting", "the row still waits for the chain");
    assert.equal(row?.failureCode, null);
    assert.equal(w.state.endCalls.length, 0);
    assert.equal(w.state.events[0]?.detail, HOSTILE, "the node's text goes to the log");
  }
});

test("unknown changes nothing", async () => {
  const w = makeWorld(
    [stored({ id: "a", txSignature: "sig_a", status: "submitting" }), stored({ id: "b", txSignature: "sig_b" })],
    { sig_a: "unknown", sig_b: "unknown" },
  );
  const res = await w.run();
  assert.equal(res.waiting, 2);
  assert.equal(w.table.get("a")?.status, "submitting");
  assert.equal(w.table.get("b")?.status, "submitted");
  assert.equal(w.state.sends.length, 0, "nothing is sent on a failed read");
  assert.equal(w.state.endCalls.length, 0);
  assert.equal(w.state.ledger.length, 0);
});

// ---------- the unsigned row ----------

test("a `prepared` row past its time with no signature expires with unsigned_expired", async () => {
  const w = makeWorld([
    stored({ status: "prepared", txSignature: null, signedTxB64: null, expiresAt: PAST }),
  ]);
  const res = await w.run();

  assert.equal(res.expiredUnsigned, 1);
  const row = w.table.get("t1");
  assert.equal(row?.status, "expired");
  assert.equal(row?.failureCode, "unsigned_expired");
  assert.equal(w.state.fateReads.length, 0, "no signature, so no chain read");
});

test("a `prepared` row still inside its time is not touched, even if it is handed in", async () => {
  const w = makeWorld([]);
  const fresh = stored({ status: "prepared", txSignature: null, expiresAt: FUTURE });
  const res = await w.run({ loadTopups: async () => [fresh] });
  assert.equal(res.waiting, 1);
  assert.equal(w.state.expireCalls.length, 0);
});

test("a submit that claims the row first makes the expiry lose, silently", async () => {
  const w = makeWorld([
    stored({ status: "prepared", txSignature: null, signedTxB64: null, expiresAt: PAST }),
  ]);
  const res = await w.run({
    loadTopups: async (args) => {
      const rows = await w.deps.loadTopups(args);
      // Between the read and the change, the submit route claims it.
      const live = w.table.get("t1");
      assert.ok(live);
      live.status = "submitting";
      live.txSignature = "sig_t1";
      return rows;
    },
  });
  assert.equal(res.lostRace, 1);
  assert.equal(res.expiredUnsigned, 0);
  assert.equal(w.table.get("t1")?.status, "submitting");
  assert.equal(w.table.get("t1")?.failureCode, null);
});

// ---------- only the chain ends a row with a signature ----------

test("a row with a signature is never ended by the clock, a failed read or a failed send", async () => {
  for (const status of ["prepared", "submitting", "submitted"]) {
    for (const fate of ["in_flight", "unknown"] as const) {
      const w = makeWorld([]);
      const row = stored({ status, expiresAt: PAST });
      const res = await w.run({
        loadTopups: async () => [{ ...row }],
        readFate: async (args) => fateOf(fate, args.signature),
        resendSignedBytes: async () => ({ ok: false, detail: "blockhash not found" }),
      });
      assert.equal(res.failed + res.expiredNeverLanded + res.expiredUnsigned, 0);
      assert.equal(w.state.endCalls.length, 0, `${status}/${fate}: not ended`);
      assert.equal(w.state.expireCalls.length, 0, `${status}/${fate}: not expired`);
    }
  }
});

test("a fate that cannot be read is never taken for a failure", async () => {
  const w = makeWorld([stored({ expiresAt: PAST })]);
  const res = await w.run({
    readFate: async () => {
      throw new Error(HOSTILE);
    },
  });
  assert.equal(res.errors, 1);
  assert.equal(w.table.get("t1")?.status, "submitted");
  assert.equal(w.state.endCalls.length, 0);
});

test("a row no pass can end is put in the log, not waited on in silence", async () => {
  // In flight with no signature: nothing to ask the chain about.
  const unsignedInFlight = makeWorld([
    stored({ status: "submitting", txSignature: null, signedTxB64: null, expiresAt: PAST }),
  ]);
  const first = await unsignedInFlight.run();
  assert.equal(first.waiting, 1);
  assert.equal(unsignedInFlight.table.get("t1")?.status, "submitting");
  assert.equal(unsignedInFlight.state.expireCalls.length, 0);
  assert.match(unsignedInFlight.state.events[0]?.detail ?? "", /no signature/);

  // `prepared` with a signature whose transfer landed: the credit cannot
  // win, and that is an error for an operator, not a lost race.
  const w = makeWorld([]);
  const row = stored({ status: "prepared", expiresAt: PAST });
  w.table.set(row.id, row);
  const second = await w.run({
    loadTopups: async () => [{ ...row }],
    readFate: async (args) => fateOf("landed_ok", args.signature),
  });
  assert.equal(second.errors, 1);
  assert.equal(second.lostRace, 0);
  assert.equal(second.credited, 0);
  assert.equal(w.state.ledger.length, 0);
  assert.equal(w.table.get("t1")?.status, "prepared");
  assert.equal(w.state.events[0]?.action, "error");
  assert.match(w.state.events[0]?.detail ?? "", /prepared row holds a signature/);
});

// ---------- races ----------

test("a run racing a submit credits once", async () => {
  const w = makeWorld([stored()], { sig_t1: "landed_ok" });
  const args = {
    topupId: "t1",
    orgId: "org_1",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    asset: "USDC",
    network: "solana:devnet",
  };
  // The submit request confirms and credits while two passes of the
  // worker hold the same row: both read it while it was `submitted`.
  const held = await w.deps.loadTopups({ limit: 50, now: NOW });
  assert.equal(held.length, 1);
  const loadTopups = async () => held.map((r) => ({ ...r }));
  const [first, second, submit] = await Promise.all([
    w.run({ loadTopups }),
    w.run({ loadTopups }),
    w.creditTopup(args),
  ]);

  const wins =
    first.credited + second.credited + (submit.credited ? 1 : 0);
  assert.equal(wins, 1, "exactly one of the three granted");
  assert.equal(first.lostRace + second.lostRace + (submit.credited ? 0 : 1), 2);
  assert.equal(first.errors + second.errors, 0, "a lost race is not an error");
  assert.equal(w.state.balance, 5_500n);
  assert.equal(w.state.ledger.length, 2, "one purchase row and one bonus row");

  const again = await w.run();
  assert.equal(again.loaded, 0, "a credited row is not taken again");
});

test("a row the submit request already credited is a silent lost race", async () => {
  const w = makeWorld([stored()], { sig_t1: "landed_ok" });
  const res = await w.run({
    readFate: async (args) => {
      const live = w.table.get("t1");
      assert.ok(live);
      live.status = "credited";
      return fateOf("landed_ok", args.signature);
    },
  });
  assert.equal(res.lostRace, 1);
  assert.equal(res.credited, 0);
  assert.equal(w.state.ledger.length, 0, "no second grant");
});

test("an end that loses its compare-and-set is counted, not treated as a fault", async () => {
  const w = makeWorld([stored()], { sig_t1: "landed_failed" });
  const res = await w.run({ endFromChain: async () => false });
  assert.equal(res.lostRace, 1);
  assert.equal(res.failed, 0);
  assert.equal(res.errors, 0);
});

// ---------- isolation ----------

test("a row that throws does not stop the rows after it", async () => {
  const w = makeWorld(
    [
      stored({ id: "a", txSignature: "sig_a" }),
      stored({ id: "b", txSignature: "sig_b" }),
      stored({ id: "c", txSignature: null, signedTxB64: null, status: "prepared", expiresAt: PAST }),
    ],
    { sig_a: "landed_ok", sig_b: "landed_ok" },
  );
  const res = await w.run({
    creditTopup: async (args) => {
      if (args.topupId === "a") throw new Error(HOSTILE);
      return w.creditTopup(args);
    },
    log: (event) => {
      w.state.events.push(event);
      throw new Error("a logger that throws");
    },
  });

  assert.equal(res.loaded, 3);
  assert.equal(res.errors, 1);
  assert.equal(res.credited, 1);
  assert.equal(res.expiredUnsigned, 1);
  assert.equal(w.table.get("a")?.status, "submitted", "the row that threw is left as it was");
  assert.equal(w.table.get("b")?.status, "credited");
  assert.equal(w.table.get("c")?.status, "expired");
  assert.deepEqual(
    w.state.events.map((e) => [e.topupId, e.action]),
    [
      ["a", "error"],
      ["b", "credited"],
      ["c", "expired_unsigned"],
    ],
  );
});

// ---------- on and off ----------

test("the worker is off unless top-ups are on and the interval is above zero", () => {
  assert.equal(topupReconcileEnabled({ walletTopupsEnabled: true, intervalMs: 15_000 }), true);
  assert.equal(topupReconcileEnabled({ walletTopupsEnabled: false, intervalMs: 15_000 }), false);
  assert.equal(topupReconcileEnabled({ walletTopupsEnabled: true, intervalMs: 0 }), false);
  assert.equal(topupReconcileEnabled({ walletTopupsEnabled: true, intervalMs: -1 }), false);
  assert.equal(topupReconcileEnabled({ walletTopupsEnabled: true, intervalMs: Number.NaN }), false);
});

test("a disabled run reads nothing: not the cluster, not the table", async () => {
  const w = makeWorld([stored()], { sig_t1: "landed_ok" });
  const res = await runTopupReconcileTick({ enabled: false, now: () => NOW }, w.deps);
  assert.equal(res.ran, false);
  assert.equal(res.skipped, "disabled");
  assert.equal(w.state.clusterChecks, 0);
  assert.equal(w.state.loadArgs.length, 0);
  assert.equal(w.table.get("t1")?.status, "submitted");
});

test("a run is skipped when the cluster check is not ok, or throws", async () => {
  for (const checkCluster of [
    async () => ({ ok: false, reason: "wrong_cluster" }),
    async () => ({ ok: false, reason: "unreachable" }),
    async () => {
      throw new Error(HOSTILE);
    },
  ]) {
    const w = makeWorld([stored()], { sig_t1: "landed_ok" });
    const res = await w.run({ checkCluster });
    assert.equal(res.ran, false);
    assert.equal(res.skipped, "chain_unavailable");
    assert.equal(w.state.loadArgs.length, 0);
    assert.equal(w.state.fateReads.length, 0);
    assert.equal(w.table.get("t1")?.status, "submitted");
  }
});

test("a run takes up to 50 rows unless told otherwise", async () => {
  assert.equal(TOPUP_RECONCILE_BATCH_SIZE, 50);
  const w = makeWorld([]);
  await w.run();
  await runTopupReconcileTick({ enabled: true, limit: 7, now: () => NOW }, w.deps);
  assert.deepEqual(
    w.state.loadArgs.map((a) => [a.limit, a.now.getTime()]),
    [
      [50, NOW.getTime()],
      [7, NOW.getTime()],
    ],
  );
});
