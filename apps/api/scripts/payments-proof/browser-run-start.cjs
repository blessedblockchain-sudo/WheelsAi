// What a new person meets at the start of a run on a real network, checked in
// a browser before anyone brings a wallet: signing up on a database that
// holds nothing, then the Billing page. It moves no money, asks no wallet for
// anything and shows no deposit address.
//
//   1. a person can sign up on an empty database
//   2. the API offers what the run needs: paying from a wallet, USDC first,
//      a deposit address, no credits without a payment, the network named
//   3. the Billing page shows the four packs with "Pay with Wallet", the
//      choice of asset, "Show my deposit address", and no card button while
//      there is no card rail
//   4. SOL can be chosen where it is offered
//   5. the page fits a phone
//   6. no page error and no failed request to this machine on the way
//
// IT SIGNS UP AN ACCOUNT, so it is never pointed at the run's own database:
// a run starts on an empty one. Start the API for it on a database and a key
// of its own, check, stop it, and start the run's:
//
//   node apps/api/scripts/payments-proof/make-run-database.cjs wheelsai_check
//   RUN_DATABASE=wheelsai_check WALLET_MASTER_KEY="$(openssl rand -hex 32)" \
//     bash apps/api/scripts/payments-proof/start-api.sh --run devnet
//   bash apps/api/scripts/payments-proof/start-web.sh        # in another terminal
//   node apps/api/scripts/payments-proof/browser-run-start.cjs <outDir> [devnet|mainnet-beta]
//
// The browser is the one playwright-core finds, or the one WHEELSAI_CHROME
// names. Screenshots are saved in <outDir>. WALK_WEB and WALK_API (or WEB and
// API) name other addresses. A request to a host other than this machine (the
// pages ask a font host for a stylesheet) is listed and not counted.
const fs = require("node:fs");
const path = require("node:path");
const { launchBrowser } = require("./lib.cjs");

const WEB = process.env.WALK_WEB ?? process.env.WEB ?? "http://localhost:3100";
const API = process.env.WALK_API ?? process.env.API ?? "http://localhost:4000";
const PASSWORD = "Run-start-2026";

(async () => {
  const outDir = process.argv[2];
  const network = process.argv[3] ?? "devnet";
  if (!outDir || !["devnet", "mainnet-beta"].includes(network)) {
    console.log("usage: node browser-run-start.cjs <outDir> [devnet|mainnet-beta]");
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
  };

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const problems = [];
  const outside = new Set();
  page.on("console", (m) => {
    // A resource that did not load is named by the two listeners below.
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.push(`console: ${m.text().slice(0, 220)}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${String(e).slice(0, 220)}`));
  page.on("requestfailed", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") outside.add(u.origin);
    else problems.push(`request failed ${r.method()} ${u.pathname} (${r.failure()?.errorText ?? ""})`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`${r.status()} ${r.request().method()} ${r.url().replace(API, "api:").replace(WEB, "web:")}`);
  });

  try {
    // 1. Sign up, as a person would.
    await page.goto(`${WEB}/register`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.fill("#email", `run-start-${Date.now()}@example.com`);
    await page.fill("#password", PASSWORD);
    await page.fill("#confirmPassword", PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith("/register"), { timeout: 45_000 }).catch(() => {});
    const landed = new URL(page.url()).pathname;
    check("a person can sign up on an empty database", landed.startsWith("/dashboard"), landed);
    await page.screenshot({ path: path.join(outDir, "run-start-1-signed-up.png"), fullPage: true });

    // 2. What the API offers, read as the Billing page reads it.
    const offered = await page.evaluate(async (api) => {
      const res = await fetch(`${api}/api/billing/packages`, { credentials: "include" });
      return { status: res.status, body: await res.json().catch(() => null) };
    }, API);
    const rails = offered.body?.rails ?? {};
    const assets = Array.isArray(rails.walletAssets) ? rails.walletAssets : [];
    check(`the API is on ${network}`, rails.network === network, `status ${offered.status}, network ${rails.network}`);
    check("paying from a wallet is on, USDC first", rails.wallet === true && assets[0] === "USDC", assets.join(", "));
    check("a deposit address is on", rails.deposits === true);
    check("credits cannot be had without a payment", rails.mockCheckout === false);
    if (!assets.includes("SOL")) console.log("      SOL is not offered: no SOL price source is set on this API");

    // 3. The Billing page.
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.getByRole("button", { name: "Pay with Wallet" }).first().waitFor({ timeout: 30_000 }).catch(() => {});
    const payButtons = await page.getByRole("button", { name: "Pay with Wallet" }).count();
    check('each of the four packs shows "Pay with Wallet"', payButtons === 4, `${payButtons} buttons`);
    const text = await page.innerText("body");
    check("the $10 pack is there", /\$10\b/.test(text));
    const drawn = await page.$$eval('input[name="topup-asset"]', (els) => els.map((e) => e.value));
    // The choice is drawn only when there is one to make.
    const expected = assets.length > 1 ? assets : [];
    check("the choice of asset is the one the API offers", drawn.join(",") === expected.join(","), drawn.join(", ") || "no choice drawn");
    check('"Show my deposit address" is offered', text.includes("Show my deposit address"));
    if (rails.stripeCheckout !== true) {
      check("no card button is drawn while there is no card rail", (await page.getByRole("button", { name: "Purchase", exact: true }).count()) === 0);
    }
    await page.screenshot({ path: path.join(outDir, "run-start-2-billing.png"), fullPage: true });

    // 4. SOL, where it is offered.
    if (drawn.includes("SOL")) {
      await page.locator('label:has(input[name="topup-asset"][value="SOL"])').click();
      await page.waitForTimeout(1_000);
      const chosen = await page.$eval('input[name="topup-asset"]:checked', (e) => e.value);
      check("SOL can be chosen", chosen === "SOL" && (await page.getByRole("button", { name: "Pay with Wallet" }).count()) === 4, chosen);
    }

    // 5. A phone's width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("the page fits a phone", overflow <= 1, `overflow ${overflow}px`);
    await page.screenshot({ path: path.join(outDir, "run-start-3-billing-phone.png"), fullPage: true });

    // 6. Nothing went wrong on the way.
    check("no page error and no failed request to this machine", problems.length === 0, problems.slice(0, 8).join(" ; "));
    if (outside.size > 0) console.log(`      asked of other hosts and not answered in this browser: ${[...outside].join(", ")}`);
  } catch (err) {
    check("the check ran to its end", false, String(err).slice(0, 300));
    if (problems.length) console.log(`      seen on the way: ${problems.slice(0, 8).join(" ; ")}`);
    await page.screenshot({ path: path.join(outDir, "run-start-error.png"), fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed} of ${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})();
