# Deploy Runbook — Fly.io Staging & Production (B7)

The corrected end-to-end sequence for standing up an environment.
`scripts/setup-fly.sh` prints the same steps interactively;
`apps/api/src/config/env.ts` is the source of truth for every variable —
when this document and the schema disagree, the schema wins.

## Blockers that are USER actions

1. **GitLab runner identity verification** — CI has NEVER executed
   (1,400+ tests, zero CI runs). Until GitLab verifies the account, no
   pipeline — including the deploy jobs below — runs at all.
2. **Fly.io account with billing** — apps, Postgres, and Upstash Redis
   below are paid resources.
3. **FLY_API_TOKEN in GitLab** — `flyctl tokens create deploy -x 999999h`,
   then Settings → CI/CD → Variables, masked + protected. The deploy jobs
   in `.gitlab-ci.yml` only appear when this variable exists.

## 1. Create apps + infra (once per environment)

```bash
bash scripts/setup-fly.sh          # prompts staging/production, creates apps
flyctl postgres create --name wheelsai-db-<env> --region lax
flyctl postgres attach wheelsai-db-<env> --app wheelsai-api[-staging]
flyctl redis create --name wheelsai-redis-<env> --region lax
flyctl redis attach wheelsai-redis-<env> --app wheelsai-api[-staging]
```

`postgres attach` injects `DATABASE_URL`; `redis attach` injects
`REDIS_URL`. Neither needs to be set by hand.

Postgres must have the `vector` extension available (migration
`20260808001344_pgvector_embeddings` runs `CREATE EXTENSION vector`).
Redis must use `maxmemory-policy noeviction`, or BullMQ loses jobs.

`TRUST_PROXY_HOPS` defaults to 1 (Fly's edge). Set it to 0 only if nothing
sits in front of the API, or client IPs (and every per-IP rate limit)
become attacker-controlled.

## 2. API secrets

Boot-fatal without these outside development, staging included (`validateEnv`):

| Secret | Note |
| --- | --- |
| `JWT_SECRET` | ≥32 chars |
| `ENCRYPTION_KEY` | ≥32 chars, **must differ from JWT_SECRET** |
| `CORS_ORIGIN` | the real web origin — localhost is refused outside development (staging included) |
| `COOKIE_DOMAIN` | the shared parent domain (e.g. `.wheelsai.app`) when web and API run on sibling subdomains; without it the web middleware never sees the session and loops users back to /login |
| `SOLANA_RPC_URL` | **production only, and non-negotiable**: the schema default is the DEVNET endpoint, and `SOLANA_NETWORK=mainnet-beta` (set in `fly.production.toml`) refuses to boot without an explicit non-devnet URL. May carry an API key (Helius/Triton) — that's why it's a secret, not toml `[env]`. |

Platform keys:

| Secret | Note |
| --- | --- |
| `WALLET_MASTER_KEY` | HKDF root for treasury/creator/deposit keys. Set ONCE, back it up; rotation changes every derived address. Required whenever token launch or wallet top-ups are enabled. |
| `NOSANA_WALLET_PRIVATE_KEY` | GPU job submission |
| `SENTRY_DSN` | optional — error tracking switches on when present |

Optional rails (each is gated; endpoints answer 501 honestly until configured):

| Rail | Secrets |
| --- | --- |
| Stripe checkout (T3/T4) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Wallet top-ups (T5) | `WALLET_TOPUPS_ENABLED=true` (+ `WALLET_MASTER_KEY`); the SOL test rail (`ALLOW_DEVNET_WALLET_TOPUPS`) is boot-fatal in production — USDC only |
| x402 pay-per-request (T7) | `X402_ENABLED=true`, `X402_SUBMIT_TRANSACTIONS=true`, `X402_SETTLEMENT_WORKER_ENABLED=true`, `TREASURY_WALLET_ADDRESS=<real pubkey>` — the all-ones default is boot-fatal |

```bash
flyctl secrets set -a wheelsai-api[-staging] KEY=value …
```

## 3. Web build args (NOT secrets)

`NEXT_PUBLIC_*` is baked into the browser bundle by `next build` — a
runtime secret does **nothing** for it, and without the build arg the
deployed web app calls `http://localhost:4000`. Pass at deploy:

```bash
--build-arg NEXT_PUBLIC_API_URL=https://wheelsai-api[-staging].fly.dev
--build-arg NEXT_PUBLIC_APP_URL=https://wheelsai-web[-staging].fly.dev
```

(The old GitHub deploy workflow omitted these — any bundle it shipped
pointed at localhost.)

## 4. Deploy

From the **repo root** (the Dockerfiles COPY the monorepo root — running
from `apps/*` fails at the first COPY). Migrations run automatically via
the `release_command` in the fly tomls before machines are replaced.

```bash
flyctl deploy --config apps/api/fly.staging.toml --dockerfile apps/api/Dockerfile --remote-only
flyctl deploy --config apps/web/fly.staging.toml --dockerfile apps/web/Dockerfile --remote-only \
  --build-arg NEXT_PUBLIC_API_URL=https://wheelsai-api-staging.fly.dev \
  --build-arg NEXT_PUBLIC_APP_URL=https://wheelsai-web-staging.fly.dev
```

Or via CI once the runner is verified: the `deploy:staging:api` /
`deploy:staging:web` jobs (`.gitlab-ci.yml`, manual trigger, default
branch only) run exactly these commands after the unit + migration gates.

## 5. Smoke

```bash
curl -fsS https://wheelsai-api-staging.fly.dev/health/ready   # probes PG+Redis, 503 when broken
curl -fsS https://wheelsai-web-staging.fly.dev/api/health
```

`/health/ready` is the readiness probe the Fly checks use; `/health`
answers 200 unconditionally and proves nothing.

## 6. One-time data steps after the first deploy

- The model catalog syncs itself at boot (log line "Model catalog synced");
  no seed step is needed for model deployments. Never run `seed-demo.ts`
  against a real database.
- Seal agent secrets written before encryption existed (run with the
  API's `ENCRYPTION_KEY`; dry run first):

  ```bash
  flyctl ssh console -a wheelsai-api[-staging] -C "node apps/api/dist/seal-agent-env.js"
  flyctl ssh console -a wheelsai-api[-staging] -C "node apps/api/dist/seal-agent-env.js --apply"
  ```

## Known good / known gaps

- Boot assertions verified by unit tests: mainnet⇒non-devnet RPC,
  ENCRYPTION_KEY≠JWT_SECRET, CORS pinned, mock gates off in production,
  x402 treasury real, wallet-topup master key present.
- No staging environment has actually been stood up yet — this runbook
  is the corrected procedure, executed zero times. First real run should
  be staging, manually, before wiring the CI trigger habitually.
