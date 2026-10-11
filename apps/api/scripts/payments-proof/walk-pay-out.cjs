#!/usr/bin/env node
/*
 * Payouts of a creator's earnings, against the local API on port 4000 and the
 * local test chain on 127.0.0.1:18899.
 *
 * It proves: the limits as the page reads them; refusals that reserve
 * nothing; a payout to a wallet that waits while the paying wallet is empty
 * and can be cancelled; payouts in USDC and in SOL that are sent and arrive
 * to the last unit; the day's limit; a payout as credits; and that the
 * creator's ledger adds up to what they are owed.
 *
 * What must be running:
 *   - the local chain:  bash apps/api/scripts/payments-proof/local-chain.sh start
 *   - the repository's Postgres and Redis (Docker)
 *   - the API:          bash apps/api/scripts/payments-proof/start-api.sh
 * start-api.sh gives the API what this walk expects: payouts on, the worker
 * every 3 seconds, and SMALL limits so the walk can reach them:
 *
 *   PAYOUTS_ENABLED=true PAYOUT_EXECUTOR_INTERVAL_MS=3000
 *   PAYOUT_MAX_PER_PAYOUT_USD=20 PAYOUT_MAX_PER_DAY_USD=45
 *   SOL_PRICE_SOURCE=static SOL_PRICE_STATIC_USD=110
 *
 * A throwaway creator is given earnings the way a sale would leave them: the
 * balance and its ledger row together. The wallet that pays out belongs to
 * the local chain's throwaway master key; the walk fills and empties it on
 * the local chain. No real money and no real network.
 *
 *   node apps/api/scripts/payments-proof/walk-pay-out.cjs
 */
const { hkdfSync, randomUUID } = require("crypto");
const fs = require("fs");
const { KEYS_DIR, req, sql, sleep } = require("./lib.cjs");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");

const API = process.env.WALK_API || "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-pay4-2026";

const results = [];
const seenAnswers = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
}
const short = (v, n = 170) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + "..." : s;
};

class Client {
  constructor() {
    this.cookies = new Map();
  }
  async call(method, path, body) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
    if (path.startsWith("/api/marketplace/payouts") || path.startsWith("/api/marketplace/revenue")) seenAnswers.push({ path, status: res.status, text });
    return { status: res.status, body: json };
  }
}

async function account(label) {
  const client = new Client();
  const email = `walk-pay4-${label}-${STAMP}@example.test`;
  let r = await client.call("POST", "/api/auth/register", { email, password: PASSWORD });
  if (r.status === 429) {
    await sleep(62_000);
    r = await client.call("POST", "/api/auth/register", { email, password: PASSWORD });
  }
  if (r.status !== 200 && r.status !== 201) throw new Error(`register ${label}: ${r.status} ${short(r.body)}`);
  const me = await client.call("GET", "/api/auth/me");
  return { client, orgId: me.body.organization.id, email };
}

const chain = new web3.Connection(RPC, "confirmed");
const mintAuthority = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${KEYS_DIR}/mint-authority.json`, "utf8"))));
const masterKey = fs.readFileSync(`${KEYS_DIR}/master.key`, "utf8").trim();
// The same derivation as apps/api/src/services/payoutKeypair.ts, for the local chain's throwaway key.
const payingWallet = web3.Keypair.fromSeed(new Uint8Array(hkdfSync("sha512", Buffer.from(masterKey, "utf8"), Buffer.from("wheelsai-payout-v1"), Buffer.from("platform-payout"), 32)));

async function confirm(signature) {
  const latest = await chain.getLatestBlockhash("confirmed");
  await chain.confirmTransaction({ signature, ...latest }, "confirmed");
}
async function mintUsdcTo(owner, usdc) {
  const ata = spl.getAssociatedTokenAddressSync(USDC_MINT, owner);
  const tx = new web3.Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(mintAuthority.publicKey, ata, owner, USDC_MINT),
    spl.createMintToInstruction(USDC_MINT, ata, mintAuthority.publicKey, BigInt(Math.round(usdc * 1_000_000))),
  );
  await web3.sendAndConfirmTransaction(chain, tx, [mintAuthority], { commitment: "confirmed" });
  return ata;
}
const usdcOf = async (owner) => {
  const ata = spl.getAssociatedTokenAddressSync(USDC_MINT, owner);
  const info = await chain.getTokenAccountBalance(ata).catch(() => null);
  return info ? Number(info.value.amount) : 0;
};

/** Earnings the way a sale leaves them: the balance and its ledger row, together. */
function giveEarnings(orgId, cents) {
  sql(
    `with moved as (update publisher_profiles set pending_payout_cents = pending_payout_cents + ${cents}, total_revenue_cents = total_revenue_cents + ${cents} where org_id='${orgId}' returning pending_payout_cents) ` +
      `insert into earnings_transactions (id, org_id, amount_cents, type, description, reference_id, balance_after) select '${randomUUID()}', '${orgId}', ${cents}, 'sale', 'Sale: set up by the payout walk', 'walk-${STAMP}', pending_payout_cents from moved`,
  );
}
const owed = (orgId) => Number(sql(`select pending_payout_cents from publisher_profiles where org_id='${orgId}'`));
const ledgerSum = (orgId) => Number(sql(`select coalesce(sum(amount_cents),0) from earnings_transactions where org_id='${orgId}'`));
const payoutRow = (id) => sql(`select status, coalesce(waiting_reason,''), coalesce(failure_code,''), attempt_count, (tx_signature is not null)::int, coalesce(amount_raw,'') from creator_payouts where id='${id}'`);

async function waitForPayout(client, id, wanted, seconds = 60) {
  let row = null;
  for (let i = 0; i < seconds; i++) {
    const r = await client.call("GET", "/api/marketplace/payouts");
    row = (r.body.payouts || []).find((p) => p.id === id) || null;
    if (row && wanted(row)) return row;
    await sleep(1000);
  }
  return row;
}

async function main() {
  if (!(await chain.getVersion().catch(() => null))) throw new Error("the local chain is not running: bash apps/api/scripts/payments-proof/local-chain.sh start");
  // The mint authority pays the fees of the walk's own set-up transfers.
  if ((await chain.getBalance(mintAuthority.publicKey)) < 0.5 * web3.LAMPORTS_PER_SOL) {
    await confirm(await chain.requestAirdrop(mintAuthority.publicKey, 2 * web3.LAMPORTS_PER_SOL));
  }

  const creator = await account("creator");
  // A publisher profile comes with the first listing.
  let r = await creator.client.call("POST", "/api/agents", { name: `Walk Payout Agent ${STAMP}`, description: "Says hello.", agentKind: "conversation", systemPrompt: "You say hello." });
  const agent = r.body.agent || {};
  r = await creator.client.call("POST", "/api/marketplace/listings", { agentId: agent.id, title: agent.name, shortDescription: "A listing made by the payout walk, safe to ignore.", category: "other", pricingModel: "free", publish: true });
  const listing = r.body.listing || {};
  check("set up: a creator with a listing, so a publisher profile", r.status === 201 && owed(creator.orgId) === 0, `${r.status}`);

  const capability = (await creator.client.call("GET", "/api/capabilities")).body.payouts || {};
  check("this API says payouts are running", capability.available === true, short(capability));

  // ---- Limits, as the page reads them
  giveEarnings(creator.orgId, 300);
  r = await creator.client.call("GET", "/api/marketplace/revenue");
  let limits = r.body.payoutLimits || {};
  check("the limits come with the earnings: a $5.00 minimum, the caps, the methods offered",
    limits.minimumCents === 500 && limits.perPayoutCents === 2000 && limits.perDayCents === 4500 && limits.usedTodayCents === 0 && String(limits.methods) === "credits,crypto_usdc,crypto_sol",
    short(limits, 260));

  // ---- Refusals that reserve nothing
  const receiver = web3.Keypair.generate().publicKey;
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "credits" });
  check("under the minimum is refused with what the creator has", r.status === 400 && r.body.error === "payout_below_minimum" && /smallest payout is \$5\.00\. You have \$3\.00 available\./.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  giveEarnings(creator.orgId, 9700); // $100.00 owed
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: receiver.toBase58(), amountCents: 2500 });
  check("more than one payout to a wallet may be is refused", r.status === 400 && r.body.error === "payout_above_limit" && /most for one payout to a wallet is \$20\.00/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "credits", amountCents: 20000 });
  check("more than the creator is owed is refused", r.status === 400 && r.body.error === "payout_above_balance" && /You have \$100\.00 available/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", amountCents: 1000 });
  check("a wallet payout with no address is refused", r.status === 400 && r.body.error === "payout_address_required", `${r.status} ${short(r.body)}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: "not-an-address", amountCents: 1000 });
  check("something that is not an address is refused", r.status === 400 && r.body.error === "invalid_payout_address" && /not a Solana wallet address/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: TOKEN_PROGRAM, amountCents: 1000 });
  check("a program's address is refused", r.status === 400 && r.body.error === "invalid_payout_address" && /token account or a program/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  const someTokenAccount = await mintUsdcTo(web3.Keypair.generate().publicKey, 1);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: someTokenAccount.toBase58(), amountCents: 1000 });
  check("a token account's address is refused", r.status === 400 && r.body.error === "invalid_payout_address" && /token account or a program/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: payingWallet.publicKey.toBase58(), amountCents: 1000 });
  check("the platform's own paying wallet is refused", r.status === 400 && r.body.error === "invalid_payout_address" && /belongs to WheelsAI/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  check("none of those refusals reserved anything", owed(creator.orgId) === 10000 && sql(`select count(*) from creator_payouts where publisher_id='${creator.orgId}'`) === "0", `owed=${owed(creator.orgId)}`);

  // ---- The paying wallet is empty: the payout waits, and can be taken back
  // An earlier run of this walk leaves USDC in the paying wallet. It is the
  // local chain's throwaway wallet, so the walk empties it first.
  const leftOver = await usdcOf(payingWallet.publicKey);
  if (leftOver > 0) {
    const sink = web3.Keypair.generate().publicKey;
    const from = spl.getAssociatedTokenAddressSync(USDC_MINT, payingWallet.publicKey);
    const to = spl.getAssociatedTokenAddressSync(USDC_MINT, sink);
    const tx = new web3.Transaction().add(
      spl.createAssociatedTokenAccountIdempotentInstruction(mintAuthority.publicKey, to, sink, USDC_MINT),
      spl.createTransferCheckedInstruction(from, USDC_MINT, to, payingWallet.publicKey, BigInt(leftOver), 6),
    );
    tx.feePayer = mintAuthority.publicKey;
    await web3.sendAndConfirmTransaction(chain, tx, [mintAuthority, payingWallet], { commitment: "confirmed" });
  }
  const startSol = await chain.getBalance(payingWallet.publicKey);
  const startUsdc = await usdcOf(payingWallet.publicKey);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: receiver.toBase58(), amountCents: 1000 });
  const waiting = r.body.payout || {};
  check("a $10.00 payout in USDC is requested, and the rest stays in the earnings",
    r.status === 201 && waiting.status === "pending" && r.body.remainingCents === 9000 && /Payout of \$10\.00 requested/.test(r.body.message || "") && owed(creator.orgId) === 9000,
    `${r.status} ${short(r.body, 220)}`);
  let row = await waitForPayout(creator.client, waiting.id, (p) => !!p.message, 25);
  check(`with the paying wallet empty (it holds ${startUsdc} USDC units) the payout waits, says so, and stays cancellable`,
    startUsdc === 0 && row && row.status === "pending" && row.cancellable === true && /waiting to be sent\. You can cancel it and keep your earnings/.test(row.message || "") && payoutRow(waiting.id).startsWith("pending|wallet_low||0|0"),
    `row=${payoutRow(waiting.id)} msg=${short(row && row.message, 90)}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "credits", amountCents: 500 });
  check("a second payout while one is open is refused", r.status === 409 && r.body.error === "payout_in_progress", `${r.status} ${short(r.body)}`);
  r = await creator.client.call("POST", `/api/marketplace/payouts/${waiting.id}/cancel`, {});
  check("cancelling the waiting payout puts the $10.00 back", r.status === 200 && owed(creator.orgId) === 10000 && payoutRow(waiting.id).startsWith("cancelled|"), `${r.status} owed=${owed(creator.orgId)} row=${payoutRow(waiting.id)}`);

  // ---- Fill the paying wallet: USDC arrives
  await confirm(await chain.requestAirdrop(payingWallet.publicKey, 1 * web3.LAMPORTS_PER_SOL));
  await mintUsdcTo(payingWallet.publicKey, 100);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: receiver.toBase58(), amountCents: 1000 });
  const usdcPayout = r.body.payout || {};
  row = await waitForPayout(creator.client, usdcPayout.id, (p) => p.status === "completed", 60);
  check("with the wallet filled, a USDC payout is sent and completes: exactly 10 USDC arrives at a wallet that had no USDC account",
    row && row.status === "completed" && !!row.txSignature && (await usdcOf(receiver)) === 10_000_000 && payoutRow(usdcPayout.id).startsWith("completed|||1|1|10000000"),
    `status=${row && row.status} arrived=${await usdcOf(receiver)} row=${payoutRow(usdcPayout.id)}`);

  // ---- The largest allowed, when no amount is given
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_sol", payoutAddress: receiver.toBase58() });
  const solPayout = r.body.payout || {};
  check("with no amount given, a wallet payout is the most one payout may be, and the answer says what stays",
    r.status === 201 && solPayout.amountCents === 2000 && /Requested \$20\.00, the most for one payout to a wallet\. \$70\.00 stays in your earnings\./.test(r.body.message || ""),
    `${r.status} ${short(r.body, 240)}`);
  const lamportsBefore = await chain.getBalance(receiver);
  row = await waitForPayout(creator.client, solPayout.id, (p) => p.status === "completed", 60);
  const wantLamports = Math.floor((2000 * 10_000 * 1e9) / 110_000_000);
  const got = (await chain.getBalance(receiver)) - lamportsBefore;
  check("the SOL payout is priced from the quote in whole lamports rounded down, and exactly that arrives",
    row && row.status === "completed" && got === wantLamports && payoutRow(solPayout.id).endsWith(`|${wantLamports}`),
    `status=${row && row.status} arrived=${got} want=${wantLamports} row=${payoutRow(solPayout.id)}`);

  // ---- The day's limit for one creator ($45.00: $10.00 and $20.00 are used)
  limits = (await creator.client.call("GET", "/api/marketplace/revenue")).body.payoutLimits || {};
  check("the page is told what was used today and the most that can be asked for now", limits.usedTodayCents === 3000 && limits.largestNowCents && limits.largestNowCents.wallet === 1500 && limits.largestNowCents.credits === 7000, short(limits, 260));
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: receiver.toBase58(), amountCents: 2000 });
  check("a payout that would pass the day's limit is refused, with credits offered", r.status === 409 && r.body.error === "payout_daily_limit" && /today's limit for payouts to a wallet/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: receiver.toBase58() });
  const lastWallet = r.body.payout || {};
  row = await waitForPayout(creator.client, lastWallet.id, (p) => p.status === "completed", 60);
  check("what is left of the day's limit can still be taken", r.status === 201 && lastWallet.amountCents === 1500 && row && row.status === "completed" && (await usdcOf(receiver)) === 25_000_000, `${r.status} amount=${lastWallet.amountCents} status=${row && row.status}`);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "crypto_usdc", payoutAddress: receiver.toBase58(), amountCents: 500 });
  check("after that, even the minimum to a wallet is refused today", r.status === 409 && r.body.error === "payout_daily_limit", `${r.status} ${short(r.body)}`);

  // ---- Credits have no cap
  const creditsBefore = Number((await creator.client.call("GET", "/api/billing/balance")).body?.balance?.available ?? NaN);
  r = await creator.client.call("POST", "/api/marketplace/payouts", { payoutMethod: "credits" });
  const creditsPayout = r.body.payout || {};
  row = await waitForPayout(creator.client, creditsPayout.id, (p) => p.status === "completed", 40);
  const creditsAfter = Number((await creator.client.call("GET", "/api/billing/balance")).body?.balance?.available ?? NaN);
  const ledgerType = sql(`select type from credit_transactions where reference_id='${creditsPayout.id}' limit 1`);
  check("the rest is taken as credits with no cap, and the ledger calls it a payout, not a purchase",
    r.status === 201 && creditsPayout.amountCents === 5500 && row && row.status === "completed" && Math.abs(creditsAfter - creditsBefore - 55) < 0.005 && ledgerType === "payout_credit" && owed(creator.orgId) === 0,
    `${r.status} amount=${creditsPayout.amountCents} credits+${(creditsAfter - creditsBefore).toFixed(2)} type=${ledgerType} owed=${owed(creator.orgId)}`);

  // ---- Another organization
  const other = await account("other");
  r = await other.client.call("POST", `/api/marketplace/payouts/${usdcPayout.id}/cancel`, {});
  check("another organization cannot touch a payout", r.status === 404, `${r.status}`);

  // ---- The books
  const reserved = sql(`select count(*), coalesce(sum(amount_cents),0) from earnings_transactions where org_id='${creator.orgId}' and type='payout_reserved'`);
  const restored = sql(`select count(*), coalesce(sum(amount_cents),0) from earnings_transactions where org_id='${creator.orgId}' and type='payout_restored'`);
  check("the creator's ledger adds up to what they are owed: five reservations, one put back", ledgerSum(creator.orgId) === owed(creator.orgId) && reserved === "5|-11000" && restored === "1|1000", `sum=${ledgerSum(creator.orgId)} owed=${owed(creator.orgId)} reserved=${reserved} restored=${restored}`);
  const stuck = sql(`select count(*) from creator_payouts where publisher_id='${creator.orgId}' and status in ('pending','processing')`);
  check("no payout of the walk is left open", stuck === "0", `open=${stuck}`);
  const paidOut = startUsdc + 100_000_000 - (await usdcOf(payingWallet.publicKey));
  check("the paying wallet paid out exactly the 25 USDC the payouts say", paidOut === 25_000_000, `paid=${paidOut}`);

  const hostile = /blockhash|0x[0-9a-f]{2,}|simulation failed|custom program error|ECONN|prisma|at Object\.|SendTransactionError|-320\d\d|P20\d\d/i;
  // A transaction in base64 is not words: it is left out, so that letters in it are not read as any.
  const words = (text) => text.replace(/"[A-Za-z0-9+/=]{60,}"/g, '""');
  const leaks = seenAnswers.filter((a) => hostile.test(words(a.text)));
  check("no answer in this walk carried the chain's or the database's own words", leaks.length === 0, leaks.slice(0, 2).map((a) => `${a.path} ${a.status} ${short(words(a.text), 160)}`).join(" || "));
  const dashes = seenAnswers.filter((a) => /—|–/.test(a.text));
  check("no sentence in this walk has a long dash", dashes.length === 0, dashes.slice(0, 2).map((a) => `${a.path} ${short(a.text, 120)}`).join(" || "));

  // ---- Leave nothing on sale
  if (listing.id) await creator.client.call("POST", `/api/marketplace/listings/${listing.id}/archive`, {});
  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((err) => {
  console.error("walk crashed:", err && err.stack ? err.stack : err);
  process.exit(2);
});
