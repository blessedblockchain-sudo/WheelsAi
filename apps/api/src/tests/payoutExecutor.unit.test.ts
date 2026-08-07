import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, PublicKey } from "@solana/web3.js";

function setupEnv() {
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai";
  process.env.JWT_SECRET =
    process.env.JWT_SECRET ?? "12345678901234567890123456789012";
}
setupEnv();

// Drives the payout executor (W2 money keystone): the credits exactly-once
// settler, the crypto transfer math, and the recovery/duplicate guards.

const DEVNET_USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// ============================================
// Credits settler — exactly once
// ============================================

interface LedgerRow {
  type: string;
  amountCents: bigint;
  balanceAfter: bigint;
  referenceId: string;
  description: string;
}

function makeCreditsDb(startBalance: bigint, casCount: number) {
  const state = {
    balance: startBalance,
    ledger: [] as LedgerRow[],
    casWheres: [] as unknown[],
  };
  const tx = {
    creatorPayout: {
      updateMany: async (args: { where: unknown }) => {
        state.casWheres.push(args.where);
        return { count: casCount };
      },
    },
    creditBalance: {
      upsert: async (a: { update: { balanceCents: { increment: bigint } } }) => {
        state.balance += a.update.balanceCents.increment;
        return { balanceCents: state.balance };
      },
      update: async (a: { data: { balanceCents: { increment: bigint } } }) => {
        state.balance += a.data.balanceCents.increment;
        return { balanceCents: state.balance };
      },
    },
    creditTransaction: {
      create: async (a: { data: LedgerRow }) => {
        state.ledger.push(a.data);
        return {};
      },
    },
  };
  const db = { $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { db, state };
}

test("credits payout: winning the CAS grants once, referenced to the payout id", async () => {
  const { makeSettleCreditsPayout } = await import("../services/payoutExecutor.js");
  const { db, state } = makeCreditsDb(2_000n, 1);
  const settle = makeSettleCreditsPayout(db as never);
  const res = await settle({
    payoutId: "payout_1",
    publisherId: "org_pub",
    amountCents: 4_500n,
  });
  assert.equal(res.outcome, "completed");
  if (res.outcome === "completed") {
    assert.equal(res.balanceAfterCents, 6_500n);
  }
  assert.equal(state.ledger.length, 1);
  assert.equal(state.ledger[0]!.referenceId, "payout_1");
  assert.match(state.ledger[0]!.description, /Creator payout/);
  // The CAS demanded status: "processing".
  assert.equal((state.casWheres[0] as { status: string }).status, "processing");
});

test("credits payout: losing the CAS grants nothing (exactly-once barrier)", async () => {
  const { makeSettleCreditsPayout } = await import("../services/payoutExecutor.js");
  const { db, state } = makeCreditsDb(2_000n, 0);
  const settle = makeSettleCreditsPayout(db as never);
  const res = await settle({
    payoutId: "payout_1",
    publisherId: "org_pub",
    amountCents: 4_500n,
  });
  assert.equal(res.outcome, "already_settled");
  assert.equal(state.balance, 2_000n, "balance untouched");
  assert.equal(state.ledger.length, 0);
});

// ============================================
// Crypto transfer math
// ============================================

test("crypto_sol payout converts cents through the operator quote", async () => {
  const { buildPayoutTransfer } = await import("../services/payoutExecutor.js");
  const payer = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const tx = buildPayoutTransfer({
    method: "crypto_sol",
    payer,
    recipient,
    amountCents: 5_000n, // $50
    solPriceUsd: 200, // → 0.25 SOL = 250_000_000 lamports
    blockhash,
    lastValidBlockHeight: 1_000,
  });
  // SystemProgram.transfer: [4-byte type=2][8-byte lamports LE].
  const ix = tx.instructions[0]!;
  const lamports = ix.data.readBigUInt64LE(4);
  assert.equal(lamports, 250_000_000n);
  assert.ok(ix.keys.some((k) => k.pubkey.equals(recipient)));
});

test("crypto_sol without a quote is refused, not guessed", async () => {
  const { buildPayoutTransfer } = await import("../services/payoutExecutor.js");
  assert.throws(
    () =>
      buildPayoutTransfer({
        method: "crypto_sol",
        payer: Keypair.generate().publicKey,
        recipient: Keypair.generate().publicKey,
        amountCents: 5_000n,
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1_000,
      }),
    /solPriceUsd required/,
  );
});

test("crypto_usdc payout is exact integer base units (no oracle)", async () => {
  const { buildPayoutTransfer } = await import("../services/payoutExecutor.js");
  const tx = buildPayoutTransfer({
    method: "crypto_usdc",
    payer: Keypair.generate().publicKey,
    recipient: Keypair.generate().publicKey,
    amountCents: 5_000n, // $50 → 50_000_000 base units (6dp)
    usdcMint: DEVNET_USDC,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1_000,
  });
  // Instructions: [0] idempotent ATA create, [1] transferChecked.
  const transferIx = tx.instructions[1]!;
  // transferChecked layout: [1-byte type=12][8-byte amount LE][1-byte decimals].
  const amount = transferIx.data.readBigUInt64LE(1);
  assert.equal(amount, 50_000_000n);
});

// ============================================
// Crypto settle — recovery + duplicate guards
// ============================================

function makeConnStub(over: Record<string, unknown> = {}) {
  return {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1_000,
    }),
    sendRawTransaction: async () => "sig",
    confirmTransaction: async () => ({ value: { err: null } }),
    getSignatureStatuses: async () => ({ value: [null] }),
    ...over,
  };
}

test("crypto settle: a recorded-but-confirmed signature completes without re-sending", async () => {
  const { settleCryptoPayout } = await import("../services/payoutExecutor.js");
  let sent = 0;
  const res = await settleCryptoPayout(
    {
      id: "p1",
      publisherId: "org",
      amountCents: 5_000n,
      payoutMethod: "crypto_sol",
      payoutAddress: Keypair.generate().publicKey.toBase58(),
      txSignature: "existing_sig",
    },
    {
      connection: makeConnStub({
        sendRawTransaction: async () => {
          sent += 1;
          return "x";
        },
        getSignatureStatuses: async () => ({
          value: [{ err: null, confirmationStatus: "confirmed" }],
        }),
      }) as never,
      payoutWallet: Keypair.generate(),
      solPriceUsd: 200,
      recordSignature: async () => "recorded",
      markCompleted: async () => true,
    },
  );
  assert.equal(res.outcome, "completed");
  assert.equal(sent, 0, "recovery re-confirms, never re-sends");
});

test("crypto settle: a duplicate signature record means another tick owns it", async () => {
  const { settleCryptoPayout } = await import("../services/payoutExecutor.js");
  let sent = 0;
  const res = await settleCryptoPayout(
    {
      id: "p1",
      publisherId: "org",
      amountCents: 5_000n,
      payoutMethod: "crypto_sol",
      payoutAddress: Keypair.generate().publicKey.toBase58(),
      txSignature: null,
    },
    {
      connection: makeConnStub({
        sendRawTransaction: async () => {
          sent += 1;
          return "x";
        },
      }) as never,
      payoutWallet: Keypair.generate(),
      solPriceUsd: 200,
      recordSignature: async () => "duplicate",
      markCompleted: async () => true,
    },
  );
  assert.equal(res.outcome, "already_settled");
  assert.equal(sent, 0, "never broadcasts when the signature slot is taken");
});

test("crypto settle: a bad payout address fails (releasable), never sends", async () => {
  const { settleCryptoPayout } = await import("../services/payoutExecutor.js");
  const res = await settleCryptoPayout(
    {
      id: "p1",
      publisherId: "org",
      amountCents: 5_000n,
      payoutMethod: "crypto_sol",
      payoutAddress: "not-a-pubkey",
      txSignature: null,
    },
    {
      connection: makeConnStub() as never,
      payoutWallet: Keypair.generate(),
      solPriceUsd: 200,
      recordSignature: async () => "recorded",
      markCompleted: async () => true,
    },
  );
  assert.equal(res.outcome, "failed");
});

test("crypto settle: a broadcast error leaves it pending_confirmation (not failed)", async () => {
  const { settleCryptoPayout } = await import("../services/payoutExecutor.js");
  const res = await settleCryptoPayout(
    {
      id: "p1",
      publisherId: "org",
      amountCents: 5_000n,
      payoutMethod: "crypto_sol",
      payoutAddress: Keypair.generate().publicKey.toBase58(),
      txSignature: null,
    },
    {
      connection: makeConnStub({
        sendRawTransaction: async () => {
          throw new Error("network blip");
        },
      }) as never,
      payoutWallet: Keypair.generate(),
      solPriceUsd: 200,
      recordSignature: async () => "recorded",
      markCompleted: async () => true,
    },
  );
  // The signature is already on the row; a later tick re-confirms rather
  // than re-sending, so we must NOT restore the balance here.
  assert.equal(res.outcome, "pending_confirmation");
});
