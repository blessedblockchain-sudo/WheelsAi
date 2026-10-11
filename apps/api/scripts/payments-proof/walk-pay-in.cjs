#!/usr/bin/env node
/*
 * Paying in from a wallet, with USDC or SOL, against the local API on port
 * 4000 and the local test chain on 127.0.0.1:18899.
 *
 * It proves: a top-up is prepared for the wallet an account names, signed and
 * credited once, in USDC and in SOL at the stated price; a bonus pack; what a
 * wallet may add to the transfer and what nothing may add; a send that errors
 * although the transfer landed; refusals said in a sentence; linking a wallet
 * in Settings; and, with --slow, a transfer that can never land and a top-up
 * that is never signed.
 *
 * What must be running:
 *   - the local chain:  bash apps/api/scripts/payments-proof/local-chain.sh start
 *   - the repository's Postgres and Redis (Docker)
 *   - the API:          bash apps/api/scripts/payments-proof/start-api.sh
 * start-api.sh gives the API what this walk expects: the wallet rail on, a
 * stated SOL price of $110 and the reconcile worker every 3 seconds
 * (`node apps/api/scripts/payments-proof/walk-pay-in.cjs --how` prints the same).
 *
 * A test wallet plays the part of a customer's wallet: it signs what the
 * server prepares. No real money and no real network is involved.
 *
 *   node apps/api/scripts/payments-proof/walk-pay-in.cjs [--slow]
 *
 * --slow adds the two checks that wait for a blockhash to expire (about two
 * minutes). WALK_API names another API address, WALK_DB another database in
 * the same Postgres container.
 */
const fs = require("fs");
const lib = require("./lib.cjs");
const { KEYS_DIR, req, sleep } = lib;
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");
const nacl = req("tweetnacl");
const bs58 = req("bs58");

const API = process.env.WALK_API || "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-pay2-2026";
const SLOW = process.argv.includes("--slow");

if (process.argv.includes("--how")) {
  console.log(
    "API for this walk (the master key is a throwaway made for the local chain):\n" +
      "  bash apps/api/scripts/payments-proof/local-chain.sh start\n" +
      "  bash apps/api/scripts/payments-proof/start-api.sh\n" +
      "start-api.sh sets, for this walk:\n" +
      "  SOLANA_RPC_URL=http://127.0.0.1:18899 SOLANA_NETWORK=devnet NODE_ENV=development\n" +
      "  WALLET_TOPUPS_ENABLED=true WALLET_MASTER_KEY=<the chain's throwaway key>\n" +
      "  SOL_PRICE_SOURCE=static SOL_PRICE_STATIC_USD=110 TOPUP_RECONCILE_INTERVAL_MS=3000",
  );
  process.exit(0);
}

const results = [];
const seenAnswers = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
}
const short = (v, n = 150) => {
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
    if (path.startsWith("/api/billing/topups") || path.startsWith("/api/settings/link-wallet")) {
      seenAnswers.push({ path, status: res.status, text });
    }
    return { status: res.status, body: json, setCookie: res.headers.get("set-cookie") };
  }
}

/** WALK_DB names another database in the same Postgres container. */
const sql = (statement) => lib.sql(statement, process.env.WALK_DB || "wheelsai");

async function account(label) {
  const client = new Client();
  const email = `walk-pay2-${label}-${STAMP}@example.test`;
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

async function confirm(signature) {
  const latest = await chain.getLatestBlockhash("confirmed");
  await chain.confirmTransaction({ signature, ...latest }, "confirmed");
}

/** A wallet with SOL for fees and, when asked, stand-in USDC. */
async function fundedWallet(sol, usdc) {
  const wallet = web3.Keypair.generate();
  if (sol > 0) await confirm(await chain.requestAirdrop(wallet.publicKey, Math.round(sol * web3.LAMPORTS_PER_SOL)));
  if (usdc > 0) {
    const ata = spl.getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
    const tx = new web3.Transaction().add(
      spl.createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, USDC_MINT),
      spl.createMintToInstruction(USDC_MINT, ata, mintAuthority.publicKey, BigInt(Math.round(usdc * 1_000_000))),
    );
    await web3.sendAndConfirmTransaction(chain, tx, [wallet, mintAuthority], { commitment: "confirmed" });
  }
  return wallet;
}

/** Sign what the server prepared, the way a wallet would. `change` may alter the transaction first. */
function sign(unsignedTxBase64, wallet, change) {
  const tx = web3.Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  if (change) change(tx);
  tx.sign(wallet);
  return tx.serialize().toString("base64");
}

async function balanceUsd(client) {
  const r = await client.call("GET", "/api/billing/balance");
  return Number(r.body?.balance?.available ?? NaN);
}
const ledgerRows = (topupId) => Number(sql(`select count(*) from credit_transactions where reference_id='${topupId}'`));
const rowOf = (topupId) => sql(`select status, coalesce(failure_code,''), (signed_tx_b64 is not null)::int, (tx_signature is not null)::int from wallet_topups where id='${topupId}'`);

/** Follow a top-up the way the page does, until it is final. */
async function follow(client, topupId, seconds = 60) {
  let last = null;
  for (let i = 0; i < seconds / 2; i++) {
    last = await client.call("POST", `/api/billing/topups/${topupId}/reconcile`, {});
    if (["credited", "failed", "expired"].includes(last.body.status)) return last;
    await sleep(2000);
  }
  return last;
}

async function settle(client, submitAnswer, topupId) {
  if (submitAnswer.status === 200 && submitAnswer.body.status === "credited") return submitAnswer;
  return follow(client, topupId);
}

/** Prepare is limited to 10 a minute per address; a walk that runs into that waits and asks once more. */
async function prepare(client, body) {
  let r = await client.call("POST", "/api/billing/topups/prepare", body);
  if (r.status === 429) {
    process.stdout.write("      (prepare limit reached: waiting a minute)\n");
    await sleep(61_000);
    r = await client.call("POST", "/api/billing/topups/prepare", body);
  }
  return r;
}

const cents = (usd) => Math.round(usd * 100);
const near = (a, b) => Math.abs(a - b) < 0.005;

async function main() {
  const health = await chain.getVersion().catch(() => null);
  if (!health) throw new Error("the local chain is not running: bash apps/api/scripts/payments-proof/local-chain.sh start");

  const buyer = await account("buyer");
  const rails = (await buyer.client.call("GET", "/api/billing/packages")).body.rails || {};
  check("the wallet rail is live and offers USDC first, then SOL", rails.wallet === true && String(rails.walletAssets) === "USDC,SOL", short(rails));

  // ---- An email account, with no wallet on it
  let r = await prepare(buyer.client, { amountUsd: 10, asset: "USDC" });
  check("with no wallet named, prepare asks for one in a sentence", r.status === 400 && r.body.error === "wallet_required" && /Connect a Solana wallet to pay/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);

  const wallet = await fundedWallet(2, 200);
  const payer = wallet.publicKey.toBase58();
  const start = await balanceUsd(buyer.client);

  // ---- USDC, $10
  r = await prepare(buyer.client, { amountUsd: 10, asset: "USDC", payerAddress: payer });
  const p1 = r.body;
  check("an email account prepares a USDC top-up for the wallet it names", r.status === 200 && p1.payerAddress === payer && p1.amountRaw === "10000000" && p1.quote === null && p1.opensUsdcAccount === true && typeof p1.message === "string",
    `${r.status} raw=${p1.amountRaw} opens=${p1.opensUsdcAccount} msg=${short(p1.message, 90)}`);
  r = await buyer.client.call("POST", `/api/billing/topups/${p1.topupId}/submit`, { signedTxBase64: sign(p1.unsignedTxBase64, wallet) });
  let done = await settle(buyer.client, r, p1.topupId);
  const depositAta = spl.getAssociatedTokenAddressSync(USDC_MINT, new web3.PublicKey(p1.depositAddress), true);
  const onChain1 = Number((await chain.getTokenAccountBalance(depositAta)).value.amount);
  check("signed and submitted, it is credited: $10.00 in credits, 10 USDC on chain, one ledger row",
    done.body.status === "credited" && near((await balanceUsd(buyer.client)) - start, 10) && onChain1 === 10_000_000 && ledgerRows(p1.topupId) === 1,
    `${done.status} ${done.body.status} balance+${((await balanceUsd(buyer.client)) - start).toFixed(2)} chain=${onChain1} ledger=${ledgerRows(p1.topupId)} msg=${short(done.body.message, 80)}`);
  r = await buyer.client.call("GET", `/api/billing/topups/${p1.topupId}`);
  check("its page view says so in a sentence, with no raw fields", r.status === 200 && r.body.status === "credited" && /Added \$10\.00 in credits/.test(r.body.message || "") && !("failureReason" in r.body) && !("reason" in r.body), short(r.body, 200));

  // ---- USDC, $50 earns the $5 bonus
  r = await prepare(buyer.client, { amountUsd: 50, asset: "USDC", payerAddress: payer });
  const p2 = r.body;
  r = await buyer.client.call("POST", `/api/billing/topups/${p2.topupId}/submit`, { signedTxBase64: sign(p2.unsignedTxBase64, wallet) });
  done = await settle(buyer.client, r, p2.topupId);
  check("a $50 pack is credited as $55.00, and the USDC account is not opened twice",
    done.body.status === "credited" && near((await balanceUsd(buyer.client)) - start, 65) && p2.opensUsdcAccount === false && /Added \$55\.00 in credits: \$50\.00 paid and a \$5\.00 bonus\./.test(done.body.message || ""),
    `balance+${((await balanceUsd(buyer.client)) - start).toFixed(2)} opens=${p2.opensUsdcAccount} msg=${short(done.body.message, 90)}`);

  // ---- SOL, $5 at the stated $110
  r = await prepare(buyer.client, { amountUsd: 5, asset: "SOL", payerAddress: payer });
  const p3 = r.body;
  const wantLamports = Math.ceil((500 * 10_000 * 1e9) / 110_000_000);
  check("a SOL top-up is priced from the quote, in whole lamports rounded up, and says how long the price holds",
    r.status === 200 && p3.amountRaw === String(wantLamports) && p3.quote && near(p3.quote.solPriceUsd, 110) && /1 SOL = \$110\.00\. This price holds for 60 seconds\./.test(p3.message || ""),
    `${r.status} raw=${p3.amountRaw} want=${wantLamports} quote=${short(p3.quote)} msg=${short(p3.message, 90)}`);
  const lamportsBefore = await chain.getBalance(new web3.PublicKey(p3.depositAddress));
  r = await buyer.client.call("POST", `/api/billing/topups/${p3.topupId}/submit`, { signedTxBase64: sign(p3.unsignedTxBase64, wallet) });
  done = await settle(buyer.client, r, p3.topupId);
  const lamportsAfter = await chain.getBalance(new web3.PublicKey(p3.depositAddress));
  check("it is credited $5.00 and exactly that many lamports arrived",
    done.body.status === "credited" && near((await balanceUsd(buyer.client)) - start, 70) && lamportsAfter - lamportsBefore === wantLamports,
    `${done.body.status} balance+${((await balanceUsd(buyer.client)) - start).toFixed(2)} lamports+${lamportsAfter - lamportsBefore}`);

  // ---- What a wallet may add, and what nothing may add
  r = await prepare(buyer.client, { amountUsd: 5, asset: "USDC", payerAddress: payer });
  const p4 = r.body;
  const withFee = sign(p4.unsignedTxBase64, wallet, (tx) => {
    tx.instructions.unshift(web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }));
  });
  r = await buyer.client.call("POST", `/api/billing/topups/${p4.topupId}/submit`, { signedTxBase64: withFee });
  done = await settle(buyer.client, r, p4.topupId);
  check("a transfer the wallet added its own fee setting to is accepted and credited", done.body.status === "credited" && near((await balanceUsd(buyer.client)) - start, 75), `${r.status} -> ${done.body.status} ${short(done.body.message, 80)}`);

  r = await prepare(buyer.client, { amountUsd: 5, asset: "USDC", payerAddress: payer });
  const p5 = r.body;
  const tampered = sign(p5.unsignedTxBase64, wallet, (tx) => {
    tx.add(web3.SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: web3.Keypair.generate().publicKey, lamports: 1_000_000 }));
  });
  r = await buyer.client.call("POST", `/api/billing/topups/${p5.topupId}/submit`, { signedTxBase64: tampered });
  check("a transfer with any other instruction added is refused and not sent", r.status === 400 && r.body.error === "message_mismatch" && /does not match the one we prepared/.test(r.body.message || "") && rowOf(p5.topupId).startsWith("prepared|"),
    `${r.status} ${short(r.body)} row=${rowOf(p5.topupId)}`);
  // The untouched transfer for the same top-up still goes through.
  r = await buyer.client.call("POST", `/api/billing/topups/${p5.topupId}/submit`, { signedTxBase64: sign(p5.unsignedTxBase64, wallet) });
  done = await settle(buyer.client, r, p5.topupId);
  check("the same top-up, signed as prepared, still goes through", done.body.status === "credited" && near((await balanceUsd(buyer.client)) - start, 80), `${done.body.status}`);

  // ---- The send errors, and the transfer landed anyway
  r = await prepare(buyer.client, { amountUsd: 5, asset: "SOL", payerAddress: payer });
  const p6 = r.body;
  const signed6 = sign(p6.unsignedTxBase64, wallet);
  const sig6 = await chain.sendRawTransaction(Buffer.from(signed6, "base64"));
  await confirm(sig6); // on the chain before the server ever sees it: the server's own send will error
  r = await buyer.client.call("POST", `/api/billing/topups/${p6.topupId}/submit`, { signedTxBase64: signed6 });
  done = await settle(buyer.client, r, p6.topupId);
  check("a transfer that had already landed when the server's send errored is credited, once",
    [200, 202].includes(r.status) && done.body.status === "credited" && ledgerRows(p6.topupId) === 1 && near((await balanceUsd(buyer.client)) - start, 85),
    `submit ${r.status} ${short(r.body.message, 70)} -> ${done.body.status} ledger=${ledgerRows(p6.topupId)} balance+${((await balanceUsd(buyer.client)) - start).toFixed(2)}`);
  r = await buyer.client.call("POST", `/api/billing/topups/${p6.topupId}/submit`, { signedTxBase64: signed6 });
  check("the same signed bytes again credit nothing more", r.status === 200 && r.body.status === "credited" && ledgerRows(p6.topupId) === 1 && near((await balanceUsd(buyer.client)) - start, 85), `${r.status} ${short(r.body)}`);

  // ---- Another organization
  const other = await account("other");
  r = await other.client.call("GET", `/api/billing/topups/${p1.topupId}`);
  const r2 = await other.client.call("POST", `/api/billing/topups/${p1.topupId}/reconcile`, {});
  check("another organization cannot read or settle it", r.status === 404 && r2.status === 404, `${r.status} ${r2.status}`);

  // ---- A wallet that cannot cover it
  const poor = await fundedWallet(0.05, 0);
  r = await prepare(buyer.client, { amountUsd: 10, asset: "USDC", payerAddress: poor.publicKey.toBase58() });
  check("a wallet that holds too little is told so before anything is signed", r.status === 409 && r.body.error === "wallet_balance_short" && /holds 0(\.00)? USDC/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);
  r = await prepare(buyer.client, { amountUsd: 10, asset: "USDC", payerAddress: "not-an-address" });
  check("something that is not a wallet address is refused in a sentence", r.status === 400 && r.body.error === "invalid_payer_address" && typeof r.body.message === "string", `${r.status} ${short(r.body)}`);
  r = await prepare(buyer.client, { amountUsd: 1, asset: "USDC", payerAddress: payer });
  check("an amount under $5 is refused in a sentence", r.status === 400 && r.body.error === "invalid_amount" && /between \$5 and \$10,000/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);

  // ---- The list the page reads on opening
  r = await buyer.client.call("GET", "/api/billing/topups");
  const list = r.body.topups || [];
  check("the list is this organization's top-ups, newest first, each with a sentence",
    r.status === 200 && list.length >= 6 && list.length <= 20 && list.every((t) => typeof t.message === "string" && t.message.length > 0 && !("failureReason" in t)) && list[0].createdAt >= list[list.length - 1].createdAt,
    `${r.status} n=${list.length} first=${list[0] && list[0].status}`);

  // ---- Linking a wallet in Settings
  const linkWallet = web3.Keypair.generate();
  const linkAddress = linkWallet.publicKey.toBase58();
  r = await buyer.client.call("POST", "/api/settings/link-wallet/nonce", { walletAddress: linkAddress });
  const nonce = r.body.nonce;
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(String(nonce)), linkWallet.secretKey));
  r = await buyer.client.call("POST", "/api/settings/link-wallet", { walletAddress: linkAddress, signature, nonce });
  const me = await buyer.client.call("GET", "/api/auth/me");
  check("a wallet is linked with the server's nonce, and the session carries it at once",
    r.status === 200 && r.body.walletAddress === linkAddress && !!r.setCookie && me.body.user && me.body.user.walletAddress === linkAddress,
    `${r.status} ${short(r.body)} cookie=${!!r.setCookie} me=${me.body.user && me.body.user.walletAddress}`);
  r = await buyer.client.call("POST", "/api/settings/link-wallet", { walletAddress: linkAddress, signature, nonce });
  check("the same nonce cannot be used twice", r.status === 401 && r.body.error === "invalid_nonce", `${r.status} ${short(r.body)}`);
  r = await other.client.call("POST", "/api/settings/link-wallet/nonce", { walletAddress: linkAddress });
  const sig2 = bs58.encode(nacl.sign.detached(new TextEncoder().encode(String(r.body.nonce)), linkWallet.secretKey));
  r = await other.client.call("POST", "/api/settings/link-wallet", { walletAddress: linkAddress, signature: sig2, nonce: r.body.nonce });
  check("a wallet that belongs to another account cannot be linked", r.status === 409 && r.body.error === "wallet_in_use" && /already signs in to another WheelsAI account/.test(r.body.message || ""), `${r.status} ${short(r.body)}`);

  if (SLOW) {
    // ---- Never signed: it runs out of time
    r = await prepare(buyer.client, { amountUsd: 5, asset: "SOL", payerAddress: payer });
    const unsignedOne = r.body;
    // ---- Signed, but sent only after its blockhash has expired: it can never land
    r = await prepare(buyer.client, { amountUsd: 5, asset: "USDC", payerAddress: payer });
    const late = r.body;
    const lateSigned = sign(late.unsignedTxBase64, wallet);
    const lastValid = web3.Transaction.from(Buffer.from(late.unsignedTxBase64, "base64")).lastValidBlockHeight;
    const lvh = Number(sql(`select last_valid_block_height from wallet_topups where id='${late.topupId}'`));
    process.stdout.write(`      waiting for block height to pass ${lvh} (${lastValid ?? "n/a"}) `);
    for (let i = 0; i < 100; i++) {
      if ((await chain.getBlockHeight("confirmed")) > lvh + 2) break;
      process.stdout.write(".");
      await sleep(2000);
    }
    process.stdout.write("\n");
    const before = await balanceUsd(buyer.client);
    r = await buyer.client.call("POST", `/api/billing/topups/${late.topupId}/submit`, { signedTxBase64: lateSigned });
    const submitLate = r;
    done = await follow(buyer.client, late.topupId, 90);
    check("a transfer sent after its blockhash expired ends as expired from the chain's say-so, with nothing credited",
      done.body.status === "expired" && /did not take this transfer, so nothing was taken/.test(done.body.message || "") && ledgerRows(late.topupId) === 0 && near(await balanceUsd(buyer.client), before) && rowOf(late.topupId).startsWith("expired|never_landed"),
      `submit ${submitLate.status} ${short(submitLate.body, 110)} -> ${done.body.status} row=${rowOf(late.topupId)} msg=${short(done.body.message, 80)}`);
    r = await follow(buyer.client, unsignedOne.topupId, 40);
    check("a top-up that was never signed runs out of time and says so",
      r.body.status === "expired" && /ran out of time before it was sent/.test(r.body.message || "") && rowOf(unsignedOne.topupId).startsWith("expired|unsigned_expired"),
      `${r.body.status} row=${rowOf(unsignedOne.topupId)} msg=${short(r.body.message, 80)}`);
  }

  // ---- Nothing the chain or the database said reached an answer
  const hostile = /blockhash|0x[0-9a-f]{2,}|simulation failed|custom program error|ECONN|prisma|at Object\.|SendTransactionError|-320\d\d/i;
  const leaks = seenAnswers.filter((a) => hostile.test(a.text));
  check("no answer in this walk carried the chain's or the database's own words", leaks.length === 0, leaks.slice(0, 2).map((a) => `${a.path} ${a.status} ${short(a.text, 160)}`).join(" || "));
  const dashes = seenAnswers.filter((a) => /—|–/.test(a.text));
  check("no sentence in this walk has a long dash", dashes.length === 0, dashes.slice(0, 2).map((a) => `${a.path} ${short(a.text, 120)}`).join(" || "));

  console.log(`\n${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch((err) => {
  console.error("walk crashed:", err && err.stack ? err.stack : err);
  process.exit(2);
});
