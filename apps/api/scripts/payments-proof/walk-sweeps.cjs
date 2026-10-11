#!/usr/bin/env node
/*
 * Sweeps, proving the treasury, the money report and set-plan, against the
 * local API on port 4000 and the local test chain on 127.0.0.1:18899.
 *
 * It proves: what arrives at a deposit address is swept to the paying wallet
 * while that is under its float, and to the treasury once the treasury is
 * proven; SOL is swept less what an address must keep and its own fee; the
 * paying wallet sends on what it holds above its float; an amount under the
 * threshold stays; the operator's money report explains every unit; and the
 * treasury-verify.ts and set-plan.ts commands do what they say.
 *
 * START FROM A QUIET CHAIN, or balances left by the other walks are swept too
 * and the figures below cannot be told apart. In this order:
 *
 *   bash apps/api/scripts/payments-proof/local-chain.sh stop
 *   bash apps/api/scripts/payments-proof/local-chain.sh start
 *   node apps/api/scripts/payments-proof/walk-sweeps.cjs --prepare
 *   bash apps/api/scripts/payments-proof/start-api.sh            (in another terminal)
 *   node apps/api/scripts/payments-proof/walk-sweeps.cjs
 *
 * --prepare resets what the deposit scan remembers in the local database (a
 * new chain has none of that history) and prints the treasury's address and
 * the operator's key. start-api.sh works both out by itself, and sets what
 * this walk expects:
 *
 *   SWEEPS_ENABLED=true SWEEP_INTERVAL_MS=3000 SWEEP_MIN_USD=5
 *   HOT_WALLET_FLOAT_USDC=20 HOT_WALLET_FLOAT_SOL_USD=22
 *   TREASURY_WALLET_ADDRESS=<printed>  PLATFORM_ADMIN_KEY=<printed>
 *
 * The repository's Postgres and Redis (Docker) must be running. With SOL at
 * the stated $110, a float of $22 is 0.2 SOL. No real money and no real
 * network.
 */
const { spawnSync } = require("child_process");
const { hkdfSync } = require("crypto");
const fs = require("fs");
const { REPO, KEYS_DIR, req, sql, sleep } = require("./lib.cjs");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");

const API = process.env.WALK_API || "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const ADMIN_KEY = "walk-pay6-admin-key-0123456789";
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-pay6-2026";
const KEEP_LAMPORTS = 890_880;
const FLOAT_USDC_RAW = 20_000_000n;
const FLOAT_SOL_LAMPORTS = 200_000_000;

const results = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
}
const short = (v, n = 200) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + "..." : s;
};

const masterKey = fs.readFileSync(`${KEYS_DIR}/master.key`, "utf8").trim();
const derive = (salt, info) => web3.Keypair.fromSeed(new Uint8Array(hkdfSync("sha512", Buffer.from(masterKey, "utf8"), Buffer.from(salt), Buffer.from(info), 32)));
const hotWallet = derive("wheelsai-payout-v1", "platform-payout");
const depositAddressOf = (orgId) => derive("wheelsai-topup-v1", orgId).publicKey;
const treasuryPath = `${KEYS_DIR}/treasury.json`;

if (process.argv.includes("--prepare")) {
  if (!fs.existsSync(treasuryPath)) fs.writeFileSync(treasuryPath, JSON.stringify([...web3.Keypair.generate().secretKey]), { mode: 0o600 });
  const treasury = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(treasuryPath, "utf8"))));
  // A new chain has none of the history the scan remembers, and no proven treasury.
  sql("update deposit_addresses set last_sol_signature=null, last_usdc_signature=null, last_seen_lamports=0, last_seen_usdc_raw=0, usdc_account_opened_at=null, usdc_account_opened_by=null, usdc_account_requested_at=null, scan_requested_at=null where network='solana:devnet'");
  sql("delete from platform_wallets where network='solana:devnet'");
  sql("update chain_transfers set status='dead', settled_at=now() where status='sent' and network='solana:devnet'");
  console.log(`TREASURY_WALLET_ADDRESS=${treasury.publicKey.toBase58()}`);
  console.log(`PLATFORM_ADMIN_KEY=${ADMIN_KEY}`);
  process.exit(0);
}
const treasury = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(treasuryPath, "utf8"))));

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
    return { status: res.status, body: json, headers: res.headers };
  }
}
const anon = new Client();
const report = () => anon.call("GET", "/api/platform/money", undefined, { "x-admin-key": ADMIN_KEY });

async function account(label) {
  const client = new Client();
  const email = `walk-pay6-${label}-${STAMP}@example.test`;
  let r = await client.call("POST", "/api/auth/register", { email, password: PASSWORD });
  if (r.status === 429) {
    process.stdout.write("      (sign-up limit reached: waiting a minute)\n");
    await sleep(62_000);
    r = await client.call("POST", "/api/auth/register", { email, password: PASSWORD });
  }
  if (r.status !== 200 && r.status !== 201) throw new Error(`register ${label}: ${r.status} ${short(r.body)}`);
  const me = await client.call("GET", "/api/auth/me");
  const orgId = me.body.organization.id;
  await client.call("POST", "/api/billing/deposit-address");
  return { client, orgId, email, address: depositAddressOf(orgId) };
}

const chain = new web3.Connection(RPC, "confirmed");
const mintAuthority = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${KEYS_DIR}/mint-authority.json`, "utf8"))));
async function confirm(signature) {
  const latest = await chain.getLatestBlockhash("confirmed");
  await chain.confirmTransaction({ signature, ...latest }, "confirmed");
}
const airdrop = async (to, lamports) => confirm(await chain.requestAirdrop(to, lamports));
const send = (tx, signers) => web3.sendAndConfirmTransaction(chain, tx, signers, { commitment: "confirmed" });
const ataOf = (owner) => spl.getAssociatedTokenAddressSync(USDC_MINT, owner, true);
const usdcOf = async (owner) => BigInt((await chain.getTokenAccountBalance(ataOf(owner), "confirmed").catch(() => null))?.value.amount ?? "0");
const solOf = (owner) => chain.getBalance(owner, "confirmed");
async function mintUsdc(to, usdc) {
  if ((await solOf(mintAuthority.publicKey)) < 0.05 * web3.LAMPORTS_PER_SOL) await airdrop(mintAuthority.publicKey, web3.LAMPORTS_PER_SOL);
  const tx = new web3.Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(mintAuthority.publicKey, ataOf(to), to, USDC_MINT),
    spl.createMintToInstruction(USDC_MINT, ataOf(to), mintAuthority.publicKey, BigInt(Math.round(usdc * 1_000_000))),
  );
  return send(tx, [mintAuthority]);
}
/** A plain wallet's transfer of SOL to an address. */
async function sendSol(to, lamports) {
  const from = web3.Keypair.generate();
  await airdrop(from.publicKey, lamports + 10_000_000);
  return send(new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })), [from]);
}

// Only this walk's transfers: the hot wallet's address is the same from one walk to the next.
const transfersFrom = (address, asset) =>
  sql(`select kind, status, amount_raw, to_address, fee_payer, fee_lamports, tx_signature from chain_transfers where from_address='${address}' and asset='${asset}' and created_at >= to_timestamp(${Number(STAMP) - 5}) order by created_at`)
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [kind, status, amountRaw, to, feePayer, fee, signature] = l.split("|");
      return { kind, status, amountRaw, to, feePayer, fee, signature };
    });
async function waitFor(read, ok, seconds = 90) {
  let value;
  for (let i = 0; i < seconds; i++) {
    value = await read();
    if (ok(value)) return value;
    await sleep(1000);
  }
  return value;
}
const credited = (signature) => sql(`select count(*) from onchain_receipts where tx_signature='${signature}' and status='credited'`) !== "0";
const seen = (orgId) => sql(`select last_seen_lamports, last_seen_usdc_raw from deposit_addresses where org_id='${orgId}'`);

/** One of the operator's scripts in apps/api/scripts, run the way an operator would, with the walk's chain settings. */
function script(name, args = []) {
  const run = spawnSync("npx", ["tsx", `scripts/${name}`, ...args], {
    cwd: `${REPO}/apps/api`,
    encoding: "utf8",
    env: {
      ...process.env,
      WALLET_MASTER_KEY: masterKey,
      SOLANA_RPC_URL: RPC,
      SOLANA_NETWORK: "devnet",
      NODE_ENV: "development",
      WALLET_TOPUPS_ENABLED: "true",
      DEPOSITS_ENABLED: "true",
      TREASURY_WALLET_ADDRESS: treasury.publicKey.toBase58(),
    },
    timeout: 120_000,
  });
  return { code: run.status, out: `${run.stdout || ""}${run.stderr || ""}`.replace(/\s+/g, " ").trim() };
}

async function main() {
  if (!(await chain.getVersion().catch(() => null))) throw new Error("the local chain is not running");
  const hot = hotWallet.publicKey;
  const start = { hotUsdc: await usdcOf(hot), hotSol: await solOf(hot), treasuryUsdc: await usdcOf(treasury.publicKey) };
  if (start.hotUsdc !== 0n || start.treasuryUsdc !== 0n || sql("select count(*) from platform_wallets where network='solana:devnet'") !== "0") {
    throw new Error("not a quiet start: restart the chain and run --prepare first (see the header)");
  }

  // ---- The report is the operator's only
  let r = await anon.call("GET", "/api/platform/money");
  check("the money report is refused without the operator's key", r.status === 401 && r.body.error === "invalid_admin_key", `${r.status} ${short(r.body)}`);
  r = await report();
  const before = r.body;
  check("with the key it answers every section, uncached",
    r.status === 200 && ["customers", "creators", "income", "onChain", "sweeps", "reconciliation", "health"].every((k) => before[k] && typeof before[k].state === "string" || k === "health" && before[k]) && /no-store/.test(r.headers.get("cache-control") || ""),
    `${r.status} ${short(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v && v.state])))}`);
  check("it says nothing is proven yet and reads the hot wallet", before.onChain?.treasury?.proven === false && before.onChain?.treasury?.address === treasury.publicKey.toBase58() && before.onChain?.hotWallet?.address === hot.toBase58() && before.health?.sweeps === true && before.health?.cluster === "ok", short(before.onChain));

  // The hot wallet starts with 0.1 SOL: enough to pay fees, under its float of 0.2 SOL.
  await airdrop(hot, 100_000_000);

  // ---- USDC under the float goes to the hot wallet
  const a = await account("a");
  const sender = web3.Keypair.generate();
  await airdrop(sender.publicKey, 2 * web3.LAMPORTS_PER_SOL);
  await mintUsdc(sender.publicKey, 500);
  const usdcTo = (to, usdc) =>
    send(new web3.Transaction().add(
      spl.createAssociatedTokenAccountIdempotentInstruction(sender.publicKey, ataOf(to), to, USDC_MINT),
      spl.createTransferCheckedInstruction(ataOf(sender.publicKey), USDC_MINT, ataOf(to), sender.publicKey, BigInt(Math.round(usdc * 1_000_000)), 6),
    ), [sender]);
  const s1 = await usdcTo(a.address, 30);
  await waitFor(() => credited(s1), Boolean);
  let rows = await waitFor(() => transfersFrom(a.address.toBase58(), "USDC"), (v) => v.length === 1 && v[0].status === "landed");
  check("30 USDC at an address is swept whole to the hot wallet while it is under its float",
    rows.length === 1 && rows[0].kind === "sweep_to_hot" && rows[0].status === "landed" && rows[0].amountRaw === "30000000" && rows[0].to === hot.toBase58() && rows[0].feePayer === hot.toBase58() && (await usdcOf(a.address)) === 0n && (await usdcOf(hot)) === 30_000_000n,
    `${short(rows)} address=${await usdcOf(a.address)} hot=${await usdcOf(hot)}`);
  const caught = await waitFor(() => seen(a.orgId), (v) => v.split("|")[1] === "0", 60);
  check("the scan reads the sweep as its own and remembers the address as empty", caught.split("|")[1] === "0" && sql(`select count(*) from onchain_receipts where tx_signature='${rows[0]?.signature}'`) === "0", caught);
  check("the customer keeps the credits: a sweep is not theirs to lose", Number((await a.client.call("GET", "/api/billing/balance")).body?.balance?.available) === 30);

  // ---- At the float, with no proven treasury, it stays
  const b = await account("b");
  const s2 = await usdcTo(b.address, 12);
  await waitFor(() => credited(s2), Boolean);
  await sleep(20_000);
  check("with the hot wallet at its float and no proven treasury, 12 USDC stays where it is", transfersFrom(b.address.toBase58(), "USDC").length === 0 && (await usdcOf(b.address)) === 12_000_000n, `${short(transfersFrom(b.address.toBase58(), "USDC"))}`);

  // ---- Proving the treasury
  let v = script("treasury-verify.ts", ["--dry-run"]);
  check("before any transfer from it, the treasury is not proven and the command says what to send where", sql("select count(*) from platform_wallets where network='solana:devnet'") === "0" && v.out.includes(hot.toBase58()) && /0\.1 SOL/.test(v.out), `exit ${v.code}: ${short(v.out, 260)}`);
  await airdrop(treasury.publicKey, web3.LAMPORTS_PER_SOL);
  const proof = await send(new web3.Transaction().add(web3.SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: hot, lamports: 100_000_000 })), [treasury]);
  await sleep(20_000); // finalized
  v = script("treasury-verify.ts", ["--dry-run"]);
  check("a dry run finds the transfer and writes nothing", sql("select count(*) from platform_wallets where network='solana:devnet'") === "0" && v.out.includes(proof.slice(0, 12)), `exit ${v.code}: ${short(v.out, 260)}`);
  v = script("treasury-verify.ts");
  const proven = sql("select role, address, proof_signature from platform_wallets where network='solana:devnet'");
  check("the command proves the treasury from the transfer it signed", v.code === 0 && proven === `treasury|${treasury.publicKey.toBase58()}|${proof}`, `exit ${v.code}: ${short(v.out, 200)} row=${short(proven, 60)}`);

  rows = await waitFor(() => transfersFrom(b.address.toBase58(), "USDC"), (x) => x.length === 1 && x[0].status === "landed");
  check("once it is proven, the 12 USDC goes to the treasury",
    rows.length === 1 && rows[0].kind === "sweep_to_treasury" && rows[0].to === treasury.publicKey.toBase58() && rows[0].amountRaw === "12000000" && (await usdcOf(treasury.publicKey)) === 12_000_000n && (await usdcOf(b.address)) === 0n,
    `${short(rows)} treasury=${await usdcOf(treasury.publicKey)}`);

  // ---- SOL: the address keeps what an empty account must, and pays its own fee
  const hotSolBefore = await solOf(hot);
  const s3 = await sendSol(a.address, 500_000_000);
  await waitFor(() => credited(s3), Boolean);
  rows = await waitFor(() => transfersFrom(a.address.toBase58(), "SOL"), (x) => x.length === 1 && x[0].status === "landed");
  const wantLamports = 500_000_000 - KEEP_LAMPORTS - 5000;
  check("0.5 SOL is swept, less what the address must keep and its own fee, to the hot wallet while that is under its float",
    hotSolBefore < FLOAT_SOL_LAMPORTS && rows.length === 1 && rows[0].kind === "sweep_to_hot" && rows[0].amountRaw === String(wantLamports) && rows[0].feePayer === a.address.toBase58() && rows[0].fee === "5000" && (await solOf(a.address)) === KEEP_LAMPORTS,
    `hot before=${hotSolBefore} ${short(rows)} address now=${await solOf(a.address)}`);

  // ---- The hot wallet's excess goes back
  let back = await waitFor(() => transfersFrom(hot.toBase58(), "SOL"), (x) => x.length >= 1 && x.every((t) => t.status === "landed"));
  const hotSolAfter = await solOf(hot);
  check("holding more than twice its SOL float, the hot wallet sends the excess to the treasury and keeps the float",
    back.length === 1 && back[0].kind === "hot_to_treasury" && back[0].to === treasury.publicKey.toBase58() && hotSolAfter <= FLOAT_SOL_LAMPORTS && hotSolAfter > FLOAT_SOL_LAMPORTS - 100_000,
    `${short(back)} hot now=${hotSolAfter}`);
  await mintUsdc(hot, 100);
  back = await waitFor(() => transfersFrom(hot.toBase58(), "USDC"), (x) => x.length === 1 && x[0].status === "landed");
  check("and the same for USDC: 130 held, 110 sent on, 20 kept",
    back.length === 1 && back[0].kind === "hot_to_treasury" && back[0].amountRaw === "110000000" && (await usdcOf(hot)) === FLOAT_USDC_RAW && (await usdcOf(treasury.publicKey)) === 122_000_000n,
    `${short(back)} hot=${await usdcOf(hot)} treasury=${await usdcOf(treasury.publicKey)}`);

  // ---- Under the threshold stays
  const c = await account("c");
  const s4 = await usdcTo(c.address, 3);
  await waitFor(() => credited(s4), Boolean);
  await sleep(15_000);
  check("3 USDC, under the threshold, is credited and left at its address", transfersFrom(c.address.toBase58(), "USDC").length === 0 && (await usdcOf(c.address)) === 3_000_000n);

  // ---- The report after
  await waitFor(() => seen(a.orgId), (x) => x === `${KEEP_LAMPORTS}|0`, 60);
  await waitFor(() => seen(b.orgId), (x) => x.split("|")[1] === "0", 60);
  r = await report();
  const after = r.body;
  // What landed in this walk: the month's figure after, less the figure before (earlier walks are in both).
  const landedIn = (rep, kind, asset) => BigInt((rep.sweeps?.landedInRange || []).find((x) => x.kind === kind && x.asset === asset)?.amountRaw ?? "0");
  const landed = (kind, asset) => landedIn(after, kind, asset) - landedIn(before, kind, asset);
  check("the report shows the hot wallet, the proven treasury and the transfers that landed",
    r.status === 200 && after.onChain?.hotWallet?.usdcRaw === "20000000" && after.onChain?.treasury?.proven === true && after.onChain?.treasury?.usdcRaw === "122000000" && landed("sweep_to_hot", "USDC") === 30_000_000n && landed("sweep_to_treasury", "USDC") === 12_000_000n && landed("hot_to_treasury", "USDC") === 110_000_000n && landed("sweep_to_hot", "SOL") === BigInt(wantLamports) && after.sweeps?.sent === 0,
    `${short(after.onChain, 300)} landed: to hot ${landed("sweep_to_hot", "USDC")}, to treasury ${landed("sweep_to_treasury", "USDC")}, back ${landed("hot_to_treasury", "USDC")}, SOL to hot ${landed("sweep_to_hot", "SOL")} sent=${after.sweeps?.sent}`);
  const big = (x) => BigInt(x ?? "0");
  check("what the deposit addresses hold is explained to the last unit: the difference did not move",
    big(after.reconciliation?.usdc?.differenceRaw) === big(before.reconciliation?.usdc?.differenceRaw) && big(after.reconciliation?.sol?.differenceLamports) === big(before.reconciliation?.sol?.differenceLamports) &&
      big(after.reconciliation?.usdc?.receivedRaw) - big(before.reconciliation?.usdc?.receivedRaw) === 45_000_000n && big(after.reconciliation?.usdc?.sweptRaw) - big(before.reconciliation?.usdc?.sweptRaw) === 42_000_000n &&
      big(after.reconciliation?.sol?.feeLamports) - big(before.reconciliation?.sol?.feeLamports) === 5000n,
    `before=${short(before.reconciliation, 260)} after=${short(after.reconciliation, 320)}`);
  const sold = (after.income?.creditsSold || []).find((x) => x.rail === "deposit" && x.asset === "USDC");
  check("income counts the deposits as credits sold, in cents as strings", after.income?.state === "ok" && sold && /^\d+$/.test(sold.amountCents) && BigInt(sold.amountCents) >= 4500n && /^\d+$/.test(after.customers?.balanceCents || ""), short(after.income, 260));
  const text = JSON.stringify(after);
  check("the report carries no key and no signed bytes", !text.includes(masterKey) && !/signedTx|signed_tx|secret/i.test(text));

  // ---- Setting a plan
  const planOf = () => sql(`select plan, status from org_subscriptions where org_id='${a.orgId}'`);
  let p = script("set-plan.ts", [a.orgId, "enterprise", "--dry-run"]);
  check("a dry run of set-plan says what it would do and writes nothing", /enterprise/i.test(p.out) && (planOf() === "" || planOf().startsWith("starter")), `exit ${p.code}: ${short(p.out, 200)} row=${planOf()}`);
  p = script("set-plan.ts", [a.email, "enterprise"]);
  const sub = await a.client.call("GET", "/api/billing/plan");
  check("set-plan by the owner's email puts the organization on Enterprise, and the API says so", p.code === 0 && planOf().startsWith("enterprise") && JSON.stringify(sub.body).toLowerCase().includes("enterprise"), `exit ${p.code}: ${short(p.out, 160)} row=${planOf()} api=${short(sub.body, 160)}`);
  p = script("set-plan.ts", ["nobody-by-this-name@example.test", "enterprise"]);
  check("a name that matches no organization changes nothing and says so", p.code !== 0 && p.out.length > 10, `exit ${p.code}: ${short(p.out, 160)}`);
  p = script("set-plan.ts", [a.orgId, "starter"]);
  check("and back to Starter", p.code === 0 && !planOf().startsWith("enterprise"), `exit ${p.code} row=${planOf()}`);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("WALK STOPPED:", err && err.stack ? err.stack : err);
  process.exit(2);
});
