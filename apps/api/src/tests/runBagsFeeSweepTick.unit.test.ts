import assert from "node:assert/strict";
import test from "node:test";

import {
  runBagsFeeSweepTick,
  type BagsFeeSweepTickDeps,
  type BagsSweepRow,
} from "../services/runBagsFeeSweepTick.js";

const NOW = new Date("2026-06-04T00:00:00Z");

function row(id: string): BagsSweepRow {
  return {
    tokenId: id,
    mintAddress: `mint_${id}`,
    treasuryPdaAddress: `pda_${id}`,
  };
}

test("sweeps tokens with claimable fees and advances their cursors", async () => {
  const persisted: string[] = [];
  const deps: BagsFeeSweepTickDeps = {
    loadBagsTokens: async () => [row("a"), row("b")],
    sweepToken: async (r) => ({
      lamports: r.tokenId === "a" ? 1_000n : 2_000n,
      txSignature: `sig_${r.tokenId}`,
    }),
    persistSwept: async ({ tokenId }) => {
      persisted.push(tokenId);
    },
  };
  const result = await runBagsFeeSweepTick({ now: NOW }, deps);
  assert.deepEqual(result, { swept: 2, skipped: 0, failed: 0 });
  assert.deepEqual(persisted.sort(), ["a", "b"]);
});

test("skips tokens with nothing claimable (no cursor advance)", async () => {
  let persistCalled = false;
  const deps: BagsFeeSweepTickDeps = {
    loadBagsTokens: async () => [row("a")],
    sweepToken: async () => ({ lamports: 0n, txSignature: null }),
    persistSwept: async () => {
      persistCalled = true;
    },
  };
  const result = await runBagsFeeSweepTick({ now: NOW }, deps);
  assert.deepEqual(result, { swept: 0, skipped: 1, failed: 0 });
  assert.equal(persistCalled, false);
});

test("counts a failed sweep and does NOT advance its cursor", async () => {
  const persisted: string[] = [];
  const deps: BagsFeeSweepTickDeps = {
    loadBagsTokens: async () => [row("a"), row("b")],
    sweepToken: async (r) => {
      if (r.tokenId === "a") throw new Error("claim failed");
      return { lamports: 500n, txSignature: "sig_b" };
    },
    persistSwept: async ({ tokenId }) => {
      persisted.push(tokenId);
    },
  };
  const result = await runBagsFeeSweepTick({ now: NOW }, deps);
  assert.deepEqual(result, { swept: 1, skipped: 0, failed: 1 });
  assert.deepEqual(persisted, ["b"], "only the successful token advances");
});

test("a persist failure after a successful sweep propagates (BullMQ retries)", async () => {
  const deps: BagsFeeSweepTickDeps = {
    loadBagsTokens: async () => [row("a")],
    sweepToken: async () => ({ lamports: 1_000n, txSignature: "sig_a" }),
    persistSwept: async () => {
      throw new Error("db down");
    },
  };
  await assert.rejects(runBagsFeeSweepTick({ now: NOW }, deps), /db down/);
});
