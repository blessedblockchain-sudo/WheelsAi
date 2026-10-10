/**
 * Drives services/buildTopupReconcileTickDeps.ts, the binding of the
 * top-up reconcile worker to Prisma and the chain reads.
 *
 * Pinning, against a stand-in Prisma client (no database, no network):
 *   - the rows one run takes: in flight, or `prepared` past the clock,
 *     oldest first, up to the limit
 *   - every change is a compare-and-set with the expected status in
 *     `where`, and its count decides the answer
 *   - a row is ended from the chain only while it holds that signature
 *   - an unsigned expiry needs the row to have no signature
 *   - the bytes sent again are the stored bytes, byte for byte, and only
 *     when they carry the stored signature
 *   - crediting goes through makeCreditTopup: one status change and its
 *     ledger rows in one transaction
 */

import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import {
  Keypair,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import {
  buildTopupReconcileTickDeps,
  type BuildTopupReconcileTickDepsInput,
} from "../services/buildTopupReconcileTickDeps.js";
import { runTopupReconcileTick } from "../services/runTopupReconcileTick.js";
import { signatureFate } from "../services/signatureFate.js";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";

/** A signed transfer made offline, as a wallet would return it. */
function signedTransfer() {
  const payer = Keypair.generate();
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1_000,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000_000n,
    }),
  );
  tx.sign(payer);
  const raw = tx.serialize();
  const signature = bs58.encode(
    VersionedTransaction.deserialize(raw).signatures[0] as Uint8Array,
  );
  return { raw, signedTxB64: raw.toString("base64"), signature };
}

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    orgId: "org_1",
    asset: "SOL",
    network: "solana:devnet",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    amountRaw: "453514739",
    quotedSolPriceUsd: 110.25,
    payerAddress: "payer",
    depositAddress: "deposit",
    unsignedMessageB64: "bWVzc2FnZQ==",
    txSignature: "sig_t1",
    status: "submitted",
    failureReason: null,
    failureCode: null,
    signedTxB64: "c2lnbmVk",
    lastValidBlockHeight: 1_000n,
    expiresAt: new Date(NOW.getTime() + 60_000),
    createdAt: new Date(NOW.getTime() - 60_000),
    ...over,
  };
}

function makeHarness(opts: {
  rows?: Array<ReturnType<typeof dbRow>>;
  updateCount?: number;
  send?: (raw: Buffer) => Promise<unknown>;
} = {}) {
  const calls = {
    findMany: [] as Array<Record<string, unknown>>,
    updateMany: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    transactions: 0,
    upserts: [] as unknown[],
    ledger: [] as Array<Record<string, unknown>>,
    sent: [] as Buffer[],
  };
  const walletTopUp = {
    findMany: async (args: Record<string, unknown>) => {
      calls.findMany.push(args);
      return opts.rows ?? [];
    },
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      calls.updateMany.push(args);
      return { count: opts.updateCount ?? 1 };
    },
  };
  let balance = 0n;
  const txClient = {
    walletTopUp,
    creditBalance: {
      upsert: async (args: { update: { balanceCents: { increment: bigint } } }) => {
        calls.upserts.push(args);
        balance += args.update.balanceCents.increment;
        return { balanceCents: balance };
      },
      update: async (args: { data: { balanceCents: { increment: bigint } } }) => {
        balance += args.data.balanceCents.increment;
        return { balanceCents: balance };
      },
    },
    creditTransaction: {
      create: async (args: { data: Record<string, unknown> }) => {
        calls.ledger.push(args.data);
        return {};
      },
    },
  };
  const prisma = {
    walletTopUp,
    $transaction: async <T>(fn: (tx: typeof txClient) => Promise<T>) => {
      calls.transactions += 1;
      return fn(txClient);
    },
  };

  const input: BuildTopupReconcileTickDepsInput = {
    prisma: prisma as never,
    network: "solana:devnet",
    checkCluster: async () => ({ ok: true }),
    readFate: (args) =>
      signatureFate(args, {
        marginBlocks: 10,
        getFinalizedPosition: async () => ({ slot: 900, blockHeight: 900 }),
        getSignatureStatus: async () => ({
          status: { confirmationStatus: "confirmed", err: null },
          contextSlot: 905,
        }),
      }),
    sendRawTransaction: async (raw) => {
      calls.sent.push(raw);
      return (opts.send ?? (async () => "signature"))(raw);
    },
  };
  return { deps: buildTopupReconcileTickDeps(input), calls };
}

test("loadTopups asks for this chain's rows in flight and `prepared` rows past the clock, oldest first, up to the limit", async () => {
  const { deps, calls } = makeHarness({ rows: [dbRow()] });
  const rows = await deps.loadTopups({ limit: 50, now: NOW });

  assert.deepEqual(calls.findMany, [
    {
      where: {
        // A top-up made on another chain is never asked about here: its
        // signature is absent on this chain, and absent must not end it.
        network: "solana:devnet",
        OR: [
          { status: { in: ["submitting", "submitted"] } },
          { status: "prepared", expiresAt: { lt: NOW } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    },
  ]);
  assert.deepEqual(rows, [
    {
      id: "t1",
      orgId: "org_1",
      asset: "SOL",
      network: "solana:devnet",
      amountUsdCents: 5_000n,
      bonusCents: 500n,
      status: "submitted",
      txSignature: "sig_t1",
      signedTxB64: "c2lnbmVk",
      lastValidBlockHeight: 1_000n,
      expiresAt: new Date(NOW.getTime() + 60_000),
    },
  ]);
});

test("endFromChain is a compare-and-set on the status AND the signature, and writes the code and the operator note", async () => {
  const { deps, calls } = makeHarness();
  const won = await deps.endFromChain({
    id: "t1",
    txSignature: "sig_t1",
    to: "failed",
    failureCode: "failed_on_chain",
    failureReason: '{"InstructionError":[0,"Custom"]}',
  });
  assert.equal(won, true);
  assert.deepEqual(calls.updateMany, [
    {
      where: {
        id: "t1",
        txSignature: "sig_t1",
        status: { in: ["submitting", "submitted"] },
      },
      data: {
        status: "failed",
        failureCode: "failed_on_chain",
        failureReason: '{"InstructionError":[0,"Custom"]}',
      },
    },
  ]);
});

test("endFromChain answers false when the row had already moved on", async () => {
  const { deps } = makeHarness({ updateCount: 0 });
  assert.equal(
    await deps.endFromChain({
      id: "t1",
      txSignature: "sig_t1",
      to: "expired",
      failureCode: "never_landed",
      failureReason: "absent_expired_by_height",
    }),
    false,
  );
});

test("expireUnsigned changes only a `prepared` row that has no signature", async () => {
  const { deps, calls } = makeHarness();
  assert.equal(
    await deps.expireUnsigned({ id: "t1", failureCode: "unsigned_expired" }),
    true,
  );
  assert.deepEqual(calls.updateMany, [
    {
      where: { id: "t1", status: "prepared", txSignature: null },
      data: { status: "expired", failureCode: "unsigned_expired" },
    },
  ]);

  const lost = makeHarness({ updateCount: 0 });
  assert.equal(
    await lost.deps.expireUnsigned({ id: "t1", failureCode: "unsigned_expired" }),
    false,
  );
});

test("markSubmitted is a compare-and-set from `submitting` only", async () => {
  const { deps, calls } = makeHarness();
  assert.equal(await deps.markSubmitted({ id: "t1" }), true);
  assert.deepEqual(calls.updateMany, [
    { where: { id: "t1", status: "submitting" }, data: { status: "submitted" } },
  ]);
  const lost = makeHarness({ updateCount: 0 });
  assert.equal(await lost.deps.markSubmitted({ id: "t1" }), false);
});

test("resendSignedBytes sends the stored bytes, byte for byte", async () => {
  const { raw, signedTxB64, signature } = signedTransfer();
  const { deps, calls } = makeHarness();
  const res = await deps.resendSignedBytes({ signedTxB64, txSignature: signature });

  assert.deepEqual(res, { ok: true });
  assert.equal(calls.sent.length, 1);
  assert.ok(Buffer.from(raw).equals(calls.sent[0] as Buffer), "the same bytes");
  assert.equal((calls.sent[0] as Buffer).toString("base64"), signedTxB64);
});

test("resendSignedBytes sends nothing when the stored bytes do not carry the stored signature", async () => {
  const { signedTxB64 } = signedTransfer();
  const other = signedTransfer();
  for (const args of [
    { signedTxB64, txSignature: other.signature },
    { signedTxB64: Buffer.from("not a transaction").toString("base64"), txSignature: other.signature },
  ]) {
    const { deps, calls } = makeHarness();
    const res = await deps.resendSignedBytes(args);
    assert.equal(res.ok, false);
    assert.equal(calls.sent.length, 0);
  }
});

test("a send that throws is `not taken` with the node's text as detail; it never throws on", async () => {
  const { signedTxB64, signature } = signedTransfer();
  const { deps } = makeHarness({
    send: async () => {
      throw new Error("Transaction simulation failed: Blockhash not found");
    },
  });
  assert.deepEqual(
    await deps.resendSignedBytes({ signedTxB64, txSignature: signature }),
    { ok: false, detail: "Transaction simulation failed: Blockhash not found" },
  );
});

test("creditTopup is makeCreditTopup: the status change and the ledger rows in one transaction", async () => {
  const { deps, calls } = makeHarness();
  const res = await deps.creditTopup({
    topupId: "t1",
    orgId: "org_1",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    asset: "SOL",
    network: "solana:mainnet",
  });
  assert.deepEqual(res, {
    credited: true,
    balanceAfterCents: 5_500n,
    grantedCents: 5_500n,
  });
  assert.equal(calls.transactions, 1);
  assert.deepEqual(calls.updateMany[0]?.where, {
    id: "t1",
    status: { in: ["submitting", "submitted"] },
  });
  assert.equal(calls.updateMany[0]?.data.status, "credited");
  assert.deepEqual(
    calls.ledger.map((l) => [l.type, l.amountCents, l.referenceId]),
    [
      ["purchase", 5_000n, "t1"],
      ["bonus", 500n, "t1"],
    ],
  );

  const lost = makeHarness({ updateCount: 0 });
  assert.deepEqual(
    await lost.deps.creditTopup({
      topupId: "t1",
      orgId: "org_1",
      amountUsdCents: 5_000n,
      bonusCents: 500n,
      asset: "SOL",
      network: "solana:mainnet",
    }),
    { credited: false },
  );
  assert.equal(lost.calls.ledger.length, 0, "a lost compare-and-set grants nothing");
});

test("end to end through the pure tick: a `submitting` row in flight has its own bytes sent again and becomes `submitted`", async () => {
  const { raw, signedTxB64, signature } = signedTransfer();
  const { calls, deps } = makeHarness({
    rows: [dbRow({ status: "submitting", txSignature: signature, signedTxB64 })],
  });
  const res = await runTopupReconcileTick(
    { enabled: true, now: () => NOW },
    {
      ...deps,
      readFate: (args) =>
        signatureFate(args, {
          marginBlocks: 10,
          getFinalizedPosition: async () => ({ slot: 900, blockHeight: 900 }),
          getSignatureStatus: async () => ({ status: null, contextSlot: 905 }),
        }),
    },
  );

  assert.equal(res.resent, 1);
  assert.ok(Buffer.from(raw).equals(calls.sent[0] as Buffer));
  assert.deepEqual(calls.updateMany, [
    { where: { id: "t1", status: "submitting" }, data: { status: "submitted" } },
  ]);
});

test("end to end through the pure tick: a landed transfer is credited through the one transaction", async () => {
  const { calls, deps } = makeHarness({ rows: [dbRow()] });
  const res = await runTopupReconcileTick({ enabled: true, now: () => NOW }, deps);
  assert.equal(res.credited, 1);
  assert.equal(calls.transactions, 1);
  assert.equal(calls.sent.length, 0);
  assert.equal(calls.ledger.length, 2);
});
