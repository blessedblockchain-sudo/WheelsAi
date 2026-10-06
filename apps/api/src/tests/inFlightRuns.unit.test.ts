import assert from "node:assert/strict";
import test from "node:test";

import { createInFlightRuns, ServerShuttingDownError } from "../services/inFlightRuns.js";

// Drives services/inFlightRuns.ts - what a deploy does to graph runs that
// hold a marketplace charge. The bug: SIGTERM waited on a run that had
// minutes left, the platform SIGKILLed the process at 60s, and the charge
// stayed `pending` forever (buyer debited, nothing refunded).

/** A run shaped like runAgentGraph: charge, work until cancelled, then settle or refund. */
function startRun(runs: ReturnType<typeof createInFlightRuns>, ledger: string[], id: string, settleMs = 0) {
  const slot = runs.begin();
  if (!slot) throw new ServerShuttingDownError();
  ledger.push(`charge:${id}`);
  return (async () => {
    try {
      await new Promise<void>((resolve) => slot.signal.addEventListener("abort", () => resolve(), { once: true }));
      await new Promise((r) => setTimeout(r, settleMs));
      ledger.push(`refund:${id}`);
    } finally {
      slot.done();
    }
  })();
}

test("shutdown cancels every in-flight run and waits for each to refund", async () => {
  const runs = createInFlightRuns();
  const ledger: string[] = [];
  const a = startRun(runs, ledger, "a", 5);
  const b = startRun(runs, ledger, "b", 10);
  assert.equal(runs.size, 2);

  const result = await runs.cancelAll(1_000);

  assert.deepEqual(result, { cancelled: 2, unfinished: 0 });
  // By the time cancelAll returns, every charge has its refund: nothing is
  // left for the kill signal to strand.
  assert.deepEqual(ledger.sort(), ["charge:a", "charge:b", "refund:a", "refund:b"]);
  assert.equal(runs.size, 0);
  await Promise.all([a, b]);
});

test("once shutdown has begun a new run is refused BEFORE it is charged", async () => {
  const runs = createInFlightRuns();
  const ledger: string[] = [];
  await runs.cancelAll(10);
  assert.equal(runs.begin(), null);
  assert.throws(() => startRun(runs, ledger, "late"), ServerShuttingDownError);
  assert.deepEqual(ledger, []);
});

test("a run that finished on its own is not cancelled and not waited for", async () => {
  const runs = createInFlightRuns();
  const slot = runs.begin()!;
  slot.done();
  slot.done(); // idempotent
  const result = await runs.cancelAll(1_000);
  assert.deepEqual(result, { cancelled: 0, unfinished: 0 });
  assert.equal(slot.signal.aborted, false);
});

test("a run that will not finish is reported, and does not hold shutdown past its budget", async () => {
  const runs = createInFlightRuns();
  const stuck = runs.begin()!;
  const started = Date.now();
  const result = await runs.cancelAll(30);
  assert.equal(stuck.signal.aborted, true);
  assert.deepEqual(result, { cancelled: 1, unfinished: 1 });
  assert.ok(Date.now() - started < 500);
  stuck.done();
});

test("the shutdown refusal tells the caller nothing was charged", () => {
  assert.match(new ServerShuttingDownError().message, /nothing was charged/);
});
