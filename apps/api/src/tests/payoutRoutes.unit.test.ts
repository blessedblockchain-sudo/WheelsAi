// POST /api/marketplace/payouts (routes/payouts.ts) over an in-memory
// database, and the production wiring's two own parts
// (routes/payoutBindings.ts): the one chain read for an address, and the
// list of the platform's own addresses. Nothing here reaches a chain.
import "./unitEnv.js";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import { buildPayoutAddressRead, payoutPlatformAddresses } from "../routes/payoutBindings.js";
import { derivePayoutKeypair } from "../services/payoutKeypair.js";
import { payoutRequestSettingsFromEnv } from "../services/payoutRequests.js";
import { deriveTopupDepositKeypair } from "../services/topupKeypairs.js";
import { fakeDb, ORG, OTHER_ORG, payoutApp, payoutRow, routeDepsOver, type RequestWorld } from "./payoutFakes.js";

const WALLET = Keypair.generate().publicKey.toBase58();
const OWN = Keypair.generate().publicKey.toBase58();

async function world(
  balance: bigint,
  over: RequestWorld & { running?: boolean; rows?: ReturnType<typeof payoutRow>[] } = {},
) {
  const { state, db } = fakeDb(over.rows ?? [], { [ORG]: balance });
  const { routeDeps, chainReads } = routeDepsOver(db, { platformAddresses: [OWN], ...over });
  const app = await payoutApp(routeDeps);
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/payouts", payload: payload as any });
  return { state, db, app, post, chainReads, routeDeps };
}

// ---------------------------------------------------------------
// A request that goes through
// ---------------------------------------------------------------

test("201: the payout as the list shows it, what is left, and a sentence", async () => {
  const { state, app, post } = await world(4120n);
  try {
    const res = await post({ payoutMethod: "crypto_usdc", payoutAddress: WALLET });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.deepEqual(Object.keys(body), ["payout", "remainingCents", "message"]);
    assert.equal(body.remainingCents, 0);
    assert.equal(body.message, "Payout of $41.20 requested. It is usually sent within a few minutes.");
    assert.deepEqual(Object.keys(body.payout), [
      "id",
      "amountCents",
      "payoutMethod",
      "payoutAddress",
      "status",
      "txSignature",
      "grossRevenueCents",
      "platformFeeCents",
      "periodStart",
      "periodEnd",
      "requestedAt",
      "processedAt",
      "failureReason",
      "cancellable",
      "message",
    ]);
    assert.equal(body.payout.id, state.payouts[0]!.id);
    assert.equal(body.payout.amountCents, 4120);
    assert.equal(body.payout.payoutMethod, "crypto_usdc");
    assert.equal(body.payout.payoutAddress, WALLET);
    assert.equal(body.payout.status, "pending");
    assert.equal(body.payout.cancellable, true);
    assert.equal(body.payout.message, null);
    assert.equal(state.balances[ORG], 0n);

    // The list shows the same payout.
    const list = await app.inject({ method: "GET", url: "/payouts" });
    assert.deepEqual(list.json().payouts, [body.payout]);
  } finally {
    await app.close();
  }
});

test("201 at the cap says what stays; credits say credits; an amount is honoured", async () => {
  const capped = await world(74_000n);
  const atCap = await capped.post({ payoutMethod: "crypto_sol", payoutAddress: WALLET });
  assert.equal(atCap.statusCode, 201);
  assert.equal(atCap.json().payout.amountCents, 50_000);
  assert.equal(atCap.json().remainingCents, 24_000);
  assert.equal(
    atCap.json().message,
    "Requested $500.00, the most for one payout to a wallet. $240.00 stays in your earnings.",
  );
  await capped.app.close();

  const credits = await world(74_000n);
  const all = await credits.post({ payoutMethod: "credits" });
  assert.equal(all.statusCode, 201);
  assert.equal(all.json().payout.amountCents, 74_000, "credits have no cap");
  assert.equal(all.json().payout.payoutAddress, null);
  assert.equal(all.json().message, "Payout of $740.00 requested as credits.");
  assert.equal(credits.chainReads.length, 0);
  await credits.app.close();

  const some = await world(4120n);
  const part = await some.post({ payoutMethod: "credits", amountCents: 500, payoutAddress: null });
  assert.equal(part.statusCode, 201);
  assert.equal(part.json().payout.amountCents, 500);
  assert.equal(part.json().remainingCents, 3620);
  assert.equal(some.state.balances[ORG], 3620n);
  await some.app.close();
});

// ---------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------

test("every refusal is { error, message } with the contract's status and sentence, and reserves nothing", async () => {
  const open = payoutRow({ status: "processing" });
  const cases: Array<{
    name: string;
    balance: bigint;
    over?: Parameters<typeof world>[1];
    payload: unknown;
    status: number;
    error: string;
    message: string;
  }> = [
    {
      name: "payouts off",
      balance: 4120n,
      over: { running: false },
      payload: { payoutMethod: "credits" },
      status: 503,
      error: "payouts_unavailable",
      message: "Payouts are temporarily unavailable. Nothing was reserved and your earnings are unchanged. Try again later.",
    },
    ...[
      {},
      { payoutMethod: "paypal" },
      { payoutMethod: "credits", amountCents: "1000" },
      { payoutMethod: "credits", amountCents: 10.5 },
      { payoutMethod: "credits", amountCents: 0 },
      { payoutMethod: "credits", amountCents: -500 },
      { payoutMethod: "credits", amountCents: 2 ** 60 },
      { payoutMethod: "crypto_usdc", payoutAddress: 12345 },
      { payoutMethod: "crypto_usdc", payoutAddress: "x".repeat(201) },
      ["credits"],
    ].map((payload, i) => ({
      name: `unreadable ${i}`,
      balance: 4120n,
      payload,
      status: 400,
      error: "invalid_payload",
      message: "We could not read that request. Check the amount and try again.",
    })),
    {
      name: "SOL not offered",
      balance: 4120n,
      over: { settings: { solOffered: false } },
      payload: { payoutMethod: "crypto_sol", payoutAddress: WALLET },
      status: 400,
      error: "payout_method_unavailable",
      message: "SOL payouts are not available right now. Choose USDC or credits.",
    },
    {
      name: "one already open",
      balance: 4120n,
      over: { rows: [open] },
      payload: { payoutMethod: "credits" },
      status: 409,
      error: "payout_in_progress",
      message: "You already have a payout in progress. Wait for it to finish, or cancel it if it has not been sent.",
    },
    {
      name: "balance below the minimum",
      balance: 310n,
      payload: { payoutMethod: "credits" },
      status: 400,
      error: "payout_below_minimum",
      message: "The smallest payout is $5.00. You have $3.10 available.",
    },
    {
      name: "amount below the minimum",
      balance: 4120n,
      payload: { payoutMethod: "credits", amountCents: 499 },
      status: 400,
      error: "payout_below_minimum",
      message: "The smallest payout is $5.00.",
    },
    {
      name: "above the balance",
      balance: 4120n,
      payload: { payoutMethod: "credits", amountCents: 4121 },
      status: 400,
      error: "payout_above_balance",
      message: "You have $41.20 available. Request that amount or less.",
    },
    {
      name: "above the cap",
      balance: 74_000n,
      payload: { payoutMethod: "crypto_usdc", payoutAddress: WALLET, amountCents: 50_001 },
      status: 400,
      error: "payout_above_limit",
      message: "The most for one payout to a wallet is $500.00. Request that amount or less; the rest stays in your earnings.",
    },
    {
      name: "the day used up",
      balance: 74_000n,
      over: {
        rows: [
          payoutRow({ payoutMethod: "crypto_usdc", status: "completed", amountCents: 50_000n, requestedAt: new Date("2026-10-10T01:00:00Z") }),
          payoutRow({ id: "00000000-0000-4000-8000-000000000002", payoutMethod: "crypto_sol", status: "completed", amountCents: 50_000n, requestedAt: new Date("2026-10-10T02:00:00Z") }),
        ],
      },
      payload: { payoutMethod: "crypto_usdc", payoutAddress: WALLET },
      status: 409,
      error: "payout_daily_limit",
      message:
        "You have reached today's limit for payouts to a wallet. You can request more after midnight UTC, or take a payout as credits now.",
    },
    {
      name: "no address",
      balance: 4120n,
      payload: { payoutMethod: "crypto_usdc" },
      status: 400,
      error: "payout_address_required",
      message: "Enter the wallet address to send this payout to.",
    },
    {
      name: "not an address",
      balance: 4120n,
      payload: { payoutMethod: "crypto_sol", payoutAddress: "AttackerWa11et1111111111111111111111111111" },
      status: 400,
      error: "invalid_payout_address",
      message: "That is not a Solana wallet address. Check it and try again.",
    },
    {
      name: "the platform's own",
      balance: 4120n,
      payload: { payoutMethod: "crypto_usdc", payoutAddress: OWN },
      status: 400,
      error: "invalid_payout_address",
      message: "That address belongs to WheelsAI, not to you. Enter your own wallet address.",
    },
    {
      name: "a token account or a program",
      balance: 4120n,
      over: { chain: "not_a_wallet" },
      payload: { payoutMethod: "crypto_usdc", payoutAddress: WALLET },
      status: 400,
      error: "invalid_payout_address",
      message: "That address is a token account or a program, not a wallet. Enter the wallet address itself.",
    },
    {
      name: "the chain read failed",
      balance: 4120n,
      over: {
        chain: async () => {
          throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:8899");
        },
      },
      payload: { payoutMethod: "crypto_usdc", payoutAddress: WALLET },
      status: 503,
      error: "payout_check_unavailable",
      message:
        "Payouts to a wallet are paused for a moment. Nothing was reserved and your earnings are unchanged. Try again shortly.",
    },
  ];
  for (const c of cases) {
    const { state, app, post } = await world(c.balance, c.over);
    try {
      const before = state.payouts.length;
      const res = await post(c.payload);
      assert.equal(res.statusCode, c.status, c.name);
      assert.deepEqual(res.json(), { error: c.error, message: c.message }, c.name);
      assert.ok(!res.body.includes("ECONNREFUSED"), c.name);
      assert.equal(state.balances[ORG], c.balance, `${c.name}: the balance is untouched`);
      assert.equal(state.payouts.length, before, `${c.name}: no payout row`);
      assert.equal(state.ledger.length, 0, `${c.name}: no ledger row`);
      assert.equal(state.balanceWrites + state.payoutInserts, 0, `${c.name}: nothing was written`);
    } finally {
      await app.close();
    }
  }
});

test("the day's limit refuses a wallet, and the same creator can still take credits", async () => {
  const used = payoutRow({ payoutMethod: "crypto_usdc", status: "completed", amountCents: 99_900n, requestedAt: new Date("2026-10-10T01:00:00Z") });
  const { state, app, post } = await world(74_000n, { rows: [used] });
  try {
    assert.equal((await post({ payoutMethod: "crypto_usdc", payoutAddress: WALLET })).json().error, "payout_daily_limit");
    const credits = await post({ payoutMethod: "credits" });
    assert.equal(credits.statusCode, 201);
    assert.equal(state.balances[ORG], 0n);
  } finally {
    await app.close();
  }
});

test("two requests at once: 201 and 409, one payout, one reservation", async () => {
  const { state, app, post } = await world(2500n);
  try {
    const answers = await Promise.all([post({ payoutMethod: "credits" }), post({ payoutMethod: "credits" })]);
    assert.deepEqual(answers.map((a) => a.statusCode).sort(), [201, 409]);
    const lost = answers.find((a) => a.statusCode === 409)!;
    assert.equal(lost.json().error, "payout_in_progress");
    assert.equal(state.payouts.length, 1);
    assert.equal(state.ledger.length, 1);
    assert.equal(state.balanceWrites, 1);
    assert.equal(state.balances[ORG], 0n);
  } finally {
    await app.close();
  }
});

test("a balance that changed under the request: 409 payout_reservation_conflict, nothing written", async () => {
  const { state, db } = fakeDb([], { [ORG]: 2500n });
  const { routeDeps } = routeDepsOver(db);
  // The request reads 2500; the balance is 900 by the time it reserves.
  const realFind = (db as any).publisherProfile.findUnique;
  let reads = 0;
  (db as any).publisherProfile.findUnique = async (args: unknown) => {
    const row = await realFind(args);
    if (reads++ === 0) state.balances[ORG] = 900n;
    return row;
  };
  const app = await payoutApp(routeDeps);
  try {
    const res = await app.inject({ method: "POST", url: "/payouts", payload: { payoutMethod: "credits" } });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), {
      error: "payout_reservation_conflict",
      message: "Your payout balance changed while this request was processing. Please try again.",
    });
    assert.equal(state.balances[ORG], 900n);
    assert.equal(state.payouts.length, 0);
    assert.equal(state.ledger.length, 0);
  } finally {
    await app.close();
  }
});

test("a database error never reaches an answer: a fixed sentence, and nothing reserved", async () => {
  const texts = [
    "Invalid `prisma.creatorPayout.findFirst()` invocation: Can't reach database server at `db.internal:5432` (P1001)",
    'PrismaClientKnownRequestError: P2034 write conflict {"meta":{"table":"creator_payouts"}}',
  ];
  for (const text of texts) {
    const { state, app, post } = await world(2500n);
    state.payoutsBroken = Object.assign(new Error(text), { code: "P1001" });
    try {
      const res = await post({ payoutMethod: "credits" });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.json(), {
        error: "payout_request_failed",
        message: "We could not request this payout. Check your payouts before trying again.",
      });
      assert.doesNotMatch(res.body, /prisma|P1001|P2034|5432|creator_payouts|invocation/i);
      assert.equal(state.balances[ORG], 2500n);
      assert.equal(state.ledger.length, 0);
    } finally {
      await app.close();
    }
  }

  // The same when it is the write that fails, after every check passed.
  const { state, db } = fakeDb([], { [ORG]: 2500n });
  const { routeDeps } = routeDepsOver(db);
  (db as any).$transaction = async () => {
    throw new Error("Transaction API error: Unable to start a transaction in the given time.");
  };
  const app = await payoutApp(routeDeps);
  try {
    const res = await app.inject({ method: "POST", url: "/payouts", payload: { payoutMethod: "credits" } });
    assert.equal(res.statusCode, 500);
    assert.equal(res.json().error, "payout_request_failed");
    assert.ok(!res.body.includes("Transaction API"));
    assert.equal(state.balances[ORG], 2500n);
    assert.equal(state.payouts.length, 0);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------
// Who may ask
// ---------------------------------------------------------------

// Payouts carry a caller-supplied address, and API keys bypass the role
// check, so an org API key could redirect a creator's earnings. The route
// requires a signed-in person, and decides on the membership as it is now.
test("only a signed-in owner or admin may request: an API key, a member, a demoted or removed admin are refused", async () => {
  const cases: Array<{ name: string; principal: Record<string, unknown> | null; currentRole: string | null; status: number; error?: string }> = [
    { name: "nobody", principal: null, currentRole: null, status: 401 },
    { name: "an API key with org authority", principal: { userId: null, orgId: ORG, type: "api_key", scopes: ["*"] }, currentRole: "owner", status: 401 },
    { name: "a member", principal: { userId: "u1", orgId: ORG, type: "jwt", role: "member" }, currentRole: "member", status: 403 },
    { name: "an admin demoted to member, on the old token", principal: { userId: "u1", orgId: ORG, type: "jwt", role: "admin" }, currentRole: "member", status: 403, error: "insufficient_role" },
    { name: "an admin removed from the org, on the old token", principal: { userId: "u1", orgId: ORG, type: "jwt", role: "admin" }, currentRole: null, status: 403, error: "not_a_member" },
  ];
  for (const c of cases) {
    const { state, db } = fakeDb([], { [ORG]: 2500n });
    const { routeDeps } = routeDepsOver(db);
    let ran = false;
    const app = await payoutApp(
      {
        ...routeDeps,
        payoutsAvailable: () => {
          ran = true;
          return true;
        },
      },
      c.principal,
      c.currentRole,
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/payouts",
        payload: { payoutMethod: "crypto_sol", payoutAddress: WALLET },
      });
      assert.equal(res.statusCode, c.status, c.name);
      if (c.error) assert.equal(res.json().error, c.error, c.name);
      assert.equal(ran, false, `${c.name}: the payout service does not run`);
      assert.equal(state.balances[ORG], 2500n);
      assert.equal(state.payouts.length, 0);
    } finally {
      await app.close();
    }
  }
  // An admin as the membership has it now may.
  const { db } = fakeDb([], { [ORG]: 2500n });
  const app = await payoutApp(routeDepsOver(db).routeDeps, { userId: "u1", orgId: ORG, type: "jwt", role: "admin" }, "admin");
  assert.equal((await app.inject({ method: "POST", url: "/payouts", payload: { payoutMethod: "credits" } })).statusCode, 201);
  await app.close();
});

test("a request is for the caller's own organization only", async () => {
  const { state, db } = fakeDb([], { [ORG]: 2500n, [OTHER_ORG]: 9000n });
  const app = await payoutApp(routeDepsOver(db).routeDeps);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/payouts",
      payload: { payoutMethod: "credits", orgId: OTHER_ORG, publisherId: OTHER_ORG },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(state.payouts[0]!.publisherId, ORG);
    assert.equal(state.balances[OTHER_ORG], 9000n);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------------------
// Where the routes live
// ---------------------------------------------------------------

test("the payout routes are registered once, under /api/marketplace, and no thrown text is sent", () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (file: string) => readFileSync(path.join(src, file), "utf8");
  assert.match(read("index.ts"), /app\.register\(createPayoutRoutesProduction\(\), \{ prefix: "\/api\/marketplace" \}\)/);
  const marketplace = read("routes/marketplace.ts");
  assert.doesNotMatch(marketplace, /["']\/payouts/, "the marketplace routes no longer carry the payout routes");
  const routes = read("routes/payouts.ts");
  assert.equal((routes.match(/["']\/payouts(\/:id\/cancel)?["']/g) ?? []).length, 3);
  assert.doesNotMatch(routes, /badRequest\(|\.message\b|String\(err/, "an error's own text is never sent");
});

// ---------------------------------------------------------------
// The one chain read
// ---------------------------------------------------------------

function connectionSaying(answer: unknown) {
  const calls: Array<{ address: string; commitment: unknown }> = [];
  return {
    calls,
    connection: {
      getAccountInfo: async (key: PublicKey, commitment: unknown) => {
        calls.push({ address: key.toBase58(), commitment });
        if (answer instanceof Error) throw answer;
        return answer as any;
      },
    },
  };
}

test("the address read: nothing there or an ordinary account is fine; a token account or a program is not", async () => {
  const account = (over: Record<string, unknown>) => ({
    lamports: 1_000_000,
    data: Buffer.alloc(0),
    executable: false,
    owner: SystemProgram.programId,
    ...over,
  });
  const cases: Array<[string, unknown, string]> = [
    ["no account yet", null, "absent"],
    ["a funded wallet", account({}), "wallet"],
    ["a token account", account({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) }), "not_a_wallet"],
    ["a Token-2022 account", account({ owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(165) }), "not_a_wallet"],
    ["a program", account({ executable: true, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111") }), "not_a_wallet"],
    ["an answer with no owner", { lamports: 1 }, "unavailable"],
    ["a node error", new Error("429 Too Many Requests"), "unavailable"],
  ];
  for (const [name, answer, expected] of cases) {
    const { connection, calls } = connectionSaying(answer);
    const read = buildPayoutAddressRead({ getConnection: () => connection as any });
    assert.equal(await read(WALLET), expected, name);
    assert.deepEqual(calls, [{ address: WALLET, commitment: "confirmed" }], `${name}: one read`);
  }
});

test("the address read never throws and never waits for ever", async () => {
  // The node never answers.
  const hung = buildPayoutAddressRead({
    getConnection: () => ({ getAccountInfo: () => new Promise(() => undefined) }) as any,
    waitMs: 20,
  });
  assert.equal(await hung(WALLET), "unavailable");
  // No connection at all.
  const none = buildPayoutAddressRead({
    getConnection: () => {
      throw new Error("no connection");
    },
  });
  assert.equal(await none(WALLET), "unavailable");
  // Text that is not an address (the rules never pass one, but still).
  const { connection, calls } = connectionSaying(null);
  assert.equal(await buildPayoutAddressRead({ getConnection: () => connection as any })("nope"), "unavailable");
  assert.equal(calls.length, 0);
});

test("the address is not read on a chain the settings do not name", async () => {
  for (const cluster of [{ ok: false }, null, new Error("unreachable")]) {
    const { connection, calls } = connectionSaying(null);
    const read = buildPayoutAddressRead({
      getConnection: () => connection as any,
      ensureCluster: async () => {
        if (cluster instanceof Error) throw cluster;
        return cluster as any;
      },
    });
    assert.equal(await read(WALLET), "unavailable");
    assert.equal(calls.length, 0);
  }
  const { connection, calls } = connectionSaying(null);
  const ok = buildPayoutAddressRead({ getConnection: () => connection as any, ensureCluster: async () => ({ ok: true }) });
  assert.equal(await ok(WALLET), "absent");
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------
// The platform's own addresses, and the settings
// ---------------------------------------------------------------

test("the platform's own: the paying wallet, this organization's deposit address, and a real treasury", () => {
  const masterKey = "unit-test-master-key-0123456789abcdef";
  const treasury = Keypair.generate().publicKey.toBase58();
  const paying = derivePayoutKeypair(masterKey).publicKey.toBase58();
  const deposit = deriveTopupDepositKeypair({ masterKey, orgId: ORG }).publicKey.toBase58();
  assert.deepEqual(payoutPlatformAddresses({ WALLET_MASTER_KEY: masterKey, TREASURY_WALLET_ADDRESS: treasury }, ORG), [
    paying,
    deposit,
    treasury,
  ]);
  // Another organization's deposit address is not this one's.
  assert.notEqual(
    payoutPlatformAddresses({ WALLET_MASTER_KEY: masterKey, TREASURY_WALLET_ADDRESS: treasury }, OTHER_ORG)[1],
    deposit,
  );
  // The default treasury is the System Program: left to the chain read, which calls it a program.
  assert.deepEqual(
    payoutPlatformAddresses({ WALLET_MASTER_KEY: masterKey, TREASURY_WALLET_ADDRESS: "11111111111111111111111111111111" }, ORG),
    [paying, deposit],
  );
  // No master key: no list, so no wallet payout is planned against half of one.
  assert.throws(() => payoutPlatformAddresses({ TREASURY_WALLET_ADDRESS: treasury }, ORG));
});

test("each of the platform's own addresses is refused at the route", async () => {
  const masterKey = "unit-test-master-key-0123456789abcdef";
  const treasury = Keypair.generate().publicKey.toBase58();
  const own = payoutPlatformAddresses({ WALLET_MASTER_KEY: masterKey, TREASURY_WALLET_ADDRESS: treasury }, ORG);
  assert.equal(own.length, 3);
  for (const address of own) {
    const { state, app, post, chainReads } = await world(4120n, { platformAddresses: own });
    try {
      const res = await post({ payoutMethod: "crypto_usdc", payoutAddress: address });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().message, "That address belongs to WheelsAI, not to you. Enter your own wallet address.");
      assert.equal(chainReads.length, 0);
      assert.equal(state.balances[ORG], 4120n);
    } finally {
      await app.close();
    }
  }
});

test("the limits come from the settings in whole dollars; SOL is offered only with a price source", () => {
  const base = { PAYOUT_MAX_PER_PAYOUT_USD: 500, PAYOUT_MAX_PER_DAY_USD: 1000 };
  assert.deepEqual(payoutRequestSettingsFromEnv({ ...base, SOL_PRICE_SOURCE: "pyth" }), {
    perPayoutCents: 50_000n,
    perDayCents: 100_000n,
    solOffered: true,
  });
  assert.equal(payoutRequestSettingsFromEnv({ ...base, SOL_PRICE_SOURCE: "static" }).solOffered, true);
  for (const source of ["off", "", "OFF", "something else"]) {
    assert.equal(payoutRequestSettingsFromEnv({ ...base, SOL_PRICE_SOURCE: source }).solOffered, false, source);
  }
  assert.throws(() => payoutRequestSettingsFromEnv({ ...base, PAYOUT_MAX_PER_DAY_USD: Number.NaN, SOL_PRICE_SOURCE: "off" }));
});

test("the production settings have the defaults the contract names", async () => {
  const { env } = await import("../config/env.js");
  const settings = payoutRequestSettingsFromEnv(env);
  assert.equal(settings.perPayoutCents, BigInt(env.PAYOUT_MAX_PER_PAYOUT_USD) * 100n);
  assert.equal(settings.perDayCents, BigInt(env.PAYOUT_MAX_PER_DAY_USD) * 100n);
  assert.equal(settings.solOffered, env.SOL_PRICE_SOURCE !== "off");
});
