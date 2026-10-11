#!/usr/bin/env node
/*
 * The mainnet run of docs/PAYMENTS-RUN.md, rehearsed step for step on the
 * local test chain, from an empty database, with test wallets in place of a
 * person's.
 *
 * The other walks prove each money path on its own, with figures chosen to
 * reach every rule. This one proves the run itself before real money follows
 * it: that the steps work in that order from nothing, that a sale made through
 * the product is what a payout is paid from, and that at the end every unit is
 * where the run says it is.
 *
 * WHAT IS THE SAME AS THE RUN: the order of the steps and their numbers, the
 * amounts, the server's workers, and the run's settings (a sweep from $1,
 * floats of $5 in USDC and $10 in SOL, a paying wallet that works down to
 * 0.01 SOL, the product's own payout limits), which start-api.sh sets in one
 * place for the rehearsal and for the run.
 *
 * WHAT IS NOT: the chain is the local one (its rows are recorded as devnet),
 * the price of SOL is stated where the run reads Pyth's, and the workers run
 * every 3 seconds where the run's run every 15 and 30, so the run's waits are
 * not timed here. Where a person uses a page, a wallet or an exchange, this
 * walk calls the API, signs with a key and sends a plain transfer: the pages
 * have their own tests (browser-*.cjs), and what a real wallet signs is what
 * the devnet step of the document is for.
 *
 * All of it in one go, once for each price of SOL given ($110 when none is):
 *
 *   bash apps/api/scripts/payments-proof/run-all.sh --runbook [price ...]
 *
 * Or by hand, from a chain that has just been started:
 *
 *   bash apps/api/scripts/payments-proof/local-chain.sh stop
 *   bash apps/api/scripts/payments-proof/local-chain.sh start
 *   node apps/api/scripts/payments-proof/walk-runbook.cjs --prepare
 *   bash apps/api/scripts/payments-proof/start-api.sh --runbook      (in another terminal)
 *   node apps/api/scripts/payments-proof/walk-runbook.cjs
 *
 * And, for what an operator does afterwards to take the paying wallet's float
 * back, the API stopped and started again with both floats at 0:
 *
 *   HOT_WALLET_FLOAT_USDC=0 HOT_WALLET_FLOAT_SOL_USD=0 bash apps/api/scripts/payments-proof/start-api.sh --runbook
 *   node apps/api/scripts/payments-proof/walk-runbook.cjs --after
 *
 * --prepare makes the empty database wheelsai_runbook in the repository's
 * Postgres container (an older one of that name is dropped) and applies the
 * migrations to it. start-api.sh --runbook points the API at that database.
 *
 * The price of SOL is the one start-api.sh states ($110 unless
 * SOL_PRICE_STATIC_USD says otherwise; give the walk the same). The walk holds
 * at any price: where the SOL swept off the address goes (the paying wallet
 * while that is under its float, the cold wallet after) depends on the price,
 * so the walk says which it was and checks what must hold either way. No real
 * money and no real network.
 */
const { spawnSync } = require("child_process");
const { hkdfSync } = require("crypto");
const fs = require("fs");
const lib = require("./lib.cjs");
const { REPO, KEYS_DIR, req, sleep } = lib;
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");

const API = process.env.WALK_API || "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const DB = "wheelsai_runbook";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ADMIN_KEY = "walk-pay6-admin-key-0123456789";
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-runbook-2026";
/** The stated price of SOL, as start-api.sh was given it. */
const PRICE = Number(process.env.SOL_PRICE_STATIC_USD || 110);
const KEEP_LAMPORTS = 890_880;
const USDC_ACCOUNT_RENT = 2_039_280;
const PROOF_LAMPORTS = 100_000_000;
/** HOT_WALLET_MIN_SOL as the run sets it: 0.01 SOL. */
const PAYING_WALLET_KEEPS = 10_000_000;
const FLOAT_USDC_RAW = 5_000_000n;

const sql = (statement) => lib.sql(statement, DB);

if (process.argv.includes("--prepare")) {
  const up = spawnSync("curl", ["-s", "-m", "2", "-o", "/dev/null", `${API}/health`]);
  if (up.status === 0) {
    console.error(`an API is answering at ${API}: stop it first, the database it reads is about to be replaced`);
    process.exit(1);
  }
  lib.sql(`drop database if exists ${DB}`, "postgres");
  lib.sql(`create database ${DB}`, "postgres");
  const run = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: `${REPO}/packages/db`,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: lib.databaseUrl(DB) },
  });
  if (run.status !== 0) {
    console.error(`${run.stdout || ""}${run.stderr || ""}`.replace(/:\/\/[^@\s]*@/g, "://...@"));
    process.exit(1);
  }
  console.log(`database ${DB}: empty, with every migration applied (${sql("select count(*) from _prisma_migrations")} of them)`);
  process.exit(0);
}

const results = [];
const seenAnswers = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
}
const step = (title) => console.log(`\n-- ${title}`);
const short = (v, n = 200) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + "..." : s;
};
const usd = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

class Client {
  constructor() {
    this.cookies = new Map();
  }
  async call(method, path, body, headers = {}) {
    const h = { ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(API + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    if (path.startsWith("/api/billing") || path.startsWith("/api/marketplace")) seenAnswers.push({ path, status: res.status, text });
    return { status: res.status, body: json };
  }
}
const anon = new Client();
const report = async () => (await anon.call("GET", "/api/platform/money", undefined, { "x-admin-key": ADMIN_KEY })).body;

async function account(label) {
  const client = new Client();
  const email = `runbook-${label}-${STAMP}@example.test`;
  const r = await client.call("POST", "/api/auth/register", { email, password: PASSWORD });
  if (r.status !== 200 && r.status !== 201) throw new Error(`register ${label}: ${r.status} ${short(r.body)}`);
  const me = await client.call("GET", "/api/auth/me");
  return { client, orgId: me.body.organization.id, email };
}

const masterKey = fs.readFileSync(`${KEYS_DIR}/master.key`, "utf8").trim();
const derive = (salt, info) => web3.Keypair.fromSeed(new Uint8Array(hkdfSync("sha512", Buffer.from(masterKey, "utf8"), Buffer.from(salt), Buffer.from(info), 32)));
// The same derivations as the API's, for the local chain's throwaway key.
const payingWallet = derive("wheelsai-payout-v1", "platform-payout").publicKey;
const depositAddressOf = (orgId) => derive("wheelsai-topup-v1", orgId).publicKey;
const keyFile = (name) => web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${KEYS_DIR}/${name}`, "utf8"))));
// The chain's throwaway treasury key plays the cold wallet: the API is started with its address.
const cold = keyFile("treasury.json");
const mintAuthority = keyFile("mint-authority.json");

const chain = new web3.Connection(RPC, "confirmed");
async function confirm(signature, commitment = "confirmed") {
  const latest = await chain.getLatestBlockhash(commitment);
  await chain.confirmTransaction({ signature, ...latest }, commitment);
}
const airdrop = async (to, lamports) => confirm(await chain.requestAirdrop(to, lamports));
const send = (tx, signers) => web3.sendAndConfirmTransaction(chain, tx, signers, { commitment: "confirmed" });
const ataOf = (owner) => spl.getAssociatedTokenAddressSync(USDC_MINT, owner, true);
const usdcOf = async (owner) => BigInt((await chain.getTokenAccountBalance(ataOf(owner), "confirmed").catch(() => null))?.value.amount ?? "0");
const solOf = (owner) => chain.getBalance(owner, "confirmed");
const hasUsdcAccount = async (owner) => (await chain.getAccountInfo(ataOf(owner), "confirmed")) !== null;

/** A wallet holding exactly these lamports and this much stand-in USDC: what a person's wallet holds before the run. */
async function wallet(lamports, usdc) {
  const key = web3.Keypair.generate();
  if (lamports > 0) await airdrop(key.publicKey, lamports);
  if (usdc > 0) {
    if ((await solOf(mintAuthority.publicKey)) < 0.05 * web3.LAMPORTS_PER_SOL) await airdrop(mintAuthority.publicKey, web3.LAMPORTS_PER_SOL);
    await send(
      new web3.Transaction().add(
        spl.createAssociatedTokenAccountIdempotentInstruction(mintAuthority.publicKey, ataOf(key.publicKey), key.publicKey, USDC_MINT),
        spl.createMintToInstruction(USDC_MINT, ataOf(key.publicKey), mintAuthority.publicKey, BigInt(Math.round(usdc * 1_000_000))),
      ),
      [mintAuthority],
    );
  }
  return key;
}

/** Sign what the server prepared, the way a wallet would. */
function sign(unsignedTxBase64, key) {
  const tx = web3.Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  tx.sign(key);
  return tx.serialize().toString("base64");
}
/** Pay in from a wallet the way the Billing page does, and follow the top-up until it is final. */
async function payIn(client, key, amountUsd, asset) {
  const prepared = await client.call("POST", "/api/billing/topups/prepare", { amountUsd, asset, payerAddress: key.publicKey.toBase58() });
  if (prepared.status !== 200) return { prepared: prepared.body, done: prepared };
  let done = await client.call("POST", `/api/billing/topups/${prepared.body.topupId}/submit`, { signedTxBase64: sign(prepared.body.unsignedTxBase64, key) });
  for (let i = 0; i < 40 && !["credited", "failed", "expired"].includes(done.body.status); i++) {
    await sleep(2000);
    done = await client.call("POST", `/api/billing/topups/${prepared.body.topupId}/reconcile`, {});
  }
  return { prepared: prepared.body, done };
}
const available = async (client) => Math.round(Number((await client.call("GET", "/api/billing/balance")).body?.balance?.available ?? NaN) * 100);

async function waitFor(read, ok, seconds = 120) {
  let value;
  for (let i = 0; i < seconds; i++) {
    value = await read();
    if (ok(value)) return value;
    await sleep(1000);
  }
  return value;
}
const transfersFrom = (address, asset) =>
  sql(`select kind, status, amount_raw, to_address, fee_payer, coalesce(fee_lamports::text,''), tx_signature from chain_transfers where from_address='${address}' and asset='${asset}' order by created_at`)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [kind, status, amountRaw, to, feePayer, fee, signature] = l.split("|");
      return { kind, status, amountRaw, to, feePayer, fee, signature };
    });
const allLanded = (rows, n) => rows.length === n && rows.every((t) => t.status === "landed");
const receipt = (signature, asset) => sql(`select status, coalesce(amount_usd_cents::text,''), source from onchain_receipts where tx_signature='${signature}' and asset='${asset}'`);
const owedTo = (orgId) => Number(sql(`select coalesce((select pending_payout_cents from publisher_profiles where org_id='${orgId}'),0)`));
/** What the operator's report says landed, the way the document tells a person to read it. */
const landedInReport = (rep, kind, asset) => (rep.sweeps?.landedInRange || []).find((x) => x.kind === kind && x.asset === asset)?.amountRaw ?? null;

/**
 * One of the operator's scripts in apps/api/scripts, run the way the document
 * tells an operator to: through start-api.sh, which gives it the settings the
 * API was started with (the run's database, chain and keys).
 */
function script(name, args = []) {
  const run = spawnSync("bash", [`${__dirname}/start-api.sh`, "--runbook", "--", "npx", "tsx", `scripts/${name}`, ...args], {
    encoding: "utf8",
    env: { ...process.env, SOL_PRICE_STATIC_USD: String(PRICE) },
    timeout: 120_000,
  });
  return { code: run.status, out: `${run.stdout || ""}${run.stderr || ""}`.replace(/\s+/g, " ").trim() };
}

async function waitForPayout(client, id) {
  return waitFor(
    async () => ((await client.call("GET", "/api/marketplace/payouts")).body.payouts || []).find((p) => p.id === id) || null,
    (p) => p && ["completed", "failed", "cancelled"].includes(p.status),
    90,
  );
}

function finish() {
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

/**
 * After the run, with the API started again with both floats at 0: the
 * paying wallet sends what it holds to the cold wallet, and keeps only the
 * SOL it needs to go on paying fees.
 */
async function afterRun() {
  if (!(await chain.getVersion().catch(() => null))) throw new Error("the local chain is not running");
  const hot = payingWallet;
  step("Afterwards: with both floats at 0, the paying wallet hands back what it holds");
  const usdcRows = await waitFor(() => transfersFrom(hot.toBase58(), "USDC"), (r) => allLanded(r, 1));
  check("its 5 USDC goes to the cold wallet whole, which now holds every USDC the run did not pay out",
    allLanded(usdcRows, 1) && usdcRows[0].kind === "hot_to_treasury" && usdcRows[0].amountRaw === "5000000" && usdcRows[0].to === cold.publicKey.toBase58() && (await usdcOf(hot)) === 0n && (await usdcOf(cold.publicKey)) === 7_000_000n,
    `${short(usdcRows)} paying wallet=${await usdcOf(hot)} cold wallet=${await usdcOf(cold.publicKey)}`);
  const hotSol = await waitFor(() => solOf(hot), (x) => x === PAYING_WALLET_KEEPS);
  // The balance moves when the transfer lands; its row is ended only once the block is final.
  const solRows = await waitFor(() => transfersFrom(hot.toBase58(), "SOL"), (r) => r.length >= 1 && r.every((t) => t.status === "landed"), 60);
  check("its SOL goes too, down to exactly the 0.01 SOL it keeps to pay fees",
    hotSol === PAYING_WALLET_KEEPS && solRows.length >= 1 && solRows.every((t) => t.status === "landed" && t.kind === "hot_to_treasury" && t.to === cold.publicKey.toBase58()),
    `paying wallet=${hotSol} ${short(solRows.slice(-1))}`);
  await waitFor(() => sql("select count(*) from chain_transfers where status='sent'"), (n) => n === "0", 60);
  const last = await report();
  check("nothing is left open and both reconciliation differences are still 0",
    last.sweeps?.sent === 0 && last.sweeps?.failedInRange === 0 && last.reconciliation?.usdc?.differenceRaw === "0" && last.reconciliation?.sol?.differenceLamports === "0" && last.onChain?.hotWallet?.usdcRaw === "0",
    `sent=${last.sweeps?.sent} failed=${last.sweeps?.failedInRange} ${short(last.reconciliation, 300)}`);
  finish();
}

async function main() {
  if (!(await chain.getVersion().catch(() => null))) throw new Error("the local chain is not running: bash apps/api/scripts/payments-proof/local-chain.sh start");
  // A chain that has only just started takes no fee for its first transactions. The run starts past that, so every figure below is exact.
  for (let i = 0; i < 90 && (await chain.getSlot("finalized")) < 32; i++) await sleep(1000);
  const hot = payingWallet;
  const cents = (lamports) => Math.floor((lamports * PRICE * 100) / 1e9);

  // ---- Step 1: the report, before anything
  step("Step 1: read the money report");
  const first = await report();
  const empty =
    first.customers?.balanceCents === "0" && first.creators?.owedCents === "0" && first.reconciliation?.usdc?.receivedRaw === "0" && first.reconciliation?.sol?.receivedLamports === "0" &&
    first.onChain?.depositAddresses?.count === 0 && first.onChain?.hotWallet?.lamports === "0" && first.onChain?.hotWallet?.usdcRaw === "0";
  if (!empty) {
    throw new Error("not the start of a run: restart the chain, run --prepare and start the API with --runbook (see the header). " + short({ customers: first.customers, onChain: first.onChain, error: first.error }, 400));
  }
  check("the database is empty: nobody holds credits, nobody is owed, nothing was ever received", empty);
  const h = first.health || {};
  check("every rail is on, the chain answers and SOL has a price",
    h.walletTopups === true && h.deposits === true && h.depositScan === true && h.sweeps === true && h.payouts === true && h.cluster === "ok" && h.solPrice?.ok === true,
    short(h));
  check("the report names the paying wallet and the cold wallet, which is not proven yet",
    first.onChain.hotWallet.address === hot.toBase58() && first.onChain.treasury?.address === cold.publicKey.toBase58() && first.onChain.treasury?.proven === false, short(first.onChain));

  // ---- Step 2: the cold wallet proves itself
  step("Step 2: prove the cold wallet");
  await airdrop(cold.publicKey, 300_000_000); // the cold wallet holds a little SOL before the run
  const hadUsdcAccount = { hot: await hasUsdcAccount(hot), cold: await hasUsdcAccount(cold.publicKey) };
  let v = script("treasury-verify.ts", ["--dry-run"]);
  check("before the transfer, the command says what to send and where", v.out.includes(hot.toBase58()) && /0\.1 SOL/.test(v.out) && sql("select count(*) from platform_wallets") === "0", `exit ${v.code}: ${short(v.out, 240)}`);
  const coldBeforeProof = await solOf(cold.publicKey);
  const proof = await send(new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: cold.publicKey, toPubkey: hot, lamports: PROOF_LAMPORTS })), [cold]);
  await confirm(proof, "finalized");
  const coldAfterProof = await solOf(cold.publicKey);
  const hotAfterProof = await solOf(hot);
  v = script("treasury-verify.ts");
  const afterProof = await report();
  check("0.1 SOL from the cold wallet to the paying wallet, then the command: the cold wallet is proven",
    v.code === 0 && afterProof.onChain?.treasury?.proven === true && sql("select role, address, proof_signature from platform_wallets") === `treasury|${cold.publicKey.toBase58()}|${proof}`,
    `exit ${v.code}: ${short(v.out, 200)}`);
  check("the paying wallet now holds that 0.1 SOL, and the cold wallet paid it and one fee", hotAfterProof === PROOF_LAMPORTS && coldBeforeProof - coldAfterProof === PROOF_LAMPORTS + 5000, `paying wallet=${hotAfterProof} cold paid=${coldBeforeProof - coldAfterProof}`);

  // ---- Step 3: pay in from a wallet
  step("Step 3: pay $10 in USDC and $10 in SOL from the first wallet");
  const buyer = await account("buyer");
  const rails = (await buyer.client.call("GET", "/api/billing/packages")).body.rails || {};
  check("the Billing page is offered the wallet in USDC and SOL, and no way to credits without paying",
    rails.wallet === true && String(rails.walletAssets) === "USDC,SOL" && rails.deposits === true && rails.mockCheckout === false && rails.stripeCheckout === false, short(rails));
  // What the document says the first wallet needs: 10 USDC, and $10 of SOL plus 0.005 SOL.
  const topupLamports = Math.ceil((10 * 1e9) / PRICE);
  const wallet1 = await wallet(topupLamports + 5_000_000, 10);
  const address = depositAddressOf(buyer.orgId);
  const wallet1SolStart = await solOf(wallet1.publicKey);
  let pay = await payIn(buyer.client, wallet1, 10, "USDC");
  check("$10 in USDC is credited as $10.00, and 10 USDC is at the organization's address",
    pay.done.body.status === "credited" && /Added \$10\.00 in credits/.test(pay.done.body.message || "") && pay.prepared.depositAddress === address.toBase58() && (await usdcOf(address)) === 10_000_000n && (await usdcOf(wallet1.publicKey)) === 0n,
    `${pay.done.status} ${short(pay.done.body, 160)} at address=${await usdcOf(address)}`);
  const lamportsBefore = await solOf(address);
  pay = await payIn(buyer.client, wallet1, 10, "SOL");
  check("$10 in SOL says its price and how long it holds, and is credited as $10.00 for exactly the lamports asked",
    pay.done.body?.status === "credited" && Number(pay.prepared.quote?.solPriceUsd) === PRICE && /This price holds for 60 seconds\./.test(pay.prepared.message || "") && Number(pay.prepared.amountRaw) === topupLamports && (await solOf(address)) - lamportsBefore === topupLamports,
    `${pay.done.status} ${short(pay.done.body, 160)} price=${pay.prepared.quote?.solPriceUsd} lamports=${pay.prepared.amountRaw} msg=${short(pay.prepared.message, 110)}`);
  check("the organization holds $20.00 in credits", (await available(buyer.client)) === 2000, usd(await available(buyer.client)));
  const wallet1Paid = wallet1SolStart - (await solOf(wallet1.publicKey)) - topupLamports;
  check("beyond what it paid, the wallet spent only the two fees and the address's USDC account, and $10 of SOL plus 0.005 SOL covered it",
    wallet1Paid === USDC_ACCOUNT_RENT + 2 * 5000, `fees and rent=${wallet1Paid} left=${await solOf(wallet1.publicKey)}`);

  // ---- Step 4: the first sweep
  step("Step 4: the first sweep");
  let usdcRows = await waitFor(() => transfersFrom(address.toBase58(), "USDC"), (r) => allLanded(r, 1));
  check("the 10 USDC leaves the address whole for the paying wallet, which pays the fee",
    allLanded(usdcRows, 1) && usdcRows[0].kind === "sweep_to_hot" && usdcRows[0].amountRaw === "10000000" && usdcRows[0].to === hot.toBase58() && usdcRows[0].feePayer === hot.toBase58() && (await usdcOf(address)) === 0n && (await usdcOf(hot)) === 10_000_000n,
    `${short(usdcRows)} paying wallet=${await usdcOf(hot)}`);
  let solRows = await waitFor(() => transfersFrom(address.toBase58(), "SOL"), (r) => allLanded(r, 1));
  const firstSolSweep = topupLamports - KEEP_LAMPORTS - 5000;
  // To the paying wallet while its own SOL is worth less than its float, to the cold wallet after: which depends on the price.
  const went = (row) => (row?.kind === "sweep_to_hot" && row.to === hot.toBase58() ? "the paying wallet" : row?.kind === "sweep_to_treasury" && row.to === cold.publicKey.toBase58() ? "the cold wallet" : null);
  check(`the SOL leaves less what the address must keep and its own fee, for ${went(solRows[0]) ?? "nowhere it may go"}`,
    allLanded(solRows, 1) && went(solRows[0]) !== null && solRows[0].amountRaw === String(firstSolSweep) && solRows[0].feePayer === address.toBase58() && (await solOf(address)) === KEEP_LAMPORTS,
    `${short(solRows)} address now=${await solOf(address)}`);
  const afterSweep = await report();
  check("the report says so the way the document reads it: 10000000 of USDC under sweeps.landedInRange as sweep_to_hot, and the SOL beside it",
    landedInReport(afterSweep, "sweep_to_hot", "USDC") === "10000000" && (landedInReport(afterSweep, "sweep_to_hot", "SOL") ?? landedInReport(afterSweep, "sweep_to_treasury", "SOL")) === String(firstSolSweep),
    short(afterSweep.sweeps, 300));
  check("the customer keeps the $20.00: a sweep is not theirs to lose", (await available(buyer.client)) === 2000);

  // ---- Step 5: a withdrawal from an exchange, to the deposit address
  step("Step 5: an exchange sends 2 USDC and $2 of SOL to the deposit address");
  const shown = await buyer.client.call("POST", "/api/billing/deposit-address");
  check("the address the API gives the Billing page is the one the wallet paid", (shown.status === 200 || shown.status === 201) && shown.body.address === address.toBase58(), `${shown.status} ${short(shown.body, 160)}`);
  const exchangeLamports = Math.max(10_000_000, Math.ceil((2 * 1e9) / PRICE));
  const exchange = await wallet(exchangeLamports + 50_000_000, 2);
  const usdcIn = await send(new web3.Transaction().add(spl.createTransferCheckedInstruction(ataOf(exchange.publicKey), USDC_MINT, ataOf(address), exchange.publicKey, 2_000_000n, 6)), [exchange]);
  const solIn = await send(new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: exchange.publicKey, toPubkey: address, lamports: exchangeLamports })), [exchange]);
  const usdcReceipt = await waitFor(() => receipt(usdcIn, "USDC"), (r) => r.startsWith("credited"));
  const solReceipt = await waitFor(() => receipt(solIn, "SOL"), (r) => r.startsWith("credited"));
  const exchangeSolCents = cents(exchangeLamports);
  check("the 2 USDC is credited as $2.00, once, with no browser wallet involved", usdcReceipt === "credited|200|direct", usdcReceipt);
  check(`the SOL is credited at the price, rounded down to the cent: ${usd(exchangeSolCents)}`, solReceipt === `credited|${exchangeSolCents}|direct`, `${solReceipt} for ${exchangeLamports} lamports`);
  check("the organization now holds what it paid in", (await available(buyer.client)) === 2000 + 200 + exchangeSolCents, usd(await available(buyer.client)));
  usdcRows = await waitFor(() => transfersFrom(address.toBase58(), "USDC"), (r) => allLanded(r, 2));
  check("the paying wallet holds its float, so these 2 USDC go to the cold wallet",
    allLanded(usdcRows, 2) && usdcRows[1].kind === "sweep_to_treasury" && usdcRows[1].amountRaw === "2000000" && usdcRows[1].to === cold.publicKey.toBase58() && (await usdcOf(cold.publicKey)) === 2_000_000n && (await usdcOf(address)) === 0n,
    `${short(usdcRows.slice(1))} cold wallet=${await usdcOf(cold.publicKey)}`);
  solRows = await waitFor(() => transfersFrom(address.toBase58(), "SOL"), (r) => allLanded(r, 2));
  check(`the SOL leaves too, less its fee, for ${went(solRows[1]) ?? "nowhere it may go"}, and the address is back to what it must keep`,
    allLanded(solRows, 2) && went(solRows[1]) !== null && solRows[1].amountRaw === String(exchangeLamports - 5000) && (await solOf(address)) === KEEP_LAMPORTS,
    `${short(solRows.slice(1))} address now=${await solOf(address)}`);

  // ---- Step 6: a sale, made through the product
  step("Step 6: a second account sells a $12 a month listing to the first");
  const creator = await account("creator");
  let r = await creator.client.call("POST", "/api/agents", { name: `Runbook Agent ${STAMP}`, description: "Says hello.", agentKind: "conversation", systemPrompt: "You say hello." });
  const agent = r.body.agent || {};
  r = await creator.client.call("POST", "/api/marketplace/listings", { agentId: agent.id, title: agent.name, shortDescription: "A listing made by the rehearsal of the payments run.", category: "other", pricingModel: "monthly", monthlyPriceCents: 1200, publish: true });
  const listing = r.body.listing || {};
  check("the creator publishes a listing at $12.00 a month", r.status === 201 && !!listing.id, `${r.status} ${short(r.body, 200)}`);
  const beforeSale = await available(buyer.client);
  // The listing sells use of the creator's agent, so the buyer starts using it; the price they were shown is their consent.
  r = await buyer.client.call("POST", `/api/marketplace/listings/${listing.id}/use`, { expected: { pricingModel: "monthly", monthlyPriceCents: 1200 } });
  check("the first account subscribes, and pays the first month, $12.00, from its credits", r.status === 201 && beforeSale - (await available(buyer.client)) === 1200, `${r.status} ${short(r.body, 200)} paid=${usd(beforeSale - (await available(buyer.client)))}`);
  const earned = sql(`select type, amount_cents, balance_after from earnings_transactions where org_id='${creator.orgId}'`);
  const revenue = await creator.client.call("GET", "/api/marketplace/revenue");
  check("the creator is owed $10.80, with one row in their ledger, and the platform kept $1.20",
    owedTo(creator.orgId) === 1080 && earned.split("\n").length === 1 && /\|1080\|1080$/.test(earned) && (await report()).income?.marketplaceFeesCents === "120",
    `owed=${usd(owedTo(creator.orgId))} ledger=${earned} fees=${(await report()).income?.marketplaceFeesCents}`);
  const limits = revenue.body.payoutLimits || {};
  check("the limits the API gives the Earnings page: from $5.00, at most $500.00 a payout, to a wallet in USDC or SOL",
    limits.minimumCents === 500 && limits.perPayoutCents === 50000 && ["crypto_usdc", "crypto_sol"].every((m) => (limits.methods || []).includes(m)), short(limits, 260));

  // ---- Step 7: the creator takes it out
  step("Step 7: the creator takes $5 in USDC and $5 in SOL to a second wallet");
  const wallet2 = web3.Keypair.generate().publicKey; // a wallet that has never held anything
  const hotSolBeforePayouts = await solOf(hot);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: wallet2.toBase58(), amountCents: 500 });
  let payout = await waitForPayout(creator.client, r.body.payout?.id);
  check("$5.00 in USDC arrives: exactly 5 USDC, at a wallet that had no USDC account",
    r.status === 201 && payout?.status === "completed" && !!payout.txSignature && (await usdcOf(wallet2)) === 5_000_000n, `${r.status} ${short(r.body.message, 100)} -> ${payout?.status} arrived=${await usdcOf(wallet2)}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_sol", payoutAddress: wallet2.toBase58(), amountCents: 500 });
  payout = await waitForPayout(creator.client, r.body.payout?.id);
  const payoutLamports = Math.floor((5 * 1e9) / PRICE);
  check("$5.00 in SOL arrives: the lamports $5.00 is at the price, rounded down",
    r.status === 201 && payout?.status === "completed" && (await solOf(wallet2)) === payoutLamports, `${r.status} -> ${payout?.status} arrived=${await solOf(wallet2)} want=${payoutLamports}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: wallet2.toBase58() });
  check("$0.80 stays in the earnings: under the smallest payout, and the answer says so",
    owedTo(creator.orgId) === 80 && r.status === 400 && r.body.error === "payout_below_minimum" && /You have \$0\.80 available/.test(r.body.message || ""), `owed=${usd(owedTo(creator.orgId))} ${r.status} ${short(r.body, 160)}`);

  // ---- Step 8: the operator's report
  step("Step 8: the money report");
  await waitFor(() => sql("select count(*) from chain_transfers where status='sent'"), (n) => n === "0", 60);
  await waitFor(() => sql(`select last_seen_lamports, last_seen_usdc_raw from deposit_addresses where org_id='${buyer.orgId}'`), (x) => x === `${KEEP_LAMPORTS}|0`, 60);
  const last = await report();
  check("both reconciliation differences are 0: what the addresses hold is what was received less what was swept",
    last.reconciliation?.usdc?.differenceRaw === "0" && last.reconciliation?.sol?.differenceLamports === "0" && last.reconciliation.usdc.receivedRaw === "12000000" && last.reconciliation.usdc.sweptRaw === "12000000" &&
      last.reconciliation.sol.receivedLamports === String(topupLamports + exchangeLamports),
    short(last.reconciliation, 420));
  const paid = (method) => (last.creators?.paidOutInRange || []).find((x) => x.method === method)?.amountCents;
  check("nothing is left open, and the books say what happened: credits held, $0.80 owed, $1.20 kept, $5.00 paid out twice",
    last.sweeps?.sent === 0 && last.sweeps?.failedInRange === 0 && (last.creators?.openPayouts || []).length === 0 && last.customers?.balanceCents === String(2000 + 200 + exchangeSolCents - 1200) && last.creators?.owedCents === "80" &&
      last.income?.marketplaceFeesCents === "120" && paid("crypto_usdc") === "500" && paid("crypto_sol") === "500",
    `customers=${usd(last.customers?.balanceCents)} owed=${usd(last.creators?.owedCents)} fees=${usd(last.income?.marketplaceFeesCents)} paid=${short(last.creators?.paidOutInRange)} sent=${last.sweeps?.sent} failed=${last.sweeps?.failedInRange}`);

  // ---- Where every unit is
  const end = {
    hotUsdc: await usdcOf(hot), coldUsdc: await usdcOf(cold.publicKey), wallet2Usdc: await usdcOf(wallet2), addressUsdc: await usdcOf(address),
    hotSol: await solOf(hot), coldSol: await solOf(cold.publicKey), wallet2Sol: await solOf(wallet2), addressSol: await solOf(address),
  };
  check("USDC: the 12 that came in is 5 at the second wallet, 5 in the paying wallet and 2 in the cold wallet",
    end.wallet2Usdc === 5_000_000n && end.hotUsdc === 5_000_000n && end.coldUsdc === 2_000_000n && end.addressUsdc === 0n && end.hotUsdc >= FLOAT_USDC_RAW, short(Object.fromEntries(Object.entries(end).filter(([k]) => k.endsWith("Usdc")).map(([k, x]) => [k, String(x)]))));
  const cameIn = PROOF_LAMPORTS + topupLamports + exchangeLamports;
  const coldReceived = end.coldSol - coldAfterProof;
  // The paying wallet pays for a USDC account wherever it sends USDC and none is open: its own, the cold wallet's, the second wallet's.
  const opened = [!hadUsdcAccount.hot && (await hasUsdcAccount(hot)), !hadUsdcAccount.cold && (await hasUsdcAccount(cold.publicKey)), await hasUsdcAccount(wallet2)].filter(Boolean).length;
  const fees = cameIn - (end.hotSol + end.addressSol + coldReceived + end.wallet2Sol + opened * USDC_ACCOUNT_RENT);
  check("SOL: every lamport that came in is at the second wallet, in the paying wallet, in the cold wallet, kept by the address or in a USDC account the paying wallet opened, but for the network's fees",
    end.addressSol === KEEP_LAMPORTS && fees > 0 && fees <= 80_000 && fees % 5000 === 0, `in=${cameIn} paying wallet=${end.hotSol} cold received=${coldReceived} second wallet=${end.wallet2Sol} address=${end.addressSol} USDC accounts opened=${opened} fees=${fees}`);
  check("the paying wallet still holds the 0.01 SOL it needs to go on working", end.hotSol >= PAYING_WALLET_KEEPS, `${end.hotSol} lamports (it held ${hotSolBeforePayouts} before the payouts)`);

  // A transaction in base64 is not words: it is left out, so that letters in it are not read as any.
  const words = (text) => text.replace(/"[A-Za-z0-9+/=]{60,}"/g, '""');
  const hostile = /blockhash|0x[0-9a-f]{2,}|simulation failed|custom program error|ECONN|prisma|at Object\.|SendTransactionError|-320\d\d|P20\d\d/i;
  const leaks = seenAnswers.filter((a) => hostile.test(words(a.text)));
  check("no answer in this run carried the chain's or the database's own words", leaks.length === 0, leaks.slice(0, 2).map((a) => `${a.path} ${a.status} ${short(words(a.text), 160)}`).join(" || "));

  const sol = (lamports) => `${(Number(lamports) / 1e9).toFixed(6)} SOL`;
  const usdc = (raw) => `${(Number(raw) / 1e6).toFixed(2)} USDC`;
  console.log(`\nWhere the money is at the end (SOL at $${PRICE}):`);
  console.log(`  the second wallet (the payouts)   ${usdc(end.wallet2Usdc)}   ${sol(end.wallet2Sol)}`);
  console.log(`  the cold wallet (the sweeps)      ${usdc(end.coldUsdc)}   ${sol(coldReceived)} received, after sending ${sol(PROOF_LAMPORTS)}`);
  console.log(`  the paying wallet                 ${usdc(end.hotUsdc)}   ${sol(end.hotSol)}`);
  console.log(`  the deposit address               ${usdc(end.addressUsdc)}   ${sol(end.addressSol)} (what an address must keep)`);
  console.log(`  network fees                      ${sol(fees)}`);
  console.log(`  USDC accounts the paying wallet opened: ${opened}, each holding ${sol(USDC_ACCOUNT_RENT)}`);

  finish();
}

(process.argv.includes("--after") ? afterRun() : main()).catch((err) => {
  console.error("WALK STOPPED:", err && err.stack ? err.stack : err);
  process.exit(2);
});
