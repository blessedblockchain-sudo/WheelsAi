import assert from "node:assert/strict";
import test from "node:test";

import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import { deriveTreasuryKeypair } from "../services/treasuryKeypairs.js";

// The single platform payout wallet (W2). Deterministic, and disjoint from
// every other HKDF key family under its own salt.

const MASTER = "test-master-key-0123456789abcdef-xyz";

test("payout wallet derivation is deterministic", () => {
  const a = derivePayoutKeypair(MASTER);
  const b = derivePayoutKeypair(MASTER);
  assert.equal(a.publicKey.toBase58(), b.publicKey.toBase58());
});

test("a different master key yields a different payout wallet", () => {
  const a = derivePayoutKeypair(MASTER);
  const b = derivePayoutKeypair("another-master-key-0123456789abcdef");
  assert.notEqual(a.publicKey.toBase58(), b.publicKey.toBase58());
});

test("the payout salt is disjoint from treasury and topup key families", () => {
  const payout = derivePayoutKeypair(MASTER).publicKey.toBase58();
  const treasury = deriveTreasuryKeypair({
    masterKey: MASTER,
    treasuryId: "platform-payout",
  }).publicKey.toBase58();
  const topup = deriveTopupDepositKeypair({
    masterKey: MASTER,
    orgId: "platform-payout",
  }).publicKey.toBase58();
  assert.notEqual(payout, treasury);
  assert.notEqual(payout, topup);
});

test("weak or missing master keys are refused", () => {
  assert.throws(() => derivePayoutKeypair("short"), /at least 32/);
  assert.throws(() => derivePayoutKeypair(""), /required/);
});
