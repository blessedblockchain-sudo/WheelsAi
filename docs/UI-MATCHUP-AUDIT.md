# UI Match-Up Audit — build up, don't cut down

**Date:** 2026-08-01 · **Directive (founder):** where the UI over-delivers, do not
degrade the product to match — check whether the system can be built up to match
the UI, assuming no time/resource limits.
**Method:** 10 parallel auditors traced ~80 UI claims across every dashboard
surface and marketing claim, down through the API client → mounted routes →
services → schema → tests. Full evidence (file:line for every claim) lives in
the audit run; this doc is the synthesis and the roadmap.

---

## The headline

**The vision does not need to be degraded. Almost everything the UI promises is
buildable, and buildable on-thesis.**

The audit found a consistent shape across all ten surfaces: the persistence,
routes, and CRUD layers are genuinely built (often tested), and the missing mass
is concentrated in **execution layers** — a worker that never got started, a
container image that was never built, a writer function with zero callers, a
route that was never mounted. The UI isn't lying about *what* the product is.
It's lying about *when*.

Three claim classes, three different treatments:

| Class | Examples | Treatment |
|---|---|---|
| **BUILD** | Training, RAG, scheduler, orchestration, channels, revenue machinery, token data, domains | Build the execution layer — roadmap below |
| **POLICY** | "90% revenue share" (already coded: `CREATOR_REVENUE_SHARE=0.9`) | The number is a decision, already made; the claim returns to marketing when the first real payout executes. Acceptable meanwhile on the publish flow (it describes the coded split being applied to pricing the publisher is choosing) |
| **EARN-ONLY** | "500+ builders", "500+ agents built", invented ratings/installs | Cannot be built, only earned. Stay removed permanently until true |

**Plan revision this implies:** ticket B1's "flag-gate the demo-ware breadth
behind a default-off Advanced group" is **replaced**. Surfaces stay visible,
with truthful states (their own empty/pending states once fake writers are
removed — most already have them), each carrying a wave assignment below.
Hiding was the cheap fix; building is the ordered one.

**Discovered en route, fixed in this commit:** the A1 cleanup missed six
residue locations still shipping "10+ channels / 90% revenue" — including the
**SEO meta description and the OG share image**, the highest-distribution
surfaces in the product. All aligned to the honest claims now.

---

## The two free wins (do these first)

The audit's most surprising findings are not gaps — they're finished systems
nobody turned on:

1. **The chat-channel stack is complete, tested, and production-dead.**
   Signature verification for all three platforms, credential resolution,
   message normalization, outbound dispatch, and the agent-message BullMQ
   worker all exist with 5 unit-test files — but `createChannelWebhookRoutes`
   is imported only by tests (never mounted in `index.ts`), and the
   agent-message queue is absent from the startup block. **No inbound message
   has ever reached an agent in production.** Fix = mounting + queue
   registration + one integration test. (S)

2. **Real node health now exists but two mocks ignore it.** Post-A2, node
   health is genuinely probed and persisted — but the deployment playground
   still returns a hardcoded string even when a healthy node exists, and
   endpoint cards render an undeployed hostname. Deleting the mock and calling
   the real `/v1` path is small. (S)

---

## Surface-by-surface verdicts

### 1. Training Studio — the most complete facade
4 pages, 11 API methods, mounted routes, real models, real S3-presign code,
HMAC-authed progress webhook (tested) — and **zero training jobs can ever
run**: the UI's GPU tier strings don't match Nosana market keys (every job
insta-fails), the training container images (`ghcr.io/wheelsai/training-*`)
don't exist anywhere, and the generated training script is literally discarded
(`services/training.ts:126` — called, never assigned).
**Build:** one L (training container with the already-written script spec +
tier→market mapping + one-shot batch submit + status-reconcile worker) + two M
(billing debit, adapter→servable-model bridge via vLLM LoRA) + S's (S3 env
provisioning, metrics chart, price-label fixes).
**On-thesis:** strongly — fine-tuning as Nosana batch jobs is the deploy leg's
per-second GPU story applied to the build leg, and the output-model bridge
connects BUILD→DEPLOY.
**Blocker:** whether Nosana has real A100/H100 market supply for 70B QLoRA;
if not, cap the catalog at ~14B and say so.

### 2. Testing + Monitoring — three missing engines, everything else real
Every form writes real rows through real routes; Slack/Discord/PagerDuty
senders are real. Missing: the test **runner** grades against a hardcoded
simulated response (and the UI can't even author test cases, so Run is
permanently disabled), the alert evaluator (`triggerAlert`) and uptime prober
(`recordUptimeEvent`) have **zero callers**.
**Build:** three BullMQ repeatable workers cloned from existing queue patterns
+ one test-case editor UI + one email adapter + an assertion sandbox. (S-M
each.)
**On-thesis:** real evals harden BUILD's trust story; real uptime/alerting
feeds the same receipts/uptime transparency shipped in A5.

### 3. Knowledge + Memory — "semantic" and "for your agents" are the fake parts
CRUD/browse works end-to-end over real models. But search is keyword substring
matching (embedding columns decorative, no vector ever computed), and neither
knowledge nor memory ever touches inference — playground is stateless, so both
pages' "once your agents start chatting" states are permanently empty.
**Build:** pgvector on the existing Postgres + an embeddings adapter
(self-hostable on Nosana — reinforces the deploy leg) + a BullMQ ingestion
worker (~L for real RAG); wire the existing memory service into the two live
chat paths + one fact-extraction worker (~M). The schema was clearly designed
for exactly this.

### 4. Orchestration + Scheduler — fabricated success rows
CRUD real; execution 0% real. Nothing consumes `nextRunAt` (nothing ever fires
on schedule), and both "run" paths are in-process `setTimeout` simulations that
write **fabricated success rows** — every success-rate stat shown is fiction.
**Build:** scheduler execution worker with real cron/timezones (M — cron
libraries + the existing repeatable-tick pattern); orchestration engine
(sequential/parallel/conditional/pipeline over the two working agent-invocation
paths) + the missing create-workflow UI (L).
**Note:** the fabricated-success writers should be removed in Wave 0 even
before the engines land — simulated rows are the one thing here that actively
lies.

### 5. Domains + Integrations — enterprise facade, hollow center
Domain CRUD + real DNS TXT verification work. SSL provisioning is a `setTimeout`
mock, no request is ever routed through a custom domain (resolver has zero
callers), none of the 16 webhook events ever fires (`triggerWebhook` zero
callers), and both OAuth integrations (Slack, GitHub) dead-end at a DB row —
no OAuth route exists despite unused state/token-encryption helpers.
**Build:** webhook event emission into existing mutation sites (M — cheap,
high-leverage); Slack OAuth (M); GitHub App for private-repo import +
push-to-redeploy (L, strongly on-thesis for BUILD); real domain routing + ACME
(L — defer until agents have stable public runtime URLs to route *to*).

### 6. OpenClaw — the deploy leg's consumer product, missing its engine
(One-liner: OpenClaw is the multi-channel assistant runtime WheelsAI wraps as
its managed hosting product — config + channel tokens → hardened container →
Nosana GPU job → public URL.) DB/CRUD real; the runtime container image has no
build source in the repo, the channel pipeline is unmounted (see free win #1),
health updater has zero callers, and several paths **fabricate success**
(RUNNING on wallet-not-configured, invented `*.openclaw.wheelsai.com` URLs,
empty-string logs).
**Build:** runtime image + funded Nosana wallet (L), channel pipeline wiring
(L, mostly the free win), health polling + real URLs/logs (M+M).
**Sequencing:** shares the C1 blocker (payable Nosana hosts) — behind the
mainnet spike.

### 7. Visual Builder — diagrams, not behavior
Editing, persistence, templates, validation, version snapshots/rollback all
real. **Not one line of runtime code reads the graph** — there is tellingly no
Run button (the Play icon is imported and never rendered).
**Build, staged:** (a) M — linear-graph interpreter behind the playground
makes the headline claim true for simple graphs; (b) XL — full 13-node engine
(sandboxed code node, tool registry, loop semantics); or (c) the dead
`generatedCode` columns point to a cheaper, on-brand route: **compile graphs
to real framework code** and run through the existing inline-source deploy
path.

### 8. Deploy-surface numbers — every decision-time number is invented
Three hand-typed price tables disagree with each other AND with the rate
actually billed (wizard $0.35 vs catalog $0.25 vs metered $0.54 for the same
4070); "150 available" node counts are fabricated; market addresses are
placeholders.
**Build:** one market-sync worker (real Nosana market prices + real node
counts) + one shared pricing module consumed by wizard/catalog/billing +
delete the two mocks. (S-M; real market addresses arrive with C1.)

### 9. Marketing claims — channels, revenue, discovery
- **"10+ channels":** each new adapter is a bounded ~200-400 LOC unit in the
  existing webhook+dispatch architecture (verify fn, normalize case, reply
  builder, credential mapping, config form, tests). WhatsApp/Teams/Google
  Chat/email/web-widget/X/Farcaster enumerated in the audit. Only hard gates:
  platform approvals (Meta business verification, Azure app, X API tier).
  Claim returns at adapter #10.
- **"90% revenue":** fully coded as policy/schema/routes/UI; zero money flows
  because checkout 501s (B2), `recordMarketplaceUsage` has zero callers, and
  no payout executor exists. Build: B2-B4 rails + metering call in the billed
  request path + payout worker reusing the proven A4 payment queues (L+M).
  Claim returns to marketing at the first real payout.
- **/explore:** rebuild as a genuinely curated surface: a curation writer
  (nothing ever sets `isFeatured` today), a listing-trending aggregation
  worker, and a public variant of the substance feed (currently auth-only).
  (M) Returns when there are real agents to feature.

### 10. Token/marketplace data — two keystone builds unlock everything
The plumbing is unusually solid (money-grade columns, crash-safe indexer,
real token-gate middleware with an integration test). Both root data sources
are absent: the market-data upstream is a **fictional REST API** (PumpPortal
is WS-only — known from B6) and marketplace revenue has a zero-caller writer.
**Build:** (1) real trade/price feed — WS consumer + on-chain backfill behind
the existing DI seams (L) — unlocks charts, trades, holders, gate passability,
and fee routing at once; (2) revenue metering + payout processor (with #9's
rails). The hidden hardcoded "Token Performance" card ($0.042/89 holders) gets
deleted in Wave 0 regardless (INT-B3).

---

## The waves

Sequenced by dependency, not importance. Sizes are the audit's per-item calls.

**Wave 0 — truth + free wins (all S, no blockers): ✅ COMPLETE 2026-08-01**
residue purge (`d760787`) · channel stack mounted (`49f1dcf`) · playground +
endpoint cards de-mocked (`78ef18e`) · fabricated-success writers removed
(`8c88d31`) · dataset storage honesty + real delete (`71922a1`) · unified
pricing module (`61906c7`).

**Wave 1 — cheap engines (S-M each): ✅ COMPLETE 2026-08-02** (except
market-sync, deferred to C1 — its value is real mainnet market addresses)
scheduler execution worker (`8bc6978`) · webhook emission, 8 sites
(`a80eaae`) · uptime prober + alert evaluator (`33a1d31`) · tick-observed
deployment events (`2f7b403`) · `isFeatured` curation writer (`332e000`) ·
analytics snapshots + per-agent rollup (`d601203`) · real test runner +
case editor (`b980c86`).

Three things Wave 1 found that the audit hadn't: the assertion engine ran
**user-supplied JavaScript via `new Function()` in the API process** (RCE for
any authenticated user, behind a comment claiming it was sandboxed — now fails
closed); the "semantic" assertion reported word overlap as semantic similarity
(now labeled honestly); and `latency_p95` alert rules cannot be computed from
the per-window aggregates that exist, so the evaluator skips and counts them
rather than approximating a fabricated percentile.

**Wave 2 — keystone data + money (L each; some pair with Phase B tickets):**
✅ marketplace payout executor (`940060e`, devnet-proven `7d6b9a8` — the
"90% revenue" re-entry gate; its money-IN half, `recordMarketplaceUsage`,
still has zero callers and remains open) · ✅ pgvector RAG + memory
(`51ac173` + `75fae92` + `45e3d28`; plumbing verified against real
Postgres — semantic quality unproven until an embedding provider key
exists) · ✅ orchestration engine (`dad6d3d`, proven with live
multi-agent inference) · **open:** token trade feed (WS consumer +
backfill; supersedes/absorbs B6) · marketplace per-request metering
caller · graph linear interpreter (stage 1 of builder runtime) · Slack
OAuth + GitHub App.

**Wave 3 — heavy/externally gated (L-XL):**
training execution (containers + real Nosana markets — C1-gated) · OpenClaw
runtime image + full pipeline (C1-gated) · custom-domain routing + ACME (needs
stable public runtime URLs) · full graph engine or compile-to-code · channel
adapters toward 10+ (platform approvals).

**Never build (earn or decide instead):** user/agent counts (earn) · invented
ratings (earn) · the 90% number (decided; returns with the first payout).

## Claim re-entry gates

Each removed marketing claim has an objective return condition:

| Claim | Returns when |
|---|---|
| "10+ channels" | The 10th channel adapter passes its integration test in production |
| "90% revenue" (marketing) | The first real `CreatorPayout` executes |
| Featured/trending on /explore | Curation writer + trending worker live with ≥1 real cohort |
| "500+ builders/agents" | The DB says so |
| Live token charts | The trade feed writes real rows |

The six residue files fixed in this commit are the checklist for where the
claims go back.
