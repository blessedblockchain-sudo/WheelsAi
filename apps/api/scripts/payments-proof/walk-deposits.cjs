#!/usr/bin/env node
/*
 * A deposit address, against the local API on port 4000 and the local test
 * chain on 127.0.0.1:18899.
 *
 * It proves: each organization gets its own address; USDC and SOL sent
 * straight to it are credited once, with the bonus and the price written
 * down; a transfer too small to credit is written down as ignored; a prepared
 * top-up that was broadcast without the API is credited once, through its
 * top-up; the list of deposits; and Prepare address, with who may use it, the
 * paying wallet running low and the limit for a day.
 *
 * What must be running:
 *   - the local chain:  bash apps/api/scripts/payments-proof/local-chain.sh start
 *   - the repository's Postgres and Redis (Docker)
 *   - the API:          bash apps/api/scripts/payments-proof/start-api.sh
 * start-api.sh gives the API what this walk expects: deposits on, the scan
 * every 3 seconds, and a SMALL limit on opened accounts so the walk reaches it:
 *
 *   DEPOSITS_ENABLED=true DEPOSIT_SCAN_INTERVAL_MS=3000 DEPOSIT_ACCOUNT_OPENS_PER_DAY=2
 *   WALLET_TOPUPS_ENABLED=true SOL_PRICE_SOURCE=static SOL_PRICE_STATIC_USD=110
 *
 * Transfers are sent the way an exchange or a plain wallet sends them: straight
 * to the address, with no prepare and no browser. Crediting is watched in the
 * database (the scan worker does it), so the walk stays inside the API's
 * request limits. No real money and no real network.
 *
 *   node apps/api/scripts/payments-proof/walk-deposits.cjs
 */
const { hkdfSync } = require("crypto");
const fs = require("fs");
const { KEYS_DIR, req, sql, sleep } = require("./lib.cjs");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");

const API = process.env.WALK_API || "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const MEMO_PROGRAM = new web3.PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-pay5-2026";
const PAUSED = "Deposits are paused for a moment. Nothing sent to your address is lost. Try again shortly.";

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
    if (path.startsWith("/api/billing/deposit")) seenAnswers.push({ path, status: res.status, text });
    return { status: res.status, body: json };
  }
}

async function account(label) {
  const client = new Client();
  const email = `walk-pay5-${label}-${STAMP}@example.test`;
  let r = await client.call("POST", "/api/auth/register", { email, password: PASSWORD });
  if (r.status === 429) {
    process.stdout.write("      (sign-up limit reached: waiting a minute)\n");
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
const derive = (salt, info) => web3.Keypair.fromSeed(new Uint8Array(hkdfSync("sha512", Buffer.from(masterKey, "utf8"), Buffer.from(salt), Buffer.from(info), 32)));
// The same derivations as services/payoutKeypair.ts and services/topupKeypairs.ts, for the local chain's throwaway key.
const hotWallet = derive("wheelsai-payout-v1", "platform-payout");
const depositAddressOf = (orgId) => derive("wheelsai-topup-v1", orgId).publicKey;

async function confirm(signature) {
  const latest = await chain.getLatestBlockhash("confirmed");
  await chain.confirmTransaction({ signature, ...latest }, "confirmed");
}
async function airdrop(to, sol) {
  await confirm(await chain.requestAirdrop(to, Math.round(sol * web3.LAMPORTS_PER_SOL)));
}
/** A plain wallet with SOL and stand-in USDC, as a customer or an exchange holds them. */
async function fundedWallet(sol, usdc) {
  const wallet = web3.Keypair.generate();
  await airdrop(wallet.publicKey, sol);
  if ((await chain.getBalance(mintAuthority.publicKey)) < 0.05 * web3.LAMPORTS_PER_SOL) await airdrop(mintAuthority.publicKey, 1);
  const ata = spl.getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
  const tx = new web3.Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, USDC_MINT),
    spl.createMintToInstruction(USDC_MINT, ata, mintAuthority.publicKey, BigInt(Math.round(usdc * 1_000_000))),
  );
  await web3.sendAndConfirmTransaction(chain, tx, [wallet, mintAuthority], { commitment: "confirmed" });
  return wallet;
}
const send = (tx, signers) => web3.sendAndConfirmTransaction(chain, tx, signers, { commitment: "confirmed" });
const ataOf = (owner) => spl.getAssociatedTokenAddressSync(USDC_MINT, owner, true);
const usdcRaw = (base) => BigInt(Math.round(base * 1_000_000));

/** USDC the way a wallet sends it: open the account if needed, then a checked transfer. */
function usdcTransfer(from, to, usdc, { open = true, checked = true } = {}) {
  const tx = new web3.Transaction();
  if (open) tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ataOf(to), to, USDC_MINT));
  tx.add(
    checked
      ? spl.createTransferCheckedInstruction(ataOf(from.publicKey), USDC_MINT, ataOf(to), from.publicKey, usdcRaw(usdc), 6)
      : spl.createTransferInstruction(ataOf(from.publicKey), ataOf(to), from.publicKey, usdcRaw(usdc)),
  );
  return tx;
}
const solTransfer = (from, to, lamports) => web3.SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports });

/** "Prepare address" is limited to 3 a minute for one address; that refusal is not the day's limit. */
async function prepareAddress(client) {
  let r = await client.call("POST", "/api/billing/deposit-address/usdc-account", {});
  if (r.status === 429 && r.body.error !== "daily_limit") {
    process.stdout.write("      (request limit reached: waiting a minute)\n");
    seenAnswers.pop();
    await sleep(61_000);
    r = await client.call("POST", "/api/billing/deposit-address/usdc-account", {});
  }
  return r;
}

async function balanceUsd(client) {
  const r = await client.call("GET", "/api/billing/balance");
  return Number(r.body?.balance?.available ?? NaN);
}
const receiptsOf = (signature) =>
  sql(`select asset, source, status, amount_raw, coalesce(amount_usd_cents::text,''), bonus_cents, coalesce(topup_id::text,''), coalesce(quote_source,''), coalesce(quote_price_micro_usd::text,''), coalesce(ignored_reason,''), id from onchain_receipts where tx_signature='${signature}' order by asset`)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [asset, source, status, amountRaw, cents, bonus, topupId, quoteSource, quotePrice, ignoredReason, id] = l.split("|");
      return { asset, source, status, amountRaw, cents, bonus, topupId, quoteSource, quotePrice, ignoredReason, id };
    });
/** Wait for the scan worker to have dealt with a transfer (a receipt in a final state for each asset expected). */
async function waitForReceipts(signature, count, seconds = 90) {
  let rows = [];
  for (let i = 0; i < seconds; i++) {
    rows = receiptsOf(signature);
    if (rows.length >= count && rows.every((r) => r.status !== "detected")) return rows;
    await sleep(1000);
  }
  return rows;
}
const ledgerRows = (referenceId) => sql(`select type, amount_cents from credit_transactions where reference_id='${referenceId}' order by type`).split("\n").filter(Boolean);
const near = (a, b) => Math.abs(a - b) < 0.005;
const addressRow = (orgId) => sql(`select address, network, coalesce(usdc_account_opened_by,''), (usdc_account_opened_at is not null)::int, (usdc_account_requested_at is not null)::int, last_seen_lamports, last_seen_usdc_raw, (last_sol_signature is not null)::int, (last_usdc_signature is not null)::int from deposit_addresses where org_id='${orgId}'`);

async function main() {
  const health = await chain.getVersion().catch(() => null);
  if (!health) throw new Error("the local chain is not running: bash apps/api/scripts/payments-proof/local-chain.sh start");
  // Earlier walks leave "asked to open" marks behind; today's limit must start from none.
  sql(`update deposit_addresses set usdc_account_requested_at = null where usdc_account_requested_at is not null`);

  const a = await account("a");
  const rails = (await a.client.call("GET", "/api/billing/packages")).body.rails || {};
  check("the deposit rail is live", rails.deposits === true && rails.wallet === true, short(rails));

  // ---- The address
  let r = await a.client.call("GET", "/api/billing/deposit-address");
  check("before it is asked for there is no address, in a sentence, and nothing was created",
    r.status === 200 && r.body.address === null && r.body.message === "Your organization has no deposit address yet." && addressRow(a.orgId) === "",
    `${r.status} ${short(r.body)}`);
  r = await a.client.call("POST", "/api/billing/deposit-address");
  const address = depositAddressOf(a.orgId);
  const usdcAsset = (r.body.assets || []).find((x) => x.asset === "USDC") || {};
  const solAsset = (r.body.assets || []).find((x) => x.asset === "SOL") || {};
  check("asking issues the organization's own address, with USDC not yet receivable and SOL offered",
    r.status === 200 && r.body.address === address.toBase58() && r.body.network === "devnet" && usdcAsset.accountOpen === false && solAsset.offered === true,
    `${r.status} ${short(r.body, 260)}`);
  check("it says where to send and how it is credited",
    r.body.message === "Send USDC or SOL on Solana to this address. It belongs to your organization only. USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes.",
    short(r.body.message, 240));
  r = await a.client.call("POST", "/api/billing/deposit-address");
  check("asking twice gives the same address and one row", r.status === 200 && r.body.address === address.toBase58() && sql(`select count(*) from deposit_addresses where org_id='${a.orgId}'`) === "1", `${r.status}`);

  const b = await account("b");
  r = await b.client.call("POST", "/api/billing/deposit-address");
  check("another organization gets a different address", r.status === 200 && r.body.address && r.body.address !== address.toBase58() && r.body.address === depositAddressOf(b.orgId).toBase58(), short(r.body.address));

  const start = await balanceUsd(a.client);
  const sender = await fundedWallet(5, 500);

  // ---- USDC from a plain wallet: 50 USDC earns the $5 bonus
  const s1 = await send(usdcTransfer(sender, address, 50), [sender]);
  let rows = await waitForReceipts(s1, 1);
  check("50 USDC sent straight to the address is credited by the worker: $50.00 and a $5.00 bonus, one receipt",
    rows.length === 1 && rows[0].asset === "USDC" && rows[0].source === "direct" && rows[0].status === "credited" && rows[0].amountRaw === "50000000" && rows[0].cents === "5000" && rows[0].bonus === "500" && near((await balanceUsd(a.client)) - start, 55),
    `${short(rows)} balance+${((await balanceUsd(a.client)) - start).toFixed(2)}`);
  const led1 = rows[0] ? ledgerRows(rows[0].id) : [];
  check("its ledger rows are one purchase of $50.00 and one bonus of $5.00", String(led1) === "bonus|500,purchase|5000", String(led1));

  r = await a.client.call("POST", "/api/billing/deposit-address/check", {});
  check("Check now finds nothing new and credits nothing twice",
    r.status === 200 && Array.isArray(r.body.credited) && r.body.credited.length === 0 && r.body.message === "No new transfer yet. Transfers usually arrive within a few minutes." && near((await balanceUsd(a.client)) - start, 55) && receiptsOf(s1).length === 1,
    `${r.status} ${short(r.body)}`);
  r = await a.client.call("GET", "/api/billing/deposit-address");
  check("the address now shows that it can receive USDC", r.status === 200 && ((r.body.assets || []).find((x) => x.asset === "USDC") || {}).accountOpen === true, short(r.body.assets));

  // ---- SOL: 0.5 SOL at the stated $110 is $55.00, and earns the $5 bonus
  const s2 = await send(new web3.Transaction().add(solTransfer(sender, address, 500_000_000)), [sender]);
  rows = await waitForReceipts(s2, 1);
  check("0.5 SOL is credited at the price: $55.00 and a $5.00 bonus, with the price written down",
    rows.length === 1 && rows[0].asset === "SOL" && rows[0].status === "credited" && rows[0].amountRaw === "500000000" && rows[0].cents === "5500" && rows[0].bonus === "500" && rows[0].quoteSource === "static" && rows[0].quotePrice === "110000000" && near((await balanceUsd(a.client)) - start, 115),
    `${short(rows)} balance+${((await balanceUsd(a.client)) - start).toFixed(2)}`);

  // ---- A plain (unchecked) transfer of an amount that is not whole cents
  const s3 = await send(usdcTransfer(sender, address, 1.234567, { open: false, checked: false }), [sender]);
  rows = await waitForReceipts(s3, 1);
  check("1.234567 USDC by a plain transfer is credited $1.23, rounded down",
    rows.length === 1 && rows[0].status === "credited" && rows[0].amountRaw === "1234567" && rows[0].cents === "123" && rows[0].bonus === "0" && near((await balanceUsd(a.client)) - start, 116.23),
    `${short(rows)} balance+${((await balanceUsd(a.client)) - start).toFixed(2)}`);

  // ---- One transaction carrying both assets
  const both = usdcTransfer(sender, address, 2, { open: false });
  both.add(solTransfer(sender, address, 10_000_000));
  const s4 = await send(both, [sender]);
  rows = await waitForReceipts(s4, 2);
  check("one transaction carrying 2 USDC and 0.01 SOL is two receipts and $3.10",
    rows.length === 2 && rows[0].asset === "SOL" && rows[0].cents === "110" && rows[1].asset === "USDC" && rows[1].cents === "200" && rows.every((x) => x.status === "credited") && near((await balanceUsd(a.client)) - start, 119.33),
    `${short(rows, 300)} balance+${((await balanceUsd(a.client)) - start).toFixed(2)}`);

  // ---- Too small to credit
  const s5 = await send(new web3.Transaction().add(solTransfer(sender, address, 1000)), [sender]);
  rows = await waitForReceipts(s5, 1);
  check("a transfer worth under one cent is written down as ignored and credits nothing",
    rows.length === 1 && rows[0].status === "ignored" && rows[0].ignoredReason === "below_one_cent" && near((await balanceUsd(a.client)) - start, 119.33),
    `${short(rows)} balance+${((await balanceUsd(a.client)) - start).toFixed(2)}`);

  // ---- A prepared top-up the customer broadcast themselves, never calling submit
  const payer = sender.publicKey.toBase58();
  r = await a.client.call("POST", "/api/billing/topups/prepare", { amountUsd: 10, asset: "USDC", payerAddress: payer });
  const p1 = r.body;
  let tx = web3.Transaction.from(Buffer.from(p1.unsignedTxBase64, "base64"));
  tx.sign(sender);
  const s6 = await chain.sendRawTransaction(tx.serialize());
  rows = await waitForReceipts(s6, 1);
  const top1 = sql(`select status, coalesce(tx_signature,'') from wallet_topups where id='${p1.topupId}'`);
  check("a prepared top-up broadcast without submit is credited once, through its top-up",
    r.status === 200 && rows.length === 1 && rows[0].source === "prepared" && rows[0].topupId === p1.topupId && rows[0].status === "credited" && top1 === `credited|${s6}` && near((await balanceUsd(a.client)) - start, 129.33) && String(ledgerRows(p1.topupId)) === "purchase|1000",
    `${r.status} ${short(rows)} topup=${short(top1, 40)} balance+${((await balanceUsd(a.client)) - start).toFixed(2)} ledger=${ledgerRows(p1.topupId)}`);

  // ---- The same, on a row the older code had given up on
  r = await a.client.call("POST", "/api/billing/topups/prepare", { amountUsd: 5, asset: "USDC", payerAddress: payer });
  const p2 = r.body;
  tx = web3.Transaction.from(Buffer.from(p2.unsignedTxBase64, "base64"));
  tx.sign(sender);
  const s7 = await chain.sendRawTransaction(tx.serialize());
  sql(`update wallet_topups set status='failed', failure_code='never_landed' where id='${p2.topupId}' and status='prepared'`);
  rows = await waitForReceipts(s7, 1);
  check("a top-up marked failed whose transfer did land is credited once, through its top-up",
    rows.length === 1 && rows[0].source === "prepared" && rows[0].topupId === p2.topupId && sql(`select status from wallet_topups where id='${p2.topupId}'`) === "credited" && near((await balanceUsd(a.client)) - start, 134.33),
    `${short(rows)} balance+${((await balanceUsd(a.client)) - start).toFixed(2)}`);

  // ---- A top-up submitted the ordinary way is not credited again when the scan sees its transfer
  r = await a.client.call("POST", "/api/billing/topups/prepare", { amountUsd: 7, asset: "USDC", payerAddress: payer });
  const p3 = r.body;
  tx = web3.Transaction.from(Buffer.from(p3.unsignedTxBase64, "base64"));
  tx.sign(sender);
  r = await a.client.call("POST", `/api/billing/topups/${p3.topupId}/submit`, { signedTxBase64: tx.serialize().toString("base64") });
  for (let i = 0; i < 30 && sql(`select status from wallet_topups where id='${p3.topupId}'`) !== "credited"; i++) await sleep(1000);
  const s8 = sql(`select tx_signature from wallet_topups where id='${p3.topupId}'`);
  await sleep(25_000); // long enough for the transfer to be finalized and the scan to have read it
  rows = receiptsOf(s8);
  check("a submitted top-up has one receipt, and the scan seeing its transfer credits nothing more",
    rows.length === 1 && rows[0].source === "prepared" && rows[0].topupId === p3.topupId && near((await balanceUsd(a.client)) - start, 141.33) && String(ledgerRows(p3.topupId)) === "purchase|700",
    `${short(rows)} balance+${((await balanceUsd(a.client)) - start).toFixed(2)} ledger=${ledgerRows(p3.topupId)}`);

  // ---- What the worker keeps about the address
  const onChainLamports = await chain.getBalance(address, "finalized");
  const onChainUsdc = (await chain.getTokenAccountBalance(ataOf(address), "finalized")).value.amount;
  const row = addressRow(a.orgId).split("|");
  check("the address row holds what the chain holds, and both cursors",
    row[5] === String(onChainLamports) && row[6] === onChainUsdc && row[7] === "1" && row[8] === "1",
    `row=${row.slice(5).join("|")} chain=${onChainLamports}|${onChainUsdc}`);
  check("every credit of the organization has its ledger row: the ledger adds up to the balance",
    sql(`select (select coalesce(sum(amount_cents),0) from credit_transactions where org_id='${a.orgId}') = (select balance_cents from credit_balances where org_id='${a.orgId}')`) === "t");

  // ---- The list
  r = await a.client.call("GET", "/api/billing/deposits");
  const list = r.body.deposits || [];
  const first = list.find((d) => d.txSignature === s1) || {};
  const tiny = list.find((d) => d.txSignature === s5) || {};
  const odd = list.find((d) => d.txSignature === s3) || {};
  check("the list shows the transfers sent straight to the address, newest first, each with a sentence",
    r.status === 200 && list.length === 6 && list[0].txSignature === s5 && first.status === "credited" && first.amount === "50.00" && first.creditedUsd === 50 && first.bonusUsd === 5 && first.message === "Credited $55.00: $50.00 sent and a $5.00 bonus." && tiny.status === "ignored" && tiny.message === "This transfer was too small to credit." && odd.amount === "1.234567" && odd.message === "Credited $1.23.",
    `${r.status} n=${list.length} first=${short(first, 200)} tiny=${short(tiny.message)} odd=${odd.amount}`);
  check("a prepared top-up is not in that list", !list.some((d) => [s6, s7, s8].includes(d.txSignature)));

  // ---- Prepare address
  const c = await account("c");
  r = await prepareAddress(c.client);
  check("with no address yet, Prepare address says so", r.status === 404 && r.body.error === "deposit_address_not_issued" && r.body.message === "Your organization has no deposit address yet.", `${r.status} ${short(r.body)}`);
  await c.client.call("POST", "/api/billing/deposit-address");
  const cAddress = depositAddressOf(c.orgId);
  const hotBefore = await chain.getBalance(hotWallet.publicKey);
  if (hotBefore < 0.2 * web3.LAMPORTS_PER_SOL) await airdrop(hotWallet.publicKey, 1);
  const hotStart = await chain.getBalance(hotWallet.publicKey);
  r = await prepareAddress(c.client);
  check("an organization with no verified email and no purchase is refused, and nothing is spent",
    r.status === 403 && r.body.error === "not_eligible" && r.body.message === "Verify your email or make one purchase first, then prepare the address." && (await chain.getBalance(hotWallet.publicKey)) === hotStart,
    `${r.status} ${short(r.body)}`);

  // An exchange that does not open the account cannot send USDC yet.
  let refused = false;
  try {
    await send(usdcTransfer(sender, cAddress, 3, { open: false }), [sender]);
  } catch {
    refused = true;
  }
  check("before the address is prepared, a transfer that does not open the USDC account fails on the chain", refused);

  sql(`update users set email_verified = true where id in (select user_id from org_members where org_id='${c.orgId}')`);
  r = await prepareAddress(c.client);
  const cAta = await chain.getAccountInfo(ataOf(cAddress));
  const hotAfter = await chain.getBalance(hotWallet.publicKey);
  const cRow = addressRow(c.orgId).split("|");
  check("once the email is verified, Prepare address opens the USDC account from the paying wallet",
    r.status === 200 && r.body.accountOpen === true && r.body.message === "Your address can now receive USDC." && !!cAta && hotStart - hotAfter > 2_000_000 && hotStart - hotAfter < 2_100_000 && cRow[2] === "platform" && cRow[3] === "1" && cRow[4] === "1",
    `${r.status} ${short(r.body)} spent=${hotStart - hotAfter} row=${cRow.slice(2, 5).join("|")}`);
  r = await prepareAddress(c.client);
  check("pressing it again answers the same and spends nothing", r.status === 200 && r.body.accountOpen === true && (await chain.getBalance(hotWallet.publicKey)) === hotAfter, `${r.status} ${short(r.body)}`);

  const cStart = await balanceUsd(c.client);
  const s9 = await send(usdcTransfer(sender, cAddress, 3, { open: false }), [sender]);
  rows = await waitForReceipts(s9, 1);
  check("the same transfer now lands and is credited $3.00", rows.length === 1 && rows[0].status === "credited" && rows[0].cents === "300" && near((await balanceUsd(c.client)) - cStart, 3), `${short(rows)} balance+${((await balanceUsd(c.client)) - cStart).toFixed(2)}`);
  r = await c.client.call("POST", "/api/billing/deposit-address/check", {});
  check("Check now answers in the contract's shape", r.status === 200 && Array.isArray(r.body.credited) && Array.isArray(r.body.waiting) && typeof r.body.message === "string", `${r.status} ${short(r.body)}`);

  // ---- The paying wallet running low
  const d = await account("d");
  await d.client.call("POST", "/api/billing/deposit-address");
  sql(`update users set email_verified = true where id in (select user_id from org_members where org_id='${d.orgId}')`);
  const parked = web3.Keypair.generate();
  const hotNow = await chain.getBalance(hotWallet.publicKey);
  const keep = 10_000_000; // 0.01 SOL: under HOT_WALLET_MIN_SOL
  await send(new web3.Transaction().add(solTransfer(hotWallet, parked.publicKey, hotNow - keep - 5000)), [hotWallet]);
  r = await prepareAddress(d.client);
  check("while the paying wallet is low, Prepare address is refused in a sentence and nothing is sent",
    r.status === 503 && r.body.error === "unavailable" && r.body.message === "The address cannot be prepared right now. Send SOL, or try again later." && !(await chain.getAccountInfo(ataOf(depositAddressOf(d.orgId)))),
    `${r.status} ${short(r.body)}`);
  await send(new web3.Transaction().add(solTransfer(parked, hotWallet.publicKey, (await chain.getBalance(parked.publicKey)) - 5000)), [parked]);
  r = await prepareAddress(d.client);
  check("with the paying wallet filled again it is prepared", r.status === 200 && r.body.accountOpen === true && !!(await chain.getAccountInfo(ataOf(depositAddressOf(d.orgId)))), `${r.status} ${short(r.body)}`);

  // ---- The limit for a day (the API runs with DEPOSIT_ACCOUNT_OPENS_PER_DAY=2)
  const e = await account("e");
  await e.client.call("POST", "/api/billing/deposit-address");
  sql(`update users set email_verified = true where id in (select user_id from org_members where org_id='${e.orgId}')`);
  const hotBeforeLimit = await chain.getBalance(hotWallet.publicKey);
  r = await prepareAddress(e.client);
  check("past the day's limit Prepare address is refused in a sentence and nothing is spent",
    r.status === 429 && r.body.error === "daily_limit" && r.body.message === "The address cannot be prepared right now. Send SOL, or try again later." && (await chain.getBalance(hotWallet.publicKey)) === hotBeforeLimit,
    `${r.status} ${short(r.body)}`);

  // ---- Nothing a customer read was the chain's or the database's own words
  const raw = seenAnswers.filter((x) => /prisma|P20\d\d|ECONN|stack|at \w+ \(|TransactionExpired|SendTransactionError|blockhash|0x[0-9a-f]{2,}|custom program error/i.test(x.text));
  check("no answer carried the chain's or the database's own words", raw.length === 0, raw.length ? short(raw[0], 260) : `${seenAnswers.length} answers read`);
  const refusals = seenAnswers.filter((x) => x.status >= 400);
  check("every refusal carried a code and a sentence", refusals.length > 0 && refusals.every((x) => { try { const j = JSON.parse(x.text); return typeof j.error === "string" && typeof j.message === "string" && j.message.length > 10; } catch { return false; } }), `${refusals.length} refusals`);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("WALK STOPPED:", err && err.stack ? err.stack : err);
  process.exit(2);
});
