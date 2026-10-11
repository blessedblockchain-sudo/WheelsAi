import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDepositAddressStore,
  issueDepositAddress,
  readDepositAddress,
  readUsdcAccountOpen,
  type DepositAddressDeps,
} from "../services/depositAddresses.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import { addressFromSeed, addressRow, HOSTILE, makeFakeDb, type FakeDb } from "./depositFakes.js";

// Drives apps/api/src/services/depositAddresses.ts: issuing and reading an
// organization's deposit address, over the real store bound to a stand-in
// database.
//
// The rules these tests hold it to:
//   - reading never writes; issuing twice makes one row;
//   - a stored address that is not the derived one is never shown;
//   - a row of another network reads as none, and issuing re-labels it and
//     clears what was read on the other network.

const MASTER_KEY = "unit-test-master-key-0123456789abcdef";
const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-11T12:00:00.000Z");

const derive = (orgId: string) =>
  deriveTopupDepositKeypair({ masterKey: MASTER_KEY, orgId }).publicKey.toBase58();

function makeDeps(
  db: FakeDb,
  over: Partial<DepositAddressDeps> = {},
): DepositAddressDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    store: buildDepositAddressStore(db),
    deriveAddress: derive,
    network: "solana:devnet",
    usdcAccountExists: async (address) => {
      reads.push(address);
      return false;
    },
    now: () => NOW,
    reads,
    ...over,
  };
}

test("the address is the one prepared top-ups pay into, and differs by organization", () => {
  assert.equal(derive(ORG), derive(ORG));
  assert.notEqual(derive(ORG), derive(OTHER_ORG));
});

test("reading with no row is none, and writes nothing", async () => {
  const db = makeFakeDb();
  const read = await readDepositAddress(makeDeps(db), ORG);
  assert.deepEqual(read, { kind: "none" });
  assert.equal(db.addresses.size, 0);
  assert.deepEqual(db.writes, []);
});

test("issuing creates the row with the derived address and this network's label", async () => {
  const db = makeFakeDb();
  const issued = await issueDepositAddress(makeDeps(db), ORG);
  assert.equal(issued.kind, "issued");
  assert.equal(issued.kind === "issued" && issued.row.address, derive(ORG));
  const stored = db.addresses.get(ORG)!;
  assert.equal(stored.address, derive(ORG));
  assert.equal(stored.network, "solana:devnet");
  assert.deepEqual(db.writes, ["create"]);
});

test("the label follows the configured network", async () => {
  const db = makeFakeDb();
  await issueDepositAddress(makeDeps(db, { network: "solana:mainnet" }), ORG);
  assert.equal(db.addresses.get(ORG)!.network, "solana:mainnet");
});

test("issuing twice makes one row, and the second call writes nothing", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db);
  const first = await issueDepositAddress(deps, ORG);
  const second = await issueDepositAddress(deps, ORG);
  assert.deepEqual(second, first);
  assert.equal(db.addresses.size, 1);
  assert.deepEqual(db.writes, ["create"]);
});

test("two requests issuing at once make one row and both get the address", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db);
  const [a, b] = await Promise.all([
    issueDepositAddress(deps, ORG),
    issueDepositAddress(deps, ORG),
  ]);
  assert.equal(a.kind, "issued");
  assert.deepEqual(a, b);
  assert.equal(db.addresses.size, 1);
  assert.deepEqual(db.writes, ["create"]);
});

test("reading an issued address never writes", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db);
  await issueDepositAddress(deps, ORG);
  db.writes.length = 0;
  const before = JSON.stringify([...db.addresses.values()], (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  const read = await readDepositAddress(deps, ORG);
  assert.equal(read.kind, "issued");
  assert.deepEqual(db.writes, []);
  assert.equal(
    JSON.stringify([...db.addresses.values()], (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
    before,
  );
});

test("a stored address that is not the derived one is a mismatch, on read and on issue, and is left alone", async () => {
  const db = makeFakeDb();
  const wrong = addressFromSeed(77);
  db.addresses.set(ORG, addressRow({ orgId: ORG, address: wrong }));
  const deps = makeDeps(db);
  assert.deepEqual(await readDepositAddress(deps, ORG), { kind: "mismatch" });
  assert.deepEqual(await issueDepositAddress(deps, ORG), { kind: "mismatch" });
  assert.equal(db.addresses.get(ORG)!.address, wrong);
  assert.deepEqual(db.writes, []);
});

test("a wrong stored address labelled for another network is a mismatch too, never re-labelled", async () => {
  const db = makeFakeDb();
  db.addresses.set(
    ORG,
    addressRow({ orgId: ORG, address: addressFromSeed(77), network: "solana:mainnet" }),
  );
  const deps = makeDeps(db);
  assert.deepEqual(await readDepositAddress(deps, ORG), { kind: "mismatch" });
  assert.deepEqual(await issueDepositAddress(deps, ORG), { kind: "mismatch" });
  assert.equal(db.addresses.get(ORG)!.network, "solana:mainnet");
  assert.deepEqual(db.writes, []);
});

test("a row of another network reads as none, and reading leaves it as it was", async () => {
  const db = makeFakeDb();
  db.addresses.set(
    ORG,
    addressRow({
      orgId: ORG,
      address: derive(ORG),
      network: "solana:mainnet",
      lastSolSignature: "sigA",
    }),
  );
  assert.deepEqual(await readDepositAddress(makeDeps(db), ORG), { kind: "none" });
  assert.equal(db.addresses.get(ORG)!.network, "solana:mainnet");
  assert.equal(db.addresses.get(ORG)!.lastSolSignature, "sigA");
  assert.deepEqual(db.writes, []);
});

test("issuing re-labels a row of another network and clears what was read there", async () => {
  const db = makeFakeDb();
  const then = new Date("2026-09-01T00:00:00.000Z");
  db.addresses.set(
    ORG,
    addressRow({
      orgId: ORG,
      address: derive(ORG),
      network: "solana:mainnet",
      usdcAccountOpenedAt: then,
      usdcAccountOpenedBy: "platform",
      usdcAccountRequestedAt: then,
      lastSolSignature: "sigA",
      lastUsdcSignature: "sigB",
      lastSeenLamports: 123n,
      lastSeenUsdcRaw: 456n,
      scanRequestedAt: then,
      lastScannedAt: then,
    }),
  );
  const issued = await issueDepositAddress(makeDeps(db), ORG);
  assert.equal(issued.kind, "issued");
  assert.equal(db.addresses.size, 1);
  const stored = db.addresses.get(ORG)!;
  assert.equal(stored.address, derive(ORG));
  assert.equal(stored.network, "solana:devnet");
  assert.equal(stored.usdcAccountOpenedAt, null);
  assert.equal(stored.usdcAccountOpenedBy, null);
  assert.equal(stored.usdcAccountRequestedAt, null);
  assert.equal(stored.lastSolSignature, null);
  assert.equal(stored.lastUsdcSignature, null);
  assert.equal(stored.lastSeenLamports, 0n);
  assert.equal(stored.lastSeenUsdcRaw, 0n);
  assert.equal(stored.scanRequestedAt, null);
  assert.equal(stored.lastScannedAt, null);
  // The answer is the row as it now is, not as it was.
  assert.equal(issued.kind === "issued" && issued.row.usdcAccountOpenedAt, null);
});

test("a row of this network is not cleared by issuing again", async () => {
  const db = makeFakeDb();
  db.addresses.set(
    ORG,
    addressRow({ orgId: ORG, address: derive(ORG), lastSolSignature: "sigA", lastSeenLamports: 9n }),
  );
  await issueDepositAddress(makeDeps(db), ORG);
  assert.equal(db.addresses.get(ORG)!.lastSolSignature, "sigA");
  assert.equal(db.addresses.get(ORG)!.lastSeenLamports, 9n);
  assert.deepEqual(db.writes, []);
});

test("a database that fails is thrown to the caller, never read as 'no address'", async () => {
  const db = makeFakeDb();
  db.failNext.find = new Error(HOSTILE);
  await assert.rejects(() => readDepositAddress(makeDeps(db), ORG));
});

test("a key that cannot be derived is thrown, and no row is made", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db, {
    deriveAddress: (orgId) =>
      deriveTopupDepositKeypair({ masterKey: "", orgId }).publicKey.toBase58(),
  });
  await assert.rejects(() => issueDepositAddress(deps, ORG));
  assert.equal(db.addresses.size, 0);
});

// ---- the USDC account ----

test("accountOpen: a recorded opening is true with no chain read", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db);
  const row = addressRow({ orgId: ORG, address: derive(ORG), usdcAccountOpenedAt: NOW });
  assert.equal(await readUsdcAccountOpen(deps, row, { record: true }), true);
  assert.deepEqual(deps.reads, []);
});

test("accountOpen: one read; not there is false and nothing is stored", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db);
  db.addresses.set(ORG, addressRow({ orgId: ORG, address: derive(ORG) }));
  const row = db.addresses.get(ORG)!;
  assert.equal(await readUsdcAccountOpen(deps, row, { record: true }), false);
  assert.deepEqual(deps.reads, [derive(ORG)]);
  assert.deepEqual(db.writes, []);
});

test("accountOpen: seen with record stores when it was first seen, and not who opened it", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db, { usdcAccountExists: async () => true });
  db.addresses.set(ORG, addressRow({ orgId: ORG, address: derive(ORG) }));
  assert.equal(
    await readUsdcAccountOpen(deps, { ...db.addresses.get(ORG)! }, { record: true }),
    true,
  );
  assert.equal(db.addresses.get(ORG)!.usdcAccountOpenedAt?.getTime(), NOW.getTime());
  assert.equal(db.addresses.get(ORG)!.usdcAccountOpenedBy, null);
});

test("accountOpen: seen without record is true and writes nothing", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db, { usdcAccountExists: async () => true });
  db.addresses.set(ORG, addressRow({ orgId: ORG, address: derive(ORG) }));
  assert.equal(
    await readUsdcAccountOpen(deps, { ...db.addresses.get(ORG)! }, { record: false }),
    true,
  );
  assert.equal(db.addresses.get(ORG)!.usdcAccountOpenedAt, null);
  assert.deepEqual(db.writes, []);
});

test("accountOpen: a read that fails is false, and nothing is stored", async () => {
  const db = makeFakeDb();
  const deps = makeDeps(db, {
    usdcAccountExists: async () => {
      throw new Error(HOSTILE);
    },
  });
  db.addresses.set(ORG, addressRow({ orgId: ORG, address: derive(ORG) }));
  assert.equal(
    await readUsdcAccountOpen(deps, { ...db.addresses.get(ORG)! }, { record: true }),
    false,
  );
  assert.deepEqual(db.writes, []);
});

// ---- the rest of the store ----

test("store: an opening already recorded is never overwritten", async () => {
  const db = makeFakeDb();
  const store = buildDepositAddressStore(db);
  const first = new Date("2026-10-01T00:00:00.000Z");
  db.addresses.set(
    ORG,
    addressRow({ orgId: ORG, address: derive(ORG), usdcAccountOpenedAt: first, usdcAccountOpenedBy: null }),
  );
  assert.equal(await store.markUsdcAccountOpen({ orgId: ORG, at: NOW, by: "platform" }), false);
  assert.equal(db.addresses.get(ORG)!.usdcAccountOpenedAt, first);
  assert.equal(db.addresses.get(ORG)!.usdcAccountOpenedBy, null);
});

test("store: the request claim is a compare-and-set on the value that was read", async () => {
  const db = makeFakeDb();
  const store = buildDepositAddressStore(db);
  db.addresses.set(ORG, addressRow({ orgId: ORG, address: derive(ORG) }));
  const later = new Date(NOW.getTime() + 1_000);
  assert.equal(await store.claimUsdcAccountRequest({ orgId: ORG, expected: null, at: NOW }), true);
  // A second request that read null loses.
  assert.equal(await store.claimUsdcAccountRequest({ orgId: ORG, expected: null, at: later }), false);
  assert.equal(db.addresses.get(ORG)!.usdcAccountRequestedAt?.getTime(), NOW.getTime());
  // One that read the stored time wins.
  assert.equal(
    await store.claimUsdcAccountRequest({ orgId: ORG, expected: new Date(NOW.getTime()), at: later }),
    true,
  );
});

test("store: the day's count is of rows requested at or after the given time", async () => {
  const db = makeFakeDb();
  const store = buildDepositAddressStore(db);
  const dayStart = new Date("2026-10-11T00:00:00.000Z");
  db.addresses.set("a", addressRow({ orgId: "a", address: "A", usdcAccountRequestedAt: dayStart }));
  db.addresses.set("b", addressRow({ orgId: "b", address: "B", usdcAccountRequestedAt: NOW }));
  db.addresses.set(
    "c",
    addressRow({ orgId: "c", address: "C", usdcAccountRequestedAt: new Date("2026-10-10T23:59:59.999Z") }),
  );
  db.addresses.set("d", addressRow({ orgId: "d", address: "D" }));
  assert.equal(await store.countUsdcAccountRequestsSince(dayStart), 2);
});

test("store: asking for a scan marks only this organization's row of this network", async () => {
  const db = makeFakeDb();
  const store = buildDepositAddressStore(db);
  db.addresses.set(ORG, addressRow({ orgId: ORG, address: derive(ORG) }));
  db.addresses.set(OTHER_ORG, addressRow({ orgId: OTHER_ORG, address: derive(OTHER_ORG) }));
  assert.equal(await store.requestScan({ orgId: ORG, network: "solana:mainnet", at: NOW }), false);
  assert.equal(db.addresses.get(ORG)!.scanRequestedAt, null);
  assert.equal(await store.requestScan({ orgId: ORG, network: "solana:devnet", at: NOW }), true);
  assert.equal(db.addresses.get(ORG)!.scanRequestedAt?.getTime(), NOW.getTime());
  assert.equal(db.addresses.get(OTHER_ORG)!.scanRequestedAt, null);
});

test("store: eligible with a verified member, or with one purchase above zero, and not otherwise", async () => {
  const db = makeFakeDb();
  const store = buildDepositAddressStore(db);
  assert.equal(await store.isEligible(ORG), false);

  db.members.push({ orgId: ORG, userId: "u1", emailVerified: false });
  db.members.push({ orgId: OTHER_ORG, userId: "u2", emailVerified: true });
  db.transactions.push({ orgId: ORG, type: "bonus", amountCents: 500n });
  db.transactions.push({ orgId: ORG, type: "purchase", amountCents: 0n });
  db.transactions.push({ orgId: OTHER_ORG, type: "purchase", amountCents: 500n });
  assert.equal(await store.isEligible(ORG), false);

  db.transactions.push({ orgId: ORG, type: "purchase", amountCents: 500n });
  assert.equal(await store.isEligible(ORG), true);

  const verified = makeFakeDb();
  verified.members.push({ orgId: ORG, userId: "u1", emailVerified: true });
  assert.equal(await buildDepositAddressStore(verified).isEligible(ORG), true);
});

test("store: the list is this organization's direct receipts of this network, newest first, at most the limit", async () => {
  const db = makeFakeDb();
  const store = buildDepositAddressStore(db);
  const receipt = (id: string, minutesAgo: number, over: Record<string, unknown> = {}) => ({
    id,
    orgId: ORG,
    network: "solana:devnet",
    source: "direct",
    asset: "USDC",
    amountRaw: 1_000_000n,
    status: "credited",
    ignoredReason: null,
    amountUsdCents: 100n,
    bonusCents: 0n,
    txSignature: `sig-${id}`,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    creditedAt: NOW,
    ...over,
  });
  db.receipts.push(
    receipt("old", 30),
    receipt("new", 1, { asset: "SOL" }),
    receipt("prepared", 2, { source: "prepared" }),
    receipt("other-org", 3, { orgId: OTHER_ORG }),
    receipt("mainnet", 4, { network: "solana:mainnet" }),
    receipt("mid", 10),
  );
  const listed = await store.listDirectReceipts({ orgId: ORG, network: "solana:devnet", limit: 20 });
  assert.deepEqual(listed.map((row) => row.id), ["new", "mid", "old"]);
  assert.equal(listed[0]!.asset, "SOL");
  // Only the columns the list shows.
  assert.deepEqual(Object.keys(listed[0]!).sort(), [
    "amountRaw",
    "amountUsdCents",
    "asset",
    "bonusCents",
    "createdAt",
    "creditedAt",
    "id",
    "status",
    "txSignature",
  ]);
  const two = await store.listDirectReceipts({ orgId: ORG, network: "solana:devnet", limit: 2 });
  assert.deepEqual(two.map((row) => row.id), ["new", "mid"]);
});
