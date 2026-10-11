import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";

import {
  buildDepositAddressStore,
  readDepositAddress,
} from "../services/depositAddresses.js";
import {
  buildDepositUsdcChain,
  buildOpenUsdcAccountTransaction,
  isTokenAccount,
  prepareUsdcAccount,
  startOfUtcDay,
  USDC_ACCOUNT_WAIT_MS,
  type DepositUsdcConnection,
  type PrepareUsdcAccountDeps,
} from "../services/depositUsdcAccount.js";
import { buildHotWallet, solToLamports } from "../services/hotWallet.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import { addressFromSeed, addressRow, HOSTILE, makeFakeDb, type FakeDb } from "./depositFakes.js";

// Drives apps/api/src/services/depositUsdcAccount.ts ("Prepare address")
// and services/hotWallet.ts, with stand-ins only.
//
// The rules these tests hold it to:
//   - the steps run in the order the plan gives, and each refusal comes
//     before anything later is read or sent;
//   - at most one transaction is sent, holding one instruction: the
//     idempotent create of the address's USDC account;
//   - nothing is sent when the account is there, when a send was made
//     under two minutes ago, or when the claim is lost.

const ORG = "11111111-1111-4111-8111-111111111111";
const ADDRESS = addressFromSeed(21);
const MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const NOW = new Date("2026-10-11T12:00:00.000Z");
const MIN_LAMPORTS = 50_000_000n;

interface Harness {
  db: FakeDb;
  deps: PrepareUsdcAccountDeps;
  /** Everything asked of the outside world, in order. */
  calls: string[];
  sent: string[];
  slept: number[];
  world: {
    /** Whether the account is there, for each read in turn (the last repeats). */
    exists: Array<boolean | Error>;
    cluster: { ok: boolean; reason?: string };
    hotWalletLamports: bigint | Error;
    sendThrows: Error | null;
    /** Makes the account appear once a send was made. */
    appearsAfterSend: boolean;
  };
}

function harness(over: Partial<PrepareUsdcAccountDeps> = {}): Harness {
  const db = makeFakeDb();
  db.addresses.set(ORG, addressRow({ orgId: ORG, address: ADDRESS }));
  db.members.push({ orgId: ORG, userId: "u1", emailVerified: true });
  const store = buildDepositAddressStore(db);
  const calls: string[] = [];
  const sent: string[] = [];
  const slept: number[] = [];
  const world: Harness["world"] = {
    exists: [false],
    cluster: { ok: true },
    hotWalletLamports: 1_000_000_000n,
    sendThrows: null,
    appearsAfterSend: false,
  };
  let reads = 0;
  const deps: PrepareUsdcAccountDeps = {
    readAddress: (orgId) =>
      readDepositAddress(
        { store, deriveAddress: () => ADDRESS, network: "solana:devnet" },
        orgId,
      ),
    store: {
      markUsdcAccountOpen: store.markUsdcAccountOpen,
      claimUsdcAccountRequest: store.claimUsdcAccountRequest,
      countUsdcAccountRequestsSince: async (since) => {
        calls.push("count");
        return store.countUsdcAccountRequestsSince(since);
      },
      isEligible: async (orgId) => {
        calls.push("eligible");
        return store.isEligible(orgId);
      },
    },
    usdcAccountExists: async () => {
      calls.push("exists");
      if (world.appearsAfterSend && sent.length > 0) return true;
      const answer = world.exists[Math.min(reads, world.exists.length - 1)]!;
      reads += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    ensureCluster: async () => {
      calls.push("cluster");
      return world.cluster;
    },
    readHotWalletLamports: async () => {
      calls.push("balance");
      if (world.hotWalletLamports instanceof Error) throw world.hotWalletLamports;
      return world.hotWalletLamports;
    },
    minHotWalletLamports: MIN_LAMPORTS,
    dailyLimit: 25,
    sendOpenUsdcAccount: async (address) => {
      calls.push("send");
      if (world.sendThrows) throw world.sendThrows;
      sent.push(address);
    },
    now: () => NOW,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...over,
  };
  return { db, deps, calls, sent, slept, world };
}

const stored = (h: Harness) => h.db.addresses.get(ORG)!;

// ---- (a) ----

test("(a) no address: not_issued, and nothing is read or sent", async () => {
  const h = harness();
  h.db.addresses.clear();
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "not_issued" });
  assert.deepEqual(h.calls, []);
});

test("(a) a row of another network is no address on this one", async () => {
  const h = harness();
  stored(h).network = "solana:mainnet";
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "not_issued" });
  assert.deepEqual(h.calls, []);
});

test("(a) a stored address that is not the derived one: address_unavailable, nothing read or sent", async () => {
  const h = harness();
  stored(h).address = addressFromSeed(99);
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "address_unavailable" });
  assert.deepEqual(h.calls, []);
});

// ---- (b) ----

test("(b) an opening already recorded: open with no chain read and nothing sent", async () => {
  const h = harness();
  stored(h).usdcAccountOpenedAt = new Date("2026-10-01T00:00:00.000Z");
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: false });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.db.writes, []);
});

test("(b) the account is found on the chain: recorded, nothing sent, and it comes before eligibility", async () => {
  const h = harness();
  h.db.members.length = 0; // not eligible, and it does not matter
  h.world.exists = [true];
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: false });
  assert.deepEqual(h.calls, ["exists"]);
  assert.deepEqual(h.sent, []);
  assert.equal(stored(h).usdcAccountOpenedAt?.getTime(), NOW.getTime());
  // The sender opened it, not the platform.
  assert.equal(stored(h).usdcAccountOpenedBy, null);
  assert.equal(stored(h).usdcAccountRequestedAt, null);
});

// ---- (c) ----

test("(c) not eligible: refused before the limit, the cluster, the hot wallet and any send", async () => {
  const h = harness();
  h.db.members.length = 0;
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "not_eligible" });
  assert.deepEqual(h.calls, ["exists", "eligible"]);
  assert.deepEqual(h.db.writes, []);
});

test("(c) one purchase makes an organization eligible", async () => {
  const h = harness();
  h.db.members.length = 0;
  h.db.transactions.push({ orgId: ORG, type: "purchase", amountCents: 500n });
  h.world.appearsAfterSend = true;
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: true });
});

// ---- (d) ----

test("(d) a send under two minutes ago: nothing is sent or checked, the account is looked for", async () => {
  const h = harness();
  stored(h).usdcAccountRequestedAt = new Date(NOW.getTime() - 119_000);
  h.world.exists = [false, false, true];
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: false });
  assert.deepEqual(h.calls, ["exists", "eligible", "exists", "exists"]);
  assert.deepEqual(h.sent, []);
  // The platform's earlier send opened it.
  assert.equal(stored(h).usdcAccountOpenedBy, "platform");
  // The time of that send is left as it was.
  assert.equal(stored(h).usdcAccountRequestedAt?.getTime(), NOW.getTime() - 119_000);
});

test("(d) holds even when the day's limit is reached and the hot wallet is empty", async () => {
  const h = harness({ dailyLimit: 0 });
  stored(h).usdcAccountRequestedAt = new Date(NOW.getTime() - 5_000);
  h.world.hotWalletLamports = 0n;
  h.world.exists = [false, true];
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: false });
  assert.ok(!h.calls.includes("count") && !h.calls.includes("balance"));
});

test("(d) a send two minutes ago or more is sent again", async () => {
  const h = harness();
  stored(h).usdcAccountRequestedAt = new Date(NOW.getTime() - 120_000);
  h.world.appearsAfterSend = true;
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: true });
  assert.deepEqual(h.sent, [ADDRESS]);
  assert.equal(stored(h).usdcAccountRequestedAt?.getTime(), NOW.getTime());
});

// ---- (e) ----

test("(e) the day's limit: refused before the cluster, the hot wallet and any send", async () => {
  const h = harness({ dailyLimit: 2 });
  const today = startOfUtcDay(NOW);
  h.db.addresses.set("a", addressRow({ orgId: "a", address: "A", usdcAccountRequestedAt: today }));
  h.db.addresses.set("b", addressRow({ orgId: "b", address: "B", usdcAccountRequestedAt: NOW }));
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "daily_limit" });
  assert.deepEqual(h.calls, ["exists", "eligible", "count"]);
  assert.equal(stored(h).usdcAccountRequestedAt, null);
});

test("(e) yesterday's sends do not count", async () => {
  const h = harness({ dailyLimit: 1 });
  h.db.addresses.set(
    "a",
    addressRow({ orgId: "a", address: "A", usdcAccountRequestedAt: new Date("2026-10-10T23:59:59.999Z") }),
  );
  h.world.appearsAfterSend = true;
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: true });
});

test("(e) a limit of 0 opens none", async () => {
  const h = harness({ dailyLimit: 0 });
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "daily_limit" });
  assert.deepEqual(h.sent, []);
});

test("the day starts at midnight UTC", () => {
  assert.equal(startOfUtcDay(NOW).toISOString(), "2026-10-11T00:00:00.000Z");
  assert.equal(
    startOfUtcDay(new Date("2026-10-11T23:59:59.999Z")).toISOString(),
    "2026-10-11T00:00:00.000Z",
  );
});

// ---- (f) ----

test("(f) the cluster check refuses: unavailable, the hot wallet is not read, nothing is claimed or sent", async () => {
  const h = harness();
  h.world.cluster = { ok: false, reason: "wrong_cluster" };
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), {
    outcome: "unavailable",
    reason: "cluster",
  });
  assert.deepEqual(h.calls, ["exists", "eligible", "count", "cluster"]);
  assert.equal(stored(h).usdcAccountRequestedAt, null);
});

test("(f) the hot wallet holds under the minimum: unavailable, nothing is claimed or sent", async () => {
  const h = harness();
  h.world.hotWalletLamports = MIN_LAMPORTS - 1n;
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), {
    outcome: "unavailable",
    reason: "hot_wallet_low",
  });
  assert.deepEqual(h.calls, ["exists", "eligible", "count", "cluster", "balance"]);
  assert.equal(stored(h).usdcAccountRequestedAt, null);
  assert.deepEqual(h.sent, []);
});

test("(f) the hot wallet holding exactly the minimum is enough", async () => {
  const h = harness();
  h.world.hotWalletLamports = MIN_LAMPORTS;
  h.world.appearsAfterSend = true;
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: true });
});

test("(f) the hot wallet cannot be read: unavailable, nothing is claimed or sent", async () => {
  const h = harness();
  h.world.hotWalletLamports = new Error(HOSTILE);
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), {
    outcome: "unavailable",
    reason: "hot_wallet_unreadable",
  });
  assert.equal(stored(h).usdcAccountRequestedAt, null);
  assert.deepEqual(h.sent, []);
});

// ---- (g) ----

test("(g) the time is claimed before the one send, and the steps run in order", async () => {
  const h = harness();
  let requestedAtWhenSent: Date | null = null;
  const send = h.deps.sendOpenUsdcAccount;
  h.deps.sendOpenUsdcAccount = async (address) => {
    requestedAtWhenSent = stored(h).usdcAccountRequestedAt;
    await send(address);
  };
  h.world.appearsAfterSend = true;
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: true });
  assert.deepEqual(h.calls, ["exists", "eligible", "count", "cluster", "balance", "send", "exists"]);
  assert.deepEqual(h.sent, [ADDRESS]);
  assert.equal((requestedAtWhenSent as Date | null)?.getTime(), NOW.getTime());
});

test("(g) a lost claim sends nothing and looks for the account", async () => {
  const h = harness();
  h.deps.store = {
    ...h.deps.store,
    // Another request took the send between the read and the claim.
    claimUsdcAccountRequest: async () => false,
  };
  h.world.exists = [false, true];
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: false });
  assert.deepEqual(h.sent, []);
  assert.ok(!h.calls.includes("send"));
});

test("(g) two requests at once send one transaction", async () => {
  const h = harness();
  h.world.appearsAfterSend = true;
  const [a, b] = await Promise.all([
    prepareUsdcAccount(h.deps, ORG),
    prepareUsdcAccount(h.deps, ORG),
  ]);
  assert.equal(a.outcome, "open");
  assert.equal(b.outcome, "open");
  assert.deepEqual(h.sent, [ADDRESS]);
});

test("(g) a send that throws is unavailable; the claim stays, so the next press waits and does not send again", async () => {
  const h = harness();
  h.world.sendThrows = new Error(HOSTILE);
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), {
    outcome: "unavailable",
    reason: "send_failed",
  });
  assert.equal(stored(h).usdcAccountRequestedAt?.getTime(), NOW.getTime());
  assert.equal(stored(h).usdcAccountOpenedAt, null);

  // The send may have reached the chain all the same.
  h.world.sendThrows = null;
  h.calls.length = 0;
  h.world.exists = [false, true];
  const again = await prepareUsdcAccount(
    { ...h.deps, now: () => new Date(NOW.getTime() + 10_000) },
    ORG,
  );
  assert.deepEqual(again, { outcome: "open", sent: false });
  assert.ok(!h.calls.includes("send"));
});

// ---- (h) ----

test("(h) seen: the opening is recorded as the platform's", async () => {
  const h = harness();
  h.world.appearsAfterSend = true;
  await prepareUsdcAccount(h.deps, ORG);
  assert.equal(stored(h).usdcAccountOpenedAt?.getTime(), NOW.getTime());
  assert.equal(stored(h).usdcAccountOpenedBy, "platform");
});

test("(h) not seen within 45 seconds: unavailable, nothing recorded as open, one send only", async () => {
  const h = harness();
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), {
    outcome: "unavailable",
    reason: "not_seen",
  });
  assert.equal(h.slept.reduce((sum, ms) => sum + ms, 0), USDC_ACCOUNT_WAIT_MS);
  assert.equal(USDC_ACCOUNT_WAIT_MS, 45_000);
  assert.deepEqual(h.sent, [ADDRESS]);
  assert.equal(stored(h).usdcAccountOpenedAt, null);
});

test("(h) pressing again later finds it open, by (b), and sends nothing", async () => {
  const h = harness();
  await prepareUsdcAccount(h.deps, ORG);
  h.world.exists = [true];
  h.world.appearsAfterSend = true;
  h.calls.length = 0;
  const again = await prepareUsdcAccount(
    { ...h.deps, now: () => new Date(NOW.getTime() + 10 * 60_000) },
    ORG,
  );
  assert.deepEqual(again, { outcome: "open", sent: false });
  assert.deepEqual(h.calls, ["exists"]);
  assert.deepEqual(h.sent, [ADDRESS]);
});

test("(h) a read that fails while looking is tried again, and decides nothing", async () => {
  const h = harness();
  h.world.exists = [false, new Error(HOSTILE), new Error(HOSTILE), true];
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), { outcome: "open", sent: true });
});

test("(b) a first read that fails is not 'open': the later steps still decide", async () => {
  const h = harness();
  h.world.exists = [new Error(HOSTILE)];
  h.world.cluster = { ok: false, reason: "unreachable" };
  assert.deepEqual(await prepareUsdcAccount(h.deps, ORG), {
    outcome: "unavailable",
    reason: "cluster",
  });
  assert.deepEqual(h.sent, []);
});

// ---- the transaction ----

test("the transaction holds one instruction only: the idempotent create of the address's USDC account", () => {
  const payer = Keypair.fromSeed(new Uint8Array(32).fill(5));
  const owner = new PublicKey(ADDRESS);
  const tx = buildOpenUsdcAccountTransaction({
    payer: payer.publicKey,
    owner,
    usdcMint: MINT,
    blockhash: addressFromSeed(6),
    lastValidBlockHeight: 1_000,
  });
  assert.equal(tx.instructions.length, 1);
  const only = tx.instructions[0]!;
  assert.ok(only.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  // Instruction 1 of the associated token program is CreateIdempotent.
  assert.deepEqual([...only.data], [1]);
  const ata = getAssociatedTokenAddressSync(MINT, owner);
  assert.deepEqual(
    only.keys.map((key) => key.pubkey.toBase58()),
    [
      payer.publicKey.toBase58(),
      ata.toBase58(),
      owner.toBase58(),
      MINT.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ],
  );
  // The hot wallet pays and is the only signer.
  assert.ok(tx.feePayer?.equals(payer.publicKey));
  assert.deepEqual(
    only.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58()),
    [payer.publicKey.toBase58()],
  );
});

test("an address that only holds SOL is not a token account", () => {
  const data = { byteLength: 165 };
  assert.equal(isTokenAccount(null), false);
  assert.equal(isTokenAccount(undefined), false);
  assert.equal(isTokenAccount({ owner: SystemProgram.programId, data: { byteLength: 0 } }), false);
  assert.equal(isTokenAccount({ owner: SystemProgram.programId, data }), false);
  assert.equal(isTokenAccount({ owner: TOKEN_PROGRAM_ID, data: { byteLength: 82 } }), false);
  assert.equal(isTokenAccount({ owner: TOKEN_PROGRAM_ID, data }), true);
});

// ---- the chain binding ----

function chainHarness(cluster: { ok: boolean; reason?: string } = { ok: true }) {
  const payer = Keypair.fromSeed(new Uint8Array(32).fill(5));
  const asked: string[] = [];
  const sentRaw: Buffer[] = [];
  let account: { owner: PublicKey; data: Buffer } | null = null;
  const connection = {
    getAccountInfo: async (key: PublicKey, commitment: unknown) => {
      asked.push(`account:${key.toBase58()}:${String(commitment)}`);
      return account;
    },
    getLatestBlockhash: async () => {
      asked.push("blockhash");
      return { blockhash: addressFromSeed(6), lastValidBlockHeight: 1_000 };
    },
    sendRawTransaction: async (raw: Buffer | Uint8Array | number[]) => {
      asked.push("send");
      sentRaw.push(Buffer.from(raw as Uint8Array));
      return "signature";
    },
  } as unknown as DepositUsdcConnection;
  const chain = buildDepositUsdcChain({
    getConnection: () => connection,
    ensureCluster: async () => cluster,
    usdcMint: MINT,
    hotWalletKeypair: () => payer,
  });
  return {
    chain,
    asked,
    sentRaw,
    payer,
    setAccount: (value: typeof account) => {
      account = value;
    },
  };
}

test("chain: the read is of the address's own USDC account, and only a token account counts", async () => {
  const c = chainHarness();
  const ata = getAssociatedTokenAddressSync(MINT, new PublicKey(ADDRESS)).toBase58();
  assert.equal(await c.chain.usdcAccountExists(ADDRESS), false);
  assert.deepEqual(c.asked, [`account:${ata}:confirmed`]);
  c.setAccount({ owner: SystemProgram.programId, data: Buffer.alloc(0) });
  assert.equal(await c.chain.usdcAccountExists(ADDRESS), false);
  c.setAccount({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) });
  assert.equal(await c.chain.usdcAccountExists(ADDRESS), true);
});

test("chain: the send is one signed transaction with the one instruction, paid by the hot wallet", async () => {
  const c = chainHarness();
  await c.chain.sendOpenUsdcAccount(ADDRESS);
  assert.deepEqual(c.asked, ["blockhash", "send"]);
  assert.equal(c.sentRaw.length, 1);
  const tx = Transaction.from(c.sentRaw[0]!);
  assert.equal(tx.instructions.length, 1);
  assert.ok(tx.instructions[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.ok(tx.feePayer?.equals(c.payer.publicKey));
  assert.equal(tx.verifySignatures(), true);
});

test("chain: with the cluster in doubt nothing is read and nothing is sent", async () => {
  const c = chainHarness({ ok: false, reason: "wrong_cluster" });
  await assert.rejects(() => c.chain.usdcAccountExists(ADDRESS));
  await assert.rejects(() => c.chain.sendOpenUsdcAccount(ADDRESS));
  assert.deepEqual(c.asked, []);
});

// ---- the hot wallet ----

const MASTER_KEY = "unit-test-master-key-0123456789abcdef";

test("hot wallet: it is the payout wallet, and its balance is read at its own address", async () => {
  const asked: string[] = [];
  const wallet = buildHotWallet({
    masterKey: () => MASTER_KEY,
    getConnection: () => ({
      getBalance: async (key: PublicKey) => {
        asked.push(key.toBase58());
        return 123_456_789;
      },
    }),
  });
  const expected = derivePayoutKeypair(MASTER_KEY).publicKey.toBase58();
  assert.equal(wallet.address(), expected);
  assert.equal(wallet.keypair().publicKey.toBase58(), expected);
  assert.equal(await wallet.readLamports(), 123_456_789n);
  assert.deepEqual(asked, [expected]);
});

test("hot wallet: no master key throws, and an answer that is not a balance throws", async () => {
  const none = buildHotWallet({
    masterKey: () => undefined,
    getConnection: () => ({ getBalance: async () => 1 }),
  });
  assert.throws(() => none.keypair());
  await assert.rejects(() => none.readLamports());

  const odd = buildHotWallet({
    masterKey: () => MASTER_KEY,
    getConnection: () => ({
      getBalance: async () => Number.NaN,
    }),
  });
  await assert.rejects(() => odd.readLamports());
});

test("a setting in SOL as lamports", () => {
  assert.equal(solToLamports(0.05), 50_000_000n);
  assert.equal(solToLamports(1), 1_000_000_000n);
  assert.equal(solToLamports(0), 0n);
  assert.equal(solToLamports(Number.NaN), 0n);
});
