// The Billing page's real numbers, driven in a browser.
//
// Run walk-billing.cjs first: this test signs in as the organization that walk
// left behind (a deposit, a month of ledger rows, last month's row), adds a
// job still held in escrow and enough small rows for the list to need
// "Load more", then reads the page and compares it with what the API says.
//
//   1. the four tiles are the API's figures
//   2. "What is held" names the hold and says why
//   3. "Spending this month" lists the kinds that are not zero, and their total
//   4. a row is drawn by its own sign, with its label and the balance after
//   5. the filter and "Load more"
//   6. Export downloads the month as a file
//   7. the page fits a phone
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
//   node apps/api/scripts/payments-proof/walk-billing.cjs
//   node apps/api/scripts/payments-proof/browser-billing.cjs <outDir>
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { sql, launchBrowser } = require("./lib.cjs");

const WEB = process.env.WALK_WEB ?? process.env.WEB ?? "http://localhost:3100";
const API = process.env.WALK_API ?? process.env.API ?? "http://localhost:4000";
const PASSWORD = "Walk-pay7-2026";

function ledger(orgId, type, cents, description, { gpuSeconds = null, reference = null } = {}) {
  sql(
    `with moved as (update credit_balances set balance_cents = balance_cents + (${cents}) where org_id='${orgId}' returning balance_cents) ` +
      `insert into credit_transactions (id, org_id, amount_cents, type, description, reference_id, balance_after, gpu_seconds) ` +
      `select '${randomUUID()}', '${orgId}', ${cents}, '${type}', '${description}', ${reference ? `'${reference}'` : "null"}, balance_cents, ${gpuSeconds === null ? "null" : gpuSeconds} from moved`,
  );
}
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
    try { return { status: res.status, body: text ? JSON.parse(text) : {} }; } catch { return { status: res.status, body: { raw: text } }; }
  };
}
const usd = (n) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

(async () => {
  const outDir = process.argv[2];
  if (!outDir) {
    console.log("usage: node browser-billing.cjs <outDir>");
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push(!!ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `   [${detail}]` : ""}`);
  };

  const row = sql("select u.email, m.org_id from users u join org_members m on m.user_id=u.id where u.email like 'walk-pay7-a-%' order by u.created_at desc limit 1");
  if (!row) throw new Error("run walk-billing.cjs first");
  const [email, orgId] = row.split("|");
  // A job still in escrow, and enough rows that the first page is not the whole list.
  const revenue = randomUUID();
  if (sql(`select count(*) from marketplace_revenue where buyer_id='${orgId}' and status='pending' and type='job'`) === "0") {
    ledger(orgId, "marketplace_job", -300, "Job escrow: Translate the handbook", { reference: revenue });
    sql(`insert into marketplace_revenue (id, buyer_id, publisher_id, type, gross_amount_cents, platform_fee_cents, creator_amount_cents, status) values ('${revenue}', '${orgId}', '${orgId}', 'job', 300, 30, 270, 'pending')`);
  }
  const have = Number(sql(`select count(*) from credit_transactions where org_id='${orgId}'`));
  for (let i = have; i < 62; i++) ledger(orgId, "gpu_usage", -1, "GPU usage (4090 x1, 60s)", { gpuSeconds: 60 });

  const call = client();
  await call("POST", "/api/auth/login", { email, password: PASSWORD });
  const balance = (await call("GET", "/api/billing/balance")).body.balance;
  const usage = (await call("GET", "/api/billing/usage")).body.usage;
  const holds = (await call("GET", "/api/billing/holds")).body.holds;
  console.log(`set up: ${email}; the API says available ${balance.available}, held ${balance.held}, spent ${usage.currentMonth}, gpuHours ${usage.gpuHours}`);

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 }, acceptDownloads: true });
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

  try {
    await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([page.waitForURL(/\/dashboard/, { timeout: 30000 }), page.click('button[type="submit"]')]);
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle" });
    await waitFor("Transaction History");
    await waitFor("Balance after");
    const text = await bodyText();

    // ---- 1. The tiles
    check("the four tiles are the API's figures",
      text.includes(`Available Credits ${usd(balance.available)}`) && text.includes(`Spent This Month ${usd(usage.currentMonth)}`) && text.includes(`Held ${usd(balance.held)}`) && text.includes(`GPU Hours This Month ${usage.gpuHours.toFixed(1)}h`),
      text.slice(text.indexOf("Available Credits"), text.indexOf("Available Credits") + 190));

    // ---- 2. What is held
    const hold = holds[0];
    check("what is held is named, with why and how much",
      holds.length === 1 && text.includes("What is held") && text.includes(hold.note) && text.includes(usd(hold.amount)),
      text.slice(text.indexOf("What is held"), text.indexOf("What is held") + 200));

    // ---- 3. Spending this month
    const spendText = text.slice(text.indexOf("Spending this month"), text.indexOf("Transaction History"));
    const shown = usage.spend.filter((s) => Math.round(s.amount * 100) !== 0);
    const hidden = usage.spend.filter((s) => Math.round(s.amount * 100) === 0);
    check("the spending card lists every kind that is not zero with the API's label and amount, and their total",
      shown.length >= 5 && shown.every((s) => spendText.includes(s.label) && spendText.includes(usd(s.amount))) && hidden.every((s) => !spendText.includes(s.label)) && spendText.includes(usd(usage.currentMonth)),
      spendText.slice(0, 330));
    check("no invented split is left on the page", !/Inference Requests|Token Usage|per GPU hour/i.test(text));
    await shot("1-billing");

    // ---- 4. Rows by their own sign
    const history = text.slice(text.indexOf("Transaction History"));
    check("a row is drawn by its own sign, with its label and the balance after",
      history.includes("GPU time") && /-\$0\.01/.test(history) && history.includes("Balance after") && !history.includes("-$0.00") && !/\+\$0\.00/.test(history),
      history.slice(0, 260));

    // ---- 5. The filter and Load more
    const rowsShown = () => page.locator("text=Balance after").count();
    const firstPage = await rowsShown();
    await page.getByRole("button", { name: "Load more" }).click();
    let afterMore = firstPage;
    for (let i = 0; i < 40 && afterMore === firstPage; i++) {
      await page.waitForTimeout(250);
      afterMore = await rowsShown();
    }
    const total = Number(sql(`select count(*) from credit_transactions where org_id='${orgId}'`));
    check("Load more adds the next page and then goes away", firstPage === 50 && afterMore === total && (await page.getByRole("button", { name: "Load more" }).count()) === 0, `first=${firstPage} after=${afterMore} total=${total}`);

    await page.getByRole("radiogroup", { name: "Show" }).getByText("Credits added", { exact: true }).click();
    await page.waitForTimeout(1500);
    const addedText = (await bodyText()).slice((await bodyText()).indexOf("Transaction History"));
    check("the filter shows only credits added", addedText.includes("+$100.00") && addedText.includes("Bonus credits") && !addedText.includes("GPU time") && (await rowsShown()) === 2, addedText.slice(0, 230));
    await page.getByRole("radiogroup", { name: "Show" }).getByText("Holds", { exact: true }).click();
    await page.waitForTimeout(1500);
    const heldText = (await bodyText()).slice((await bodyText()).indexOf("Transaction History"));
    check("and only holds", heldText.includes("Held for a deployment") && heldText.includes("Deployment hold released") && heldText.includes("Held for a job") && !heldText.includes("GPU time"), heldText.slice(0, 260));
    await page.getByRole("radiogroup", { name: "Show" }).getByText("All", { exact: true }).click();
    await page.waitForTimeout(800);
    await shot("2-history");

    // ---- 6. Export
    await page.getByRole("button", { name: "Export" }).click();
    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.getByText("This month", { exact: true }).click()]);
    const file = `${outDir}/${download.suggestedFilename()}`;
    await download.saveAs(file);
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    const thisMonth = Number(sql(`select count(*) from credit_transactions where org_id='${orgId}' and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`));
    check("Export downloads this month's rows as a file named for its range",
      /^wheelsai-credits-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()) && lines[0] === "Date (UTC),Type,What,Description,Amount (USD),Balance after (USD)" && lines.length === thisMonth + 1,
      `${download.suggestedFilename()} rows=${lines.length - 1} want=${thisMonth}`);

    // ---- 7. Phone width
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${WEB}/dashboard/billing`, { waitUntil: "networkidle" });
    await waitFor("Balance after");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check("the page fits a phone with no sideways scroll", overflow <= 1, `overflow ${overflow}px`);
    await shot("3-phone");
  } catch (err) {
    console.error("test crashed:", err && err.stack ? err.stack : err);
    await shot("crash").catch(() => {});
    results.push(false);
  } finally {
    await browser.close();
  }
  console.log(`\nrefused API calls: ${refused.length ? refused.join(" | ") : "none"}`);
  check("no API call was refused", refused.length === 0, refused.join(" | "));
  console.log(`page problems: ${problems.length ? problems.slice(0, 6).join(" | ") : "none"}`);
  console.log(`${results.filter(Boolean).length} of ${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
