#!/usr/bin/env node
/*
 * The figures behind the Billing page, against the local API on port 4000 and
 * the local test chain on 127.0.0.1:18899.
 *
 * It proves: what is available and what is held; this month's spending by
 * kind, taken from the ledger's own rows; GPU hours from measured seconds;
 * the list of transactions with its pages and filters; the export as a file;
 * and that another organization sees only its own.
 *
 * What must be running:
 *   - the local chain:  bash apps/api/scripts/payments-proof/local-chain.sh start
 *   - the repository's Postgres and Redis (Docker)
 *   - the API:          bash apps/api/scripts/payments-proof/start-api.sh
 *
 * One real deposit puts credits on a new organization. The rest of its month
 * is written the way the product leaves it: each ledger row together with the
 * balance it leaves, a job paid into escrow, a deployment's hold taken and
 * released. browser-billing.cjs signs in as the organization this walk leaves
 * behind. No real money and no real network.
 *
 *   node apps/api/scripts/payments-proof/walk-billing.cjs
 */
const { hkdfSync, randomUUID } = require("crypto");
const fs = require("fs");
const { KEYS_DIR, req, sql, sleep } = require("./lib.cjs");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");

const API = process.env.WALK_API || "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-pay7-2026";

const results = [];
const seenAnswers = [];
function check(name, ok, detail) {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
}
const short = (v, n = 220) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + "..." : s;
};
const near = (a, b) => Math.abs(a - b) < 0.005;

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
      json = { raw: text };
    }
    if (path.startsWith("/api/billing/")) seenAnswers.push({ path, status: res.status, text });
    return { status: res.status, body: json, text, headers: res.headers };
  }
}

async function account(label) {
  const client = new Client();
  const email = `walk-pay7-${label}-${STAMP}@example.test`;
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

/** A ledger row the way the product writes one: with the balance it leaves, in one statement. */
function ledger(orgId, type, cents, description, { gpuSeconds = null, reference = null, at = "now()" } = {}) {
  sql(
    `with moved as (update credit_balances set balance_cents = balance_cents + (${cents}) where org_id='${orgId}' returning balance_cents) ` +
      `insert into credit_transactions (id, org_id, amount_cents, type, description, reference_id, balance_after, gpu_seconds, created_at) ` +
      `select '${randomUUID()}', '${orgId}', ${cents}, '${type}', ${description === null ? "null" : `'${description.replace(/'/g, "''")}'`}, ${reference ? `'${reference}'` : "null"}, balance_cents, ${gpuSeconds === null ? "null" : gpuSeconds}, ${at} from moved`,
  );
}

const chain = new web3.Connection(RPC, "confirmed");
const mintAuthority = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${KEYS_DIR}/mint-authority.json`, "utf8"))));
const masterKey = fs.readFileSync(`${KEYS_DIR}/master.key`, "utf8").trim();
const depositAddressOf = (orgId) =>
  web3.Keypair.fromSeed(new Uint8Array(hkdfSync("sha512", Buffer.from(masterKey, "utf8"), Buffer.from("wheelsai-topup-v1"), Buffer.from(orgId), 32))).publicKey;
async function confirm(signature) {
  const latest = await chain.getLatestBlockhash("confirmed");
  await chain.confirmTransaction({ signature, ...latest }, "confirmed");
}
async function depositUsdc(to, usdc) {
  const sender = web3.Keypair.generate();
  await confirm(await chain.requestAirdrop(sender.publicKey, web3.LAMPORTS_PER_SOL));
  if ((await chain.getBalance(mintAuthority.publicKey)) < 0.05 * web3.LAMPORTS_PER_SOL) await confirm(await chain.requestAirdrop(mintAuthority.publicKey, web3.LAMPORTS_PER_SOL));
  const from = spl.getAssociatedTokenAddressSync(USDC_MINT, sender.publicKey);
  const dest = spl.getAssociatedTokenAddressSync(USDC_MINT, to, true);
  const raw = BigInt(Math.round(usdc * 1_000_000));
  const tx = new web3.Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(sender.publicKey, from, sender.publicKey, USDC_MINT),
    spl.createMintToInstruction(USDC_MINT, from, mintAuthority.publicKey, raw),
    spl.createAssociatedTokenAccountIdempotentInstruction(sender.publicKey, dest, to, USDC_MINT),
    spl.createTransferCheckedInstruction(from, USDC_MINT, dest, sender.publicKey, raw, 6),
  );
  return web3.sendAndConfirmTransaction(chain, tx, [sender, mintAuthority], { commitment: "confirmed" });
}

async function main() {
  if (!(await chain.getVersion().catch(() => null))) throw new Error("the local chain is not running");

  const a = await account("a");
  const b = await account("b");
  let r = await a.client.call("GET", "/api/billing/balance");
  check("a new organization holds nothing and has nothing held",
    r.status === 200 && r.body.balance?.available === 0 && r.body.balance?.held === 0 && r.body.balance?.total === 0 && r.body.balance?.pending === 0,
    `${r.status} ${short(r.body)}`);

  // ---- Real credits: 100 USDC sent to the address is $100.00 and a $15.00 bonus
  await a.client.call("POST", "/api/billing/deposit-address");
  const signature = await depositUsdc(depositAddressOf(a.orgId), 100);
  for (let i = 0; i < 90 && sql(`select count(*) from onchain_receipts where tx_signature='${signature}' and status='credited'`) === "0"; i++) await sleep(1000);
  r = await a.client.call("GET", "/api/billing/transactions");
  const first = r.body.transactions || [];
  const bought = first.find((t) => t.type === "purchase") || {};
  const bonus = first.find((t) => t.type === "bonus") || {};
  check("a deposit shows as two rows, each called what it is, with the balance after it",
    r.status === 200 && first.length === 2 && bought.label === "Credits added" && bought.kind === "added" && bought.amount === 100 && bonus.label === "Bonus credits" && bonus.amount === 15 && [bought.balanceAfter, bonus.balanceAfter].sort((x, y) => x - y).join() === "100,115" && r.body.nextCursor === null,
    `${r.status} ${short(first, 400)} next=${r.body.nextCursor}`);

  // ---- The rest of the month, written as the product leaves it
  const dep = randomUUID();
  ledger(a.orgId, "deployment_reservation", -1000, "GPU deployment reservation (4090 x1, 1h)", { reference: dep });
  ledger(a.orgId, "gpu_usage", -60, "GPU usage (4090 x1, 1800s)", { gpuSeconds: 1800, reference: dep });
  ledger(a.orgId, "gpu_usage", -120, "GPU usage (4090 x2, 1800s)", { gpuSeconds: 3600, reference: dep });
  ledger(a.orgId, "deployment_reservation_release", 1000, "GPU deployment reservation released (user_stopped)", { reference: dep });
  ledger(a.orgId, "training_usage", -250, "Fine-tuning usage (4090, 5400s)", { gpuSeconds: 5400 });
  ledger(a.orgId, "marketplace_usage", -300, "Paid use: Support helper");
  ledger(a.orgId, "marketplace_refund", 100, "Paid use refunded: Support helper");
  ledger(a.orgId, "marketplace_subscription", -500, "Subscription: Research desk");
  ledger(a.orgId, "usage", -40, "=cmd()"); // a description a spreadsheet would run
  ledger(a.orgId, "usage_release", 15, "Inference: demo (unused hold released)");
  // Last month's spending is not this month's.
  ledger(a.orgId, "gpu_usage", -900, "GPU usage (4090 x1, 7200s)", { gpuSeconds: 7200, at: "date_trunc('month', now() at time zone 'utc') at time zone 'utc' - interval '1 second'" });
  // A job paid into escrow: held, not spent.
  const revenue = randomUUID();
  ledger(a.orgId, "marketplace_job", -700, "Job escrow: Logo in three sizes", { reference: revenue });
  sql(`insert into marketplace_revenue (id, buyer_id, publisher_id, type, gross_amount_cents, platform_fee_cents, creator_amount_cents, status) values ('${revenue}', '${a.orgId}', '${b.orgId}', 'job', 700, 70, 630, 'pending')`);
  // Somebody else's rows, which must never show.
  ledger(b.orgId, "purchase", 5000, "Credits of another organization");
  ledger(b.orgId, "gpu_usage", -333, "GPU usage (4090 x1, 99s)", { gpuSeconds: 99 });

  const expectBalance = (11500 - 1000 - 60 - 120 + 1000 - 250 - 300 + 100 - 500 - 40 + 15 - 900 - 700) / 100;
  r = await a.client.call("GET", "/api/billing/balance");
  check("the balance says what is available, what is held, and both together",
    r.status === 200 && near(r.body.balance.available, expectBalance) && near(r.body.balance.held, 7) && near(r.body.balance.total, expectBalance + 7) && near(r.body.balance.pending, 7),
    `${short(r.body)} want available ${expectBalance}`);

  r = await a.client.call("GET", "/api/billing/holds");
  const holds = r.body.holds || [];
  check("what is held is named, with why, and only this organization's",
    r.status === 200 && holds.length === 1 && holds[0].kind === "job" && near(holds[0].amount, 7) && holds[0].note === "Held until you accept the work, or the job is refunded." && near(r.body.total, 7) && typeof holds[0].since === "string",
    `${r.status} ${short(r.body, 400)}`);

  r = await a.client.call("GET", "/api/billing/usage");
  const usage = r.body.usage || {};
  const spend = Object.fromEntries((usage.spend || []).map((s) => [s.group, s]));
  const month = new Date().toISOString().slice(0, 7);
  check("this month's spending is the ledger's own rows, by kind, with nothing invented",
    r.status === 200 && usage.month === month && near(spend.gpu?.amount, 1.8) && spend.gpu?.label === "GPU time" && near(spend.inference?.amount, 0.25) && near(spend.fine_tuning?.amount, 2.5) && near(spend.paid_use?.amount, 2) && near(spend.subscriptions?.amount, 5) && near(spend.jobs?.amount, 0) && near(spend.try_it?.amount, 0) && near(usage.currentMonth, 11.55) && (usage.spend || []).length === 7,
    `${r.status} ${short(usage, 520)}`);
  check("GPU hours are the measured seconds of this month: 3 hours", near(usage.gpuHours, (1800 + 3600 + 5400) / 3600), `gpuHours=${usage.gpuHours}`);
  check("the invented fields are gone, and the counts other pages read are still there",
    !("computeCost" in usage) && !("requestsCost" in usage) && !("tokensCost" in usage) && !("avgCostPerHour" in usage) && typeof usage.requests === "number" && typeof usage.inputTokens === "number",
    Object.keys(usage).join(","));

  // ---- The job is accepted: no longer held, now spent
  sql(`update marketplace_revenue set status='settled', settled_at=now() where id='${revenue}'`);
  r = await a.client.call("GET", "/api/billing/holds");
  const afterHolds = r.body;
  r = await a.client.call("GET", "/api/billing/usage");
  const jobs = (r.body.usage?.spend || []).find((s) => s.group === "jobs") || {};
  check("once the work is accepted the job is no longer held and counts as spent",
    (afterHolds.holds || []).length === 0 && near(afterHolds.total, 0) && near(jobs.amount, 7) && near(r.body.usage.currentMonth, 18.55),
    `holds=${short(afterHolds)} jobs=${short(jobs)} month=${r.body.usage?.currentMonth}`);

  // ---- The list: pages, order, filters
  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    r = await a.client.call("GET", `/api/billing/transactions?limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    all.push(...(r.body.transactions || []));
    cursor = r.body.nextCursor;
    pages += 1;
  } while (cursor && pages < 10);
  const ids = new Set(all.map((t) => t.id));
  const ordered = all.every((t, i) => i === 0 || new Date(all[i - 1].createdAt) >= new Date(t.createdAt));
  check("paging by four reads every row once, newest first", all.length === 14 && ids.size === 14 && pages === 4 && ordered, `rows=${all.length} distinct=${ids.size} pages=${pages} ordered=${ordered}`);
  const reservation = all.find((t) => t.type === "deployment_reservation") || {};
  const gpu = all.find((t) => t.type === "gpu_usage") || {};
  check("each row carries its label, its kind and its own sign",
    reservation.label === "Held for a deployment" && reservation.kind === "held" && reservation.amount === -10 && gpu.label === "GPU time" && gpu.kind === "spent" && gpu.amount < 0 && all.every((t) => typeof t.balanceAfter === "number" && typeof t.label === "string" && t.label.length > 2),
    `${short(reservation)} ${short(gpu)}`);
  r = await a.client.call("GET", "/api/billing/transactions?filter=added");
  const added = (r.body.transactions || []).map((t) => t.type).sort().join();
  r = await a.client.call("GET", "/api/billing/transactions?filter=held");
  const held = (r.body.transactions || []).map((t) => t.type).sort().join();
  r = await a.client.call("GET", "/api/billing/transactions?filter=spent");
  const spentTypes = new Set((r.body.transactions || []).map((t) => t.kind));
  check("the three filters answer credits added, holds, and spending",
    added === "bonus,purchase" && held === "deployment_reservation,deployment_reservation_release,marketplace_job" && [...spentTypes].every((k) => k === "spent" || k === "returned") && (r.body.transactions || []).length === 9,
    `added=${added} held=${held} spent kinds=${[...spentTypes]} n=${(r.body.transactions || []).length}`);
  r = await a.client.call("GET", "/api/billing/transactions?filter=everything");
  check("a filter that does not exist is refused in a sentence", r.status === 400 && r.body.error === "invalid_request" && r.body.message === "That list could not be read. Reload the page and try again.", `${r.status} ${short(r.body)}`);

  // ---- The file
  r = await a.client.call("GET", "/api/billing/transactions/export");
  const lines = r.text.trim().split(/\r?\n/);
  const disposition = r.headers.get("content-disposition") || "";
  check("Export answers a file of this month's rows, oldest first, named for its range",
    r.status === 200 && /text\/csv/.test(r.headers.get("content-type") || "") && /attachment; filename="wheelsai-credits-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/.test(disposition) && lines[0] === "Date (UTC),Type,What,Description,Amount (USD),Balance after (USD)" && lines.length === 14 && lines.slice(1, 3).some((l) => /,purchase,Credits added,/.test(l)),
    `${r.status} ${disposition} rows=${lines.length} head=${lines[0]} first=${short(lines[1], 120)}`);
  const risky = lines.find((l) => l.includes("cmd()")) || "";
  const negative = lines.find((l) => l.includes(",gpu_usage,")) || "";
  check("a description a spreadsheet would run is made harmless, and a negative amount stays a number",
    risky.includes("'=cmd()") && /,-0\.6,|,-1\.2,/.test(negative) && !negative.includes("'-"),
    `${short(risky, 120)} | ${short(negative, 120)}`);
  r = await a.client.call("GET", "/api/billing/transactions/export?from=2026-13-40&to=2026-10-01");
  const bad = r;
  r = await a.client.call("GET", "/api/billing/transactions/export?from=2026-10-01");
  check("dates that cannot be read, or only one of the two, are refused in a sentence",
    bad.status === 400 && bad.body.error === "invalid_range" && bad.body.message === "Choose a start date and an end date, with the start first." && r.status === 400 && r.body.error === "invalid_range",
    `${bad.status} ${short(bad.body)} | ${r.status} ${short(r.body)}`);
  const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0));
  const day = (d) => d.toISOString().slice(0, 10);
  r = await a.client.call("GET", `/api/billing/transactions/export?from=${day(new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth(), 1)))}&to=${day(lastMonth)}`);
  check("a range of last month answers last month's one row", r.status === 200 && r.text.trim().split(/\r?\n/).length === 2 && r.text.includes("7200s"), `${r.status} rows=${r.text.trim().split(/\r?\n/).length}`);

  // ---- Another organization sees its own, and nothing of this one
  r = await b.client.call("GET", "/api/billing/transactions");
  const theirs = r.body.transactions || [];
  const theirUsage = (await b.client.call("GET", "/api/billing/usage")).body.usage || {};
  const theirHolds = (await b.client.call("GET", "/api/billing/holds")).body;
  const theirFile = (await b.client.call("GET", "/api/billing/transactions/export")).text;
  check("another organization sees only its own rows, spending, holds and file",
    theirs.length === 2 && theirs.every((t) => !ids.has(t.id)) && near((theirUsage.spend || []).find((s) => s.group === "gpu")?.amount, 3.33) && near(theirUsage.gpuHours, 99 / 3600) && (theirHolds.holds || []).length === 0 && theirFile.trim().split(/\r?\n/).length === 3 && !theirFile.includes("Logo in three sizes"),
    `rows=${theirs.length} gpu=${(theirUsage.spend || []).find((s) => s.group === "gpu")?.amount} holds=${(theirHolds.holds || []).length} file rows=${theirFile.trim().split(/\r?\n/).length}`);

  check("the ledger still adds up to the balance for both",
    [a.orgId, b.orgId].every((o) => sql(`select (select coalesce(sum(amount_cents),0) from credit_transactions where org_id='${o}') = (select balance_cents from credit_balances where org_id='${o}')`) === "t"));
  const raw = seenAnswers.filter((x) => /prisma|P20\d\d|ECONN|stack|at \w+ \(/i.test(x.text));
  check("no answer carried the database's own words", raw.length === 0, raw.length ? short(raw[0], 240) : `${seenAnswers.length} answers read`);

  console.log(`\nset up for the browser test: ${a.email}`);
  const passed = results.filter(Boolean).length;
  console.log(`${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("WALK STOPPED:", err && err.stack ? err.stack : err);
  process.exit(2);
});
