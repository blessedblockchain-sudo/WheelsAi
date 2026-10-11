// A deposit address, driven through the Billing page in a browser.
//
// start-api.sh gives the API what this test expects: deposits on and the scan
// every 3 seconds; see walk-deposits.cjs. Transfers are sent from this script
// the way an exchange sends them: straight to the address, with no wallet in
// the browser.
//
//   1. the panel offers one button before an address exists
//   2. pressing it shows the organization's address, where to send and what is credited
//   3. Prepare address is offered while the address cannot receive USDC, and a
//      refusal is the API's sentence
//   4. 12 USDC sent from outside is credited, and the page shows it after Check now
//   5. Copy puts the address on the clipboard
//   6. the panel fits a phone with no sideways scroll
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
//   node apps/api/scripts/payments-proof/browser-deposits.cjs <outDir>
const { hkdfSync } = require("node:crypto");
const fs = require("node:fs");
const { KEYS_DIR, req, sql, sleep, launchBrowser } = require("./lib.cjs");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");

const WEB = process.env.WALK_WEB ?? process.env.WEB ?? "http://localhost:3100";
const API = process.env.WALK_API ?? process.env.API ?? "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-pay5-2026";

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
  const email = `e2e-pay5-${label}-${STAMP}@example.test`;
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
const depositAddressOf = (orgId) =>
  web3.Keypair.fromSeed(new Uint8Array(hkdfSync("sha512", Buffer.from(masterKey, "utf8"), Buffer.from("wheelsai-topup-v1"), Buffer.from(orgId), 32))).publicKey;

async function airdrop(to, sol) {
  const sig = await chain.requestAirdrop(to, Math.round(sol * web3.LAMPORTS_PER_SOL));
  await chain.confirmTransaction({ signature: sig, ...(await chain.getLatestBlockhash("confirmed")) }, "confirmed");
}
/** 12 USDC from a plain wallet, opening the account at the address the way a wallet does. */
async function sendUsdc(to, usdc) {
  const sender = web3.Keypair.generate();
  await airdrop(sender.publicKey, 1);
  if ((await chain.getBalance(mintAuthority.publicKey)) < 0.05 * web3.LAMPORTS_PER_SOL) await airdrop(mintAuthority.publicKey, 1);
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

(async () => {
  const outDir = process.argv[2];
  if (!outDir) {
    console.log("usage: node browser-deposits.cjs <outDir>");
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
  };

  const buyer = await account("buyer");
  const address = depositAddressOf(buyer.orgId).toBase58();
  console.log(`set up: ${buyer.email}, address ${address}`);

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1400 }, permissions: ["clipboard-read", "clipboard-write"] });
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
  const panel = () => page.locator('section[aria-labelledby="deposit-address-title"]');
  const panelText = async () => (await panel().innerText()).replace(/\s+/g, " ");
  const waitFor = async (text, timeoutMs = 30000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if ((await panelText().catch(() => "")).includes(text)) return true;
      await page.waitForTimeout(300);
    }
    return false;
  };

  try {
    await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', buyer.email);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 30000 }), page.click('button[type="submit"]')]);

    // ---- 1. Before an address exists
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle" });
    await panel().waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Show my deposit address" }).waitFor({ timeout: 15000 });
    const before = await panelText();
    check("the Billing page has the panel, with one button and no address yet",
      before.includes("Send from an exchange or another wallet") && before.includes("Show my deposit address") && !before.includes("Check now") && sql(`select count(*) from deposit_addresses where org_id='${buyer.orgId}'`) === "0",
      before.slice(0, 160));
    await shot("1-before");

    // ---- 2. The address
    await page.getByRole("button", { name: "Show my deposit address" }).click();
    const shown = await waitFor(address, 15000);
    const after = await panelText();
    check("pressing it shows the organization's own address in full", shown && (await panel().locator("code").first().innerText()).trim() === address, after.slice(0, 200));
    check("it says where to send, how it is credited, and what cannot be recovered",
      after.includes("Send USDC or SOL on Solana to this address. It belongs to your organization only.") &&
        after.includes("USDC is credited one dollar for one USDC. SOL is credited at its dollar value when we see your transfer, usually within a few minutes.") &&
        after.includes("Send on the Solana network only. A transfer on another network cannot be recovered.") &&
        after.includes("Only USDC and SOL are credited."),
      after.slice(0, 420));
    await shot("2-address");

    // ---- 3. Prepare address: offered, and refused in the API's sentence for a new account
    const hint = after.includes("If your exchange says this address cannot receive USDC yet, press Prepare address.");
    await page.getByRole("button", { name: "Prepare address" }).click();
    const refusal = await waitFor("Verify your email or make one purchase first, then prepare the address.", 15000);
    check("Prepare address is offered, and a new account is told what to do first", hint && refusal, (await panelText()).slice(0, 300));
    await shot("3-prepare-refused");

    // ---- 4. A transfer from outside
    const balanceBefore = Number((await buyer.call("GET", "/api/billing/balance")).body?.balance?.available ?? NaN);
    const signature = await sendUsdc(new web3.PublicKey(address), 12);
    let credited = false;
    for (let i = 0; i < 90 && !credited; i++) {
      credited = sql(`select status from onchain_receipts where tx_signature='${signature}'`) === "credited";
      if (!credited) await sleep(1000);
    }
    await page.getByRole("button", { name: "Check now" }).click();
    const listed = await waitFor("Credited $12.00.", 20000);
    const balanceAfter = Number((await buyer.call("GET", "/api/billing/balance")).body?.balance?.available ?? NaN);
    const withDeposit = await panelText();
    check("12 USDC sent from outside is credited by the worker, and Check now shows it in Recent deposits",
      credited && listed && Math.abs(balanceAfter - balanceBefore - 12) < 0.005 && withDeposit.includes("Recent deposits"),
      `credited=${credited} balance+${(balanceAfter - balanceBefore).toFixed(2)} text=${withDeposit.slice(withDeposit.indexOf("Check now"), withDeposit.indexOf("Check now") + 220)}`);
    check("Check now says there is nothing new, in the API's sentence", withDeposit.includes("No new transfer yet. Transfers usually arrive within a few minutes."));
    let tile = "";
    for (let i = 0; i < 20 && !/Available Credits \$12\.00/.test(tile); i++) {
      tile = (await page.locator("body").innerText()).replace(/\s+/g, " ");
      if (!/Available Credits \$12\.00/.test(tile)) await page.waitForTimeout(500);
    }
    check("the balance on the page catches up without a reload", /Available Credits \$12\.00/.test(tile), tile.slice(tile.indexOf("Available Credits"), tile.indexOf("Available Credits") + 40));
    await shot("4-credited");
    await page.reload({ waitUntil: "networkidle" });
    await waitFor(address, 15000);
    const reloaded = await panelText();
    check("after a reload the address is still shown, and Prepare address is gone now that USDC can be received",
      reloaded.includes(address) && !reloaded.includes("press Prepare address") && reloaded.includes("Credited $12.00."),
      reloaded.slice(0, 200));

    // ---- 5. Copy
    await page.getByRole("button", { name: "Copy deposit address" }).click();
    const copiedLabel = await page.getByRole("button", { name: "Deposit address copied" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    check("Copy puts the address on the clipboard and says so", copiedLabel && clip === address, `label=${copiedLabel} clip=${clip.slice(0, 12)}...`);

    // ---- 6. Phone width
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle" });
    await waitFor(address, 15000);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const box = await panel().locator("code").first().boundingBox();
    check("the panel fits a phone: no sideways scroll, and the address wraps inside the screen", overflow <= 1 && box && box.x >= 0 && box.x + box.width <= 391, `overflow ${overflow}px address ${box && Math.round(box.x)}..${box && Math.round(box.x + box.width)}`);
    await panel().scrollIntoViewIfNeeded();
    await shot("5-phone");
  } catch (err) {
    console.error("test crashed:", err && err.stack ? err.stack : err);
    await shot("crash").catch(() => {});
    results.push(false);
  } finally {
    await browser.close();
  }
  const expected = refused.filter((r) => /^403 POST \/api\/billing\/deposit-address\/usdc-account/.test(r));
  const unexpected = refused.filter((r) => !expected.includes(r));
  console.log(`\nrefused API calls: ${refused.length ? refused.join(" | ") : "none"}`);
  check("the only refused call was the Prepare address the test expected", expected.length === 1 && unexpected.length === 0, unexpected.join(" | "));
  console.log(`page problems: ${problems.length ? problems.slice(0, 6).join(" | ") : "none"}`);
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
