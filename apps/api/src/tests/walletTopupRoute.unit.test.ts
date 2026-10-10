import "./unitEnv.js";

import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";

import {
  createWalletTopupRoutes,
  type PayerBalances,
  type TopupRowView,
  type WalletTopupRouteDeps,
} from "../routes/walletTopup.js";
import type {
  SignatureFate,
  SignatureFateAnswer,
  SignatureFateInput,
} from "../services/signatureFate.js";
import type { SolQuote } from "../services/solPrice.js";
import { topupSentence } from "../services/topupSentences.js";
import {
  buildTopupTransaction,
  signatureOfSignedTransaction,
} from "../services/walletTopup.js";

// Drives apps/api/src/routes/walletTopup.ts against THE CONTRACT of the
// payments pass, batch 2. Every IO surface is a stand-in; the accept step
// runs REAL web3.js code against a really-signed transaction, so these
// tests also pin the deserialize→sign→reserialize wallet round trip.
//
// The rules these tests hold the routes to:
//   - once a signature is stored, only the chain (signatureFate) ends a
//     row; a send error ends nothing and answers 202;
//   - every answer carries `message`, a sentence from topupSentences.ts,
//     and no answer carries text from a node, the database or a throw.

const PAYER = Keypair.fromSeed(new Uint8Array(32).fill(11));
const USER_WALLET = PAYER.publicKey.toBase58();
const OTHER_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(14));
const DEPOSIT = Keypair.fromSeed(new Uint8Array(32).fill(12)).publicKey.toBase58();
const PAYOUT_WALLET = Keypair.fromSeed(new Uint8Array(32).fill(15)).publicKey.toBase58();
const BLOCKHASH = Keypair.fromSeed(new Uint8Array(32).fill(13)).publicKey.toBase58();
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOPUP_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FIXED_NOW = new Date("2026-08-07T12:00:00.000Z");

// What a node, a database or a library might say. None of it may ever be
// part of an answer.
const HOSTILE =
  "ECONNREFUSED https://rpc.example.invalid/?api-key=SECRET-KEY-123 <script>alert(1)</script> PrismaClientKnownRequestError P2002";

const QUOTE: SolQuote = {
  source: "pyth",
  midMicroUsdPerSol: 200_000_000n,
  confMicroUsdPerSol: 0n,
  publishTime: 1_786_104_000,
  ageSeconds: 2,
  account: "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
};

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

/** A wallet that adds its own fee setting before signing. */
function walletSignWithFee(unsignedTxBase64: string, signer: Keypair): string {
  const original = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  const tx = new Transaction({
    feePayer: signer.publicKey,
    blockhash: original.recentBlockhash!,
    lastValidBlockHeight: 1_000,
  });
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
    ...original.instructions,
  );
  tx.sign(signer);
  return tx.serialize().toString("base64");
}

const SIGNED_B64 = walletSign(BUILT.unsignedTxBase64, PAYER);
const SIGNED_SIGNATURE = signatureOfSignedTransaction(SIGNED_B64)!;

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
    failureCode: null,
    createdAt: new Date(FIXED_NOW.getTime() - 5_000),
    expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
    lastValidBlockHeight: 1_000n,
    ...over,
  };
}

function fateAnswer(
  fate: SignatureFate,
  input: SignatureFateInput,
  error?: string,
): SignatureFateAnswer {
  return {
    fate,
    reason:
      fate === "landed_ok"
        ? "status_ok"
        : fate === "landed_failed"
          ? "status_err"
          : fate === "dead"
            ? "absent_expired_by_height"
            : fate === "in_flight"
              ? "absent_within_window"
              : "status_read_failed",
    signature: input.signature,
    ...(error === undefined ? {} : { error }),
    detail: {
      finalizedSlot: 10n,
      finalizedBlockHeight: 9n,
      lastValidBlockHeight: 1_000n,
      marginBlocks: 32,
      statusContextSlot: 10n,
      confirmationStatus: null,
      landedSlot: null,
      blockhashValid: null,
      blockhashContextSlot: null,
    },
  };
}

type Mark = Parameters<WalletTopupRouteDeps["markStatus"]>[0];
type Claim = Parameters<WalletTopupRouteDeps["claimForSubmit"]>[0];
type Created = Parameters<WalletTopupRouteDeps["createTopup"]>[0];

interface Recorded {
  created: Created[];
  claims: Claim[];
  marks: Mark[];
  credits: unknown[];
  sent: string[];
  fates: SignatureFateInput[];
  waits: number;
  quotes: number;
  balanceReads: unknown[];
  /** What happened, in order: the proof of claim-before-broadcast. */
  order: string[];
}

interface Knobs {
  fate?: SignatureFate;
  fateError?: string;
  balances?: PayerBalances;
}

function makeDeps(
  row: TopupRowView | null,
  over: Partial<WalletTopupRouteDeps> = {},
  knobs: Knobs = {},
): { deps: WalletTopupRouteDeps; recorded: Recorded } {
  const recorded: Recorded = {
    created: [],
    claims: [],
    marks: [],
    credits: [],
    sent: [],
    fates: [],
    waits: 0,
    quotes: 0,
    balanceReads: [],
    order: [],
  };
  const deps: WalletTopupRouteDeps = {
    enabled: true,
    network: "devnet",
    solEnabled: true,
    usdcMint: DEVNET_USDC,
    deriveDepositAddress: () => DEPOSIT,
    platformAddresses: () => [DEPOSIT, PAYOUT_WALLET],
    ensureCluster: async () => ({ ok: true }),
    getSolQuote: async () => {
      recorded.quotes += 1;
      return { ok: true, quote: QUOTE };
    },
    solMarginBps: () => 0,
    readPayerBalances: async (args) => {
      recorded.balanceReads.push(args);
      return (
        knobs.balances ?? {
          lamports: 10_000_000_000n,
          usdcRaw: 1_000_000_000n,
          depositUsdcAccountExists: true,
        }
      );
    },
    getLatestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1_000,
    }),
    createTopup: async (data) => {
      recorded.created.push(data);
    },
    findTopup: async ({ id, orgId }) =>
      row && row.id === id && row.orgId === orgId ? row : null,
    listTopups: async ({ orgId }) => (row && row.orgId === orgId ? [row] : []),
    claimForSubmit: async (args) => {
      recorded.claims.push(args);
      recorded.order.push("claim");
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
        if (args.failureCode) row.failureCode = args.failureCode;
        return true;
      }
      return false;
    },
    expireStalePrepared: async () => {},
    sendRawTransaction: async (raw) => {
      recorded.sent.push(raw);
      recorded.order.push("send");
      return { ok: true };
    },
    waitForConfirmation: async () => {
      recorded.waits += 1;
    },
    readSignatureFate: async (input) => {
      recorded.fates.push(input);
      recorded.order.push("fate");
      return fateAnswer(knobs.fate ?? "landed_ok", input, knobs.fateError);
    },
    creditTopup: async (args) => {
      recorded.credits.push(args);
      if (row) row.status = "credited";
      return {
        credited: true,
        balanceAfterCents: 6_500n,
        grantedCents: 5_500n,
      };
    },
    readBalanceCents: async () => 6_500n,
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

type App = Awaited<ReturnType<typeof makeApp>>;

const prepare = (app: App, payload: unknown) =>
  app.inject({ method: "POST", url: "/topups/prepare", payload: payload as object });
const submit = (app: App, signedTxBase64: string = SIGNED_B64, id = TOPUP_ID) =>
  app.inject({
    method: "POST",
    url: `/topups/${id}/submit`,
    payload: { signedTxBase64 },
  });
const reconcile = (app: App, id = TOPUP_ID) =>
  app.inject({ method: "POST", url: `/topups/${id}/reconcile`, payload: {} });

/** A refusal is `{ error, message }` with the sentence for the code. */
function assertRefusal(
  res: { statusCode: number; body: string; json: () => any },
  status: number,
  error: string,
  message: string,
) {
  assert.equal(res.statusCode, status, res.body);
  const body = res.json();
  assert.equal(body.error, error);
  assert.equal(body.message, message);
  assert.deepEqual(Object.keys(body).sort(), ["error", "message"]);
}

function assertNoRawText(body: string) {
  for (const piece of [
    "ECONNREFUSED",
    "rpc.example.invalid",
    "SECRET-KEY-123",
    "<script>",
    "Prisma",
    "P2002",
    "InstructionError",
    "failureReason",
    "failure_reason",
  ]) {
    assert.ok(!body.includes(piece), `answer carries "${piece}": ${body}`);
  }
}

const PAUSED = topupSentence("chain_unavailable");

// ============================================
// Gates
// ============================================

test("a disabled rail answers 501 with a sentence on every endpoint", async () => {
  const { deps } = makeDeps(null, { enabled: false });
  const app = await makeApp(deps);
  for (const [method, url] of [
    ["POST", "/topups/prepare"],
    ["POST", `/topups/${TOPUP_ID}/submit`],
    ["POST", `/topups/${TOPUP_ID}/reconcile`],
    ["GET", `/topups/${TOPUP_ID}`],
    ["GET", "/topups"],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      ...(method === "POST" ? { payload: {} } : {}),
    });
    assertRefusal(res, 501, "wallet_topups_not_enabled", PAUSED);
  }
});

test("unauthenticated requests get 401 with a sentence, on every endpoint", async () => {
  const { deps } = makeDeps(null);
  const app = await makeApp(deps, { authed: false });
  for (const [method, url] of [
    ["POST", "/topups/prepare"],
    ["POST", `/topups/${TOPUP_ID}/submit`],
    ["POST", `/topups/${TOPUP_ID}/reconcile`],
    ["GET", `/topups/${TOPUP_ID}`],
    ["GET", "/topups"],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      ...(method === "POST" ? { payload: { amountUsd: 50, asset: "SOL" } } : {}),
    });
    assertRefusal(res, 401, "unauthenticated", "Sign in to add credits.");
  }
});

test("prepare is limited to 10 a minute", async () => {
  const { deps } = makeDeps(null);
  const app = Fastify();
  const limits: Record<string, unknown> = {};
  app.addHook("onRoute", (route) => {
    limits[`${String(route.method)} ${route.url}`] = (
      route.config as { rateLimit?: unknown } | undefined
    )?.rateLimit;
  });
  await app.register(createWalletTopupRoutes(deps));
  await app.ready();
  assert.deepEqual(limits["POST /topups/prepare"], {
    max: 10,
    timeWindow: "1 minute",
  });
});

// ============================================
// Prepare: who pays
// ============================================

test("prepare with no wallet on the session and none in the body is wallet_required", async () => {
  const { deps, recorded } = makeDeps(null);
  const app = await makeApp(deps, { walletAddress: null });
  const res = await prepare(app, { amountUsd: 50, asset: "USDC" });
  assertRefusal(
    res,
    400,
    "wallet_required",
    "Connect a Solana wallet to pay. The wallet you connect signs the transfer.",
  );
  assert.equal(recorded.created.length, 0);
});

test("an email session with no wallet pays with the address in the body", async () => {
  const { deps, recorded } = makeDeps(null);
  const app = await makeApp(deps, { walletAddress: null });
  const res = await prepare(app, {
    amountUsd: 50,
    asset: "USDC",
    payerAddress: OTHER_PAYER.publicKey.toBase58(),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.payerAddress, OTHER_PAYER.publicKey.toBase58());
  assert.equal(recorded.created[0]!.payerAddress, OTHER_PAYER.publicKey.toBase58());
  // The transfer is that wallet's to sign: it is the fee payer.
  const tx = Transaction.from(Buffer.from(body.unsignedTxBase64, "base64"));
  assert.equal(tx.feePayer!.toBase58(), OTHER_PAYER.publicKey.toBase58());
});

test("the address in the body is the payer even when the session has a wallet", async () => {
  const { deps, recorded } = makeDeps(null);
  const app = await makeApp(deps);
  const res = await prepare(app, {
    amountUsd: 50,
    asset: "USDC",
    payerAddress: OTHER_PAYER.publicKey.toBase58(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(recorded.created[0]!.payerAddress, OTHER_PAYER.publicKey.toBase58());
});

test("with no address in the body the session's wallet pays", async () => {
  const { deps, recorded } = makeDeps(null);
  const app = await makeApp(deps);
  const res = await prepare(app, { amountUsd: 50, asset: "USDC" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().payerAddress, USER_WALLET);
  assert.equal(recorded.created[0]!.payerAddress, USER_WALLET);
});

test("a payer that is no wallet, or is one of the platform's addresses, is refused", async () => {
  const [offCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("x")],
    new PublicKey("11111111111111111111111111111111"),
  );
  for (const payerAddress of [
    "",
    "not an address",
    USER_WALLET.slice(0, 30),
    offCurve.toBase58(),
    DEPOSIT,
    PAYOUT_WALLET,
  ]) {
    const { deps, recorded } = makeDeps(null);
    const app = await makeApp(deps);
    const res = await prepare(app, { amountUsd: 50, asset: "USDC", payerAddress });
    assertRefusal(
      res,
      400,
      "invalid_payer_address",
      "That is not a Solana wallet address. Connect a wallet and try again.",
    );
    assert.equal(recorded.created.length, 0, payerAddress);
  }
});

// ============================================
// Prepare: the refusals, in the contract's order
// ============================================

test("a body that cannot be read is invalid_payload, with no detail of why", async () => {
  const { deps } = makeDeps(null);
  const app = await makeApp(deps);
  for (const payload of [
    {},
    { amountUsd: "50", asset: "USDC" },
    { amountUsd: 50, asset: "DOGE" },
    { amountUsd: 50, asset: "USDC", payerAddress: 7 },
  ]) {
    const res = await prepare(app, payload);
    assertRefusal(
      res,
      400,
      "invalid_payload",
      "We could not read that request. Start the top-up again.",
    );
  }
});

test("an amount out of bounds is invalid_amount, before anything about the wallet", async () => {
  for (const amountUsd of [2, 4.99, 10_000.01, 999_999, -5, 0]) {
    const { deps, recorded } = makeDeps(null);
    // No wallet anywhere: the amount is still what is refused first.
    const app = await makeApp(deps, { walletAddress: null });
    const res = await prepare(app, { amountUsd, asset: "SOL" });
    assertRefusal(
      res,
      400,
      "invalid_amount",
      "Choose an amount between $5 and $10,000.",
    );
    assert.equal(recorded.created.length, 0, "no row persisted");
    assert.equal(recorded.quotes, 0, "no price asked for");
  }
});

test("SOL is asset_unavailable while the price source is off; USDC is not affected", async () => {
  const { deps, recorded } = makeDeps(null, { solEnabled: false });
  const app = await makeApp(deps);
  const res = await prepare(app, { amountUsd: 50, asset: "SOL" });
  assertRefusal(
    res,
    400,
    "asset_unavailable",
    "SOL is not available here right now. Pay with USDC.",
  );
  assert.equal(recorded.quotes, 0);
  const usdc = await prepare(app, { amountUsd: 50, asset: "USDC" });
  assert.equal(usdc.statusCode, 200, usdc.body);
});

test("prepare answers 503 chain_unavailable when the cluster check is not ok", async () => {
  for (const reason of ["wrong_cluster", "unreachable"] as const) {
    const { deps, recorded } = makeDeps(null, {
      ensureCluster: async () => ({ ok: false, reason }),
    });
    const app = await makeApp(deps);
    for (const asset of ["USDC", "SOL"]) {
      const res = await prepare(app, { amountUsd: 50, asset });
      assertRefusal(res, 503, "chain_unavailable", PAUSED);
    }
    assert.equal(recorded.created.length, 0);
    assert.equal(recorded.quotes, 0, "no price read on a chain in doubt");
  }
  // A check that throws is a check that is not ok.
  const { deps } = makeDeps(null, {
    ensureCluster: async () => {
      throw new Error(HOSTILE);
    },
  });
  const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "USDC" });
  assertRefusal(res, 503, "chain_unavailable", PAUSED);
});

test("a stale price refuses SOL while USDC still prepares", async () => {
  const { deps, recorded } = makeDeps(null, {
    getSolQuote: async () => ({ ok: false, code: "stale", detail: `age 900s ${HOSTILE}` }),
  });
  const app = await makeApp(deps);

  const sol = await prepare(app, { amountUsd: 50, asset: "SOL" });
  assertRefusal(
    sol,
    503,
    "price_unavailable",
    "We could not get a current SOL price, so nothing was prepared. Pay with USDC, or try again in a minute.",
  );
  assertNoRawText(sol.body);
  assert.equal(recorded.created.length, 0, "nothing prepared for SOL");

  const usdc = await prepare(app, { amountUsd: 50, asset: "USDC" });
  assert.equal(usdc.statusCode, 200, usdc.body);
  assert.equal(recorded.created.length, 1);
  assert.equal(recorded.created[0]!.asset, "USDC");
});

test("every quote refusal is price_unavailable: there is no fallback price", async () => {
  for (const code of [
    "source_off",
    "account_missing",
    "too_uncertain",
    "off_average",
    "rpc_unavailable",
    "static_not_set",
  ] as const) {
    const { deps, recorded } = makeDeps(null, {
      getSolQuote: async () => ({ ok: false, code }),
    });
    const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "SOL" });
    assert.equal(res.statusCode, 503, code);
    assert.equal(res.json().error, "price_unavailable");
    assert.equal(recorded.created.length, 0);
  }
  // A quote that values SOL at nothing cannot price an amount either.
  const { deps, recorded } = makeDeps(null, {
    getSolQuote: async () => ({
      ok: true,
      quote: { ...QUOTE, confMicroUsdPerSol: QUOTE.midMicroUsdPerSol },
    }),
  });
  const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "SOL" });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, "price_unavailable");
  assert.equal(recorded.created.length, 0);
});

test("a wallet holding too little USDC is told what it holds", async () => {
  const { deps, recorded } = makeDeps(
    null,
    {},
    { balances: { lamports: 1_000_000n, usdcRaw: 3_200_000n, depositUsdcAccountExists: true } },
  );
  const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "USDC" });
  assertRefusal(
    res,
    409,
    "wallet_balance_short",
    "This wallet holds 3.20 USDC, which is less than this top-up needs. Choose a smaller amount or another wallet.",
  );
  assert.equal(recorded.created.length, 0);
  assert.deepEqual(recorded.balanceReads, [
    { payerAddress: USER_WALLET, depositAddress: DEPOSIT, asset: "USDC" },
  ]);
});

test("a wallet holding too little SOL is told what it holds, allowing for the fee", async () => {
  // $50 at $200 is 0.25 SOL. Exactly 0.25 SOL cannot also pay the fee.
  const exact = makeDeps(
    null,
    {},
    { balances: { lamports: 250_000_000n, usdcRaw: null, depositUsdcAccountExists: null } },
  );
  const short = await prepare(await makeApp(exact.deps), { amountUsd: 50, asset: "SOL" });
  assertRefusal(
    short,
    409,
    "wallet_balance_short",
    "This wallet holds 0.2500 SOL, which is less than this top-up needs. Choose a smaller amount or another wallet.",
  );
  assert.equal(exact.recorded.created.length, 0);

  const enough = makeDeps(
    null,
    {},
    { balances: { lamports: 250_005_000n, usdcRaw: null, depositUsdcAccountExists: null } },
  );
  const ok = await prepare(await makeApp(enough.deps), { amountUsd: 50, asset: "SOL" });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("the balance check is advisory: a read that fails, or says nothing, carries on", async () => {
  const failing = makeDeps(null, {
    readPayerBalances: async () => {
      throw new Error(HOSTILE);
    },
  });
  const res = await prepare(await makeApp(failing.deps), { amountUsd: 50, asset: "USDC" });
  assert.equal(res.statusCode, 200, res.body);
  assertNoRawText(res.body);
  assert.equal(res.json().opensUsdcAccount, false);

  const silent = makeDeps(
    null,
    {},
    { balances: { lamports: null, usdcRaw: null, depositUsdcAccountExists: null } },
  );
  for (const asset of ["USDC", "SOL"]) {
    const answer = await prepare(await makeApp(silent.deps), { amountUsd: 50, asset });
    assert.equal(answer.statusCode, 200, answer.body);
  }
});

test("prepare answers 502 rpc_unavailable, with no row and none of the node's words", async () => {
  const { deps, recorded } = makeDeps(null, {
    getLatestBlockhash: async () => {
      throw new Error(HOSTILE);
    },
  });
  const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "USDC" });
  assertRefusal(res, 502, "rpc_unavailable", PAUSED);
  assertNoRawText(res.body);
  assert.equal(recorded.created.length, 0);
});

test("a row that cannot be written hands out nothing to sign", async () => {
  const { deps } = makeDeps(null, {
    createTopup: async () => {
      throw new Error(HOSTILE);
    },
  });
  const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "USDC" });
  assertRefusal(res, 502, "rpc_unavailable", PAUSED);
  assertNoRawText(res.body);
  assert.ok(!res.body.includes("unsignedTxBase64"));
});

// ============================================
// Prepare: what is answered and stored
// ============================================

test("a SOL top-up is priced by the quote, holds for 60 seconds and records the price", async () => {
  const { deps, recorded } = makeDeps(null, { solMarginBps: () => 0 });
  const app = await makeApp(deps);
  const res = await prepare(app, { amountUsd: 50, asset: "SOL" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  const validUntil = new Date(FIXED_NOW.getTime() + 60_000).toISOString();
  assert.deepEqual(Object.keys(body).sort(), [
    "amountRaw",
    "amountUsd",
    "asset",
    "bonusUsd",
    "depositAddress",
    "expiresAt",
    "message",
    "opensUsdcAccount",
    "payerAddress",
    "quote",
    "quotedSolPriceUsd",
    "topupId",
    "unsignedTxBase64",
  ]);
  assert.equal(body.topupId, TOPUP_ID);
  assert.equal(body.depositAddress, DEPOSIT);
  assert.equal(body.payerAddress, USER_WALLET);
  assert.equal(body.asset, "SOL");
  assert.equal(body.amountUsd, 50);
  assert.equal(body.bonusUsd, 5);
  assert.equal(body.amountRaw, "250000000");
  assert.equal(body.quotedSolPriceUsd, 200);
  assert.deepEqual(body.quote, { solPriceUsd: 200, validUntil });
  assert.equal(body.opensUsdcAccount, false);
  assert.equal(body.expiresAt, validUntil);
  assert.equal(
    body.message,
    "1 SOL = $200.00. This price holds for 60 seconds. Confirm the transfer in your wallet.",
  );

  assert.equal(recorded.created.length, 1);
  const created = recorded.created[0]!;
  assert.equal(created.network, "solana:devnet");
  assert.equal(created.amountUsdCents, 5_000n);
  assert.equal(created.bonusCents, 500n);
  assert.equal(created.amountRaw, "250000000");
  assert.equal(created.lastValidBlockHeight, 1_000n);
  assert.equal(created.expiresAt.toISOString(), validUntil);
  // The price the amount was worked out from, its time and its source.
  assert.equal(created.quotedSolPriceUsd, 200);
  assert.equal(created.quotePriceMicroUsd, 200_000_000n);
  assert.equal(
    created.quotePublishTime!.toISOString(),
    new Date(QUOTE.publishTime * 1000).toISOString(),
  );
  assert.equal(created.quoteSource, "pyth");
  // The persisted message bytes are exactly the message of the returned
  // unsigned tx — sign-and-submit round-trips against this same row.
  const tx = Transaction.from(Buffer.from(body.unsignedTxBase64, "base64"));
  assert.equal(
    tx.serializeMessage().toString("base64"),
    created.unsignedMessageB64,
  );
});

test("the SOL amount leans against the payer by the margin, and the price shown is the one used", async () => {
  const { deps, recorded } = makeDeps(null, { solMarginBps: () => 100 });
  const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "SOL" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  // $200 less 1% is $198 a SOL; $50 / $198, rounded up to the lamport.
  assert.equal(body.quotedSolPriceUsd, 198);
  assert.equal(body.amountRaw, "252525253");
  assert.equal(recorded.created[0]!.quotePriceMicroUsd, 198_000_000n);
  assert.equal(
    body.message,
    "1 SOL = $198.00. This price holds for 60 seconds. Confirm the transfer in your wallet.",
  );
});

test("a USDC top-up is exact, holds for 120 seconds and asks for no price", async () => {
  const { deps, recorded } = makeDeps(null);
  const res = await prepare(await makeApp(deps), { amountUsd: 19.99, asset: "USDC" });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.amountUsd, 19.99);
  assert.equal(body.bonusUsd, 0);
  assert.equal(body.amountRaw, "19990000", "cents times 10,000");
  assert.equal(body.quote, null);
  assert.ok(!("quotedSolPriceUsd" in body));
  assert.equal(body.opensUsdcAccount, false);
  assert.equal(
    body.expiresAt,
    new Date(FIXED_NOW.getTime() + 120_000).toISOString(),
  );
  assert.equal(body.message, "Confirm the transfer in your wallet.");
  assert.equal(recorded.quotes, 0, "USDC never reads a price");
  const created = recorded.created[0]!;
  assert.equal(created.amountUsdCents, 1_999n);
  assert.equal(created.quotedSolPriceUsd, undefined);
  assert.equal(created.quotePriceMicroUsd, undefined);
  assert.equal(created.quotePublishTime, undefined);
  assert.equal(created.quoteSource, undefined);
});

test("the first USDC payment says it opens the organization's USDC account", async () => {
  const { deps } = makeDeps(
    null,
    {},
    { balances: { lamports: 1n, usdcRaw: 1_000_000_000n, depositUsdcAccountExists: false } },
  );
  const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "USDC" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().opensUsdcAccount, true);
  assert.equal(
    res.json().message,
    "Confirm the transfer in your wallet. This first USDC payment also opens your organization's USDC account, which costs your wallet about 0.002 SOL once.",
  );
});

test("mainnet top-ups are recorded on solana:mainnet", async () => {
  const { deps, recorded } = makeDeps(null, { network: "mainnet-beta" });
  const res = await prepare(await makeApp(deps), { amountUsd: 50, asset: "USDC" });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(recorded.created[0]!.network, "solana:mainnet");
});

// ============================================
// Submit
// ============================================

test("submit: accept → claim (signature and bytes) → send → fate → credit", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row);
  const res = await submit(await makeApp(deps));
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "balanceUsd",
    "grantedUsd",
    "message",
    "status",
    "txSignature",
  ]);
  assert.equal(body.status, "credited");
  assert.equal(body.grantedUsd, 55);
  assert.equal(body.balanceUsd, 65);
  assert.equal(body.txSignature, SIGNED_SIGNATURE);
  assert.equal(
    body.message,
    "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
  );

  // Claim before broadcast, and the claim carried everything needed to
  // find or re-send the transfer later.
  assert.deepEqual(recorded.order, ["claim", "send", "fate"]);
  assert.deepEqual(recorded.claims, [
    {
      id: TOPUP_ID,
      txSignature: SIGNED_SIGNATURE,
      signedTxB64: SIGNED_B64,
      submittedAt: FIXED_NOW,
    },
  ]);
  // The exact submitted bytes were broadcast, once.
  assert.deepEqual(recorded.sent, [SIGNED_B64]);
  // submitting → submitted before the wait.
  assert.deepEqual(recorded.marks, [
    { id: TOPUP_ID, from: ["submitting"], to: "submitted" },
  ]);
  assert.equal(recorded.waits, 1);
  // The fate was asked with the row's own last valid block height.
  assert.deepEqual(recorded.fates, [
    { signature: SIGNED_SIGNATURE, lastValidBlockHeight: 1_000n },
  ]);
  // Credit got the row's amounts, not anything client-supplied.
  assert.deepEqual(recorded.credits, [
    {
      topupId: TOPUP_ID,
      orgId: "org_1",
      amountUsdCents: 5_000n,
      bonusCents: 500n,
      asset: "SOL",
      network: "solana:devnet",
    },
  ]);
});

test("a wallet that added its fee setting is accepted, and ITS bytes are stored and sent", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row);
  const withFee = walletSignWithFee(BUILT.unsignedTxBase64, PAYER);
  assert.notEqual(withFee, SIGNED_B64);
  const res = await submit(await makeApp(deps), withFee);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(recorded.claims[0]!.signedTxB64, withFee);
  assert.equal(recorded.claims[0]!.txSignature, signatureOfSignedTransaction(withFee));
  assert.deepEqual(recorded.sent, [withFee]);
});

test("a transfer that is not the prepared one is message_mismatch and the row stays signable", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row);
  const tampered = buildTopupTransaction({
    asset: "SOL",
    payerAddress: USER_WALLET,
    depositAddress: Keypair.generate().publicKey.toBase58(),
    amountRaw: "250000000",
    topupId: TOPUP_ID,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1_000,
  });
  const res = await submit(
    await makeApp(deps),
    walletSign(tampered.unsignedTxBase64, PAYER),
  );
  assertRefusal(
    res,
    400,
    "message_mismatch",
    "The signed transfer does not match the one we prepared, so it was not sent. Nothing was taken. Start the top-up again.",
  );
  assert.equal(recorded.claims.length, 0, "never claimed");
  assert.equal(recorded.sent.length, 0, "never broadcast");
  assert.equal(row.status, "prepared", "row untouched — retryable");
});

test("bytes that are no signed transaction are unreadable_transaction", async () => {
  const sentence =
    "We could not read the signed transfer, so it was not sent. Nothing was taken. Start the top-up again.";
  for (const signedTxBase64 of [
    Buffer.from("not a transaction").toString("base64"),
    BUILT.unsignedTxBase64,
  ]) {
    const row = makeRow();
    const { deps, recorded } = makeDeps(row);
    const res = await submit(await makeApp(deps), signedTxBase64);
    assertRefusal(res, 400, "unreadable_transaction", sentence);
    assert.equal(recorded.claims.length, 0);
    assert.equal(recorded.sent.length, 0);
    assert.equal(row.status, "prepared");
  }
  // No signed transaction in the body at all.
  const { deps } = makeDeps(makeRow());
  const app = await makeApp(deps);
  const res = await app.inject({
    method: "POST",
    url: `/topups/${TOPUP_ID}/submit`,
    payload: {},
  });
  assertRefusal(res, 400, "unreadable_transaction", sentence);
});

test("someone else's top-up, or an id that is no id, is topup_not_found", async () => {
  const row = makeRow({ orgId: "org_2" });
  const { deps } = makeDeps(row);
  const app = await makeApp(deps);
  const sentence = "We could not find that top-up. Start a new one.";
  assertRefusal(await submit(app), 404, "topup_not_found", sentence);
  assertRefusal(await submit(app, SIGNED_B64, "nope"), 404, "topup_not_found", sentence);
  assertRefusal(await reconcile(app), 404, "topup_not_found", sentence);
  assertRefusal(
    await app.inject({ method: "GET", url: `/topups/${TOPUP_ID}` }),
    404,
    "topup_not_found",
    sentence,
  );
});

test("a prepared top-up past its time expires as unsigned and is refused", async () => {
  for (const [asset, sentence] of [
    [
      "SOL",
      "This top-up ran out of time before it was sent. Nothing was taken. Start it again for a fresh price.",
    ],
    [
      "USDC",
      "This top-up ran out of time before it was sent. Nothing was taken. Start it again.",
    ],
  ] as const) {
    const row = makeRow({ asset, expiresAt: new Date(FIXED_NOW.getTime() - 1_000) });
    const { deps, recorded } = makeDeps(row);
    const res = await submit(await makeApp(deps));
    assertRefusal(res, 410, "topup_expired", sentence);
    assert.deepEqual(recorded.marks, [
      {
        id: TOPUP_ID,
        from: ["prepared"],
        to: "expired",
        failureCode: "unsigned_expired",
      },
    ]);
    assert.equal(recorded.sent.length, 0);
    assert.equal(recorded.fates.length, 0);
  }
});

test("an already credited top-up answers 200 again, with no second credit", async () => {
  const row = makeRow({ status: "credited", txSignature: SIGNED_SIGNATURE });
  const { deps, recorded } = makeDeps(row);
  const res = await submit(await makeApp(deps));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), {
    status: "credited",
    message: "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
    txSignature: SIGNED_SIGNATURE,
    grantedUsd: 55,
    balanceUsd: 65,
    alreadyCredited: true,
  });
  assert.equal(recorded.credits.length, 0);
  assert.equal(recorded.sent.length, 0);
});

test("an ended top-up is 410 with its sentence, and nothing is sent", async () => {
  const cases: Array<[Partial<TopupRowView>, string, string]> = [
    [
      { status: "failed", failureCode: "failed_on_chain", txSignature: "sig" },
      "topup_failed",
      "This transfer failed on the network, so no payment was taken. Check your wallet balance and start the top-up again.",
    ],
    [
      { status: "failed", failureCode: null, txSignature: "sig" },
      "topup_failed",
      "This top-up did not go through. Start it again.",
    ],
    [
      { status: "expired", failureCode: "never_landed", txSignature: "sig" },
      "topup_expired",
      "The network did not take this transfer, so nothing was taken. Check your wallet balance and start the top-up again.",
    ],
    [
      { status: "expired", failureCode: "unsigned_expired", asset: "USDC" },
      "topup_expired",
      "This top-up ran out of time before it was sent. Nothing was taken. Start it again.",
    ],
  ];
  for (const [over, error, sentence] of cases) {
    const { deps, recorded } = makeDeps(makeRow(over));
    const res = await submit(await makeApp(deps));
    assertRefusal(res, 410, error, sentence);
    assert.equal(recorded.sent.length, 0);
    assert.equal(recorded.claims.length, 0);
  }
});

test("different bytes for a top-up in flight are 409 in_flight, never a second broadcast", async () => {
  const sentence =
    "This top-up is already being confirmed. You do not need to send it again.";
  for (const status of ["submitting", "submitted"]) {
    const row = makeRow({ status, txSignature: "some_other_signature" });
    const { deps, recorded } = makeDeps(row);
    const res = await submit(await makeApp(deps));
    assertRefusal(res, 409, "in_flight", sentence);
    assert.equal(recorded.sent.length, 0);
    assert.equal(recorded.fates.length, 0);
    // Bytes that are no transaction at all are not "the same bytes".
    const garbage = await submit(await makeApp(deps), "AAAA");
    assertRefusal(garbage, 409, "in_flight", sentence);
  }
});

test("the same bytes twice are broadcast once, and the second answer is the current state", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {}, { fate: "in_flight" });
  const app = await makeApp(deps);

  const first = await submit(app);
  assert.equal(first.statusCode, 202, first.body);
  assert.deepEqual(first.json(), {
    status: "submitted",
    message:
      "Your transfer was sent and is being confirmed. Your credits appear as soon as it is, usually within a minute. You can leave this page.",
    txSignature: SIGNED_SIGNATURE,
    pendingConfirmation: true,
  });

  const second = await submit(app);
  assert.equal(second.statusCode, 202, second.body);
  assert.deepEqual(second.json(), first.json());

  assert.deepEqual(recorded.sent, [SIGNED_B64], "broadcast exactly once");
  assert.equal(recorded.claims.length, 1, "claimed exactly once");
  assert.equal(recorded.credits.length, 0);
  assert.equal(row.status, "submitted");
});

test("the same bytes again for a transfer that has landed are 200 credited, once", async () => {
  const row = makeRow({ status: "submitted", txSignature: SIGNED_SIGNATURE });
  const { deps, recorded } = makeDeps(row, {}, { fate: "landed_ok" });
  const app = await makeApp(deps);
  const first = await submit(app);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().status, "credited");
  assert.equal(first.json().alreadyCredited, undefined);
  const again = await submit(app);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().alreadyCredited, true);
  assert.equal(recorded.credits.length, 1);
  assert.equal(recorded.sent.length, 0, "never broadcast by a repeat");
});

test("two submits of the same bytes at once: the one that loses the claim gets the state, not a conflict", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(
    row,
    {
      claimForSubmit: async (args) => {
        // The other request won the row with the very same transfer.
        row.status = "submitting";
        row.txSignature = args.txSignature;
        return "lost";
      },
    },
    { fate: "in_flight" },
  );
  const res = await submit(await makeApp(deps));
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(res.json().status, "submitting");
  assert.equal(res.json().txSignature, SIGNED_SIGNATURE);
  assert.equal(recorded.sent.length, 0, "the loser never broadcasts");
});

test("losing the claim to a DIFFERENT transfer is 409 in_flight without broadcasting", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    claimForSubmit: async () => {
      row.status = "submitting";
      row.txSignature = "another_signature";
      return "lost";
    },
  });
  const res = await submit(await makeApp(deps));
  assertRefusal(
    res,
    409,
    "in_flight",
    "This top-up is already being confirmed. You do not need to send it again.",
  );
  assert.equal(recorded.sent.length, 0);
  assert.equal(recorded.fates.length, 0);
});

test("a signature that already belongs to another top-up is 409 duplicate_signature", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    claimForSubmit: async () => "duplicate_signature",
  });
  const res = await submit(await makeApp(deps));
  assertRefusal(
    res,
    409,
    "duplicate_signature",
    "This top-up is already being confirmed. You do not need to send it again.",
  );
  assert.equal(recorded.sent.length, 0);
});

test("a send that errors ends nothing: 202, the row waits in submitting for the worker", async () => {
  const sends: Array<WalletTopupRouteDeps["sendRawTransaction"]> = [
    async () => ({ ok: false, detail: HOSTILE }),
    async () => ({ ok: false, detail: "Blockhash not found" }),
    async () => {
      throw new Error(HOSTILE);
    },
  ];
  for (const sendRawTransaction of sends) {
    const row = makeRow();
    const { deps, recorded } = makeDeps(row, { sendRawTransaction });
    const res = await submit(await makeApp(deps));
    assert.equal(res.statusCode, 202, res.body);
    assert.deepEqual(res.json(), {
      status: "submitting",
      message:
        "We could not confirm that the network took this transfer. If it goes through, your credits are added within a few minutes. If it does not, nothing is taken.",
      txSignature: SIGNED_SIGNATURE,
      pendingConfirmation: true,
    });
    assertNoRawText(res.body);
    // The claim happened; nothing after it changed the row.
    assert.equal(recorded.claims.length, 1);
    assert.deepEqual(recorded.marks, [], "no status change from an error");
    assert.equal(row.status, "submitting");
    assert.equal(row.failureCode, null);
    assert.equal(row.txSignature, SIGNED_SIGNATURE);
    assert.equal(recorded.credits.length, 0);
  }
});

test("a transfer that failed on the chain fails the row by code; the chain's words stay with operators", async () => {
  const row = makeRow();
  const chainError = `{"InstructionError":[0,"Custom"]} ${HOSTILE}`;
  const { deps, recorded } = makeDeps(
    row,
    {},
    { fate: "landed_failed", fateError: chainError },
  );
  const res = await submit(await makeApp(deps));
  assertRefusal(
    res,
    410,
    "topup_failed",
    "This transfer failed on the network, so no payment was taken. Check your wallet balance and start the top-up again.",
  );
  assertNoRawText(res.body);
  assert.equal(recorded.credits.length, 0);
  assert.equal(row.status, "failed");
  assert.deepEqual(recorded.marks[1], {
    id: TOPUP_ID,
    from: ["submitting", "submitted"],
    to: "failed",
    failureCode: "failed_on_chain",
    failureReason: chainError,
  });
});

test("a transfer the chain proves dead expires the row as never_landed", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {}, { fate: "dead" });
  const res = await submit(await makeApp(deps));
  assertRefusal(
    res,
    410,
    "topup_expired",
    "The network did not take this transfer, so nothing was taken. Check your wallet balance and start the top-up again.",
  );
  assert.equal(row.status, "expired");
  assert.equal(recorded.marks[1]!.failureCode, "never_landed");
  assert.equal(recorded.credits.length, 0);
});

test("an undecided fate answers 202 and changes nothing", async () => {
  for (const fate of ["in_flight", "unknown"] as const) {
    const row = makeRow();
    const { deps, recorded } = makeDeps(row, {}, { fate, fateError: HOSTILE });
    const res = await submit(await makeApp(deps));
    assert.equal(res.statusCode, 202, res.body);
    assert.equal(res.json().status, "submitted");
    assert.equal(res.json().pendingConfirmation, true);
    assertNoRawText(res.body);
    assert.equal(recorded.credits.length, 0, "no credit without the chain saying so");
    assert.equal(row.status, "submitted");
    assert.equal(recorded.marks.length, 1, "only submitting → submitted");
  }
});

test("the wait decides nothing: whatever it does, the fate is what is read", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    waitForConfirmation: async () => {
      throw new Error(HOSTILE);
    },
  });
  const res = await submit(await makeApp(deps));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "credited");
  assert.equal(recorded.fates.length, 1);
  assertNoRawText(res.body);
});

test("submit answers 503 chain_unavailable before anything is claimed or sent", async () => {
  const row = makeRow();
  const { deps, recorded } = makeDeps(row, {
    ensureCluster: async () => ({ ok: false, reason: "wrong_cluster" }),
  });
  const res = await submit(await makeApp(deps));
  assertRefusal(res, 503, "chain_unavailable", PAUSED);
  assert.equal(recorded.claims.length, 0);
  assert.equal(recorded.sent.length, 0);
  assert.equal(recorded.fates.length, 0, "the wrong chain is never asked");
  assert.equal(row.status, "prepared");
});

test("a repeat submit of a transfer already sent is never told nothing was taken", async () => {
  // The cluster is in doubt, but this transfer was handed to the network
  // earlier and may have landed: the answer is the row as it stands.
  for (const status of ["submitting", "submitted"]) {
    const row = makeRow({ status, txSignature: SIGNED_SIGNATURE });
    const { deps, recorded } = makeDeps(row, {
      ensureCluster: async () => ({ ok: false, reason: "wrong_cluster" }),
    });
    const res = await submit(await makeApp(deps));
    assert.equal(res.statusCode, 202, res.body);
    const body = res.json();
    assert.equal(body.status, status);
    assert.equal(body.pendingConfirmation, true);
    assert.equal(body.txSignature, SIGNED_SIGNATURE);
    assert.ok(!/nothing was taken/i.test(body.message), body.message);
    assert.equal(recorded.fates.length, 0, "the wrong chain is never asked");
    assert.equal(recorded.sent.length, 0);
    assert.equal(recorded.claims.length, 0);
    assert.equal(recorded.credits.length, 0);
    assert.equal(recorded.marks.length, 0);
    assert.equal(row.status, status);
  }
});

test("a credit taken by the worker first is reported as already credited", async () => {
  const row = makeRow();
  const { deps } = makeDeps(row, {
    creditTopup: async () => {
      // The worker's compare-and-set won between the fate and ours.
      row.status = "credited";
      return { credited: false };
    },
  });
  const res = await submit(await makeApp(deps));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, "credited");
  assert.equal(res.json().alreadyCredited, true);
  assert.equal(res.json().grantedUsd, 55);
});

// ============================================
// Reconcile
// ============================================

test("reconcile credits a transfer that landed, exactly once", async () => {
  const row = makeRow({ status: "submitted", txSignature: "onchain_sig" });
  const { deps, recorded } = makeDeps(row, {}, { fate: "landed_ok" });
  const app = await makeApp(deps);
  const res = await reconcile(app);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    status: "credited",
    message: "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
    txSignature: "onchain_sig",
    grantedUsd: 55,
    balanceUsd: 65,
  });
  assert.deepEqual(recorded.fates, [
    { signature: "onchain_sig", lastValidBlockHeight: 1_000n },
  ]);
  const again = await reconcile(app);
  assert.equal(again.json().status, "credited");
  assert.equal(again.json().alreadyCredited, true);
  assert.equal(recorded.credits.length, 1);
  assert.equal(recorded.fates.length, 1, "an ended row is not asked about again");
});

test("reconcile finishes a row left in submitting by a send that errored", async () => {
  const row = makeRow({ status: "submitting", txSignature: "onchain_sig" });
  const { deps, recorded } = makeDeps(row, {}, { fate: "landed_ok" });
  const res = await reconcile(await makeApp(deps));
  assert.equal(res.json().status, "credited");
  assert.equal(recorded.credits.length, 1);
});

test("reconcile fails a row whose transfer failed on the chain, by code", async () => {
  const row = makeRow({ status: "submitted", txSignature: "onchain_sig" });
  const { deps, recorded } = makeDeps(
    row,
    {},
    { fate: "landed_failed", fateError: `{"InstructionError":[1,"Custom"]} ${HOSTILE}` },
  );
  const res = await reconcile(await makeApp(deps));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    status: "failed",
    message:
      "This transfer failed on the network, so no payment was taken. Check your wallet balance and start the top-up again.",
    txSignature: "onchain_sig",
  });
  assertNoRawText(res.body);
  assert.equal(recorded.credits.length, 0);
  assert.equal(row.status, "failed");
  assert.equal(recorded.marks[0]!.failureCode, "failed_on_chain");
});

test("reconcile expires a transfer only when the chain proves it dead", async () => {
  const row = makeRow({ status: "submitted", txSignature: "gone_sig" });
  const { deps, recorded } = makeDeps(row, {}, { fate: "dead" });
  const res = await reconcile(await makeApp(deps));
  assert.deepEqual(res.json(), {
    status: "expired",
    message:
      "The network did not take this transfer, so nothing was taken. Check your wallet balance and start the top-up again.",
    txSignature: "gone_sig",
  });
  assert.deepEqual(recorded.marks, [
    {
      id: TOPUP_ID,
      from: ["submitting", "submitted"],
      to: "expired",
      failureCode: "never_landed",
      failureReason: "absent_expired_by_height",
    },
  ]);
});

test("reconcile keeps waiting while the fate is undecided, however late the clock", async () => {
  for (const fate of ["in_flight", "unknown"] as const) {
    for (const status of ["submitting", "submitted"]) {
      const row = makeRow({
        status,
        txSignature: "pending_sig",
        // Long past the wall-clock time: only the chain may end it.
        expiresAt: new Date(FIXED_NOW.getTime() - 3_600_000),
      });
      const { deps, recorded } = makeDeps(row, {}, { fate, fateError: HOSTILE });
      const res = await reconcile(await makeApp(deps));
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, status);
      assert.equal(res.json().pendingConfirmation, true);
      assert.equal(res.json().txSignature, "pending_sig");
      assertNoRawText(res.body);
      assert.equal(recorded.credits.length, 0);
      assert.deepEqual(recorded.marks, []);
      assert.equal(row.status, status, "not ended early");
    }
  }
});

test("a fate read that throws changes nothing", async () => {
  const row = makeRow({ status: "submitted", txSignature: "pending_sig" });
  const { deps, recorded } = makeDeps(row, {
    readSignatureFate: async () => {
      throw new Error(HOSTILE);
    },
  });
  const res = await reconcile(await makeApp(deps));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "submitted");
  assertNoRawText(res.body);
  assert.deepEqual(recorded.marks, []);
  assert.equal(recorded.credits.length, 0);
});

test("reconcile reads no chain while the cluster is in doubt", async () => {
  const row = makeRow({ status: "submitted", txSignature: "pending_sig" });
  const { deps, recorded } = makeDeps(
    row,
    { ensureCluster: async () => ({ ok: false, reason: "wrong_cluster" }) },
    { fate: "dead" },
  );
  const res = await reconcile(await makeApp(deps));
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "submitted");
  assert.equal(res.json().pendingConfirmation, true);
  assert.equal(recorded.fates.length, 0);
  assert.equal(row.status, "submitted");
});

test("reconcile on an ended row reports it with its sentence and reads no chain", async () => {
  const row = makeRow({ status: "expired", failureCode: "unsigned_expired" });
  const { deps, recorded } = makeDeps(row);
  const res = await reconcile(await makeApp(deps));
  assert.deepEqual(res.json(), {
    status: "expired",
    message:
      "This top-up ran out of time before it was sent. Nothing was taken. Start it again for a fresh price.",
  });
  assert.equal(recorded.credits.length, 0);
  assert.equal(recorded.fates.length, 0);
});

test("reconcile on a prepared row: waiting for a signature, or expired as unsigned", async () => {
  const waiting = makeRow();
  const a = makeDeps(waiting);
  const res = await reconcile(await makeApp(a.deps));
  assert.deepEqual(res.json(), {
    status: "prepared",
    message:
      "1 SOL = $200.00. This price holds for 60 seconds. Confirm the transfer in your wallet.",
    pendingSignature: true,
  });
  assert.deepEqual(a.recorded.marks, []);

  const late = makeRow({ expiresAt: new Date(FIXED_NOW.getTime() - 1) });
  const b = makeDeps(late);
  const expired = await reconcile(await makeApp(b.deps));
  assert.equal(expired.json().status, "expired");
  assert.equal(
    expired.json().message,
    "This top-up ran out of time before it was sent. Nothing was taken. Start it again for a fresh price.",
  );
  assert.deepEqual(b.recorded.marks, [
    {
      id: TOPUP_ID,
      from: ["prepared"],
      to: "expired",
      failureCode: "unsigned_expired",
    },
  ]);
  assert.equal(b.recorded.fates.length, 0);
});

// ============================================
// Reading top-ups
// ============================================

const VIEW_KEYS = [
  "amountUsd",
  "asset",
  "bonusUsd",
  "createdAt",
  "depositAddress",
  "expiresAt",
  "id",
  "message",
  "payerAddress",
  "status",
  "txSignature",
];

test("GET /topups/:id returns the contract's view, with a sentence and no raw reason", async () => {
  const row = makeRow({ status: "submitted", txSignature: "sig123" });
  const { deps } = makeDeps(row);
  const app = await makeApp(deps);
  const res = await app.inject({ method: "GET", url: `/topups/${TOPUP_ID}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(Object.keys(body).sort(), VIEW_KEYS);
  assert.deepEqual(body, {
    id: TOPUP_ID,
    status: "submitted",
    message:
      "Your transfer was sent and is being confirmed. Your credits appear as soon as it is, usually within a minute. You can leave this page.",
    asset: "SOL",
    amountUsd: 50,
    bonusUsd: 5,
    txSignature: "sig123",
    depositAddress: DEPOSIT,
    payerAddress: USER_WALLET,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
});

test("a failed row's stored reason is never part of the view", async () => {
  // Even if a binding handed the raw reason over, the view has no place
  // for it.
  const row = {
    ...makeRow({ status: "failed", failureCode: "failed_on_chain", txSignature: "sig" }),
    failureReason: HOSTILE,
    reason: HOSTILE,
  } as TopupRowView;
  const { deps } = makeDeps(row);
  const app = await makeApp(deps);
  for (const url of [`/topups/${TOPUP_ID}`, "/topups"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200);
    assertNoRawText(res.body);
  }
  assertNoRawText((await reconcile(app)).body);
  assertNoRawText((await submit(app)).body);
});

test("GET /topups lists the organization's last 20 in the same shape", async () => {
  const row = makeRow({ status: "credited", txSignature: "sig123" });
  const asked: unknown[] = [];
  const { deps } = makeDeps(row, {
    listTopups: async (args) => {
      asked.push(args);
      return [row, makeRow({ id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" })];
    },
  });
  const res = await (await makeApp(deps)).inject({ method: "GET", url: "/topups" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(asked, [{ orgId: "org_1", limit: 20 }]);
  const { topups } = res.json();
  assert.equal(topups.length, 2);
  assert.deepEqual(Object.keys(topups[0]).sort(), VIEW_KEYS);
  assert.equal(
    topups[0].message,
    "Added $55.00 in credits: $50.00 paid and a $5.00 bonus.",
  );
  // A prepared row has no signature to show.
  assert.ok(!("txSignature" in topups[1]));
  assert.equal(topups[1].status, "prepared");
});

// ============================================
// Nothing raw, ever
// ============================================

test("a throw nobody expected is one fixed sentence, on every route", async () => {
  const { deps } = makeDeps(makeRow(), {
    findTopup: async () => {
      throw new Error(HOSTILE);
    },
    listTopups: async () => {
      throw new Error(HOSTILE);
    },
    deriveDepositAddress: () => {
      throw new Error(HOSTILE);
    },
  });
  const app = await makeApp(deps);
  const answers = [
    await prepare(app, { amountUsd: 50, asset: "USDC" }),
    await submit(app),
    await reconcile(app),
    await app.inject({ method: "GET", url: `/topups/${TOPUP_ID}` }),
    await app.inject({ method: "GET", url: "/topups" }),
  ];
  for (const res of answers) {
    assertRefusal(
      res,
      500,
      "internal_error",
      "Something went wrong on our side. Check your top-ups before you try again.",
    );
    assertNoRawText(res.body);
  }
});

test("a claim or a credit that throws after the signature is stored leaks nothing", async () => {
  const claimThrows = makeDeps(makeRow(), {
    claimForSubmit: async () => {
      throw new Error(HOSTILE);
    },
  });
  const a = await submit(await makeApp(claimThrows.deps));
  assert.equal(a.statusCode, 500);
  assertNoRawText(a.body);
  assert.equal(claimThrows.recorded.sent.length, 0, "no claim, no broadcast");

  const row = makeRow();
  const creditThrows = makeDeps(row, {
    creditTopup: async () => {
      throw new Error(HOSTILE);
    },
  });
  const b = await submit(await makeApp(creditThrows.deps));
  assert.equal(b.statusCode, 500);
  assertNoRawText(b.body);
  // The row is still in flight: the worker credits it from the chain.
  assert.equal(row.status, "submitted");
});

test("every answer about a top-up carries a sentence", async () => {
  const states: Array<Partial<TopupRowView>> = [
    {},
    { status: "submitting", txSignature: SIGNED_SIGNATURE },
    { status: "submitted", txSignature: SIGNED_SIGNATURE },
    { status: "credited", txSignature: SIGNED_SIGNATURE },
    { status: "failed", txSignature: SIGNED_SIGNATURE, failureCode: "failed_on_chain" },
    { status: "expired", failureCode: "unsigned_expired" },
    { status: "expired", txSignature: SIGNED_SIGNATURE, failureCode: "never_landed" },
  ];
  for (const state of states) {
    for (const fate of ["landed_ok", "landed_failed", "dead", "in_flight", "unknown"] as const) {
      const { deps } = makeDeps(makeRow(state), {}, { fate });
      const app = await makeApp(deps);
      for (const res of [
        await app.inject({ method: "GET", url: `/topups/${TOPUP_ID}` }),
        await reconcile(app),
        await submit(app),
      ]) {
        const body = res.json();
        assert.equal(typeof body.message, "string", res.body);
        assert.ok(body.message.length > 10, res.body);
        assert.ok(!/[–—]/.test(body.message), body.message);
        assert.ok(body.status !== undefined || body.error !== undefined, res.body);
      }
    }
  }
});
