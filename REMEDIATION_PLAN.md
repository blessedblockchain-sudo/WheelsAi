# WheelsAI Remediation — Detailed Execution Spec

**Audience:** an implementing model (Opus 4.8) with no prior context. Everything needed is in this document plus the repo at `/home/bprime/Bounties/WheelsAi`. Findings below were produced by a 56-agent deep review (June 2026) and the P0/P1s were adversarially re-verified against the code — but ALWAYS re-read the cited file before editing; line numbers drift.

## Context

WheelsAI is a Solana platform: build/deploy AI agents on Nosana GPUs, optionally tokenize them (pump.fun today, Bags/Meteora adapter spike-gated), with an on-chain closed loop — trade fees → `agent-treasury` Anchor program → pays Nosana compute → `reputation-oracle` attests usage. Strategic frame (decided, do not re-litigate): the moat is CREDIBILITY — tokens backed by working, revenue-generating agents; eligibility-gated; marketplace ranks by substance, not hype. Monorepo: `apps/api` (Fastify), `apps/web` (Next.js 15 app router), `packages/db` (Prisma, 74 models), `programs/` (2 Anchor programs), deploy via Fly.io, CI via GitHub Actions.

State of the codebase: the new-era money-path code (tick workers, partial-sign launch, HMAC prepare tokens) is excellent; the older ~70% (most routes, marketplace, billing, enterprise) is junior-quality CRUD. The flagship closed loop **cannot currently run end-to-end** (3 interlocking bugs), there are **live fund-loss endpoints**, and **CI has never once run the test suite** (65/65 runs failed on lint; repo unpushed for 2.5 months).

## Rules for the implementing model

1. **Commits:** one ticket = one commit, conventional message (`fix(api): ...`). **NEVER add Co-Authored-By or any AI credit line.**
2. **Verify before claiming done:** `cd apps/api && npm run test:unit` (~940 cases, ~22s, no infra needed) and `npx tsc --noEmit` in both `apps/api` and `apps/web` must pass after every ticket. Run `npm run lint` after workstream B1 lands.
3. **Patterns to imitate (already in the repo — copy these, don't invent):**
   - Tick worker decomposition: `run*Tick.ts` (pure orchestrator) + `build*Deps.ts` (composition root) + `load*ByPrisma.ts` + `persist*.ts`. See `apps/api/src/services/runSubmitPaymentsTick.ts`.
   - Race-safe state transition: `updateMany({where:{id, status:'X'}})`, throw if `count===0`. See `apps/api/src/services/persistSubmitTransition.ts:70-79`.
   - Boot-fatal env assertion: see `apps/api/src/config/env.ts:162-190` (`ALLOW_NOSANA_MOCK` forbidden in prod) and the Bags boot guard `apps/api/src/index.ts:73-81`.
   - HKDF key derivation: `apps/api/src/services/treasuryKeypairs.ts`, `creatorKeypairs.ts`.
   - Validated route w/ structured envelope: the DI factories, e.g. `apps/api/src/routes/tokenLaunchPartialSign.ts` (safeParse + snake_case error codes).
   - HMAC w/ `timingSafeEqual`: `apps/api/src/services/launchpadPrepareToken.ts:140-203`; webhook HMAC pattern: `apps/api/src/services/channelAuth.ts`.
   - Test style: node test runner via tsx, table-driven, stub deps. See `apps/api/src/tests/runFeeRouterTick.unit.test.ts`.
4. **Order:** Workstreams A → B are blocking and first. C and D next (D is the product). E–I can interleave. Within a workstream, tickets are ordered.
5. When a ticket says "feature-flag off", use the env-flag pattern in `apps/web/src/lib/feature-flags.ts` (web) / `env.ts` zod schema (api).

---

## Workstream A — Fund-loss kill-switches (P0, day 1)

### A1. Mock checkout mints free credits in production
- **Problem:** `POST /api/billing/checkout` (`apps/api/src/routes/billing.ts:124-194`) increments `creditBalance` + tiered bonus credits with NO Stripe call, no env gate, no idempotency (`referenceId: "development_mock"`). Credits buy real Nosana GPU compute (`apps/api/src/routes/inference.ts:206-225`). Any authed user → unlimited free compute. Mounted unconditionally (`index.ts:167`).
- **Fix:** Add `ALLOW_MOCK_CHECKOUT` boolean to the env schema, default false, **boot-fatal if true in production** (copy the `ALLOW_NOSANA_MOCK` assertion pattern in `env.ts:162-190`). In the handler: if flag off → `501 {error:'checkout_not_implemented'}`. Also wrap the existing balance-upsert + ledger-insert in one `prisma.$transaction` (they're currently two separate awaits — crash between them desyncs balance from ledger).
- **Test:** unit test for env assertion (prod + flag → parseEnv throws); route test (flag off → 501; flag on → credits granted atomically).

### A2. Deprecated custodial mint path still live
- **Problem:** `POST /api/tokens/create` (`apps/api/src/routes/tokens.ts:188-216`) is mounted while its service (`apps/api/src/services/agentToken.ts:194-201,243-255,278-283`) carries an `@deprecated` banner stating tokens minted here get **broken on-chain metadata** (passes `listing.iconUrl` directly as the metadata `uri`). Its duplicate-token guard is check-then-act (two concurrent calls both mint, loser's mint is orphaned). The supported path is the partial-sign flow (`/api/tokens/launch/prepare|submit`), already live in the web wizard.
- **Fix:** Return `410 Gone` with a pointer to `/api/tokens/launch/prepare` from the create handler. Do not delete the service yet (the indexer reuses parts). Also delete the dead web client for it: `apps/web/src/components/dashboard/tokenize-modal.tsx` (zero importers — verify with grep) and the `tokenApi.create` client method if unused.
- **Test:** route test asserting 410.

### A3. Client-side trading panel builds wrong/unsafe pump.fun instructions
- **Problem:** `apps/web/src/lib/pumpfun-trade.ts` hand-rolls pump.fun buy/sell from a guessed IDL: buy writes `token_amount=0` on an invented "0 means buy with SOL" semantic (`:87-88` — pump.fun's `buy(amount, max_sol_cost)` has no such semantic; buys nothing or reverts); sell hardcodes `min_sol_output=0` (`:141`) while the accepted `slippageBps` param (`:127`) is never used → any executed sell has **unbounded slippage**, while the UI displays "Max slippage: 1%" (`apps/web/src/components/dashboard/token-trade-panel.tsx:341,350-353`). Account list omits required accounts (global/event_authority/program).
- **Fix (phase 1, now):** hard-disable the trade panel UI behind the existing token-UI feature flag mechanism with its own flag (`NEXT_PUBLIC_ENABLE_TRADING`, default off), and delete `pumpfun-trade.ts`'s exported builders or throw at entry.
- **Fix (phase 2, separate ticket later):** server-prepared trades — backend builds buy/sell via pumpportal `/api/trade-local` (it already does this for launches — see `apps/api/src/services/launchpadPrepareToken.ts` flow), returns the tx for browser signing; quote `min_sol_output`/`max_sol_cost` from bonding-curve state server-side; `simulateTransaction` preflight before returning. Also fix the hardcoded SOL=$150 estimate (`token-trade-panel.tsx:76`) by quoting from curve reserves.
- **Test:** with flag off, panel renders "trading coming soon" and no instruction builder is importable from the page.

### A4. GPU deployment has no credit gate
- **Problem:** `POST /api/deployments` (`apps/api/src/routes/deployments.ts:135-213`) and `POST /api/agents/:agentId/deploy` (`apps/api/src/routes/agents.ts:286-348`) submit Nosana jobs **signed by the platform's `NOSANA_WALLET_PRIVATE_KEY`** with no creditBalance check, no per-org quota. Combined with A1, an attacker drains the platform Nosana wallet.
- **Fix:** Before submitting to Nosana: (1) estimate job cost via existing `apps/api/src/services/computeCostForDeployment.ts`; (2) atomic conditional reservation: `updateMany({where:{orgId, balanceCents:{gte: estCents}}, data:{balanceCents:{decrement: estCents}}})`, 402 on `count===0`, write a `CreditTransaction` row in the same `$transaction`; (3) enforce `MAX_ACTIVE_DEPLOYMENTS_PER_ORG` (env, default 5) by counting active rows.
- **Test:** unit tests for insufficient balance → 402 and quota exceeded → 429; concurrency test: two parallel deploys against a balance covering one → exactly one succeeds.

### A5. x402 marks payments "settled" without broadcasting
- **Problem:** With `X402_SUBMIT_TRANSACTIONS=false` (the default), `verifyPayment` (`apps/api/src/services/x402.ts:344-380`) validates only local signature/shape of the client-supplied tx and returns valid; the inference route then serves the request and flips the payment to `settled` (`apps/api/src/routes/inference.ts:226-234`). The settlement worker is also off by default. Net: client "pays" with a tx that never lands, keeps funds, gets inference.
- **Fix:** Boot-fatal env assertion: `X402_ENABLED=true` requires `X402_SUBMIT_TRANSACTIONS=true` (env.ts pattern). Change the route to set status `verified` (not `settled`); only the settlement worker's confirmation path may transition `verified→settled` after on-chain confirmation. Keep the existing replay defense (it's correct: `inference.ts:408-456`).
- **Test:** env assertion test; route test asserting status `verified`.

### A6. Training webhook is unauthenticated
- **Problem:** `POST /api/training/jobs/:jobId/webhook` (`apps/api/src/routes/training.ts:577-630`) has no preHandler/signature — anyone with a jobId can mark jobs completed/failed, overwrite `outputPath`, and append unbounded `logs`.
- **Fix:** Generate a per-job HMAC secret at job submission (store on TrainingJob row), include it in the webhook URL given to Nosana; verify timing-safely in the handler (copy `services/channelAuth.ts`). Cap log append to 64KB per call.
- **Test:** missing/wrong signature → 401; valid → transition applied; log-size cap enforced.

---

## Workstream B — Resurrect CI/CD (day 1–3)

### B1. CI is 100% red; lint gates everything
- **Problem:** All 65 visible Actions runs failed at the Lint job (`.github/workflows/ci.yml` — `build needs:[lint,typecheck]`, `test/e2e needs:[build]`), so the 940-case suite has NEVER run in CI. Reproduce: `npm run lint` → 69 errors / 25 warnings in `@wheelsai/api` (mostly unused-var hygiene; 4 auto-fixable).
- **Fix:** Fix all 69 lint errors (prefer deleting dead imports/vars over `// eslint-disable`). Add `concurrency: {group: ci-${{github.ref}}, cancel-in-progress: true}` to ci.yml. Add db:generate to the lint job if missing (it currently fails type-aware rules without the Prisma client).
- **Done when:** `npm run lint && npm run typecheck && npm run test` green locally; push branch; CI green on GitHub.

### B2. Push the repo; protect main
- **Problem:** local `main` is ~30 commits ahead of `origin/main` (nothing pushed since 2026-03-29); the entire token-launch + bags work has never seen CI.
- **Fix:** Push `main` and `feat/bags-launchpad` (ask the user before pushing if anything looks secret-laden; `.env` files are gitignored — verify with `git status --ignored packages/db`). Enable branch protection on main requiring the lint/typecheck/build/test checks (`gh api` or instruct the user).

### B3. Deploy workflows have a guaranteed build failure
- **Problem:** `deploy-staging.yml`/`deploy-production.yml` run `flyctl deploy` with `working-directory: apps/api` (and `apps/web`), so the Docker build context is the app subdir — but both Dockerfiles `COPY package.json package-lock.json turbo.json ./` and `COPY packages ./packages` from **repo root** (`apps/api/Dockerfile:10-15`). First COPY fails. Never surfaced because CI always failed earlier.
- **Fix:** Run flyctl from the checkout root: `flyctl deploy --config apps/api/fly.staging.toml --dockerfile apps/api/Dockerfile` (flyctl uses cwd as context). Same for web and production workflows.
- **Done when:** a staging deploy succeeds from Actions (coordinate with the user for Fly tokens).

### B4. No migrations in the deploy path
- **Problem:** Neither fly toml has a `[deploy] release_command`; the Docker entrypoint is bare `node apps/api/dist/index.js`; migrations are manual ssh (`scripts/setup-fly.sh:91-92`). With `min_machines_running=2` and rolling deploys, new code boots against an unmigrated DB — the fund-moving tick workers crash-loop on Prisma errors.
- **Fix:** Add `[deploy] release_command = "npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma"` to `apps/api/fly.production.toml` and `fly.staging.toml`. Add a CI job: apply all migrations to a scratch Postgres (service container exists in ci.yml already) then `prisma migrate diff --from-migrations ./packages/db/prisma/migrations --to-schema-datamodel ./packages/db/prisma/schema.prisma --exit-code` to fail on drift.

### B5. BullMQ Redis connection strips auth/TLS — financial workers dead in prod
- **Problem:** `apps/api/src/queues/connection.ts:7-14` extracts ONLY hostname+port from `REDIS_URL`, discarding password, TLS (`rediss://`), db index. Against any managed Redis (Fly/Upstash) all 8 queue workers (token-indexer, treasury-settlement, payment-submit/poll/reap, fee-router, attestation, x402) loop AUTH errors and **no tick ever runs**, while `/health` stays green. This is simultaneously the biggest reliability bug and the only thing that has kept the Workstream-D bugs from burning funds.
- **Fix:** `getQueueConnectionOpts()` → return a shared `new IORedis(env.REDIS_URL, {maxRetriesPerRequest: null})` (BullMQ accepts an ioredis instance). Add a boot assertion: each worker's connection must reach `ready` within 15s or `process.exit(1)`.
- **Test:** unit test parsing `rediss://user:pass@host:6380/2` retains credentials/TLS/db (assert on the ioredis options); integration smoke vs password-protected Redis if available.
- **ORDERING NOTE:** do NOT deploy B5 to production until D1–D4 are merged — B5 un-deadlocks workers that currently have double-billing bugs.

---

## Workstream C — On-chain authority fixes (week 1–2)

### C1. `initialize_treasury` is front-runnable → treasury hijack
- **Problem:** `programs/agent-treasury/src/lib.rs:62-80,206-226`: anyone can call `initialize_treasury` for any mint; `platform_authority` is a plain arg, not a Signer. PDA seed = pump.fun mint (public at launch); the operator's bootstrap runs later. Attacker front-runs init with THEIR authority; the bootstrap probe (`apps/api/src/services/isPdaAccountInitialized.ts:44-48`) checks only the 8-byte discriminator, so `bootstrap-treasury.ts:146-157` flips `programInitialized=true` and the fee router then deposits platform funds into an attacker-drainable vault (`pay_nosana` sends to ANY recipient the recorded authority signs for). No recovery instruction exists → permanent.
- **Fix (program):** require `platform_authority` to be a `Signer` in `InitializeTreasury` accounts (remove it from args). Redeploy to devnet (devnet program IDs in `Anchor.toml`; mainnet not yet deployed, so this is cheap NOW).
- **Fix (client, defense-in-depth):** extend `isPdaAccountInitialized.ts` to decode the account and compare `platform_authority` to the expected key; bootstrap refuses to reconcile on mismatch with a distinct exit code. The fee-router deps should likewise verify before depositing.
- **Test:** LiteSVM test: init without authority signature fails; bootstrap unit test: mismatched authority → no DB flip.

### C2. Authority cross-wiring: bootstrap records a global key, worker signs per-treasury HKDF keys
- **Problem:** `bootstrap-treasury.ts:80-92,165-169` records ONE env pubkey (`BOOTSTRAP_PLATFORM_AUTHORITY`) on every treasury; the submit worker derives a DIFFERENT keypair per treasury via `HKDF(masterKey, info=treasuryId)` (`treasuryKeypairs.ts:52-56`) and uses its pubkey (`buildSubmitPaymentsTickDeps.ts:111,136`). HKDF differs per treasury → `pay_nosana`'s `has_one` fails for every treasury except at most one. The loop cannot pay even after D-fixes.
- **Fix:** bootstrap derives the per-treasury authority with the same provider (`makeTreasurySignerProvider(masterKey)` per treasuryId) instead of one env key. Submit worker: on first use per treasury, fetch the on-chain `Treasury.platform_authority` and assert it equals the derived signer; on mismatch fail the row with error `authority_mismatch` (per-row failure isolation already exists).
- **Test:** unit test that bootstrap and signer-provider produce the same pubkey for the same treasuryId+masterKey.

### C3. No authority rotation — master-key rotation permanently strands all funds
- **Problem:** the program has only 3 instructions; `platform_authority` is immutable post-init (`lib.rs:41-44` defers governance). `treasuryKeypairs.ts:13-16` documents that rotating `WALLET_MASTER_KEY` changes every derived key → rotation (the standard response to compromise) bricks every treasury.
- **Fix:** add `set_platform_authority(new_authority: Pubkey)` instruction — current authority must sign; two-step (propose/accept) preferred; emit an event. Mirror in TS client (`apps/api/src/lib/programs/agentTreasury.ts`) + an operator script `scripts/rotate-treasury-authority.ts` (dry-run flag, per the existing bootstrap CLI style). Also fix `transfer_admin` in reputation-oracle to two-step (`programs/reputation-oracle/src/lib.rs:155-173` is single-step; a typo bricks the oracle).
- **Test:** LiteSVM: old authority rotates, new pays, old can no longer pay; non-authority rotation attempt fails.

### C4. Document the authority/threat model
- **Fix:** write `SECURITY.md` at repo root: privileged-actions matrix (platform key can drain any treasury to any address — custodial **by design**, state it), key derivation scheme, rotation runbook, BPF upgrade-authority holder, incident response. The reviews found this answerable only by reading code; an auditor will demand it.

---

## Workstream D — Make the closed loop actually run (weeks 2–5) — THE PRODUCT

Background: settlement flow = `treasury-settlement.queue` tick → `loadSettlementBatch` → `decideTreasurySettlement` → `persistComputePayments` (PENDING rows) → `payment-submit.queue` tick signs+broadcasts `pay_nosana` → poll/reap lifecycle. Three interlocking bugs make it structurally dead, and a fourth makes "fixing" it dangerous.

### D1. `solBalanceLamports` is never synced from chain — every payment born FAILED
- **Problem:** `decideTreasurySettlement` gates on `treasury.solBalanceLamports < amountLamports` (`apps/api/src/services/treasurySettlement.ts:109`); the column defaults 0 (`schema.prisma:2227`) and **no code anywhere writes it** (verified by grep — bootstrap only flips `programInitialized`; fee-router only bumps `lastFeeRoutedAt`). Every settlement → `FAILED('insufficient_funds')`. Smoke tests passed only because `scripts/seed-test-payment.ts` hand-inserts PENDING rows.
- **Fix:** new tick `runTreasuryBalanceSyncTick` (follow the run/build/load/persist pattern): for treasuries with `programInitialized=true`, `getMultipleAccounts` on their PDAs, write `solBalanceLamports = lamports - rentReserve` + new column `balanceSyncedAt`. Run it at the top of the settlement cycle (call from `treasurySettlementCycle.ts`) AND as its own repeatable job. Settlement must skip treasuries whose `balanceSyncedAt` is older than 5 min (stale-data guard) — add that filter to `loadSettlementBatch`.
- **Migration:** add `balanceSyncedAt DateTime?` to AgentTreasury.
- **Test:** unit: sync writes balance minus rent; settlement skips stale-synced treasuries; integration-style: settlement with synced balance ≥ bill produces PENDING row.

### D2. `lastComputeBillAt` never advances + cost is cumulative → compounding over-billing
- **Problem:** the cooldown filter `lastComputeBillAt === null || < cutoff` (`loadSettlementBatch.ts:117-119`) is permanently true (no writer exists), so every 60s tick re-bills every running tokenized deployment; AND `calculateJobComputeCost` (`computeMetering.ts:74-91`) bills **cumulative job lifetime** (`end - start` since job start), not the delta since last bill. A 10-hour job would be billed ~10 hours of compute every minute the moment D1 lands. `persistComputePayments` (`:56`) uses `createMany` with no unique and no `skipDuplicates`.
- **Fix (one atomic unit):** (1) pass a billing window `[lastComputeBillAt ?? jobStart, now]` into metering; bill `max(0, windowCost)`; (2) in `persistComputePayments`, wrap `createMany` + `updateMany agentTreasury SET lastComputeBillAt=now WHERE id AND lastComputeBillAt <unchanged value>` in one `$transaction` (compare-and-set so concurrent ticks no-op); (3) **migration:** `periodStart/periodEnd DateTime` on ComputePayment + `@@unique([treasuryId, nosanaJobId, periodStart])`, and switch to `createMany({skipDuplicates:true})` (this is exactly the trades pattern in `persistAgentTokenTrades.ts`).
- **Test:** re-run of the same window is a DB no-op; two overlapping ticks produce one row; delta billing pins (job ran 2h, billed 1h ago → bills 1h).

### D3. Payment submit broadcasts BEFORE claiming the row → double-spend on crash/replica-overlap
- **Problem:** `runSubmitPaymentsTick.ts:80-100` loads PENDING, `deps.submit()` signs + `sendRawTransaction` (`buildSubmitPaymentsTickDeps.ts:109-174`), and only afterwards `persistSubmitTransition` claims PENDING→SUBMITTED. Crash (or 2-replica overlap — Fly prod runs `min_machines_running=2` and every replica runs all workers) between broadcast and persist → row still PENDING → next tick re-signs with a FRESH blockhash → two valid transfers. The comment in `persistSubmitTransition.ts:9-14` claiming determinism protects this is false (blockhash differs across ticks).
- **Fix (claim-first protocol):** add `SUBMITTING` status to the payment state machine. Tick: (1) claim: `updateMany {id, status:'PENDING'} → {status:'SUBMITTING', txSignature, lastValidBlockHeight, signedTxB64}` — sign FIRST, store signature + serialized signed tx + lastValidBlockHeight in the claim write, skip row if `count===0`; (2) broadcast the stored bytes; (3) transition SUBMITTING→SUBMITTED on send-success. Recovery (boot + each tick): for SUBMITTING rows, `getSignatureStatuses(searchTransactionHistory:true)` — if landed → SUBMITTED/CONFIRMED; if blockhash still valid → re-broadcast the SAME bytes; if expired and unseen → back to PENDING (re-sign is now safe).
- **Migration:** add `signedTxB64 String?`, `lastValidBlockHeight BigInt?` to ComputePayment; extend the status enum/string.
- **Test (most important in the repo):** simulate crash between claim and broadcast, and between broadcast and transition → exactly one effective transfer; two concurrent ticks → one claims, one no-ops. Update `persistSubmitTransition`'s false doc-comment.

### D4. Reaper force-fails on wall-clock age without a final chain check
- **Problem:** `reapStuckSubmissions.ts:49-62` marks SUBMITTED rows older than 150s FAILED('blockhash_expired') purely on age; `lastValidBlockHeight` is fetched at submit (`submitTreasuryPayment.ts:64-72`) but discarded. The same RPC outage that blinds the poller triggers the reaper → payments that DID land get recorded FAILED (SOL left, books say it didn't).
- **Fix:** with D3's persisted `lastValidBlockHeight`: reap only when `getBlockHeight() > lastValidBlockHeight` AND final `getSignatureStatuses(searchTransactionHistory:true)` returns null. RPC unreachable → do nothing (poller already has this discipline — `runPollPaymentsTick.ts:67-71`).
- **Test:** confirmed-on-chain-but-stale row is NOT reaped; expired+unseen row is.

### D5. Head-of-line blocking: one bad Nosana job halts the whole payment pipeline
- **Problem:** recipient resolution happens inside `loadPendingBatch` in a serial loop (`buildSubmitPaymentsTickDeps.ts:93-106`); `resolveNosanaRecipient` throws on not-found (`resolveNosanaRecipient.ts:38-47`); a loader throw aborts the whole tick (`runSubmitPaymentsTick.ts:76`); the loader re-selects the same first-50 by `scheduledFor asc` forever. The doc-comment claims per-row containment that the wiring doesn't implement.
- **Fix:** move resolution inside the per-row `submit()` closure (whose try/catch already converts throws to FAILED transitions); add `resolutionAttempts Int @default(0)` and park rows (status `PARKED`) after 5 failures.
- **Test:** one unresolvable row → that row FAILED/parked, others proceed.

### D6. Fee router & attestation: broadcast-as-finality + timestamp-watermark misses trades
- **Problem (two related):** (1) `runFeeRouterTick.ts:62-78` and `runAttestationTick.ts:120-128` advance cursors immediately after `sendRawTransaction` returns — dropped txs (no priority fee, congestion) permanently skip fee windows / write phantom `OnChainAttestation` mirror rows (`observedAt` records broadcast, not landing). (2) The fee window is `timestamp > lastFeeRoutedAt` over an at-least-once indexer — late-arriving trades are permanently excluded; a persist-failure after submit re-pays the window (the code's own comment calls for an "operator alert" that doesn't exist).
- **Fix:** route fees by **row identity**: migration adds `feeRoutedBatchId String?` (indexed) on `agent_token_trades` + a `fee_routing_batches` table (treasuryId, txSignature unique, status SUBMITTING/SUBMITTED/CONFIRMED, lamports). Tick: claim a batch (mark trades with batchId + insert batch row in one $transaction) → broadcast → confirm (reuse `pollComputePaymentConfirmation` pattern) → mark CONFIRMED. Unconfirmed/expired batches: un-mark trades, retry. Attestation: same claim→broadcast→confirm shape; write the mirror row only after confirmation, reading true cumulative values from the `AgentReputation` PDA (`readAgentReputationFromChain.ts` exists).
- **Test:** failed submit does not advance/lose the window; late-arriving trade gets a later batch; double-tick claims don't overlap.

### D7. Wire the cursor-based trade indexer (the correct one is dead code)
- **Problem:** the production indexer (`tokenIndexer.ts:101-121`) fetches last-20 trades/30s per token, no cursor/pagination — any token trading >20/30s silently loses trades (under-routes fees, corrupts charts/holders). `PumpFunClient.request` has no timeout/retry/429 handling and swallows errors into `[]` (`pumpfun.ts:55-78,101-119`). The DI rewrite with per-token high-water-mark cursors EXISTS and is TESTED (`runTokenIndexerOuterTick.ts`, `buildTokenTradeIndexerTickDeps.ts`) but has no production caller.
- **Fix:** wire `runTokenIndexerOuterTick` into `queues/token-indexer.queue.ts` (replacing the legacy tick); persist per-token cursors in Postgres; paginate until cursor reached; add AbortController timeout (10s) + retry-with-jitter + 429 handling to `PumpFunClient`; surface fetch-error streaks as a counter (consumed by H2 heartbeats). Delete the deprecated `startTokenIndexerWorker`/`startX402SettlementWorker` setInterval twins (`tokenIndexer.ts:186-212`, `x402Settlement.ts:294`) — they'd double-run ticks if ever invoked.
- **Test:** the rewrite's tests already exist; add one for pagination-until-cursor.

### D8. Real deployment status (today: an 8-second lie)
- **Problem:** `apps/api/src/routes/agents.ts:514-525` flips AgentDeployment to `running` via `setTimeout(8000)` ("Simulate deployment completion"). Eligibility (deployment age), token gating, and settlement all key off this fabricated status; the timer dies on restart.
- **Fix:** new `deployment-status.queue` repeatable tick polling Nosana job state via `@nosana/sdk` for non-terminal deployments; persist observed transitions with timestamps. Remove the setTimeout.
- **Test:** tick maps Nosana states → deployment statuses; restart-safety (no in-memory state).

### D9. Money math: Float → integer
- **Problem:** zero `Decimal` usage in 74 models; `AgentTokenTrade.solAmount/tokenAmount/priceUsd`, `AgentTokenHolder.balance/percentage` are Float (`schema.prisma:2171-2188`) and feed REAL transfers: `loadUnroutedFeesByPrisma.ts:102-112` sums Float and converts `BigInt(Math.floor(sumSol * 0.01 * 1e9))`; holder Float feeds the token-gate access check; `AgentContributor.revenueShare` is Float (`:332`). Raw pump.fun units (1e15) sit near the 2^53 ceiling. Also `BigInt.prototype.toJSON = Number` (`index.ts:11-13`) silently corrupts large values API-wide.
- **Fix:** migration: add BigInt raw-unit columns (`solLamports`, `tokenAmountRaw`) alongside the Floats; indexer writes both; fee math reads BigInt only (sum in SQL); backfill from Floats once; drop Float reads from money paths (keep for display only). `revenueShare` → basis points Int. Remove the BigInt monkeypatch; add a Fastify serializer (or per-DTO `.toString()` like `payments.ts:98-99` already does).
- **Test:** conservation property test: Σ routed fee lamports ≤ 1% of Σ trade lamports; serializer round-trips > 2^53.

### D10. End-to-end devnet loop smoke (the proof artifact)
- **Fix:** script `scripts/loop-smoke.ts` + runbook: launch (partial-sign against devnet) → simulate trades (or seed) → fee route → balance sync → settle → pay_nosana → poll confirm → attest → `readAgentReputationFromChain` — assert every hop, print the tx-chain. Wire as a manually-triggered CI job against devnet. This doubles as the public "replayable receipts" demo from the strategy.

---

## Workstream E — Productize the moat + frontend integrity (weeks 3–8)

### E1. Mount the transparency surfaces (the moat is dark code)
- **Problem:** complete, tested DI route factories are never registered in `index.ts:161-208`: `publicAgent.ts` (its own header: "the single most differentiated artifact in the product"), `agentDetail.ts`, `agentList.ts`, `launch.ts`, `channelWebhooks.ts`. The A6 channel pipeline worker (`queues/agent-message.worker.ts`) is never instantiated.
- **Fix:** mount `publicAgent` + `agentDetail` + `agentList` now (follow how `tokenLaunchPartialSignBindings` builds production deps). `launch.ts`/channel pipeline: create explicit feature-flag work items — mount behind flags or delete; no more ambient dead code.
- **Test:** route tests against the mounted paths (the factories already have tests — add binding-level ones).

### E2. Public `/a/:slug` substance page (web)
- **Fix:** new public page consuming the mounted publicAgent endpoint: headline = treasury balance, cumulative compute paid, uptime, attested usage, reputation tier, with Solscan links to the treasury PDA and recent pay_nosana txs. Server component (it's public/SEO). This page IS the marketing.

### E3. Substance on the buy decision + ranking
- **Problem:** marketplace listing API returns zero substance fields; `apps/web/src/app/marketplace/[slug]/page.tsx:560-656` shows rating/installs/mcap/holders only (it imports a `Shield` icon at `:14` and never renders it); sort options are popular/rating only (`marketplace/page.tsx:27-30`) — the exact hype metrics the strategy rejects.
- **Fix (api):** extend the marketplace listing response with substance fields (uptime %, requests 30d, treasury lamports, computePaid lamports, reputation score, eligibilityVerified bool) — joins exist in the agentDetail loaders. Add server-computed `substanceScore` (weighted: uptime × log(usage) × runway × reputation; document the formula in code). Default sort = substance.
- **Fix (web):** Substance panel + "Eligibility verified" badge on `marketplace/[slug]` and token pages; default marketplace sort to substance with popular/rating as secondary toggles.

### E4. Delete fabricated public data
- **Problem:** `/explore` (`apps/web/src/app/explore/page.tsx:31-111`) ships six hardcoded fake agents with fake ratings/installs/token prices/GRADUATED badges on the public internet — self-refuting for a credibility-branded platform. The waitlist form (`waitlist/page.tsx:52-56`) stores emails in the visitor's own localStorage and claims success.
- **Fix:** redirect `/explore` → `/marketplace` (the real page already fetches live listings + trending). Waitlist: one-table Fastify route + real POST, or delete the page.

### E5. Frontend auth architecture (none exists)
- **Problem:** no `middleware.ts`, no 401 handling anywhere (`api()` in `apps/web/src/lib/api.ts:22-42` — zero `401` matches in src), `authApi.refresh`/`me` have zero callers, dashboard shells render fully logged-out and degrade into toast spam.
- **Fix:** (1) `apps/web/src/middleware.ts`: presence-check the `wheelsai_token` cookie, redirect `/dashboard/*` → `/login?next=...`; (2) `api()`: on 401, attempt `authApi.refresh()` once, retry, else hard-redirect to login; (3) session context at the `(dashboard)` layout calling `authApi.me`, rendering identity in the sidebar; (4) logout must `await disconnect()` the wallet adapter and `window.location.assign('/login')` (today the next user on a shared machine auto-reconnects the previous wallet — `sidebar.tsx:121-128`).

### E6. `api()` parses JSON before checking `res.ok`
- **Problem:** `api.ts:35` runs `await res.json()` unconditionally — any non-JSON 5xx (proxy HTML, empty body) throws raw SyntaxError, so every `err?.data?.*` recovery branch breaks — **including the launch wizard's `persistence_failed` detection** (`create/page.tsx:212-217`), exactly in infrastructure-failure scenarios.
- **Fix:** check `res.ok` first; `const data = await res.json().catch(() => null)`; always throw typed `ApiError` (status, data, fallback message from `res.statusText`); wrap network failures in a distinct `NetworkError`.
- **Test:** unit tests: HTML-body 502 and empty 500 → ApiError with status.

### E7. Launch wizard double-mint window
- **Problem:** recovery only arms on structured `persistence_failed` (`create/page.tsx:212-217`); any other submit failure (timeout, 504 AFTER server broadcast) falls to a generic toast and re-enables Create → user signs a SECOND mint + dev-buy.
- **Fix:** immediately after `signTransaction`, persist `{mintAddress, txSignature, prepareToken}` to state AND sessionStorage; on ANY submit failure enter the recovery panel driving the (already idempotent) `reconcileLaunch`; clear stored state only on confirmed tokenId; survive page refresh via sessionStorage.
- **Test:** Playwright (see I3): kill the API between sign and submit → recovery panel appears, reconcile succeeds.

### E8. Front-door legibility + theme unification
- **Problem:** root layout hardcodes `<html class="dark">` (`layout.tsx:55`); auth labels use `text-gray-700` which the gray-remap maps to `#1a2744` on a `#0a1424` card ≈ 1.3:1 contrast — **Email/Password labels are invisible** (`login/page.tsx:65,85`, `register/page.tsx:69,89,109`). Three theme regimes fight (hardcoded dark / dashboard-only system-default provider / light-hardcoded public marketplace pages).
- **Fix:** sweep (auth) pages + `wallet-button.tsx` to token classes (`text-foreground`/`text-muted-foreground`); replace the custom ThemeProvider with `next-themes` mounted at root (no-flash script), remove the hardcoded class; convert public marketplace chrome to token classes. Add axe-core contrast check to Playwright for /login in both themes.

### E9. Marketplace install flow + broken navigation
- **Problem:** `marketplaceApi.installAgent` (`api.ts:1077`) has ZERO callers — the core discover→install→revenue loop is unreachable; the public listing CTA "Deploy Agent" is a bare `/login` link with no next-redirect (`[slug]/page.tsx:726-732`); publisher links 404 (`/marketplace/publisher/:id` route doesn't exist — `:309,833`); `/docs` 404s; no root `not-found.tsx`/`error.tsx`; the listing's token tab finds its token by listing 50 and `.find()`ing client-side (breaks at >50 tokens — `:158-161`); sidebar "Browse Agents" opens a my-listings page.
- **Fix:** build the authed install flow (plan selection per the locked pricing matrix: Free/Per-request/Monthly/Tokenized) wired to `installAgent`; CTA → `/login?next=/marketplace/{slug}`; add `GET /api/tokens/by-listing/:listingId` and use it; add branded root `not-found.tsx`/`error.tsx`; remove or implement publisher/docs links; rename the sidebar item.

### E10. Cut the sprawl (product decision already made: credibility over breadth)
- **Problem:** 28 nav items (`sidebar.tsx:64-108`); confirmed shells: Scheduler computes nextRun but **no worker executes tasks** (no scheduler queue exists); custom-domain SSL is `setTimeout(2000)` flipping `sslStatus='active'` with a fabricated expiry (`domains.ts:345-393`); SSO stores config (clientSecret as plaintext `Buffer.from` — `enterprise.ts:439`) with **no ACS/callback/login flow**; the monitoring product's `triggerAlert` has zero callers and email alerts are console.log (`monitoring.ts:415-417,604-608`).
- **Fix:** hide behind a `NEXT_PUBLIC_ENABLE_LABS` flag (default off): Scheduler, Domains, Testing, Versioning, Orchestration, Memory, Knowledge, Monitoring, Training. Keep: Agents/Playground/Templates, Marketplace, Deployments, Billing, Keys, Settings, OpenClaw (it's real). SSO: remove the surface until E11. Remove the decorative notification bell (`header.tsx:26-28`). Do NOT delete backend code yet — flag the UI, file deprecation decisions per module with a delete-by date.

### E11 (later). Real SSO
- If/when enterprise sales need it: openid-client OIDC code flow + ACS endpoint, secrets encrypted with the existing AES-256-GCM `encryptConfig` helper, session minting through the existing JWT path. Until then the surface stays hidden (a config-only SSO is worse than none).

---

## Workstream F — API platform layer (weeks 4–8)

### F1. ZodError → 400 (8-line fix, do first)
- `index.ts:211-230` global error handler lacks a ZodError branch — ~14 route files calling bare `.parse()` turn invalid input into 500s. Add: `if (error instanceof ZodError) return reply.code(400).send({error:'validation_failed', details: error.flatten()})`.

### F2. Validation coverage: 17 route files have ZERO runtime validation
- Blind casts like `request.body as {name: string; config: any}` across memory/monitoring/billing/webhooks/testing/knowledge/scheduler/orchestration/templates/twoFactor/versioning/domains/analytics/enterprise/agentGraph routes.
- **Fix:** adopt `fastify-type-provider-zod`; add zod schemas to every mounted handler in those files (start with the money/auth-adjacent ones: billing, twoFactor, webhooks, enterprise). Add an ESLint `no-restricted-syntax` rule banning `request.body as` in `src/routes`.

### F3. One error envelope + pagination convention
- Five envelope shapes and three pagination dialects coexist. Declare the DI-factory style the winner (`{error:'snake_case_code', details?}`); enforce centrally in the error handler; document cursor pagination; migrate legacy files opportunistically (don't big-bang).

### F4. RBAC: `request.auth` has no role
- Any freshly-invited member can read audit logs, configure SSO, mint credits. **Fix:** include org role in the JWT/auth context (membership is looked up at login — `services/auth.ts`); add `requireRole('owner'|'admin')` preHandler; apply to enterprise, billing, settings, domains, payout, and destructive routes. Fix API-key principals getting `userId: ""` (`middleware/auth.ts:118`) → make it `string|null` and add `requireJwtAuth` on user-identity routes (2FA — `twoFactor.ts:27-84` currently reachable with API keys).
- **Test:** table-driven role matrix over the privileged routes.

### F5. Tenancy enforcement + org-isolation harness
- Org scoping is hand-threaded `orgId` in ~40 files. **Fix:** (1) write the table-driven org-isolation test harness FIRST (authed as org B, every GET/PATCH/DELETE with org A's ids → 404/403) — this finds today's IDORs; (2) add a Prisma client extension that requires `orgId` in where-clauses for tenant-owned models (escape hatch: explicit `bypassTenancy()` for system jobs).

### F6. Rate limiting & trustProxy
- `trustProxy: true` (`index.ts:85`) trusts any spoofable X-Forwarded-For; the global 100/min IP limit both fails (evasion) and hurts (NAT'd customers, including paid `/v1` inference). **Fix:** set trustProxy to the Fly hop count (1); key the limiter on `request.auth` (org/API key) with IP fallback; separate tier for `/v1` (billing is its backpressure); keep stricter auth-route overrides.

---

## Workstream G — Ledger & data integrity (weeks 4–8)

### G1. Credit ledger discipline
- `inference.ts:206-225` computes `balanceAfter` from a stale pre-request read (concurrent requests → unreconcilable ledger), no floor (balance can go negative). **Fix:** single transaction: `updateMany({where:{orgId, balanceCents:{gte:cost}}, data:{decrement}})`, 402 on count=0; `balanceAfter` from the post-update value; idempotency key (requestId) unique on usage CreditTransactions.

### G2. Creator payout TOCTOU
- `marketplace.ts:976-1010`: findFirst-then-create (two concurrent → double payout), create + `pendingPayoutCents=0` reset not in a transaction, reset writes literal 0 destroying concurrently-accrued revenue. **Fix:** one `$transaction` with atomic conditional `decrement: amount` (abort on count=0); partial unique index `creator_payouts(publisher_id) WHERE status IN ('pending','processing')`.

### G3. Usage recording loses rows
- `inference.ts:236-246` upsert races on first-write (P2002 swallowed by `.catch` → billable usage dropped), fire-and-forget. **Fix:** catch P2002 → retry as update; move to a durable BullMQ job (infra exists).

### G4. Constraints over comments (migration batch)
- Add: unique on `WebhookDelivery.eventId` (comment claims idempotency; index isn't unique); unique `(conversationId, sequenceNum)` on Message; missing FKs on bare-string relation columns (TwoFactorChallenge.userId etc. — audit the ~1/3 without FKs); convert the ~30 string status machines to Prisma enums (start with money: ComputePayment, CreditTransaction, AgentToken, CreatorPayout); indexes on `AgentTransaction.walletId`, `ApiKey.orgId`, `AgentDeployment.status`.

### G5. Encrypt what claims to be encrypted
- `Webhook.secret` plaintext; `AlertChannel.config` comment claims encryption it doesn't have; SSO clientSecret `Buffer.from` plaintext. **Fix:** run all through the existing AES-256-GCM `encryptConfig` helper (openclaw service has the pattern); migration re-encrypts existing rows.

### G6. Financial history must survive org deletion
- Org deletion hard-cascades every ledger (CreditTransaction, payouts, ComputePayment, token/treasury chain). **Fix:** `deletedAt` soft-delete on Organization; switch financial relations from `onDelete: Cascade` to `Restrict`; offboarding = soft-delete + anonymize PII, never destroy ledgers.

### G7. Retention & mutability
- Trade rows are mutable (`agentToken.ts:495-517` upsert overwrites history → make update a no-op on existing txSignature); per-tick snapshots and FAILED-payment spam grow unbounded → retention/pruning tick for AgentTokenSnapshot + holder rows; audit log misses every money event → emit AuditLog entries from billing/payout/launch/payment paths (service exists — `enterprise.ts`).

---

## Workstream H — Reliability & observability (weeks 3–8)

### H1. Real `/metrics` + error tracking
- Fly scrapes `/metrics` (`fly.production.toml:41-43`) which doesn't exist; zero Prometheus/OTel/Sentry anywhere. **Fix:** `prom-client` registry at `/metrics` (no auth, bind to Fly's scrape): per-queue `getJobCounts`, tick duration + lag histograms (duration vs interval is THE saturation signal), payment-state gauges, indexer freshness, RPC error counters. Wire Sentry (`SENTRY_DSN` already in env) with worker exception capture.

### H2. Worker heartbeats in shared store
- The "indexer metrics" endpoint reports `enabled:false` forever (set only by the deprecated worker — `tokenIndexer.ts:32-48,195-197`) and counters are per-process in a 2-replica deploy. **Fix:** `worker_heartbeats` table (or Redis hash): queue → lastTickAt, lastDurationMs, lastError, counters; written at tick end; `/api/tokens/indexer/metrics` and `/health/ready` read from it; alert (H1 metric) when a queue's heartbeat exceeds 3× its interval.

### H3. Separate worker process; stop double-scheduling
- Every HTTP replica runs all 8 workers; deploy/restart interrupts ticks mid-flight (the D3 window); 2 replicas double-schedule overlap-capable repeatable jobs. **Fix:** `WORKER_MODE` env: `api` (HTTP only) / `worker` (queues only) / `all` (dev default). Fly: add a worker process group with `min_machines_running=1` for workers, 2 for api. BullMQ repeatable jobs schedule once regardless of replicas, but ticks must remain claim-first (D3) anyway.

### H4. RPC resilience
- `lib/solana.ts:19-28`: one Connection, devnet silently ignores `SOLANA_RPC_URL` (hard-pins public devnet), no timeout (web3.js can hang minutes), no retry, no fallback; `x402Settlement.ts:550-558` duplicates a second flawed Connection. **Fix:** honor `SOLANA_RPC_URL` on every network; custom fetch with AbortSignal timeout (15s); `withRpcRetry` helper (jitter, classify 429/5xx); optional `SOLANA_RPC_FALLBACK_URLS`; single shared module. Add ComputeBudget + priority-fee instructions to all program txs (`treasuryProgramTransferTx.ts`, `feeReceiveTx.ts`, `submitAttestationTx.ts`) — env-tunable microLamports.

### H5. Health checks that mean something
- `/health` returns ok unconditionally; `/health/ready` news up an ioredis client per probe (`health.ts:28-35`). **Fix:** reuse a lazy module-level Redis client (pattern: `tokenGate.ts:13-30`); `/health/ready` = DB ping + Redis ping + (worker mode) queue heartbeat freshness; point Fly checks at it.

### H6. Graceful shutdown + process guards
- Shutdown is unbounded and single-shot-unguarded; no `unhandledRejection`/`uncaughtException` handlers (`index.ts:254-269`). **Fix:** 30s shutdown deadline then exit(1); second signal → immediate exit; process-level handlers that log + Sentry + exit nonzero (supervisor restarts).

### H7. Token gate verifies on-chain
- `middleware/tokenGate.ts:194-210` authorizes against a Float DB snapshot from the 30s poller (sold-29s-ago passes; transfer-received holder denied) and fails open on Redis errors. **Fix:** gate decisions via `getParsedTokenAccountsByOwner` with a 30s Redis cache; DB snapshot for display only; fail closed on errors for token-gated routes (document the choice).

### H8. SOL price fallbacks
- `treasury-settlement.queue.ts:25-30` falls back to SOL=$100 in settlement math; `wallet.ts:22` uses $150. **Fix:** on mainnet, a stale-beyond-threshold oracle ABORTS settlement (skip tick, alert) instead of substituting a constant; constants allowed only on devnet.

---

## Workstream I — Testing & quality gates (continuous, start week 2)

### I1. Real DB-backed test tier
- The 4 "integration" tests monkey-patch Prisma — CI's Postgres/Redis containers exercise nothing; no test in the repo runs real SQL. **Fix:** CI test job runs `prisma migrate deploy` against the service container, then runs the ~30 `load*ByPrisma`/`persist*` modules against the real client (the DI seams make this near-free: same tests, real client injected). Rename current "integration" tests to `*.stubbed.test.ts`.

### I2. Backfill by blast radius (not coverage %)
- Zero tests exist for: marketplace (payouts), billing, openclaw config crypto, 2FA, enterprise/SSO, webhooks, wallet budget. **Minimum set:** org-isolation harness (F5) across all authed routes; openclaw `encryptConfig`/`decryptConfig` round-trip + wrong-key; Stripe webhook signature + idempotency (when A1's real Stripe lands); TOTP accept/reject/replay-window.

### I3. E2E that can fail
- The Playwright suite passes with the backend down: `expect(a||b||c)` tautology (`agents.spec.ts:22`), `if (visible)` guards, dead `authedPage` fixture (zero importers), API never booted in CI. **Fix:** boot the API in the e2e job (migrate + seed a user + `node dist/index.js &`); adopt the authedPage fixture; deterministic specs: login-redirect (strict), register→create-agent, launch wizard through review with a mocked wallet-standard provider, E7's recovery-panel path; delete every conditional assertion; add axe contrast check for /login (E8).

### I4. Money-math property tests
- fast-check over fee routing (Σ routed ≤ 1% Σ volume, no negative amounts), metering delta-billing (Σ window bills == cumulative cost), and D3's claim protocol (any crash point → ≤1 effective transfer).

### I5. Anchor program CI + adversarial tests
- The LiteSVM suites run in no pipeline. Add a CI job (`cargo test` for both programs; cache the toolchain). Add adversarial cases: C1 front-run with hostile authority, pay-to-self/pay-to-treasury, multi-treasury authority isolation, equal-unix_ts attestation replay. Fix the toolchain skew (Anchor.toml pins solana 3.0.0 vs litesvm tests on solana-sdk 2.1) by aligning versions.

### I6. Hygiene gates
- `knip`/`depcheck` in CI (web declares trpc/next-auth/zod/react-query unused while bs58 is used-but-undeclared — declare bs58 NOW, it can break wallet login on a lockfile shuffle); coverage floor on `src/services` money modules; ESLint bans: `as never` in api src, raw `fetch(API_URL` outside `apps/web/src/lib/`, `request.body as` in routes.

---

## Frontend data-layer note (do during E-work, not as a big-bang)

55/61 web pages are 'use client' with hand-rolled useEffect fetching; react-query is mounted but has ZERO uses; `api.ts` is a 3,837-line hand-typed client with 10 files bypassing it via raw fetch. Policy for all NEW/touched pages: public pages (marketplace, /a/:slug) = server components with server fetch + generateMetadata; dashboard pages = react-query hooks wrapping the typed client; split `api.ts` by domain under `src/lib/api/`; move shared DTOs into `@wheelsai/types` (it's already in transpilePackages, never imported) so client and Fastify share one contract. Debounce the marketplace search (currently `router.push` per keystroke firing 4 endpoints — `marketplace/page.tsx:237-251,292,351`).

---

## Strategy guardrails (context for product-affecting tickets; from live June-2026 research)

- Virtuals: ~$400M mcap (−87%), revenue −96% before a $1M/month subsidy, Solana arm failed (8.3% graduation; 90% of activity on Base), 18K agents with **no public alive/dead accounting**. The wedge: *provably-alive, self-funding agents on Solana with public receipts* — D10's tx-chain demo and E2's substance page are the strategy, not nice-to-haves.
- Do NOT: ship a platform token; promise holder revenue distributions (SEC Jan-2026 tokenized-securities statement — keep fees agent-directed: treasury/compute only); compete on launch volume with pump.fun/Bags/Clanker; subsidize fake agent usage (poisons the thesis); chase multi-chain before Solana depth.
- Eligibility-gate integrity: usage metrics are currently farmable by the creator's own org. When extending eligibility (`tokenEligibility.ts`), weight externally-paid usage (x402-verified, distinct payers) over raw request counts.
- Proof-point bar before marketing "credible marketplace": 10–25 tokenized agents with 90+ days attested uptime + real external revenue; public mainnet loop demo; third-party program audits; published gate stats including rejections; the category KPI = % of agent tokens still serving requests at 90 days.

## Known gap

The dedicated security-dimension review was cut off (session limits). Security findings above came from the other reviewers (auth, keys, on-chain, tenancy). After Workstreams A–C land, run a focused security pass: secrets archaeology, dependency audit (`npm audit`, lockfile), SSRF re-check on `fetchImageBytes.ts`/webhooks, full OWASP sweep of the legacy routes.

## Verification (global)

- After every ticket: `apps/api` unit suite green, both apps `tsc --noEmit` green.
- After B: CI fully green on GitHub including a successful staging deploy.
- After D: `scripts/loop-smoke.ts` passes against devnet; kill -9 chaos test shows exactly one transfer per payment.
- After E: Playwright journey (register→agent→deploy→launch→substance panel) green; axe contrast green on /login both themes.
- After F/G: org-isolation harness green across all routes; `prisma migrate diff` clean in CI.
- After H: Fly scrapes real metrics; heartbeat alert fires when a queue is paused in staging.
