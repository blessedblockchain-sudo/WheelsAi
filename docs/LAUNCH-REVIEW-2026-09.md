# Launch-readiness review — 2026-09-27

**Method:** 8 parallel read-only review agents (deploy leg, build leg, monetize leg, security, ops/infra, engineering health, on-chain, product/UX) plus live probes of wheelsai.netlify.app and of Groq's model list, and spot-verification of every headline claim against source. Updated 2026-09-30 with the product/UX report and the Groq model check. Baseline at HEAD `fcc341b`: 1,666/1,666 unit tests pass, both apps `tsc` clean, `eslint` 6 errors / 25 warnings in apps/api. No code commits since 2026-08-11; only docs and the Netlify landing since.

Nothing was modified. One agent created and dropped a scratch Postgres DB (`wheelsai_review_shadow_*`) on localhost:5434 for a migration-drift check.

---

## Verdict

**Not close to a public launch. Roughly 20–30% of the way to "external users can pay for something that works."** The honest shape of the product today:

| Leg | README claim | Reality |
|---|---|---|
| **BUILD** | "Import an agent from GitHub in 6 frameworks … and it runs here" | Import extracts a **framework label** (substring match on the manifest) plus repo name/description. No prompt, model, tools, or code is read; nothing is cloned, built, or executed. Every chat path is one function: a raw fetch to Groq with the hand-typed system prompt. 3 usable models, 2 real tools (both silently broken under streaming). `@mastra/core` is never imported. |
| **DEPLOY** | "One click to Nosana GPU markets, per-second billing, /v1 endpoint" | **No Nosana job has ever been submitted from this codebase.** `sdk.deployments.create` makes a DRAFT that is never funded or started (`.topup(`/`.start(` have zero callers). 4 of 5 market addresses are literal placeholder strings. Node URLs are fabricated as `""`. Status tick polls the wrong identity so every deployment stays `provisioning` forever. The `/v1` allowlist regex cannot match a real Nosana hostname. No per-second org billing exists for model deployments. Training is dead at submit three independent ways. |
| **MONETIZE** | "4 pricing models, creators keep 90%, payouts on-chain" | Only **per-request** works end to end (inside the credit ledger). **Monthly is schema-only** (0 references; a monthly listing installs and runs free while showing "$X/month"). **Tokenized is never written** to a listing, so the token gate can never fire; pump.fun has never been exercised on any network. Stripe: zero code. x402 is platform revenue only, charges before serving with no refund, SOL priced off a hardcoded $150. |
| **INFRA** | "Public launch (current)" | The live site's bundle calls `http://localhost:4000` so **no visitor can sign up**. `wheelsai.io` is **unregistered**; `wheelsai.com` belongs to someone else. The production API image **cannot start** (`ERR_UNKNOWN_FILE_EXTENSION ".ts"`: workspace packages export raw TS, Dockerfile runs plain `tsc`). CI is red at lint and has never run. No email sending exists (no verify, no reset). Auth cookie has no `domain`, so the planned web/API split loops back to /login. |
| **UX** | — | Readiness **4/10**. One path reaches "my agent replied": public GitHub import, three Next clicks, Playground (about 10 clicks). The from-scratch path dead-ends. Login labels and the Playground input are near-invisible in the default dark theme. Every new agent's Overview shows two red "API Error: 404" cards. Every footer link except the marketplace 404s. |

What IS real and well built: the credit ledger and grant path, marketplace per-request metering (proof matches code), wallet top-up design, payout executor core, deployment credit reservation, fee-router/attestation claim-first protocol, both Anchor programs (checked math, canonical PDAs, adversarial LiteSVM tests), SSRF guard, GitHub App stack, graph/orchestration/scheduler engines, boot-time env assertions, BullMQ hygiene, strict TS with 0 ts-ignore, clean schema/migration chain. The codebase is disciplined and honest about 501s. The gap is that the three product legs each stop one layer short of their claim.

---

## Launch gates, in order

### Gate 0 — anyone can sign up (est. 3–5 engineer-days after accounts exist)
0. **Commit the free-model remap now.** Groq has retired all three models the committed catalog calls (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `qwen/qwen3-32b`; checked against Groq's live model list on 2026-09-30). At HEAD every free-model chat fails, including the flagship demo. The uncommitted change to `config/free-models.ts` and the wizard maps the stable ids to live models (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`, all confirmed live). **S**
1. **Fix API packaging** — `packages/{db,shared,types}` export `./src/index.ts`; `apps/api/Dockerfile:24,62` runs `tsc` then `node dist/index.js` → crash. Bundle (tsup/esbuild) or give packages a real build. **M**
2. Node 22 base image + CI image (`@mastra/core` engines ≥22.13; Dockerfiles/CI pin 20). **S**
3. Fix 6 eslint errors (`buildSchedulerTickDeps.ts:19-20`, `buildUptimeProberTickDeps.ts:21`, `integrations.ts:563`, `runPayoutExecutorTick.ts:98`, `submitReputationAttestation.ts:25`). **S**
4. Register a domain; set `NEXT_PUBLIC_API_URL` in `netlify.toml [build.environment]`; cookie `domain: ".<apex>"` in `middleware/auth.ts:333-347` (or proxy `/api` through Next); one `CORS_ORIGIN`. **S**
5. Fly account + `FLY_API_TOKEN`; Postgres with pgvector (runbook silent on it); Redis with `noeviction`; `kill_timeout ≥ 60s`; **run `db:seed`** (POST /api/deployments 400s on a fresh DB — `deployments.ts:156-162`); Sentry DSN; `METRICS_TOKEN`. **S each**
6. GitLab runner verification (external).

### Gate 1 — safe to accept real users (security launch gate)
7. Rate limits keyed on spoofable IP: `trustProxy: true` (`index.ts:131-134`) with no `keyGenerator` anywhere → unlimited login/2FA/registration attempts. **S**
8. $5 credits minted on unverified signup (`services/auth.ts:157-174`) with no email verification → sybil-funded GPU/Groq spend. Grant after verification or first top-up. **S** (+ email provider **M**)
9. **Publisher API keys leak to every buyer**: install clones `env` (`marketplace.ts:734-752`); `GET /api/agents/:id` returns `env` in full (`routes/agents.ts:207-212` strips a nonexistent `secrets` field); `env` stored plaintext (schema comment claims encrypted). **S**
10. `/v1` credit overdraft: unbounded `max_tokens`, unconditional decrement, stale `balanceAfter` (`inference.ts:52-65, 206-225, 317-319`). Use the conditional-reserve pattern from `deploymentCreditGate.ts:97-100`. **S**
11. Before marketing: login open redirect (`login/page.tsx:27-28` accepts `/\evil.com`); wallet sign-in message has no domain binding (`services/auth.ts:55-64`); team invite role unvalidated + accept not bound to invitee email (`enterprise.ts`) — note member/admin invites are unusable today because login picks the first `owner` membership and there is no org switcher; `NODE_ENV=staging` bypasses every prod guard and reflects any CORS origin with credentials (`env.ts:327`, `index.ts:144`, `fly.staging.toml:16`). **S each**
12. `npm audit`: fastify/ws/axios/next high-critical patch lines; drop never-imported `next-auth`. **S**

### Gate 2 — the BUILD demo holds up (first 10 minutes of a new user)
13. "Choose a framework" path cannot create an agent (inline + empty code rejected, generic toast). **S**
14. Public-repo import is unauthenticated → shared 60 req/hr GitHub limit; ~15 imports/hour platform-wide then "Repository not found". `GITHUB_TOKEN` is declared with zero readers. **S**
15. Wizard offers `wheelsai/llama-3.1-*` models that throw "Unknown model provider"; 4 of 6 offered tools are silently dropped; streaming + tool call = empty reply while the buyer is still billed (`mastra-runtime.ts:206-231`, `playground.ts:195`). **S/M**
16. Deploy button beside Playground reserves credits and submits a job for a nonexistent image (`wheelsai/agent-runtime-*`, Docker Hub 404). 501 it until an image exists. **S**
17. Decide the BUILD story: either build a real runtime (containerize imported code — **L**) or rewrite the claim to "bring your prompt/config; we host the chat" and extract at least system prompt + model + tools from the repo (`parseElizaCharacter`/`parseCrewAi` already exist, only reachable from the unmounted `/launch`). **M**

Also in Gate 2, from the product/UX review:
- Login/register labels are `text-gray-700` (`#1a2744`) on the dark card, about 1.4:1 contrast (`login/page.tsx:158,178`, `register/page.tsx:69,89,109`). Playground and wizard textareas are light-mode screens, so typed text is invisible on dark (`playground/page.tsx:165,264,274`, `agents/new/page.tsx:461-467,678-683`). **S**
- Every new agent's Overview mounts the runway and payments cards unconditionally. Both render red "API Error: 404" and the runway card re-polls forever (`overview-tab.tsx:123-128`). Show them only for tokenized agents. **S**
- The GitHub-import call uses its own `?? ""` API fallback (`agents/new/page.tsx:29`) instead of `lib/api.ts`. Use the existing `agentsApi.importFromGithub`. **S**
- Server messages are swallowed at every gate (402 insufficient credits, 429 quota, 501s) into generic toasts or `alert("API Error: 501 Not Implemented")`. One shared error-message helper fixes it app-wide. **S**
- The mobile sidebar never closes on navigation (`(dashboard)/layout.tsx:28-38`). API key revoke and deployment stop (which calls DELETE) have no confirmation. Register drops the marketplace `next` param, so a buyer who signs up loses the listing (`register/page.tsx:39`). **S each**
- No forgot-password flow exists, so a user who forgets their password is locked out. **M** (needs the email provider from item 8)
- Web tests are 30 render-smoke Playwright specs that have never run; nothing covers create-then-chat.

### Gate 3 — DEPLOY becomes real (needed before charging for GPU)
18. Fund + start the Nosana deployment (`nosana.ts:523-557`), resolve real node URLs, use the existing `getDeploymentStatus` in the tick, real market addresses, funded `NOSANA_WALLET_PRIVATE_KEY`. **M + M + S + S**
19. Fix `/v1` allowlist (`inference.ts:561`: `[\w-]+` can't contain a dot). **S**
20. Per-second org billing writer for model deployments (today the org pays per-token + a refundable 1h hold while the platform would pay NOS for the whole job). **M**
21. Stop never releases the credit reservation (`deployments.ts:350-401`, `agents.ts:570-589`) — live P1, every Stop forfeits $0.36–$5.40/replica. **S**
22. Job definitions are pinned to public IPFS with env secrets inside; `confidential` never set (`deployPlan.ts:96-103`, `agent-runtime.ts:69-80`). **S + design M**
23. `HF_TOKEN` literal; Ollama `/health` never passes; restart orphans running jobs. **S each**
24. Training: tier keys don't match MARKETS (100% insta-fail), images don't exist, script generated then discarded, job type not in SDK schema. **L**

### Gate 4 — MONETIZE takes real money
25. **P0** `requestPayout` double-spend: pending check outside the tx, unconditional decrement, no CHECK constraint (`marketplace.ts:1009-1052`). **S**
26. **P0** Fee router pays 1% of indexed trade VOLUME from the platform wallet with no inflow (its own comment calls it "synthetic") → wash-trade drainable. Off by default; must not be enabled on mainnet. **policy + M**
27. Reinstall orphans the old clone as a free unmetered copy. **S**
28. x402: pay-before-serve with no refund; SOL quote hardcoded 150 (`getTokenPrices` 0 callers); `transferChecked` decode reads the mint as destination so wallet-emitted USDC is always rejected. **S–M**
29. Crypto payouts can wedge in `processing` forever; no `lastValidBlockHeight` on `CreatorPayout`. **S**
30. Monthly: build a subscription engine or remove it from the pricing matrix UI. Tokenized: write `pricingModel="tokenized"` on launch and gate all chat paths, or label it "launch a token" rather than a pricing model. **M / M**
31. Stripe: zero code (checkout 501s, `stripeCheckout: false`). **M** — the landing page also sells a $49/mo Pro plan and "Start Pro Trial" that no code implements, and "Contact Sales" → `/contact` is a 404 on the live site. **S to remove**
32. Compliance for crypto payouts: none (no KYC/AML/sanctions/tax). **L or policy**
33. Payout/top-up bindings have **zero tests** (`buildPayoutExecutorTickDeps.ts`, `walletTopupBindings.ts`); no test executes real SQL; integration tier hangs/fails and is quarantined. **S–M**

### Gate 5 — mainnet cutover (on-chain)
34. `submit_attestation` uses `>=` not `>` (`reputation-oracle/src/lib.rs:254-257`): same-timestamp resubmit double-counts the numbers behind the launch gate (test proves 10→15). **S**
35. Every funds-bearing key (WALLET_MASTER_KEY root, raw fee-router/attestor/Nosana keys) lives in the public API process with in-process workers, no KMS/multisig; `pay_nosana` has no on-chain spend cap. One env leak = drain everything. **M–L** (highest-leverage mainnet item)
36. `initialize_config`/`initialize_oracle` are first-caller-becomes-admin (front-run at deploy); program IDs hardcoded with no per-network guard; no bytecode-vs-source check (stale binary already happened twice); zero ComputeBudget/priority-fee instructions; no FAILED→PENDING retry for ComputePayment; pumpportal create+broadcast never run anywhere. **S / S / S–M / S–M / S–M / L**
37. Remove dead custodial launch code (`agentToken.ts:258 createToken`, unmounted `routes/tokenLaunch.ts`, `services/wallet.ts` with a hardcoded dev master key). **S**

---

## Honest-claims residue (fix before any marketing push)
- Landing pricing: Starter/Pro $49/Enterprise plans, "1,000 / 100,000 API calls/month", "Start Pro Trial", "Contact Sales" — no plan model exists in the schema; billing is credits only; `/contact` 404s; `?plan=pro` is ignored.
- README/brief: "import … and it runs here", "3060 → H100" (wizard omits H100), "per-second billing", "4 pricing models", "Creators keep 90%; payouts settle on-chain" (true only for per-request via devnet proof).
- API returns fabricated `https://api.wheelsai.io/v1/<slug>` and `https://agents.wheelsai.io/<slug>` endpoints; GET deployment logs returns a placeholder line as 200; custom-domain SSL is a `setTimeout` that sets `active` with no certificate (`domains.ts:345-380`).
- The Telegram route reads an `x-telegram-signature` header (`channelWebhooks.ts:111`) that Telegram never sends, so every inbound Telegram message fails verification. "3 chat channels" is really 2 (Slack, Discord).
- Landing feature copy claims "auto-scaling", "zero cold starts", "enterprise-grade reliability", one-click deploy to chat channels, "From Idea to Revenue in Minutes", and a CLI demo with an invented "47ms avg" latency on `api.wheelsai.com` (`features-grid.tsx:59-60`, `how-it-works.tsx:19,68-71`, `code-preview.tsx`).
- "21 models" is the GPU-deploy catalog, which cannot deploy today. The chat path offers 3 working models.
- Every footer link except the marketplace 404s (`/docs`, `/changelog`, `/status`, `/about`, `/blog`, `/privacy`, `/terms`). Ship privacy and terms before collecting emails.
- The API keys page's curl example uses `api.wheelsai.io` (`keys/page.tsx:323`).
- Hero still renders katakana "matrix rain" from the retired green theme (`hero.tsx:6`).

## Engineering health (so you know what not to touch)
Schema/migrations clean (authoritative `prisma migrate diff` exit 0, 78 models / 27 migrations). 12 of 21 `build*Deps` composition roots have binding tests; `channelStackWiring.unit.test.ts` is the template to copy for payouts/top-ups and for pinning the mount list (~40 registers and 16 worker starts are unpinned; `POST /launch` is tested but never mounted). ~130 `catch → 400` with zero logging across 11 route files (a DB outage is invisible to logs and Sentry). BullMQ job failures never reach Sentry. Phantom deps: api `yaml`, `@prisma/client`; web `bs58`. Unused: api `stripe`, `@mastra/core`, `@trpc/server`; web `next-auth`, `@trpc/*`, `zod`. Legacy `.github/workflows`, `deploy/k8s`, `deploy/helm` should be deleted.

## Recommended sequencing
1. **Week 1:** Gate 0 (starting with the free-model commit) + Gate 1 items 7–10. Result: a real URL where a stranger can register and chat with a prompt-based agent on Groq. Devnet is fine; mainnet flags stay off.
2. **Week 2:** Gate 2. Make the BUILD demo unembarrassing and decide the runtime question (item 17) — this decision shapes everything after.
3. **Weeks 3–5:** Gate 3 (real Nosana deploy, one real job on a real host is the proof that's missing) and Gate 4 items 25–29 + 33.
4. **Then:** pricing matrix honesty (30–31), mainnet custody (35), on-chain fixes (34, 36), external program audit.

Don't turn on the fee router, payouts, or x402 on mainnet before 25, 26, 28, 34 and 35.
