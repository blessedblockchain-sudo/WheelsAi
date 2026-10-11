#!/usr/bin/env node
/*
 * Seeds a demo database: a small, coherent world to show the product in.
 *
 * Almost everything is made through the product itself (its API), so what the
 * screens show is what the product would have written: accounts, agents of
 * the three kinds, a knowledge base, public pages, listings that sell use,
 * buyers who start, pay and review. A few things have no screen and are
 * written to the database by hand, and each is said so below:
 *   - the names of the organizations (nothing renames one), verified emails,
 *     and the demo organization's two teammates
 *   - the demo credits each organization starts with (one ledger row,
 *     "Demo credits")
 *   - 29 days of past sales of one listing, so the Earnings page has a
 *     history. They are invented, in the shape the product writes a paid use
 *     in, and the balances are worked out again from the rows afterwards.
 *
 * NOTHING HERE IS LIVE INFRASTRUCTURE. No deployment, no GPU time and no
 * payment on a chain is seeded: whatever the demo shows as running, or as
 * paid on chain, was really started or paid by the person showing it.
 * The seeded sales are not traction and must not be shown as such.
 *
 * It needs an API running against the SAME database, with no workers
 * (workfiles' start-demo.sh seed-api, or any API given DATABASE_URL), and it
 * refuses a database that already holds an account.
 *
 *   node apps/api/scripts/demo-seed.cjs
 *
 * Settings: DEMO_DATABASE (wheelsai_demo; the name must start with
 * wheelsai_demo), DEMO_API (http://localhost:4030), DEMO_PASSWORD (the one
 * password of every seeded account; Northwind-demo-2026 unless set).
 */
const { spawnSync } = require("child_process");
const path = require("path");
const lib = require("./payments-proof/lib.cjs");
const { REPO, req, sleep } = lib;

const DB = process.env.DEMO_DATABASE || "wheelsai_demo";
const API = process.env.DEMO_API || "http://localhost:4030";
const PASSWORD = process.env.DEMO_PASSWORD || "Northwind-demo-2026";
if (!/^wheelsai_demo[a-z0-9_]*$/.test(DB)) {
  console.error("DEMO_DATABASE must be a demo database: its name starts with wheelsai_demo");
  process.exit(2);
}

const sql = (statement) => lib.sql(statement, DB);
const lit = (text) => `'${String(text).replace(/'/g, "''")}'`;
const say = (text) => console.log(text);
const short = (v, n = 300) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}...` : s;
};

class Client {
  constructor() {
    this.cookies = new Map();
  }
  async call(method, route, body) {
    const h = {};
    if (body !== undefined) h["content-type"] = "application/json";
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(API + route, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
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
    return { status: res.status, body: json };
  }
  /** A call that must succeed: the seed stops with the API's own answer otherwise. */
  async must(method, route, body, ok = [200, 201]) {
    const r = await this.call(method, route, body);
    if (!ok.includes(r.status)) throw new Error(`${method} ${route} answered ${r.status}: ${short(r.body, 500)}`);
    return r.body;
  }
}

// ---------------------------------------------------------------- the world

const HELP_CENTER = [
  {
    title: "Getting started with Northwind Cloud",
    content:
      "Northwind Cloud runs your web services close to your users. To deploy, connect a Git repository on the Projects page, pick a region and press Deploy. The first deploy takes about two minutes. Every push to the main branch deploys again; other branches get a preview address. A project is free while it uses less than 100 hours of compute a month. To add a teammate, open Settings, Team, and invite them by email: a member can deploy, an admin can also change billing.",
  },
  {
    title: "Billing and invoices",
    content:
      "Northwind Cloud bills at the start of each month for the month before. Compute is billed by the second and storage by the gigabyte per day. Invoices are on the Billing page and are emailed to the billing contact. A card that fails is tried again after 3 days and after 7 days; after 14 days unpaid, projects are paused, never deleted, and start again when the invoice is paid. To change the billing contact or add a tax number, open Billing, Details. Refunds for a service outage are credited to the next invoice automatically.",
  },
  {
    title: "Troubleshooting a failed deploy",
    content:
      "Most failed deploys are a build that ran out of memory or a start command that exits. Open the deploy and read the last lines of its log. 'Killed' with no error means the build needed more than 2 GB of memory: raise the build size under Project settings, Build. 'Port not bound' means the service did not listen on the port in the PORT variable within 60 seconds. A deploy stuck on 'Queued' for more than 5 minutes is our fault: check status.northwind.example and write to support.",
  },
  {
    title: "API rate limits",
    content:
      "The Northwind Cloud API allows 600 requests a minute for each API key and 10 deploys a minute for each project. A request over the limit is answered 429 with a Retry-After header in seconds. Reading logs and metrics has its own limit of 60 requests a minute. Limits are raised for Business plans on request: write to support with the key's name and the limit you need.",
  },
];

const ORGS = {
  northwind: { email: "demo@northwind.ai", person: "Jordan Lee", name: "Northwind AI Labs", credits: 40_000 },
  atlas: { email: "hello@atlas-agents.example", person: "Maya Ortiz", name: "Atlas Agents", credits: 15_000 },
  kestrel: { email: "team@kestrel-labs.example", person: "Devon Clarke", name: "Kestrel Labs", credits: 15_000 },
  fieldnote: { email: "ops@fieldnote-studio.example", person: "Lena Brandt", name: "Fieldnote Studio", credits: 12_000 },
  harbor: { email: "team@harbor-analytics.example", person: "Tomas Reyes", name: "Harbor Analytics", credits: 12_000 },
};
const TEAMMATES = [
  { email: "sam@northwind.ai", person: "Sam Okafor", role: "admin" },
  { email: "priya@northwind.ai", person: "Priya Raman", role: "member" },
];

/** How many past days of sales of the first listing are written by hand. */
const HISTORY_DAYS = 29;

// ---------------------------------------------------------------- helpers

async function signUp(key) {
  const o = ORGS[key];
  const client = new Client();
  let r = await client.call("POST", "/api/auth/register", { email: o.email, password: PASSWORD });
  if (r.status === 429) {
    say("   (sign-ups are limited to a few a minute: waiting one minute)");
    await sleep(62_000);
    r = await client.call("POST", "/api/auth/register", { email: o.email, password: PASSWORD });
  }
  if (r.status !== 200 && r.status !== 201) throw new Error(`sign-up of ${o.email} answered ${r.status}: ${short(r.body)}`);
  const orgId = r.body.organization.id;
  const userId = r.body.user.id;
  await client.must("PATCH", "/api/settings/profile", { displayName: o.person });
  // By hand: nothing in the product renames an organization, and a seeded person has no inbox to verify from.
  sql(`update organizations set name=${lit(o.name)} where id='${orgId}'`);
  sql(`update users set email_verified=true where id='${userId}'`);
  // By hand: the credits a demo organization starts with, as one ledger row dated before everything else.
  sql(
    `insert into credit_balances (org_id, balance_cents, updated_at) values ('${orgId}', ${o.credits}, now()) ` +
      `on conflict (org_id) do update set balance_cents = credit_balances.balance_cents + ${o.credits}, updated_at = now()`,
  );
  sql(
    `insert into credit_transactions (id, org_id, amount_cents, type, description, balance_after, created_at) ` +
      `values (gen_random_uuid(), '${orgId}', ${o.credits}, 'adjustment', 'Demo credits', ${o.credits}, now() - interval '${HISTORY_DAYS + 6} days')`,
  );
  Object.assign(o, { client, orgId, userId });
  return o;
}

async function agent(org, body) {
  const made = await org.client.must("POST", "/api/agents", body);
  // The answer does not repeat the description; a listing is made from it below.
  return { ...made.agent, description: body.description };
}
async function list(org, a, listing) {
  const made = await org.client.must("POST", "/api/marketplace/listings", {
    agentId: a.id,
    title: a.name,
    shortDescription: a.description,
    publish: true,
    ...listing,
  });
  return made.listing;
}
const say1 = (text) => ({ messages: [{ role: "user", content: text }], stream: false });

async function main() {
  // ---- before anything
  if ((await fetch(`${API}/health`).then((r) => r.status).catch(() => 0)) !== 200) {
    throw new Error(`no API answers at ${API}: start one against the database ${DB} first`);
  }
  if (sql("select count(*) from users") !== "0") {
    throw new Error(`the database ${DB} already holds an account: the seed starts from an empty one and adds nothing to a used one`);
  }

  say("1. People and organizations");
  const nw = await signUp("northwind");
  if (sql("select count(*) from users") !== "1") throw new Error(`the API at ${API} is not running against the database ${DB}`);
  const atlas = await signUp("atlas");
  const kestrel = await signUp("kestrel");
  const fieldnote = await signUp("fieldnote");
  const harbor = await signUp("harbor");
  // By hand: two teammates. The product adds one by an emailed invitation, and a seeded person has no inbox.
  const argon2 = req("argon2");
  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });
  for (const mate of TEAMMATES) {
    const id = sql(
      `insert into users (id, email, password_hash, display_name, email_verified, created_at, updated_at) ` +
        `values (gen_random_uuid(), ${lit(mate.email)}, ${lit(hash)}, ${lit(mate.person)}, true, now(), now()) returning id`,
    ).split("\n")[0];
    sql(`insert into org_members (org_id, user_id, role) values ('${nw.orgId}', '${id}', ${lit(mate.role)})`);
  }
  // The operator's own command: Pro by an operator's grant, as the product records it.
  const plan = spawnSync("npx", ["tsx", "scripts/set-plan.ts", nw.email, "pro"], {
    cwd: path.join(REPO, "apps/api"),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: lib.databaseUrl(DB) },
  });
  if (plan.status !== 0) throw new Error(`set-plan answered ${plan.status}: ${short(`${plan.stdout}${plan.stderr}`.replace(/:\/\/[^@\s]*@/g, "://...@"), 400)}`);
  say(`   ${Object.values(ORGS).map((o) => o.name).join(", ")}; ${nw.name} is on Pro with ${TEAMMATES.length} teammates`);

  say("2. A knowledge base, written and read through the product");
  const kb = await nw.client.must("POST", "/api/knowledge", { name: "Northwind Help Center", description: "Product docs, the billing FAQ and troubleshooting guides." });
  for (const doc of HELP_CENTER) await nw.client.must("POST", `/api/knowledge/${kb.id}/documents`, { title: doc.title, content: doc.content, sourceType: "text" });

  // No agent is given a framework label: a label does not change what runs an
  // agent, and a card that says "mastra" would say the agent runs on Mastra.
  say("3. Agents of the three kinds");
  const supportHelper = await agent(nw, {
    name: "Support Helper",
    description: "Answers questions about Northwind Cloud from the help center, and says when it does not know.",
    agentKind: "conversation",
    knowledgeBaseId: kb.id,
    tags: ["support"],
    systemPrompt:
      "You are Support Helper for Northwind Cloud, a platform that runs web services. Answer from the help center passages you are given, in a few plain sentences. If the passages do not answer the question, say you do not know and suggest writing to support. Never invent a limit, a price or a date.",
  });
  const researchAnalyst = await agent(nw, {
    name: "Research Analyst",
    description: "Turns a question into a short, structured research brief.",
    agentKind: "conversation",
    tags: ["research"],
    systemPrompt: "You are a research analyst. Answer with a two-sentence summary, then three to five findings as bullets, then the open questions. Say plainly what you are unsure of.",
  });
  const releaseNotes = await agent(nw, {
    name: "Release Notes Writer",
    description: "Drafts customer-facing release notes from a list of changes.",
    agentKind: "conversation",
    tags: ["writing"],
    systemPrompt: "You write crisp, customer-facing release notes. Group changes under New, Improved and Fixed. No marketing words.",
  });
  const topicSummarizer = await agent(nw, {
    name: "Topic Summarizer",
    description: "Give it a topic and it writes a summary for the audience you name.",
    agentKind: "task",
    tags: ["writing"],
    systemPrompt: "You write a clear summary of the topic you are given, at the length asked for, for the audience named. Plain words, no filler.",
    kindConfig: {
      task: {
        fields: [
          { key: "topic", label: "Topic", type: "short_text", required: true, help: "What should the summary be about?" },
          { key: "length", label: "Length", type: "choice", required: true, options: ["Short", "Detailed"] },
          { key: "audience", label: "Audience", type: "short_text", required: false },
        ],
      },
    },
  });
  const descriptionWriter = await agent(nw, {
    name: "Product Description Writer",
    description: "Writes a product description from a few facts about the item.",
    agentKind: "task",
    tags: ["writing", "e-commerce"],
    systemPrompt: "You write a product description of about 80 words from the facts you are given, in the tone asked for. Never state a fact you were not given.",
    kindConfig: {
      task: {
        fields: [
          { key: "item", label: "Item", type: "long_text", required: true, help: "What is it, and what should a buyer know?" },
          { key: "tone", label: "Tone", type: "choice", required: false, options: ["Friendly", "Luxury", "Playful"] },
        ],
      },
    },
  });
  const morningBriefing = await agent(nw, {
    name: "Morning Briefing",
    description: "Every morning, three things worth knowing about running AI agents in production.",
    agentKind: "scheduled",
    tags: ["briefing"],
    systemPrompt: "You write a short morning briefing for a team that runs AI agents in production: three numbered points, each one sentence, each practical.",
    kindConfig: { scheduled: { prompt: "Write today's briefing.", schedule: { cronExpression: "0 8 * * *", timezone: "UTC" } } },
  });
  const seoAuditor = await agent(atlas, {
    name: "SEO Auditor",
    description: "Reads a page's text and lists what holds it back in search, most important first.",
    agentKind: "conversation",
    tags: ["seo"],
    systemPrompt: "You are an SEO auditor. Given a page's text or address, list the problems that hold it back in search, most important first, each with one concrete fix.",
  });
  const contractReviewer = await agent(atlas, {
    name: "Contract Reviewer",
    description: "Flags risky clauses in a contract and suggests safer wording. Not legal advice.",
    agentKind: "conversation",
    tags: ["legal"],
    systemPrompt: "You review contract clauses for risk to the party who asks. Name the clause, say what the risk is in one sentence, and suggest safer wording. Say that this is not legal advice.",
  });
  const marketBrief = await agent(kestrel, {
    name: "Daily Market Brief",
    description: "A two-minute brief on what moved in AI infrastructure and why it matters.",
    agentKind: "conversation",
    tags: ["markets"],
    systemPrompt: "You write a brief on AI infrastructure for a busy reader: three short paragraphs. Say what you cannot know without live data.",
  });
  const codeReviewBot = await agent(kestrel, {
    name: "Code Review Bot",
    description: "Reviews a diff for bugs, security problems and unclear code.",
    agentKind: "conversation",
    tags: ["coding"],
    systemPrompt: "You review code. For the diff you are given, list bugs first, then security problems, then what is unclear, each with the line and a fix. If it is fine, say so in one line.",
  });

  say("4. Public pages, and what is on sale");
  for (const a of [supportHelper, topicSummarizer]) await nw.client.must("PUT", `/api/agents/${a.id}/public-link`, { state: "on" });
  const lSupport = await list(nw, supportHelper, { category: "customer-support", pricingModel: "per_request", pricePerRequestCents: 5 });
  const lResearch = await list(nw, researchAnalyst, { category: "research", pricingModel: "monthly", monthlyPriceCents: 2900 });
  await list(nw, releaseNotes, { category: "automation", pricingModel: "free" });
  const lSeo = await list(atlas, seoAuditor, { category: "automation", pricingModel: "monthly", monthlyPriceCents: 1900 });
  const lContract = await list(atlas, contractReviewer, { category: "research", pricingModel: "per_request", pricePerRequestCents: 10 });
  await list(kestrel, marketBrief, { category: "research", pricingModel: "free" });
  const lCode = await list(kestrel, codeReviewBot, { category: "coding", pricingModel: "per_request", pricePerRequestCents: 8 });
  const handleOf = (listing) => (listing.agent || {}).handle;

  say("5. Buyers start, pay and review (real uses, answered by a real model)");
  const perMessage = (cents) => ({ expected: { pricingModel: "per_request", pricePerRequestCents: cents } });
  const monthly = (cents) => ({ expected: { pricingModel: "monthly", monthlyPriceCents: cents } });
  const questions = [
    "How long does a first deploy take?",
    "What happens if my card fails?",
    "My deploy says Killed with no error. What do I do?",
    "What is the API rate limit for one key?",
  ];
  let asked = 0;
  for (const buyer of [fieldnote, harbor]) {
    await buyer.client.must("POST", `/api/marketplace/listings/${lSupport.id}/use`, perMessage(5));
    for (let i = 0; i < 2; i++) {
      const question = questions[asked++ % questions.length];
      // A model that cannot be reached answers 502 and the message is refunded: tried again, a few times.
      let r = { status: 0, body: {} };
      for (let attempt = 0; attempt < 4 && r.status !== 200; attempt++) {
        if (attempt > 0) await sleep(4000 * attempt);
        r = await buyer.client.call("POST", `/api/a/${handleOf(lSupport)}/chat`, say1(question));
      }
      if (r.status !== 200) say(`   (a paid message to Support Helper answered ${r.status}: ${short(r.body, 160)})`);
    }
    await buyer.client.must("POST", `/api/marketplace/listings/${lResearch.id}/use`, monthly(2900));
  }
  await nw.client.must("POST", `/api/marketplace/listings/${lSeo.id}/use`, monthly(1900));
  await nw.client.must("POST", `/api/marketplace/listings/${lCode.id}/use`, perMessage(8));
  await nw.client.call("POST", `/api/a/${handleOf(lCode)}/chat`, say1("Review this: function add(a, b) { return a - b }"));
  await fieldnote.client.must("POST", `/api/marketplace/listings/${lContract.id}/use`, perMessage(10));
  await fieldnote.client.call("POST", `/api/a/${handleOf(lContract)}/chat`, say1("Clause: The supplier may change prices at any time without notice."));
  const review = (org, listing, rating, title, content) => org.client.call("POST", `/api/marketplace/listings/${listing.id}/reviews`, { rating, title, content });
  const reviews = [
    await review(fieldnote, lSupport, 5, "Answers from our own docs", "It stays inside the help center and says when it does not know. Paying by the message made it easy to try."),
    await review(harbor, lSupport, 5, "Accurate and quick", "Our support queue is shorter, and the billing is easy to check."),
    await review(harbor, lResearch, 4, "Good first drafts", "The briefs are well structured. The monthly price is fair for how much we use it."),
    await review(nw, lSeo, 4, "Finds the real problems", "Clear list, most important first. We fixed three pages in an afternoon."),
  ];
  const refused = reviews.filter((r) => r.status !== 200 && r.status !== 201);
  if (refused.length) say(`   (${refused.length} review(s) were not accepted: ${short(refused[0].body, 200)})`);

  say("6. A schedule, and a workflow");
  const schedule = await nw.client.call("PUT", `/api/agents/${morningBriefing.id}/schedule`, { enabled: true, cronExpression: "0 8 * * *", timezone: "UTC" });
  if (schedule.status !== 200) say(`   (the schedule was not saved: ${schedule.status} ${short(schedule.body, 200)})`);
  // One real run, so the agent's page has a result to show. Without a model key it simply has none.
  const ran = await nw.client.call("POST", `/api/agents/${morningBriefing.id}/schedule/run`);
  if (ran.status !== 200 && ran.status !== 201 && ran.status !== 202) say(`   (the first run of Morning Briefing was not started: ${ran.status} ${short(ran.body, 200)})`);
  const workflow = await nw.client.call("POST", "/api/orchestrations", {
    name: "Weekly release pipeline",
    description: "Research the week's changes, then draft the release notes.",
    executionMode: "sequential",
    steps: [
      { name: "Collect changes", stepType: "agent", agentId: researchAnalyst.id },
      { name: "Draft release notes", stepType: "agent", agentId: releaseNotes.id },
    ],
  });
  if (workflow.status !== 200 && workflow.status !== 201) say(`   (the workflow was not saved: ${workflow.status} ${short(workflow.body, 300)})`);

  say(`7. ${HISTORY_DAYS} days of past sales of Support Helper, written by hand in the shape of a paid use`);
  // One real paid use is the pattern: its sale, the buyer's ledger row and the seller's.
  const pattern = sql(
    `select r.id, r.type, r.gross_amount_cents, r.platform_fee_cents, r.creator_amount_cents, coalesce(r.request_count,1), coalesce(r.install_id::text,'') ` +
      `from marketplace_revenue r where r.listing_id='${lSupport.id}' and r.status='settled' order by r.created_at limit 1`,
  );
  if (!pattern) {
    say("   (no real paid use of Support Helper was settled, so no history is written: is a model key set?)");
  } else {
    const [patternId, revenueType, gross, fee, creator] = pattern.split("|");
    const buyerRow = sql(`select type, coalesce(description,'') from credit_transactions where reference_id='${patternId}' limit 1`).split("|");
    const sellerRow = sql(`select type, coalesce(description,'') from earnings_transactions where reference_id='${patternId}' limit 1`).split("|");
    if (!buyerRow[0] || !sellerRow[0]) throw new Error(`a real paid use left no ledger rows to follow (sale ${patternId})`);
    const buyers = [fieldnote, harbor];
    let uses = 0;
    for (let day = HISTORY_DAYS; day >= 1; day--) {
      for (const [b, buyer] of buyers.entries()) {
        // A few uses a day, more as the days come closer, never the same for both buyers.
        const n = 3 + ((day * 7 + b * 5) % 6) + Math.floor((HISTORY_DAYS - day) / 6);
        uses += n;
        const at = `now() - interval '${day} days' + interval '${9 + b * 4} hours'`;
        const install = sql(`select id from agent_installs where listing_id='${lSupport.id}' and buyer_id='${buyer.orgId}'`);
        const id = sql(
          `insert into marketplace_revenue (id, listing_id, install_id, buyer_id, publisher_id, type, gross_amount_cents, platform_fee_cents, creator_amount_cents, request_count, status, settled_at, created_at) ` +
            `values (gen_random_uuid(), '${lSupport.id}', '${install}', '${buyer.orgId}', '${nw.orgId}', ${lit(revenueType)}, ${n * Number(gross)}, ${n * Number(fee)}, ${n * Number(creator)}, ${n}, 'settled', ${at}, ${at}) returning id`,
        ).split("\n")[0];
        sql(
          `insert into credit_transactions (id, org_id, amount_cents, type, description, reference_id, balance_after, created_at) ` +
            `values (gen_random_uuid(), '${buyer.orgId}', ${-n * Number(gross)}, ${lit(buyerRow[0])}, ${lit(buyerRow[1])}, '${id}', 0, ${at})`,
        );
        sql(
          `insert into earnings_transactions (id, org_id, amount_cents, type, description, reference_id, balance_after, created_at) ` +
            `values (gen_random_uuid(), '${nw.orgId}', ${n * Number(creator)}, ${lit(sellerRow[0])}, ${lit(sellerRow[1])}, '${id}', 0, ${at})`,
        );
        sql(`update agent_installs set total_requests = total_requests + ${n}, total_spent_cents = total_spent_cents + ${n * Number(gross)} where id='${install}'`);
      }
    }
    sql(`update agent_listings set total_requests = total_requests + ${uses} where id='${lSupport.id}'`);
    say(`   ${uses} past uses at $${(Number(gross) / 100).toFixed(2)} each`);
  }

  say("8. Every balance worked out again from its rows");
  sql(
    `with ordered as (select id, sum(amount_cents) over (partition by org_id order by created_at, id) as bal from credit_transactions) ` +
      `update credit_transactions t set balance_after = o.bal from ordered o where o.id = t.id`,
  );
  sql(`update credit_balances b set balance_cents = (select coalesce(sum(amount_cents),0) from credit_transactions t where t.org_id = b.org_id), updated_at = now()`);
  sql(
    `with ordered as (select id, sum(amount_cents) over (partition by org_id order by created_at, id) as bal from earnings_transactions) ` +
      `update earnings_transactions t set balance_after = o.bal from ordered o where o.id = t.id`,
  );
  sql(
    `update publisher_profiles p set pending_payout_cents = (select coalesce(sum(amount_cents),0) from earnings_transactions t where t.org_id = p.org_id), ` +
      `total_revenue_cents = (select coalesce(sum(creator_amount_cents),0) from marketplace_revenue r where r.publisher_id = p.org_id and r.status='settled'), updated_at = now()`,
  );

  say("9. Checks");
  const problems = [];
  const negative = sql(`select count(*) from credit_balances where balance_cents < 0`);
  if (negative !== "0") problems.push(`${negative} organization(s) hold less than nothing`);
  const drift = sql(
    `select count(*) from credit_balances b where b.balance_cents <> (select coalesce(sum(amount_cents),0) from credit_transactions t where t.org_id=b.org_id)`,
  );
  if (drift !== "0") problems.push(`${drift} credit balance(s) are not the sum of their ledger`);
  const owed = sql(
    `select count(*) from publisher_profiles p where p.pending_payout_cents <> (select coalesce(sum(amount_cents),0) from earnings_transactions t where t.org_id=p.org_id)`,
  );
  if (owed !== "0") problems.push(`${owed} publisher(s) are owed something else than their earnings ledger says`);
  const sold = sql(
    `select count(*) from publisher_profiles p where (select coalesce(sum(creator_amount_cents),0) from marketplace_revenue r where r.publisher_id=p.org_id and r.status='settled') ` +
      `<> (select coalesce(sum(amount_cents),0) from earnings_transactions t where t.org_id=p.org_id and t.amount_cents > 0)`,
  );
  if (sold !== "0") problems.push(`${sold} publisher(s) have sales that do not add up to what their ledger was credited`);
  const live = sql(`select (select count(*) from deployments) + (select count(*) from agent_deployments)`);
  if (live !== "0") problems.push(`${live} deployment row(s) exist: the seed makes none`);
  for (const p of problems) say(`   PROBLEM: ${p}`);

  const row = (q) => sql(q);
  say("");
  say(`The demo database ${DB} is seeded${problems.length ? ", WITH PROBLEMS (above)" : ""}.`);
  say(`  organizations ${row("select count(*) from organizations")}, people ${row("select count(*) from users")}, agents ${row("select count(*) from agents")}, listings on sale ${row("select count(*) from agent_listings where status='published'")}`);
  say(`  ${nw.name}: credits $${(Number(row(`select balance_cents from credit_balances where org_id='${nw.orgId}'`)) / 100).toFixed(2)}, owed as a seller $${(Number(row(`select coalesce((select pending_payout_cents from publisher_profiles where org_id='${nw.orgId}'),0)`)) / 100).toFixed(2)}`);
  say(`  sign in as ${nw.email} (owner), ${TEAMMATES.map((m) => `${m.email} (${m.role})`).join(", ")}`);
  say("  no deployment and no payment on a chain is seeded: what the demo shows as running or paid on chain is real");
  process.exit(problems.length ? 1 : 0);
}

main().catch((err) => {
  console.error("\nSEED STOPPED:", err && err.message ? err.message : err);
  process.exit(2);
});
