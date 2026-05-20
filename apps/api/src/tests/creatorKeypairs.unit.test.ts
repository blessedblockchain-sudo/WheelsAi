import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveCreatorKeypair,
  makeCreatorSignerProvider,
} from "../services/creatorKeypairs.js";
import { deriveTreasuryKeypair } from "../services/treasuryKeypairs.js";

const MASTER_KEY = "x".repeat(32); // exactly the minimum length

test("deriveCreatorKeypair is deterministic for the same master+orgId", () => {
  const a = deriveCreatorKeypair({ masterKey: MASTER_KEY, orgId: "org-1" });
  const b = deriveCreatorKeypair({ masterKey: MASTER_KEY, orgId: "org-1" });
  assert.equal(a.publicKey.toBase58(), b.publicKey.toBase58());
});

test("deriveCreatorKeypair returns distinct keys for distinct orgs", () => {
  const a = deriveCreatorKeypair({ masterKey: MASTER_KEY, orgId: "org-1" });
  const b = deriveCreatorKeypair({ masterKey: MASTER_KEY, orgId: "org-2" });
  assert.notEqual(a.publicKey.toBase58(), b.publicKey.toBase58());
});

test("deriveCreatorKeypair rotates output when master key rotates", () => {
  const a = deriveCreatorKeypair({ masterKey: MASTER_KEY, orgId: "org-1" });
  const b = deriveCreatorKeypair({
    masterKey: "y".repeat(32),
    orgId: "org-1",
  });
  assert.notEqual(a.publicKey.toBase58(), b.publicKey.toBase58());
});

test("deriveCreatorKeypair domain-separates from treasury derivation", () => {
  // The two HKDF salts are distinct ("wheelsai-creator-v1" vs
  // "wheelsai-treasury-v1"). Same orgId/treasuryId input MUST yield
  // different keys — otherwise a master-key compromise on one surface
  // leaks the other.
  const creator = deriveCreatorKeypair({
    masterKey: MASTER_KEY,
    orgId: "shared-id",
  });
  const treasury = deriveTreasuryKeypair({
    masterKey: MASTER_KEY,
    treasuryId: "shared-id",
  });
  assert.notEqual(creator.publicKey.toBase58(), treasury.publicKey.toBase58());
});

test("deriveCreatorKeypair rejects short master keys", () => {
  assert.throws(
    () =>
      deriveCreatorKeypair({
        masterKey: "too-short",
        orgId: "org-1",
      }),
    /at least 32 characters/,
  );
});

test("deriveCreatorKeypair rejects empty inputs", () => {
  assert.throws(
    () => deriveCreatorKeypair({ masterKey: "", orgId: "org-1" }),
    /WALLET_MASTER_KEY required/,
  );
  assert.throws(
    () => deriveCreatorKeypair({ masterKey: MASTER_KEY, orgId: "" }),
    /orgId required/,
  );
});

test("makeCreatorSignerProvider caches per-org keypairs", () => {
  const provider = makeCreatorSignerProvider({ masterKey: MASTER_KEY });
  const first = provider("org-1");
  const second = provider("org-1");
  assert.strictEqual(first, second); // same instance from cache
  const other = provider("org-2");
  assert.notEqual(first.publicKey.toBase58(), other.publicKey.toBase58());
});
