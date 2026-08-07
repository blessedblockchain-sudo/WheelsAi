import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { Keypair, Transaction } from "@solana/web3.js";

import {
  createWalletTopupRoutes,
  type TopupRowView,
  type WalletTopupRouteDeps,
} from "../routes/walletTopup.js";
import { buildTopupTransaction } from "../services/walletTopup.js";

// Drives apps/api/src/routes/walletTopup.ts (B2/T5). Every IO surface
// is DI'd; the byte-equality verify step runs REAL web3.js code against
// a really-signed transaction, so these tests also pin the
// deserialize→sign→reserialize wallet round trip.

const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(11));
const USER_WALLET = PAYER.publicKey.toBase58();
const DEPOSIT = Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey.toBase58();
const BLOCKHASH = Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey.toBase58();
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOPUP_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FIXED_NOW = new Date("2026-08-07T12:00:00.000Z");

const BUILT = buildTopupTransaction({
  asset: "SOL",
  payerAddress: USER_WALLET,
  depositAddress: DEPOSIT,
  amountRaw: "250000000",
  topupId: TOPUP_ID,
  blockhash: BLOCKHASH,
  lastValidBlockHeight: 1_000,
});

function walletSign(unsignedTxBase64: string, signer: Keypair): string {
  const tx = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  tx.sign(signer);
  return tx.serialize().toString("base64");
}

const SIGNED_B64 = walletSign(BUILT.unsignedTxBase64, PAYER);

function makeRow(over: Partial<TopupRowView> = {}): TopupRowView {
  return {
    id: TOPUP_ID,
    orgId: "org_1",
    asset: "SOL",
    network: "solana:devnet",
    amountUsdCents: 5_000n,
    bonusCents: 500n,
    amountRaw: "250000000",
    quotedSolPriceUsd: 200,
    payerAddress: USER_WALLET,
    depositAddress: DEPOSIT,
    unsignedMessageB64: BUILT.unsignedMessageB64,
    txSignature: null,
    status: "prepared",
    failureReason: null,
    expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
    lastValidBlockHeight: 1_000n,
    ...over,
  };
}

interface Recorded {
  created: unknown[];
  claims: unknown[];
  marks: Array<{ id: string; from: string[]; to: string; failureReason?: string }>;
  credits: unknown[];
  sent: string[];
}

function makeDeps(
  row: TopupRowView | null,
  over: Partial<WalletTopupRouteDeps> = {},
): { deps: WalletTopupRouteDeps; recorded: Recorded } {
  const recorded: Recorded = {
    created: [],
    claims: [],
    marks: [],
    credits: [],
    sent: [],
  };
  const deps: WalletTopupRouteDeps = {
    enabled: true,
    network: "devnet",
    devnetSolRailEnabled: true,
    solPriceUsd: 200,
    usdcMint: DEVNET_USDC,
    deriveDepositAddress: () => DEPOSIT,
    getLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1_000,
    }),
    createTopup: async (data) => {
      recorded.created.push(data);
    },
    findTopup: async ({ id, orgId }) =>
      row && row.id === id && row.orgId === orgId ? row : null,
    claimForSubmit: async (args) => {
      recorded.claims.push(args);
      if (row) {
        row.status = "submitting";
        row.txSignature = args.txSignature;
      }
      return "claimed";
    },
    markStatus: async (args) => {
      recorded.marks.push(args);
      if (row && args.from.includes(row.status)) {
        row.status = args.to;
        if (args.failureReason) row.failureReason = args.failureReason;
        return true;
      }
      return false;
    },
    expireStalePrepared: async () => {},
    sendRawTransaction: async (raw) => {
      recorded.sent.push(raw);
      return { ok: true };
    },
    confirmTransaction: async () => ({ outcome: "confirmed" }),
    getSignatureStatus: async () => ({
      found: false,
      confirmed: false,
      err: null,
    }),
    getBlockHeight: async () => 0,
    creditTopup: async (args) => {
      recorded.credits.push(args);
      return {
        credited: true,
        balanceAfterCents: 6_500n,
        grantedCents: 5_500n,
      };
    },
    newId: () => TOPUP_ID,
    now: () => FIXED_NOW,
    ...over,
  };
  return { deps, recorded };
}

async function makeApp(
  deps: WalletTopupRouteDeps,
  opts: { authed?: boolean; walletAddress?: string | null } = {},
) {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    if (opts.authed !== false) {
      request.auth = {
        userId: "u1",
        orgId: "org_1",
        type: "jwt",
        walletAddress:
          opts.walletAddress === null
            ? undefined
            : (opts.walletAddress ?? USER_WALLET),
      };
    }
  });
  await app.register(createWalletTopupRoutes(deps));
  return app;
}

// ============================================
// Gates
// ============================================

test("disabled rail answers 501 honestly on every endpoint", async () => {
  const { deps } = makeDeps(null, { enabled: false });
  const app = await makeApp(deps);
  for (const [method, url] of [
    ["POST", "/topups/prepare"],
    ["POST", `/topups/${TOPUP_ID}/submit`],
    ["POST", `/topups/${TOPUP_ID}/reconcile`],
    ["GET", `/topups/${TOPUP_ID}`],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      ...(method === "POST" ? { payload: {} } : {}),
    });
    assert.equal(res.statusCode, 501, `${method} ${url}`);
    assert.equal(res.json().error, "wallet_topups_not_enabled");
  }
});

test("unauthenticated requests get 401", async () => {
  const { deps } = makeDeps(null);
  const app = await makeApp(deps, { authed: false });
  const res = await app.inject({
    method: "POST",
    url: "/topups/prepare",
    payload: { amountUsd: 50, asset: "SOL" },
  });
  assert.equal(res.statusCode, 401);
});

// ============================================
// Prepare
// ============================================

test("prepare without a connected wallet is refused", async () => {
  const { deps } = makeDeps(null);
  const app = await makeApp(deps, { walletAddress: null });
  const res = await app.inject({
    method: "POST",
    url: "/topups/prepare",
    payload: { amountUsd: 50, asset: "SOL" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "wallet_required");
});

test("SOL prepare is refused when the devnet rail is off", async () => {
  const { deps } = makeDeps(null, { devnetSolRailEnabled: false });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/topups/prepare",
    payload: { amountUsd: 50, asset: "SOL" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "asset_unavailable");
});

test("out-of-bounds amounts are refused with the ladder's message", async () => {
  const { deps, recorded } = makeDeps(null);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/topups/prepare",
    payload: { amountUsd: 2, asset: "SOL" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_amount");
  assert.equal(recorded.created.length, 0, "no row persisted");
});

test("prepare persists the row and returns a signable transaction", async () => {
  const { deps, recorded } = makeDeps(null);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/topups/prepare",
    payload: { amountUsd: 50, asset: "SOL" },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.topupId, TOPUP_ID);
  assert.equal(body.depositAddress, DEPOSIT);
  assert.equal(body.bonusUsd, 5);
  assert.equal(body.quotedSolPriceUsd, 200);
  assert.equal(
    body.expiresAt,
    new Date(FIXED_NOW.getTime() + 120_000).toISOString(),
  );

  assert.equal(recorded.created.length, 1);
  const created = recorded.created[0] as {
    network: string;
    amountUsdCents: bigint;
    bonusCents: bigint;
    amountRaw: string;
    unsignedMessageB64: string;
    lastValidBlockHeight: bigint;
  };
  assert.equal(created.network, "solana:devnet");
  assert.equal(created.amountUsdCents, 5_000n);
  assert.equal(created.bonusCents, 500n);
  assert.equal(created.amountRaw, "250000000");
  assert.equal(created.lastValidBlockHeight, 1_000n);
  // The persisted message bytes are exactly the message of the returned
  // unsigned tx — sign-and-submit round-trips against this same row.
  const tx = Transaction.from(Buffer.from(body.unsignedTxBase64, "base64"));
  assert.equal(
    tx.serializeMessage().toString("base64"),
    created.unsignedMessageB64,
  );
});

test("prepare surfaces RPC unavailability as 502, with no row written", async () => {
  const { deps, recorded } = makeDeps(null, {
    getLatestBlockhash: async () => {
      throw new Error("rpc down");
    },
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: "/topups/prepare",
    payload: { amountUsd: 50, asset: "SOL" },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "rpc_unavailable");
  assert.equal(recorded.created.length, 0);
});

// ============================================
// Submit
// ============================================

test("submit happy path: verify → claim → broadcast → confirm → credit", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.status, "credited");
  assert.equal(body.grantedUsd, 55);
  assert.equal(body.balanceUsd, 65);
  assert.ok(body.txSignature.length > 60);

  // Claim carried the signature BEFORE broadcast.
  assert.equal(recorded.claims.length, 1);
  const claim = recorded.claims[0] as { txSignature: string };
  assert.equal(claim.txSignature, body.txSignature);
  // The exact submitted bytes were broadcast.
  assert.deepEqual(recorded.sent, [SIGNED_B64]);
  // submitting → submitted before the confirm wait.
  assert.deepEqual(recorded.marks[0], {
    id: TOPUP_ID,
    from: ["submitting"],
    to: "submitted",
  });
  // Credit got the row's amounts, not anything client-supplied.
  const credit = recorded.credits[0] as {
    topupId: string;
    amountUsdCents: bigint;
    bonusCents: bigint;
  };
  assert.equal(credit.topupId, TOPUP_ID);
  assert.equal(credit.amountUsdCents, 5_000n);
  assert.equal(credit.bonusCents, 500n);
});

test("tampered bytes are rejected 400 and the row stays claimable", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row);
  const app = await makeApp(deps);
  const tampered = buildTopupTransaction({
    asset: "SOL",
    payerAddress: USER_WALLET,
    depositAddress: Keypair.generate().publicKey.toBase58(),
    amountRaw: "250000000",
    topupId: TOPUP_ID,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1_000,
  });
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: walletSign(tampered.unsignedTxBase64, PAYER) },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "message_mismatch");
  assert.equal(recorded.claims.length, 0, "never claimed");
  assert.equal(recorded.sent.length, 0, "never broadcast");
  assert.equal(row.status, "prepared", "row untouched — retryable");
});

test("submit against someone else's topup 404s", async () => {
  const row = makeRow({ orgId: "org_2" });
  const { deps } = makeDeps(row);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 404);
});

test("wall-clock-expired prepared rows are expired and refused", async () => {
  const row = makeRow({ expiresAt: new Date(FIXED_NOW.getTime() - 1_000) });
  const { deps, recorded } = makeDeps(row);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error, "topup_expired");
  assert.deepEqual(recorded.marks[0], {
    id: TOPUP_ID,
    from: ["prepared"],
    to: "expired",
  });
});

test("already-credited rows return 200 idempotently, no re-credit", async () => {
  const row = makeRow({ status: "credited" });
  const { deps, recorded } = makeDeps(row);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().alreadyCredited, true);
  assert.equal(recorded.credits.length, 0);
});

test("in-flight rows 409 instead of double-broadcasting", async () => {
  const row = makeRow({ status: "submitted", txSignature: "sig" });
  const { deps, recorded } = makeDeps(row);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "in_flight");
  assert.equal(recorded.sent.length, 0);
});

test("losing the claim race 409s without broadcasting", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    claimForSubmit: async () => "lost",
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(recorded.sent.length, 0);
});

test("broadcast rejection fails the row with the reason", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    sendRawTransaction: async () => ({
      ok: false,
      kind: "rejected",
      message: "insufficient funds for rent",
    }),
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "broadcast_failed");
  assert.deepEqual(recorded.marks[0], {
    id: TOPUP_ID,
    from: ["submitting"],
    to: "failed",
    failureReason: "insufficient funds for rent",
  });
  assert.equal(recorded.credits.length, 0);
});

test("expired blockhash at broadcast expires the row (410, re-preparable)", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    sendRawTransaction: async () => ({
      ok: false,
      kind: "blockhash_expired",
      message: "Blockhash not found",
    }),
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 410);
  assert.equal(recorded.marks[0]!.to, "expired");
});

test("on-chain failure after landing marks failed — money never moved", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    confirmTransaction: async () => ({
      outcome: "failed_on_chain",
      err: '{"InstructionError":[0,"Custom"]}',
    }),
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "transaction_failed_on_chain");
  assert.equal(recorded.credits.length, 0);
  assert.equal(row.status, "failed");
});

test("unresolved confirmation returns 202 — reconcile settles it later", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    confirmTransaction: async () => ({ outcome: "unresolved" }),
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: { signedTxBase64: SIGNED_B64 },
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().pendingConfirmation, true);
  assert.equal(recorded.credits.length, 0, "no credit without confirmation");
  assert.equal(row.status, "submitted");
});

// ============================================
// Reconcile
// ============================================

test("reconcile credits a confirmed-on-chain row exactly once", async () => {
  const row = makeRow({ status: "submitted", txSignature: "onchain_sig" });
  const { deps, recorded } = makeDeps(row, {
    getSignatureStatus: async (sig) => {
      assert.equal(sig, "onchain_sig");
      return { found: true, confirmed: true, err: null };
    },
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/reconcile`,
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "credited");
  assert.equal(recorded.credits.length, 1);
});

test("reconcile fails a row whose tx failed on-chain", async () => {
  const row = makeRow({ status: "submitted", txSignature: "onchain_sig" });
  const { deps, recorded } = makeDeps(row, {
    getSignatureStatus: async () => ({
      found: true,
      confirmed: true,
      err: '{"InstructionError":[1,"Custom"]}',
    }),
  });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/reconcile`,
    payload: {},
  });
  assert.equal(res.json().status, "failed");
  assert.equal(recorded.credits.length, 0);
  assert.equal(row.status, "failed");
});

test("reconcile expires a vanished tx only past the chain horizon", async () => {
  const row = makeRow({
    status: "submitted",
    txSignature: "gone_sig",
    lastValidBlockHeight: 1_000n,
  });
  const { deps } = makeDeps(row, { getBlockHeight: async () => 1_001 });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/reconcile`,
    payload: {},
  });
  assert.equal(res.json().status, "expired");
});

test("reconcile keeps waiting while the chain could still land it", async () => {
  const row = makeRow({
    status: "submitted",
    txSignature: "pending_sig",
    lastValidBlockHeight: 1_000n,
  });
  const { deps, recorded } = makeDeps(row, { getBlockHeight: async () => 999 });
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/reconcile`,
    payload: {},
  });
  assert.equal(res.json().status, "submitted");
  assert.equal(res.json().pendingConfirmation, true);
  assert.equal(recorded.credits.length, 0);
  assert.equal(row.status, "submitted", "not expired early");
});

test("reconcile on a terminal row just reports it", async () => {
  const row = makeRow({ status: "credited", txSignature: "sig" });
  const { deps, recorded } = makeDeps(row);
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/reconcile`,
    payload: {},
  });
  assert.equal(res.json().status, "credited");
  assert.equal(recorded.credits.length, 0);
});

// ============================================
// Polling view
// ============================================

test("GET /topups/:id returns the client view", async () => {
  const row = makeRow({ status: "submitted", txSignature: "sig123" });
  const { deps } = makeDeps(row);
  const app = await makeApp(deps);
  const res = await app.inject({ method: "GET", url: `/topups/${TOPUP_ID}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "submitted");
  assert.equal(body.amountUsd, 50);
  assert.equal(body.bonusUsd, 5);
  assert.equal(body.txSignature, "sig123");
  assert.equal(body.depositAddress, DEPOSIT);
});
