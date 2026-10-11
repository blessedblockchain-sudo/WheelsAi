/**
 * Drives apps/api/src/services/treasuryVerify.ts: proving that somebody
 * holds the key of TREASURY_WALLET_ADDRESS. Stand-ins only: no node, no
 * database.
 *
 * Pinning:
 *   - only a transfer the treasury SIGNED, that did not fail, and that
 *     left the hot wallet with at least 0.1 SOL more, is a proof;
 *   - each bad address is refused in plain words, before anything is read;
 *   - found: the row is written (replacing one for an older address);
 *     not found: nothing is written and the operator is told what to do;
 *     a dry run writes nothing;
 *   - the script binds it to the settings, the node and the database, and
 *     sends nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { TransactionFacts } from "../services/depositScan.js";
import { NO_TREASURY_ADDRESS } from "../services/sweepPlan.js";
import {
  TREASURY_PROOF_MAX_SIGNATURES,
  TREASURY_PROOF_MIN_LAMPORTS,
  isTreasuryProof,
  verifyTreasury,
  type TreasuryVerifyDeps,
} from "../services/treasuryVerify.js";
import { addressOf, depositAddressOf, usdcAccountOf } from "./depositStandIn.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-11T09:00:00.000Z");
const HOT = addressOf("hot-wallet");
const TREASURY = addressOf("treasury");
const STRANGER = addressOf("stranger");
const SYSTEM = "11111111111111111111111111111111";
const TENTH = 100_000_000n;

/** A transfer of `lamports` from `from` to the hot wallet, signed by `signers`. */
function transferFacts(
  signature: string,
  over: { from?: string; lamports?: bigint; signers?: string[]; failed?: boolean; to?: string } = {},
): TransactionFacts {
  const from = over.from ?? TREASURY;
  const to = over.to ?? HOT;
  const lamports = over.lamports ?? TENTH;
  return {
    signature,
    failed: over.failed ?? false,
    accountKeys: [from, to, SYSTEM],
    preLamports: [5_000_000_000n, 1_000_000n, 1n],
    postLamports: over.failed
      ? [5_000_000_000n - 5_000n, 1_000_000n, 1n]
      : [5_000_000_000n - lamports - 5_000n, 1_000_000n + lamports, 1n],
    preTokenBalances: [],
    postTokenBalances: [],
    signers: over.signers ?? [from],
    memos: [],
    slot: 1_000n,
    blockTime: NOW,
  };
}

function setup(
  history: Array<TransactionFacts | { signature: string; failed: true } | { signature: string; unloadable: true }>,
  over: Partial<TreasuryVerifyDeps> & { proof?: { address: string; proofSignature: string } | null; deposits?: string[] } = {},
) {
  const saved: Array<{ address: string; proofSignature: string; verifiedAt: Date }> = [];
  const loaded: string[] = [];
  const asked: Array<{ limit: number }> = [];
  let clusterChecks = 0;
  const { proof, deposits, ...depsOver } = over;
  const deps: TreasuryVerifyDeps = {
    network: "solana:devnet",
    checkCluster: async () => {
      clusterChecks += 1;
      return { ok: true };
    },
    treasurySetting: TREASURY,
    hotWalletAddress: () => HOT,
    isDepositAddress: async (address) => (deposits ?? []).includes(address),
    loadProof: async () => proof ?? null,
    listHotWalletSignatures: async (args) => {
      asked.push(args);
      return history.map((entry) => ({
        signature: entry.signature,
        failed: "failed" in entry && entry.failed === true,
      }));
    },
    loadTransaction: async (signature) => {
      loaded.push(signature);
      const entry = history.find((e) => e.signature === signature);
      if (!entry || "unloadable" in entry) return null;
      return "accountKeys" in entry ? entry : null;
    },
    saveProof: async (row) => {
      saved.push(row);
    },
    now: () => NOW,
    ...depsOver,
  };
  return { deps, saved, loaded, asked, clusterChecks: () => clusterChecks };
}

// ============================================
// What a proof is
// ============================================

test("a proof is a transfer the treasury signed, that did not fail, and left the hot wallet 0.1 SOL more", () => {
  const wallets = { treasury: TREASURY, hotWallet: HOT };
  assert.equal(TREASURY_PROOF_MIN_LAMPORTS, 100_000_000n);
  assert.equal(TREASURY_PROOF_MAX_SIGNATURES, 1_000);

  assert.equal(isTreasuryProof(transferFacts("ok"), wallets), true);
  assert.equal(isTreasuryProof(transferFacts("more", { lamports: 3n * TENTH }), wallets), true);
  // The treasury signed as a second signer (somebody else paid the fee).
  assert.equal(isTreasuryProof(transferFacts("cosigned", { from: STRANGER, signers: [STRANGER, TREASURY] }), wallets), true);

  // One lamport short.
  assert.equal(isTreasuryProof(transferFacts("short", { lamports: TENTH - 1n }), wallets), false);
  // It failed on the chain.
  assert.equal(isTreasuryProof(transferFacts("failed", { failed: true }), wallets), false);
  // Marked failed, whatever its balances say.
  assert.equal(isTreasuryProof({ ...transferFacts("failed-moved"), failed: true }, wallets), false);
  // Somebody else sent 0.1 SOL: the treasury is not a signer.
  assert.equal(isTreasuryProof(transferFacts("stranger", { from: STRANGER }), wallets), false);
  // The treasury is in the transaction (it received) but did not sign.
  assert.equal(
    isTreasuryProof({ ...transferFacts("named", { from: STRANGER }), accountKeys: [STRANGER, HOT, SYSTEM, TREASURY], preLamports: [5_000_000_000n, 0n, 1n, 0n], postLamports: [4_000_000_000n, TENTH, 1n, 0n] }, wallets),
    false,
  );
  // The treasury signed, and the money went somewhere else.
  assert.equal(isTreasuryProof(transferFacts("elsewhere", { to: STRANGER }), wallets), false);
  // The hot wallet ended with less: a payout it made to the treasury.
  assert.equal(
    isTreasuryProof(
      { ...transferFacts("payout"), accountKeys: [HOT, TREASURY, SYSTEM], signers: [HOT, TREASURY], preLamports: [9n * TENTH, 0n, 1n], postLamports: [8n * TENTH, TENTH, 1n] },
      wallets,
    ),
    false,
  );
  // The hot wallet signing for itself proves nothing about another wallet.
  assert.equal(isTreasuryProof(transferFacts("self", { from: HOT, signers: [HOT] }), { treasury: HOT, hotWallet: HOT }), false);
  // Balances that do not line up with the accounts.
  assert.equal(isTreasuryProof({ ...transferFacts("broken"), postLamports: [] }, wallets), false);
});

// ============================================
// Found
// ============================================

test("found: the row is written with the address, now and the signature, and the script says so", async () => {
  const w = setup([
    transferFacts("sig_newest_unrelated", { from: STRANGER }),
    { signature: "sig_failed", failed: true },
    transferFacts("sig_proof"),
    transferFacts("sig_older_proof"),
  ]);
  const res = await verifyTreasury({ dryRun: false }, w.deps);
  assert.equal(res.outcome, "proven");
  assert.deepEqual(w.saved, [{ address: TREASURY, proofSignature: "sig_proof", verifiedAt: NOW }]);
  assert.match(res.message, new RegExp(`The treasury ${TREASURY} is proven`));
  assert.match(res.message, /sig_proof/);
  assert.match(res.message, /The row for solana:devnet was written\./);
  // Newest first; a failed one is not loaded; it stops at the first proof.
  assert.deepEqual(w.loaded, ["sig_newest_unrelated", "sig_proof"]);
  assert.deepEqual(w.asked, [{ limit: 1_000 }]);
  assert.equal(w.clusterChecks(), 1);
});

test("a dry run finds the proof and writes nothing", async () => {
  const w = setup([transferFacts("sig_proof")]);
  const res = await verifyTreasury({ dryRun: true }, w.deps);
  assert.equal(res.outcome, "proven");
  assert.equal(res.outcome === "proven" && res.written, false);
  assert.deepEqual(w.saved, []);
  assert.match(res.message, /Dry run: nothing was written\./);
});

test("an address that changed since it was proven is proven again the same way: the row is replaced", async () => {
  const older = addressOf("older-treasury");
  const w = setup([transferFacts("sig_new_proof")], { proof: { address: older, proofSignature: "sig_old_proof" } });
  const res = await verifyTreasury({ dryRun: false }, w.deps);
  assert.equal(res.outcome, "proven");
  assert.equal(res.outcome === "proven" && res.replaced, older);
  assert.deepEqual(w.saved, [{ address: TREASURY, proofSignature: "sig_new_proof", verifiedAt: NOW }]);
  assert.match(res.message, new RegExp(`was replaced \\(it named ${older}\\)`));

  // With no proof for the new address the old row is left as it is.
  const none = setup([transferFacts("sig_old_proof", { from: older })], { proof: { address: older, proofSignature: "sig_old_proof" } });
  const res2 = await verifyTreasury({ dryRun: false }, none.deps);
  assert.equal(res2.outcome, "not_found");
  assert.deepEqual(none.saved, []);
});

test("an address already proven is said to be, and nothing is read from the node or written", async () => {
  const w = setup([transferFacts("sig_proof")], { proof: { address: TREASURY, proofSignature: "sig_first" } });
  const res = await verifyTreasury({ dryRun: false }, w.deps);
  assert.equal(res.outcome, "already_proven");
  assert.match(res.message, /already proven on solana:devnet, by transaction sig_first/);
  assert.deepEqual(w.saved, []);
  assert.deepEqual(w.asked, []);
});

// ============================================
// Not found
// ============================================

test("not found: nothing is written and the operator is told what to do", async () => {
  const w = setup([
    transferFacts("sig_stranger", { from: STRANGER }),
    transferFacts("sig_short", { lamports: TENTH - 1n }),
    transferFacts("sig_reverted", { failed: true }),
    { signature: "sig_failed", failed: true },
    { signature: "sig_unloadable", unloadable: true },
  ]);
  const res = await verifyTreasury({ dryRun: false }, w.deps);
  assert.equal(res.outcome, "not_found");
  assert.deepEqual(w.saved, []);
  assert.ok(
    res.message.endsWith(
      `Nothing was written. Send 0.1 SOL from the treasury wallet to ${HOT}, then run this again.`,
    ),
    res.message,
  );
  assert.match(res.message, /1 of them could not be loaded/);
  assert.ok(!res.message.includes("—"), "no em dash in operator text");

  const empty = setup([]);
  const res2 = await verifyTreasury({ dryRun: false }, empty.deps);
  assert.equal(res2.outcome, "not_found");
  assert.deepEqual(empty.saved, []);
});

test("a transaction that throws on load is passed over, not taken as a proof", async () => {
  const w = setup([transferFacts("sig_throws"), transferFacts("sig_stranger", { from: STRANGER })], {});
  w.deps.loadTransaction = async (signature) => {
    if (signature === "sig_throws") throw new Error("node is away");
    return transferFacts(signature, { from: STRANGER });
  };
  const res = await verifyTreasury({ dryRun: false }, w.deps);
  assert.equal(res.outcome, "not_found");
  assert.deepEqual(w.saved, []);
});

test("no more than 1,000 signatures are looked through", async () => {
  const history = Array.from({ length: 1_005 }, (_, i) =>
    i === 1_002 ? transferFacts("sig_too_old_proof") : transferFacts(`sig_${i}`, { from: STRANGER }),
  );
  const w = setup(history);
  const res = await verifyTreasury({ dryRun: false }, w.deps);
  assert.equal(res.outcome, "not_found");
  assert.equal(w.loaded.length, 1_000);
  assert.deepEqual(w.saved, []);
});

// ============================================
// Each bad address
// ============================================

test("each bad address is refused in plain words, before the node is asked and with nothing written", async () => {
  const deposit = depositAddressOf("org-a");
  const cases: Array<[string | null | undefined, string, RegExp, string[]?]> = [
    [NO_TREASURY_ADDRESS, "not_set", /TREASURY_WALLET_ADDRESS is not set/],
    [undefined, "not_set", /TREASURY_WALLET_ADDRESS is not set/],
    ["", "not_set", /TREASURY_WALLET_ADDRESS is not set/],
    ["not an address", "not_a_wallet", /not an ordinary wallet address/],
    [usdcAccountOf(TREASURY), "not_a_wallet", /not an ordinary wallet address/],
    [`${TREASURY}x`, "not_a_wallet", /not an ordinary wallet address/],
    [HOT, "is_hot_wallet", /is the hot wallet/],
    [deposit, "is_deposit_address", /is a deposit address/, [deposit]],
  ];
  for (const [setting, reason, words, deposits] of cases) {
    // A history that would prove the address, were it ever read.
    const w = setup([transferFacts("sig_proof", { from: typeof setting === "string" ? setting : TREASURY })], {
      treasurySetting: setting,
      deposits,
    });
    const res = await verifyTreasury({ dryRun: false }, w.deps);
    assert.equal(res.outcome, "refused", String(setting));
    assert.equal(res.outcome === "refused" && res.reason, reason, String(setting));
    assert.match(res.message, words);
    assert.ok(!res.message.includes("—"));
    assert.deepEqual(w.saved, []);
    assert.deepEqual(w.asked, [], "the node is not asked");
    assert.equal(w.clusterChecks(), 0);
  }
});

test("a node on the wrong cluster, or no hot wallet, refuses with nothing read or written", async () => {
  const wrong = setup([transferFacts("sig_proof")], { checkCluster: async () => ({ ok: false, reason: "wrong_cluster" }) });
  const res = await verifyTreasury({ dryRun: false }, wrong.deps);
  assert.equal(res.outcome === "refused" && res.reason, "chain_unavailable");
  assert.match(res.message, /wrong_cluster/);
  assert.deepEqual(wrong.asked, []);
  assert.deepEqual(wrong.saved, []);

  const thrown = setup([transferFacts("sig_proof")], {
    checkCluster: async () => {
      throw new Error("node is away");
    },
  });
  assert.equal((await verifyTreasury({ dryRun: false }, thrown.deps)).outcome, "refused");

  const noKey = setup([transferFacts("sig_proof")], {
    hotWalletAddress: () => {
      throw new Error("WALLET_MASTER_KEY required (empty or missing)");
    },
  });
  const res3 = await verifyTreasury({ dryRun: false }, noKey.deps);
  assert.equal(res3.outcome === "refused" && res3.reason, "no_hot_wallet");
  assert.deepEqual(noKey.saved, []);
});

// ============================================
// The script
// ============================================

test("the script binds the core to the settings, the node at finalized and the one row, and sends nothing", () => {
  const script = readFileSync(path.join(HERE, "..", "..", "scripts", "treasury-verify.ts"), "utf8");
  assert.match(script, /verifyTreasury\(/);
  assert.match(script, /treasurySetting: env\.TREASURY_WALLET_ADDRESS/);
  assert.match(script, /ensureSolanaCluster\(\)/);
  assert.match(script, /getSolanaConnection\(\)/);
  assert.match(script, /"--dry-run"/);
  assert.match(script, /role_network: \{ role: "treasury", network \}/);
  assert.match(script, /platformWallet\.upsert/);
  // Every chain read is at finalized.
  assert.ok(!/"confirmed"|"processed"/.test(script));
  // It builds no connection of its own, and signs and sends nothing.
  assert.ok(!/new\s+Connection\s*\(/.test(script));
  assert.ok(!/sendRawTransaction|sendTransaction|\.sign\(|keypair\(\)/.test(script));
  assert.ok(!script.includes("—"));
});
