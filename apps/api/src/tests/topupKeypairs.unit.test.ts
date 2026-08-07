import assert from "node:assert/strict";
import test from "node:test";

import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import { deriveTreasuryKeypair } from "../services/treasuryKeypairs.js";

// Per-org deposit addresses for the wallet top-up rail (B2/T5). Same
// HKDF construction as the treasury keys, DIFFERENT salt — the property
// that matters is that the two families can never collide.

const MASTER = "test-master-key-0123456789abcdef-xyz";
const ORG = "3f782d00-c346-45ba-85a9-f01b7d5f7ed5";

test("derivation is deterministic per (masterKey, orgId)", () => {
  const a = deriveTopupDepositKeypair({ masterKey: MASTER, orgId: ORG });
  const b = deriveTopupDepositKeypair({ masterKey: MASTER, orgId: ORG });
  assert.equal(a.publicKey.toBase58(), b.publicKey.toBase58());
});

test("different orgs get different deposit addresses", () => {
  const a = deriveTopupDepositKeypair({ masterKey: MASTER, orgId: "org-a" });
  const b = deriveTopupDepositKeypair({ masterKey: MASTER, orgId: "org-b" });
  assert.notEqual(a.publicKey.toBase58(), b.publicKey.toBase58());
});

test("the topup salt is disjoint from the treasury salt — same info string, different key", () => {
  const topup = deriveTopupDepositKeypair({ masterKey: MASTER, orgId: ORG });
  const treasury = deriveTreasuryKeypair({ masterKey: MASTER, treasuryId: ORG });
  assert.notEqual(topup.publicKey.toBase58(), treasury.publicKey.toBase58());
});

test("weak or missing inputs are refused", () => {
  assert.throws(
    () => deriveTopupDepositKeypair({ masterKey: "short", orgId: ORG }),
    /at least 32/,
  );
  assert.throws(
    () => deriveTopupDepositKeypair({ masterKey: "", orgId: ORG }),
    /required/,
  );
  assert.throws(
    () => deriveTopupDepositKeypair({ masterKey: MASTER, orgId: "" }),
    /orgId required/,
  );
});
