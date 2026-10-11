// Taking earnings out, driven through the Earnings page in a browser.
//
// start-api.sh gives the API what this test expects: payouts on and small
// limits ($20 a payout, $45 a day); see walk-pay-out.cjs. A throwaway creator
// is given $60.00 of earnings the way a sale leaves them (the balance and its
// ledger row together).
//
//   1. the request dialog offers credits, USDC and SOL, starts the amount at
//      the most allowed and says the minimum and the limits
//   2. a bad wallet address is refused in the API's sentence, beside the field
//   3. a payout to a wallet waits while the paying wallet is empty, says so,
//      and can be cancelled from the page
//   4. a payout as credits goes through and the page says what was requested
//   5. the page and the dialog at phone width have no sideways scroll
//
// What must be running:
//   - the local chain:  bash apps/api/scripts/payments-proof/local-chain.sh start
//   - the repository's Postgres and Redis (Docker)
//   - the API:          bash apps/api/scripts/payments-proof/start-api.sh
//   - the web app:      bash apps/api/scripts/payments-proof/start-web.sh   (its header says how to build it)
//
// The browser is the one playwright-core finds, or the one WHEELSAI_CHROME
// names. Screenshots are saved in <outDir>. WALK_WEB and WALK_API (or WEB and
// API) name other addresses. No real money and no real network.
//
//   node apps/api/scripts/payments-proof/browser-pay-out.cjs <outDir>
const { hkdfSync, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { KEYS_DIR, req, sql, sleep, launchBrowser } = require("./lib.cjs");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");

const WEB = process.env.WALK_WEB ?? process.env.WEB ?? "http://localhost:3100";
const API = process.env.WALK_API ?? process.env.API ?? "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-pay4-2026";

function client() {
  let cookie = "";
  return async function call(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(cookie && { cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
    return { status: res.status, body: json };
  };
}

async function account(label) {
  const call = client();
  const email = `e2e-pay4-${label}-${STAMP}@example.test`;
  let made = await call("POST", "/api/auth/register", { email, password: PASSWORD });
  if (made.status === 429) {
    await sleep(62000);
    made = await call("POST", "/api/auth/register", { email, password: PASSWORD });
  }
  if (![200, 201].includes(made.status)) throw new Error(`register ${label}: ${made.status} ${JSON.stringify(made.body)}`);
  const me = await call("GET", "/api/auth/me");
  return { call, email, orgId: me.body.organization.id };
}

const chain = new web3.Connection(RPC, "confirmed");
const mintAuthority = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${KEYS_DIR}/mint-authority.json`, "utf8"))));
const masterKey = fs.readFileSync(`${KEYS_DIR}/master.key`, "utf8").trim();
const payingWallet = web3.Keypair.fromSeed(new Uint8Array(hkdfSync("sha512", Buffer.from(masterKey, "utf8"), Buffer.from("wheelsai-payout-v1"), Buffer.from("platform-payout"), 32)));

/** The local chain's throwaway paying wallet, emptied of USDC so a wallet payout has to wait. */
async function emptyPayingWallet() {
  const from = spl.getAssociatedTokenAddressSync(USDC_MINT, payingWallet.publicKey);
  const held = await chain.getTokenAccountBalance(from).then((b) => Number(b.value.amount), () => 0);
  if (held === 0) return;
  const sink = web3.Keypair.generate().publicKey;
  const to = spl.getAssociatedTokenAddressSync(USDC_MINT, sink);
  const tx = new web3.Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(mintAuthority.publicKey, to, sink, USDC_MINT),
    spl.createTransferCheckedInstruction(from, USDC_MINT, to, payingWallet.publicKey, BigInt(held), 6),
  );
  tx.feePayer = mintAuthority.publicKey;
  await web3.sendAndConfirmTransaction(chain, tx, [mintAuthority, payingWallet], { commitment: "confirmed" });
}

(async () => {
  const outDir = process.argv[2];
  if (!outDir) {
    console.log("usage: node browser-pay-out.cjs <outDir>");
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
  };

  const creator = await account("creator");
  const agent = (await creator.call("POST", "/api/agents", { name: `E2E Payout Agent ${STAMP}`, description: "Says hello.", agentKind: "conversation", systemPrompt: "You say hello." })).body.agent;
  const listing = (await creator.call("POST", "/api/marketplace/listings", { agentId: agent.id, title: agent.name, shortDescription: "A listing made by the payout browser test, safe to ignore.", category: "other", pricingModel: "free", publish: true })).body.listing;
  sql(
    `with moved as (update publisher_profiles set pending_payout_cents = pending_payout_cents + 6000, total_revenue_cents = total_revenue_cents + 6000 where org_id='${creator.orgId}' returning pending_payout_cents) ` +
      `insert into earnings_transactions (id, org_id, amount_cents, type, description, reference_id, balance_after) select '${randomUUID()}', '${creator.orgId}', 6000, 'sale', 'Sale: set up by the payout browser test', 'e2e-${STAMP}', pending_payout_cents from moved`,
  );
  if ((await chain.getBalance(mintAuthority.publicKey)) < 0.5 * web3.LAMPORTS_PER_SOL) {
    const sig = await chain.requestAirdrop(mintAuthority.publicKey, 2 * web3.LAMPORTS_PER_SOL);
    await chain.confirmTransaction({ signature: sig, ...(await chain.getLatestBlockhash("confirmed")) }, "confirmed");
  }
  await emptyPayingWallet();
  const owed = () => Number(sql(`select pending_payout_cents from publisher_profiles where org_id='${creator.orgId}'`));
  console.log(`set up: ${creator.email}, owed $${(owed() / 100).toFixed(2)}`);

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  const problems = [];
  const refused = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text().slice(0, 200)}`); });
  page.on("pageerror", (e) => problems.push(`page error: ${String(e).slice(0, 200)}`));
  page.on("response", (r) => {
    const url = r.url();
    if (url.startsWith(API) && r.status() >= 400) refused.push(`${r.status()} ${r.request().method()} ${url.replace(API, "")}`);
  });
  const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  const bodyText = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const waitFor = async (text, timeoutMs = 30000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if ((await bodyText()).includes(text)) return true;
      await page.waitForTimeout(300);
    }
    return false;
  };
  const dialog = () => page.getByRole("dialog");
  const openDialog = async () => {
    await page.getByRole("button", { name: "Request Payout" }).first().click();
    await dialog().waitFor({ timeout: 10000 });
  };

  try {
    await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', creator.email);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 30000 }), page.click('button[type="submit"]')]);

    // ---- 1. The dialog
    await page.goto(`${WEB}/dashboard/marketplace/revenue`, { waitUntil: "networkidle" });
    await waitFor("Request Payout");
    await shot("1-earnings");
    await openDialog();
    const first = (await dialog().innerText()).replace(/\s+/g, " ");
    check("the dialog offers credits, USDC and SOL", ["Platform Credits", "USDC (Solana)", "SOL"].every((w) => first.includes(w)), first.slice(0, 220));
    await dialog().getByText("USDC (Solana)", { exact: true }).click();
    const amount = dialog().locator("#payout-amount");
    const startValue = await amount.inputValue();
    const usdcText = (await dialog().innerText()).replace(/\s+/g, " ");
    check("for a wallet the amount starts at the most one payout may be, and the minimum and limits are said",
      Number(startValue) === 20 && /\$5\.00/.test(usdcText) && /\$20\.00 a payout and \$45\.00 a day to a wallet/.test(usdcText),
      `amount=${startValue} text=${usdcText.slice(usdcText.indexOf("Amount"), usdcText.indexOf("Amount") + 230)}`);
    await shot("2-dialog-usdc");

    // ---- 2. A bad address
    await dialog().locator("#wallet-address").fill("not-an-address");
    await dialog().getByRole("button", { name: /^Request/ }).last().click();
    const refusedAddress = await waitFor("That is not a Solana wallet address. Check it and try again.", 10000);
    check("a bad wallet address is refused in the API's sentence, and nothing is reserved", refusedAddress && owed() === 6000, `owed=${owed()}`);
    await shot("3-bad-address");

    // ---- 3. A wallet payout that has to wait, and is cancelled
    const receiver = web3.Keypair.generate().publicKey.toBase58();
    await dialog().locator("#wallet-address").fill(receiver);
    await amount.fill("10");
    await dialog().getByRole("button", { name: /^Request/ }).last().click();
    const requested = await waitFor("Payout of $10.00 requested. It is usually sent within a few minutes.", 15000);
    check("a $10.00 payout in USDC is requested and the page says so", requested && owed() === 5000, `owed=${owed()}`);
    let waiting = false;
    for (let i = 0; i < 10 && !waiting; i++) {
      await page.waitForTimeout(3000);
      await page.reload({ waitUntil: "networkidle" });
      waiting = (await bodyText()).includes("This payout is waiting to be sent. You can cancel it and keep your earnings.");
    }
    check("with the paying wallet empty the page says the payout is waiting and can be cancelled", waiting);
    await shot("4-waiting");
    await page.getByRole("button", { name: "Cancel the $10.00 payout" }).first().click();
    await page.getByRole("button", { name: "Cancel payout" }).click();
    const cancelled = await waitFor("Payout cancelled. $10.00 is back in your earnings.", 15000);
    check("cancelling it from the page puts the $10.00 back", cancelled && owed() === 6000, `owed=${owed()}`);
    await shot("5-cancelled");

    // ---- 4. Credits
    await openDialog();
    await dialog().getByText("Platform Credits", { exact: true }).click();
    const creditsStart = await dialog().locator("#payout-amount").inputValue();
    await dialog().locator("#payout-amount").fill("41.20");
    await dialog().getByRole("button", { name: /^Request/ }).last().click();
    const asCredits = await waitFor("Payout of $41.20 requested as credits.", 15000);
    const amountCents = Number(sql(`select amount_cents from creator_payouts where publisher_id='${creator.orgId}' and payout_method='credits' order by requested_at desc limit 1`));
    check("credits start at everything owed, and $41.20 is requested as exactly 4120 cents", Number(creditsStart) === 60 && asCredits && amountCents === 4120 && owed() === 1880, `start=${creditsStart} cents=${amountCents} owed=${owed()}`);
    let done = false;
    for (let i = 0; i < 10 && !done; i++) {
      await page.waitForTimeout(2000);
      done = sql(`select status from creator_payouts where publisher_id='${creator.orgId}' and payout_method='credits' order by requested_at desc limit 1`) === "completed";
    }
    await page.reload({ waitUntil: "networkidle" });
    check("the worker completes it and the history shows it", done && (await bodyText()).includes("Completed"));
    await shot("6-credits");

    // ---- 5. Phone width
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/dashboard/marketplace/revenue`, { waitUntil: "networkidle" });
    await waitFor("Request Payout");
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await openDialog();
    await dialog().getByText("USDC (Solana)", { exact: true }).click();
    const box = await dialog().boundingBox();
    const dialogFits = box && box.x >= 0 && box.x + box.width <= 391;
    check("the Earnings page and the dialog fit a phone with no sideways scroll", pageOverflow <= 1 && dialogFits, `overflow ${pageOverflow}px dialog ${box && Math.round(box.x)}..${box && Math.round(box.x + box.width)}`);
    await shot("7-phone-dialog");
  } catch (err) {
    console.error("test crashed:", err && err.stack ? err.stack : err);
    await shot("crash").catch(() => {});
    results.push(false);
  } finally {
    await browser.close();
    if (listing && listing.id) await creator.call("POST", `/api/marketplace/listings/${listing.id}/archive`, {});
  }
  console.log(`\nrefused API calls: ${refused.length ? refused.join(" | ") : "none"}`);
  console.log(`page problems: ${problems.length ? problems.slice(0, 6).join(" | ") : "none"}`);
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
