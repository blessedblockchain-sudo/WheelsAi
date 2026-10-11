// Adding credits from a wallet, driven through the Billing page in a browser.
//
// No wallet extension: the test registers a wallet with the page through the
// wallet standard the app already supports. Its key stays in this process;
// the page only ever gets signatures back. start-api.sh gives the API what
// this test expects: wallet top-ups on and a stated SOL price of $110.
//
//   1. an email account, with no wallet, picks USDC, connects the wallet from
//      the list and pays $10: nothing asks the wallet to sign a message, one
//      transfer is signed, and the page says what was added
//   2. the same with SOL: the page says the price and how long it holds
//   3. the wallet declines: the page says so, in the product's words
//   4. a top-up still in flight when the page is opened is followed to its end
//   5. Settings links the wallet with one explicit button
//   6. the page at phone width has no sideways scroll
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
//   node apps/api/scripts/payments-proof/browser-pay-in.cjs <outDir>
const fs = require("node:fs");
const { KEYS_DIR, req, sql, sleep, launchBrowser } = require("./lib.cjs");
const web3 = req("@solana/web3.js");
const spl = req("@solana/spl-token");
const nacl = req("tweetnacl");

const WEB = process.env.WALK_WEB ?? process.env.WEB ?? "http://localhost:3100";
const API = process.env.WALK_API ?? process.env.API ?? "http://localhost:4000";
const RPC = "http://127.0.0.1:18899";
const USDC_MINT = new web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const STAMP = String(Math.floor(Date.now() / 1000));
const PASSWORD = "Walk-pay2-2026";

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
  const email = `e2e-pay2-${label}-${STAMP}@example.test`;
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
async function confirm(signature) {
  const latest = await chain.getLatestBlockhash("confirmed");
  await chain.confirmTransaction({ signature, ...latest }, "confirmed");
}
async function fundedWallet(sol, usdc) {
  const authority = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${KEYS_DIR}/mint-authority.json`, "utf8"))));
  const wallet = web3.Keypair.generate();
  await confirm(await chain.requestAirdrop(wallet.publicKey, Math.round(sol * web3.LAMPORTS_PER_SOL)));
  const ata = spl.getAssociatedTokenAddressSync(USDC_MINT, wallet.publicKey);
  const tx = new web3.Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, USDC_MINT),
    spl.createMintToInstruction(USDC_MINT, ata, authority.publicKey, BigInt(Math.round(usdc * 1_000_000))),
  );
  await web3.sendAndConfirmTransaction(chain, tx, [wallet, authority], { commitment: "confirmed" });
  return wallet;
}

/** Runs in the page before any of its own code: a wallet the app's wallet list will show. */
function registerWallet({ address, publicKeyBytes }) {
  const chains = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"];
  const enc = (u8) => btoa(String.fromCharCode(...u8));
  const dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const account = { address, publicKey: Uint8Array.from(publicKeyBytes), chains, features: ["solana:signTransaction", "solana:signMessage"], label: "E2E" };
  let connected = false;
  const listeners = new Set();
  window.__e2eCounts = { tx: 0, msg: 0, connect: 0 };
  const wallet = {
    version: "1.0.0",
    name: "E2E Wallet",
    icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjMjU2M2ViIi8+PC9zdmc+",
    chains,
    get accounts() { return connected ? [account] : []; },
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => { connected = true; window.__e2eCounts.connect++; listeners.forEach((l) => l({ accounts: [account] })); return { accounts: [account] }; } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { connected = false; listeners.forEach((l) => l({ accounts: [] })); } },
      "standard:events": { version: "1.0.0", on: (event, listener) => { if (event === "change") listeners.add(listener); return () => listeners.delete(listener); } },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => {
          const out = [];
          for (const input of inputs) {
            window.__e2eCounts.tx++;
            out.push({ signedTransaction: dec(await window.__e2eSignTransaction(enc(input.transaction))) });
          }
          return out;
        },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs) => {
          const out = [];
          for (const input of inputs) {
            window.__e2eCounts.msg++;
            out.push({ signedMessage: input.message, signature: dec(await window.__e2eSignMessage(enc(input.message))) });
          }
          return out;
        },
      },
    },
  };
  const register = (api) => api.register(wallet);
  class RegisterEvent extends Event {
    constructor() { super("wallet-standard:register-wallet", { bubbles: false, cancelable: false, composed: false }); }
    get detail() { return register; }
  }
  try { window.dispatchEvent(new RegisterEvent()); } catch { /* the app is not listening yet */ }
  window.addEventListener("wallet-standard:app-ready", (event) => register(event.detail));
}

(async () => {
  const outDir = process.argv[2];
  if (!outDir) {
    console.log("usage: node browser-pay-in.cjs <outDir>");
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
  };

  const user = await account("payer");
  const wallet = await fundedWallet(2, 100);
  const address = wallet.publicKey.toBase58();
  console.log(`set up: ${user.email}, wallet ${address}`);

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

  let decline = false;
  await page.exposeFunction("__e2eSignTransaction", async (b64) => {
    if (decline) throw new Error("User rejected the request.");
    const tx = web3.VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    tx.sign([wallet]);
    return Buffer.from(tx.serialize()).toString("base64");
  });
  await page.exposeFunction("__e2eSignMessage", async (b64) =>
    Buffer.from(nacl.sign.detached(Buffer.from(b64, "base64"), wallet.secretKey)).toString("base64"),
  );
  await page.addInitScript(registerWallet, { address, publicKeyBytes: [...wallet.publicKey.toBytes()] });

  const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  const bodyText = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const seen = [];
  const waitFor = async (text, timeoutMs = 30000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const now = await bodyText();
      seen.push(now);
      if (now.includes(text)) return true;
      await page.waitForTimeout(300);
    }
    return false;
  };
  const counts = () => page.evaluate(() => window.__e2eCounts);
  // Every line the page's status areas show, in order, so a line that is on
  // screen for a moment is still seen.
  const recordLines = () =>
    page.evaluate(() => {
      window.__e2eLines = [];
      const grab = () => {
        for (const el of document.querySelectorAll('[role="status"]')) {
          const text = el.innerText.replace(/\s+/g, " ").trim();
          if (text && window.__e2eLines[window.__e2eLines.length - 1] !== text) window.__e2eLines.push(text);
        }
      };
      new MutationObserver(grab).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  const lines = () => page.evaluate(() => window.__e2eLines || []);
  const waitForBalance = async (usd, timeoutMs = 60000) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (Math.abs((await balance()) - usd) < 0.005) return true;
      await page.waitForTimeout(500);
    }
    return false;
  };
  const payButton = (index) => page.getByRole("button", { name: "Pay with Wallet" }).nth(index);
  const balance = async () => Number((await user.call("GET", "/api/billing/balance")).body?.balance?.available ?? NaN);

  try {
    await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 30000 }), page.click('button[type="submit"]')]);

    // ---- 1. USDC, from an email account with no wallet
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle" });
    await waitFor("Add Credits");
    // The asset choice, not the history's filter, which is a group of its own on this page.
    const group = page.locator('[role="radiogroup"][aria-labelledby="pay-with-label"]');
    const assets = await group.locator("label").allInnerTexts();
    const usdcFirst = await group.getByRole("radio", { name: "USDC" }).isChecked();
    check("the page offers a choice of USDC or SOL, with USDC chosen", assets.join(",") === "USDC,SOL" && usdcFirst, `${assets.join(",")} usdc=${usdcFirst}`);
    await shot("1-billing-choice");

    await payButton(0).click();
    const listed = await page.getByRole("button", { name: /E2E Wallet/ }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    check("with no wallet connected, the wallet list opens and shows the wallet", listed);
    await shot("2-wallet-list");
    await page.getByRole("button", { name: /E2E Wallet/ }).first().click();
    const added = await waitFor("Added $10.00 in credits.", 60000);
    const c1 = await counts();
    check("once connected the payment carries on, and the page says what was added", added, (await bodyText()).match(/Added[^.]*\./)?.[0] ?? "");
    check("connecting asked the wallet to sign nothing but the one transfer", c1.msg === 0 && c1.tx === 1, JSON.stringify(c1));
    check("the account was credited $10.00", Math.abs((await balance()) - 10) < 0.005, String(await balance()));
    await shot("3-usdc-added");

    // ---- 2. SOL, at the stated price
    await recordLines();
    await group.locator("label", { hasText: "SOL" }).click();
    await payButton(0).click();
    const paid2 = await waitForBalance(20);
    await page.waitForTimeout(4000); // the page's next look at the top-up
    const shown = await lines();
    const saidPrice = shown.some((t) => t.includes("1 SOL = $110.00. This price holds for 60 seconds."));
    const saidAdded = (shown[shown.length - 1] || "").includes("Added $10.00 in credits.");
    check("paying with SOL says the price and how long it holds, then what was added", paid2 && saidPrice && saidAdded, `paid=${paid2} lines=${JSON.stringify(shown).slice(0, 320)}`);
    check("the account now holds $20.00", Math.abs((await balance()) - 20) < 0.005, String(await balance()));
    await shot("4-sol-added");

    // ---- 3. The wallet declines
    decline = true;
    await group.locator("label", { hasText: "USDC" }).click();
    await payButton(0).click();
    const declined = await waitFor("You cancelled the transfer in your wallet. Nothing was taken.", 30000);
    decline = false;
    check("a declined signature is said in the product's words, and nothing is credited", declined && Math.abs((await balance()) - 20) < 0.005, String(await balance()));
    await shot("5-declined");

    // ---- 4. A top-up in flight when the page opens
    const prepared = (await user.call("POST", "/api/billing/topups/prepare", { amountUsd: 5, asset: "USDC", payerAddress: address })).body;
    const legacy = web3.Transaction.from(Buffer.from(prepared.unsignedTxBase64, "base64"));
    legacy.sign(wallet);
    const signed = legacy.serialize().toString("base64");
    const lastValid = Number(sql(`select last_valid_block_height from wallet_topups where id='${prepared.topupId}'`));
    process.stdout.write(`      waiting for the transfer's blockhash to expire (height ${lastValid}) `);
    for (let i = 0; i < 100; i++) {
      if ((await chain.getBlockHeight("confirmed")) > lastValid + 2) break;
      process.stdout.write(".");
      await sleep(2000);
    }
    process.stdout.write("\n");
    const late = await user.call("POST", `/api/billing/topups/${prepared.topupId}/submit`, { signedTxBase64: signed });
    seen.length = 0;
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle" });
    const followed = await waitFor("The network did not take this transfer, so nothing was taken.", 120000);
    const sawWaiting = seen.some((t) => t.includes("We could not confirm that the network took this transfer") || t.includes("is being confirmed"));
    check("a top-up in flight when the page opens is followed to its end, in sentences",
      late.status === 202 && followed && sawWaiting,
      `submit ${late.status} waiting=${sawWaiting} ended=${followed}`);
    await shot("6-followed");

    // ---- 5. Settings links the wallet with one button
    await page.goto(`${WEB}/dashboard/settings`, { waitUntil: "networkidle" });
    await page.getByRole("tab", { name: /Wallet/ }).first().click().catch(async () => { await page.getByText("Wallets", { exact: true }).first().click(); });
    const offered = await waitFor("Link this wallet", 20000);
    const before = await counts();
    await shot("7-settings-before");
    await page.getByRole("button", { name: "Link this wallet" }).click();
    const linked = await waitFor("Wallet linked.", 20000);
    const after = await counts();
    const stored = sql(`select wallet_address from users where email='${user.email}'`);
    const badge = await waitFor("Linked", 8000);
    check("Settings offers one button to link the connected wallet, and nothing was signed before it was pressed", offered && before.msg === 0, JSON.stringify(before));
    check("pressing it links the wallet with one signed message", linked && badge && after.msg === 1 && stored === address, `linked=${linked} badge=${badge} ${JSON.stringify(after)} stored=${stored.slice(0, 8)}`);
    await shot("8-settings-linked");

    // ---- 6. The sidebar shows the wallet and reads no balance
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle" });
    await waitFor("Add Credits");
    const side = await page.locator("aside, nav").first().innerText().catch(() => "");
    const shortAddress = `${address.slice(0, 4)}...${address.slice(-4)}`;
    check("the sidebar shows the connected wallet's short address and no SOL balance", (await bodyText()).includes(shortAddress) && !/\d\.\d{4} SOL/.test(side), shortAddress);

    // ---- 7. Phone width
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle" });
    await waitFor("Add Credits");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("the billing page at phone width has no sideways scroll", overflow <= 1, `overflow ${overflow}px`);
    await shot("9-phone");

    const all = seen.join(" ");
    check("nothing the person read was a raw status word or had a long dash", !/Top-up (credited|failed|expired|submitted)\b|—/.test(all));
  } catch (err) {
    console.error("test crashed:", err && err.stack ? err.stack : err);
    await shot("crash").catch(() => {});
    results.push(false);
  } finally {
    await browser.close();
  }
  const unexpected = refused.filter((r) => !/^(401|404) /.test(r));
  console.log(`\nrefused API calls: ${refused.length ? refused.join(" | ") : "none"}`);
  console.log(`page problems: ${problems.length ? problems.slice(0, 6).join(" | ") : "none"}`);
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed${unexpected.length ? "" : ""}`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
