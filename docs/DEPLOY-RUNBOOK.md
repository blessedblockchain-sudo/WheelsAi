# Self-hosting WheelsAI

This guide is for operators who run their own WheelsAI: the API, the web app, the background
workers, the edge proxy that serves custom domains, and the image that runs fine-tuning jobs. It
covers what you need, how to configure each part, how to deploy and upgrade it, and how to check
that it is healthy.

The examples use [Fly.io](https://fly.io), which the repository ships configuration for
(`apps/*/fly.*.toml`, `infra/edge/fly.*.toml` and `scripts/setup-fly.sh`). Any container host
works with the same Dockerfiles and settings.

Two files are the reference for every setting:

- `apps/api/src/config/env.ts` validates the API's settings when it starts. When this guide and
  the schema disagree, the schema wins.
- `.env.example` lists every setting with its default and a one-line explanation.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Create the apps and infrastructure](#2-create-the-apps-and-infrastructure)
3. [Configure the API](#3-configure-the-api)
4. [Configure the web app](#4-configure-the-web-app)
5. [Deploy the API and the web app](#5-deploy-the-api-and-the-web-app)
6. [Health checks and first-run steps](#6-health-checks-and-first-run-steps)
7. [Custom domains: the edge proxy](#7-custom-domains-the-edge-proxy)
8. [Background workers](#8-background-workers)
9. [GPU compute on Nosana](#9-gpu-compute-on-nosana)
10. [Fine-tuning: storage and the training image](#10-fine-tuning-storage-and-the-training-image)
11. [Upgrades and migrations](#11-upgrades-and-migrations)
12. [Rotating secrets](#12-rotating-secrets)

## 1. Prerequisites

To build and deploy:

- Node 22.13 or newer, and Docker.
- The `flyctl` CLI if you follow the Fly examples.

To run:

| Component | Requirement |
| --- | --- |
| API | One container from `apps/api/Dockerfile`. The background workers run inside it. |
| Web app | One container from `apps/web/Dockerfile`. |
| PostgreSQL | With the `vector` extension available (pgvector). A migration runs `CREATE EXTENSION vector`. |
| Redis | With `maxmemory-policy noeviction`. Any eviction policy loses queued jobs. |
| Edge proxy | Optional: only for custom domains. One container from `infra/edge/Dockerfile` with a dedicated public IPv4 address. |

Accounts, for the features you turn on (each one is covered in section 3):

| Feature | You need |
| --- | --- |
| GPU deployments and fine-tuning | A Nosana account: an API key with prepaid credits, or a funded Solana wallet (section 9) |
| Solana features in production | A paid Solana RPC endpoint |
| Free models in the playground | Keys from Groq, Google Gemini and Together |
| Email (verification, password reset, alerts) | A Resend account and a sending address |
| Card payments and the Pro plan | A Stripe account with a recurring Pro price |
| Datasets, adapters and agent files | An S3-compatible bucket (AWS S3 or Cloudflare R2) |
| Gated base models for fine-tuning | A Hugging Face token with the model licences accepted |
| Code interpreter and graph code nodes | A sandbox runner service |
| Web search for agents | A Tavily API key |
| Error tracking | A Sentry DSN |

## 2. Create the apps and infrastructure

Once per environment:

```bash
bash scripts/setup-fly.sh          # asks for staging or production, creates the apps
flyctl postgres create --name wheelsai-db-<env> --region lax
flyctl postgres attach wheelsai-db-<env> --app wheelsai-api[-staging]
flyctl redis create --name wheelsai-redis-<env> --region lax
flyctl redis attach wheelsai-redis-<env> --app wheelsai-api[-staging]
```

`postgres attach` sets `DATABASE_URL` on the API and `redis attach` sets `REDIS_URL`, so neither
needs to be set by hand. Check that the Postgres image offers the `vector` extension and that
Redis uses `maxmemory-policy noeviction`.

`TRUST_PROXY_HOPS` is the number of reverse proxies in front of the API, 1 by default (Fly's
edge). Set it to 0 only if nothing sits in front of the API. A wrong value lets clients choose
their own IP address, which defeats every per-IP rate limit.

## 3. Configure the API

Set secrets with your host's secret store. On Fly:

```bash
flyctl secrets set -a wheelsai-api[-staging] KEY=value …
```

Outside development, staging included, the API refuses to start when a required setting is
missing or unsafe, and prints which one.

### 3.1 Required

| Setting | Note |
| --- | --- |
| `JWT_SECRET` | At least 32 characters. Signs sessions, signed cookies and fine-tuning callbacks. |
| `ENCRYPTION_KEY` | At least 32 characters, and **different from `JWT_SECRET`**. Encrypts agent secrets and channel settings at rest. |
| `CORS_ORIGIN` | The web app's origin. `localhost` is refused outside development, staging included. |
| `SOLANA_RPC_URL` | Production: a mainnet RPC endpoint. `SOLANA_NETWORK=mainnet-beta` (set in `fly.production.toml`) refuses to start without an explicit mainnet URL. It may carry an API key, so keep it a secret rather than a plain setting. The API uses this endpoint on every network, devnet included (before, devnet always went to the public devnet node whatever was set here). In production the API refuses to start with `WALLET_TOPUPS_ENABLED`, `PAYOUTS_ENABLED` or `X402_ENABLED` on unless `SOLANA_NETWORK=mainnet-beta`; staging and development may run them on devnet. |

### 3.2 Public origins

| Setting | Note |
| --- | --- |
| `COOKIE_DOMAIN` | The shared parent domain (for example `.example.com`) when the web app and the API run on sibling subdomains. Without it the web app never sees the session and sends users back to the sign-in page. |
| `PUBLIC_API_URL` | The API's public HTTPS origin. Used for the endpoints shown to users, OAuth redirects, Telegram webhooks, and the addresses GPU nodes call back for fine-tuning. |
| `PUBLIC_WEB_URL` | The web app's public origin, used in email links and listing URLs. Falls back to `CORS_ORIGIN`. |

### 3.3 Platform keys

| Setting | Note |
| --- | --- |
| `WALLET_MASTER_KEY` | The root secret from which treasury, creator and deposit keys are derived. Set it once and back it up: changing it changes every derived address (section 12). Required when token launches or wallet top-ups are on. |
| `NOSANA_API_KEY` or `NOSANA_WALLET_PRIVATE_KEY` | Pays for GPU jobs (section 9). |
| `PLATFORM_ADMIN_KEY` | At least 16 characters. Unlocks marketplace curation and the operator view of GPU compute, `GET /api/platform/compute` with the header `x-admin-key`. |
| `METRICS_TOKEN` | Bearer token for `GET /metrics` when that path is reachable outside your private network. |
| `SENTRY_DSN` | Optional. Error tracking starts when it is set. |

### 3.4 Features

Every feature below is off until its settings are present. While a feature is off, its endpoints
answer with a named error code (usually `501`, `503` for storage) and nothing is charged, and the
dashboard tells users the feature is temporarily unavailable. The codes are listed in the API
reference at `/docs/api` on the web app.

| Feature | Settings |
| --- | --- |
| Email | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`. Without email, verification, password reset and alert emails answer `501`, and new accounts cannot verify, so they never receive the signup credits. `EMAIL_PROVIDER=log` is refused outside development. |
| Card payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`. Point a Stripe webhook at `https://<api>/api/billing/stripe/webhook`. |
| Pro plan | `STRIPE_PRO_PRICE_ID`, a recurring price of $49 a month. |
| Wallet top-ups (USDC and SOL) | `WALLET_TOPUPS_ENABLED=true` and `WALLET_MASTER_KEY`. Outside development it also needs `TOPUP_RECONCILE_INTERVAL_MS` above 0 (15000 by default): that worker credits a transfer that lands after the customer has closed the page. USDC needs nothing more. SOL is offered when `SOL_PRICE_SOURCE=pyth`, which reads Pyth's SOL/USD price account through `SOLANA_RPC_URL`; with no fresh price SOL is refused and USDC still works. In production the rail runs only on mainnet. |
| x402 pay-per-request | `X402_ENABLED=true`, `X402_INFERENCE_MODE`, `X402_SUBMIT_TRANSACTIONS=true`, `X402_SETTLEMENT_WORKER_ENABLED=true` and `TREASURY_WALLET_ADDRESS` (a real address: the all-ones default is refused). |
| Creator payouts | `PAYOUTS_ENABLED=true` and `PAYOUT_EXECUTOR_INTERVAL_MS`. A payout taken as credits needs nothing more. A payout to a wallet is sent from the paying wallet derived from `WALLET_MASTER_KEY` (the API logs its address at start); it must hold the USDC or SOL to send plus a little SOL for fees, and while it is short a payout waits as pending and its creator can cancel it. SOL payouts are offered when `SOL_PRICE_SOURCE=pyth`. Limits, each a setting: `PAYOUT_MAX_PER_PAYOUT_USD` (500), `PAYOUT_MAX_PER_DAY_USD` per creator (1000), `PAYOUT_PLATFORM_MAX_PER_DAY_USD` in all (5000). `PAYOUT_MAX_ATTEMPTS` (3) is how many transfers may be signed for one payout before its amount goes back to the creator. In production the rail runs only on mainnet. |
| GPU deployments | Section 9. |
| Free models | `GROQ_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `TOGETHER_API_KEY`. Each provider's models appear once its key is set. |
| Semantic knowledge search | `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` (any OpenAI-compatible `/embeddings` provider). Without them, search runs in keyword mode. |
| Web search | `TAVILY_API_KEY`. |
| Code interpreter | `SANDBOX_RUNNER_URL` and `SANDBOX_RUNNER_TOKEN`. The contract is in the header of `apps/api/src/services/skills/sandboxRunner.ts`: a fresh isolated sandbox per request, no network egress, a read-only root filesystem, CPU, memory and process limits, and a kill on timeout. |
| Try it without signing in | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (Cloudflare Turnstile). Without them, visitors sign in to use Try it. |
| Funded Try it messages | `TRIAL_FUNDED_MESSAGE_CENTS`, the price of one funded message. |
| Fine-tuning | Section 10. |
| Custom domains | Section 7. |
| Public status page | `STATUS_PAGE_ORG_ID`: an organization whose uptime monitors `/status` shows. |

The web chat widget, Try it and the public response-time figure have limits and thresholds you
can tune (`WIDGET_*`, `TRIAL_*`, `PUBLIC_LATENCY_*`); `.env.example` lists them with their
defaults.

### 3.5 Development switches

These exist for local development and are refused in production: `ALLOW_NOSANA_MOCK`,
`ALLOW_MOCK_CHECKOUT`, x402 verification-only mode, `SOL_PRICE_SOURCE=static` (a stated SOL price, for a local chain),
`STORAGE_DRIVER=local`, `EMAIL_PROVIDER=log`, and a default `CORS_ORIGIN`.

## 4. Configure the web app

`NEXT_PUBLIC_*` settings are compiled into the browser bundle by `next build`. They are build
arguments, not runtime secrets: setting them as secrets does nothing, and a web app built without
them calls `http://localhost:4000`.

| Build argument | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | The API's public origin, for example `https://wheelsai-api.fly.dev`. |
| `NEXT_PUBLIC_APP_URL` | The web app's public origin. |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | `mainnet-beta` in production. |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | The RPC endpoint browsers use for wallet transactions. |
| `NEXT_PUBLIC_LAUNCHPAD` | The token launchpad, `pumpfun` by default. |
| `NEXT_PUBLIC_ENABLE_TOKEN_UI`, `NEXT_PUBLIC_ENABLE_TRADING` | `true` to show the agent-token and trading pages. |

The web app's origin must be in the API's `CORS_ORIGIN`: the landing page and the status page
read public figures from the API in the browser.

## 5. Deploy the API and the web app

Run the deploys from the **repository root**: the Dockerfiles copy the whole monorepo, so a
deploy started from `apps/*` fails at the first copy. Database migrations run automatically
through the `release_command` in the Fly configuration, before the new machines replace the old
ones.

```bash
flyctl deploy --config apps/api/fly.staging.toml --dockerfile apps/api/Dockerfile --remote-only
flyctl deploy --config apps/web/fly.staging.toml --dockerfile apps/web/Dockerfile --remote-only \
  --build-arg NEXT_PUBLIC_API_URL=https://wheelsai-api-staging.fly.dev \
  --build-arg NEXT_PUBLIC_APP_URL=https://wheelsai-web-staging.fly.dev
```

Production uses the `fly.production.toml` files and the production origins. Deploy the API
first, then the web app.

To deploy from GitLab CI, add a deploy token as the masked, protected CI variable
`FLY_API_TOKEN` (`flyctl tokens create deploy`). The manual jobs `deploy:staging:api` and
`deploy:staging:web` in `.gitlab-ci.yml` then run the commands above on the default branch,
after the unit tests and the migration check pass. They appear only when the variable exists.

## 6. Health checks and first-run steps

### Health checks

```bash
curl -fsS https://wheelsai-api-staging.fly.dev/health/ready   # 200 when PostgreSQL and Redis answer, else 503
curl -fsS https://wheelsai-web-staging.fly.dev/api/health
```

Use `/health/ready` as the API's readiness check (the Fly configuration does). `/health` answers
200 whenever the process is up, so it says nothing about the database or Redis. `GET /metrics`
serves Prometheus metrics, behind `METRICS_TOKEN` when it is set.

Feature checks:

- `GET /api/platform/compute` with `x-admin-key: <PLATFORM_ADMIN_KEY>`: the GPU compute account
  (section 9), and in `training` what keeps fine-tuning from starting, each blocker with its code
  and the setting at fault (section 10).
- `GET /api/training/capabilities` (any signed-in user): `canStart` and the codes of the
  `blockers` that stop fine-tuning. Its messages are the ones customers read, so they do not name
  settings; use the operator view above for that.
- `GET /api/domains/config` (any signed-in user): whether custom domains are set up (`configured`),
  and the edge they use (section 7).
- `GET /api/billing/packages`: which payment rails are on.

The API also logs, once at start-up, a warning for each optional setting whose absence switches a
feature off, naming the setting: every fine-tuning blocker (`Fine-tuning cannot start: …`, also
`HF_TOKEN` when gated models are in the catalog), custom domains
(`Custom domain check queue disabled`, with the reason in `reason`), `TRIAL_FUNDED_MESSAGE_CENTS`,
`TAVILY_API_KEY` and `SANDBOX_RUNNER_URL`. Read them with `flyctl logs -a wheelsai-api[-staging]`
after a deploy.

### First-run steps

- The model catalog syncs itself when the API starts (the log line `Model catalog synced`); no
  seed step is needed for model deployments. Never run `seed-demo.ts` against a real database.
- If agent secrets were stored before encryption at rest existed, seal them with the API's
  `ENCRYPTION_KEY` in place. Run it once without `--apply` to see what would change:

  ```bash
  flyctl ssh console -a wheelsai-api[-staging] -C "node apps/api/dist/seal-agent-env.js"
  flyctl ssh console -a wheelsai-api[-staging] -C "node apps/api/dist/seal-agent-env.js --apply"
  ```

## 7. Custom domains: the edge proxy

Custom domains (on the Pro and Enterprise plans) are served by a second app, the edge
(`infra/edge`: Caddy, pinned in its Dockerfile). It terminates TLS for customer hostnames and
forwards every request to the API over the private network. It keeps no list of domains: before
it requests a certificate for a hostname it asks the API
(`GET /internal/edge/ask?domain=…&token=…`), and anything but a 200 means no certificate. The API
decides what a hostname serves.

Until this section is done, custom domains are unavailable: `GET /api/domains/config` reports
`configured: false`, the API's start-up log names what is missing (the warning
`Custom domain check queue disabled`, with the reason in `reason`), adding, checking and switching on a domain answer
`501 custom_domains_not_configured`, and the domain checker and the host router stay off. The
rest of the API is unaffected.

### 7.1 Create the edge app

```bash
flyctl apps create wheelsai-edge[-staging]
flyctl ips allocate-v4 -a wheelsai-edge[-staging]        # a DEDICATED IPv4 (paid): a shared one cannot carry raw TCP 443
flyctl ips allocate-v6 -a wheelsai-edge[-staging]
flyctl volumes create caddy_data --size 1 --region lax -a wheelsai-edge[-staging]
flyctl ips list -a wheelsai-edge[-staging]               # note every address: the API needs all of them
```

The volume holds the certificates, their private keys and the ACME account. Run one edge
machine with one volume. If the volume is lost, every certificate is requested again, and Let's
Encrypt allows 5 certificates per hostname per week.

### 7.2 Secrets

Generate two shared secrets (`openssl rand -hex 32`, twice; they must differ) and set the same
values on both apps:

```bash
flyctl secrets set -a wheelsai-edge[-staging] \
  ACME_EMAIL=<a monitored mailbox> \
  CUSTOM_DOMAIN_ASK_TOKEN=<secret 1> \
  CUSTOM_DOMAIN_EDGE_SECRET=<secret 2>

flyctl secrets set -a wheelsai-api[-staging] \
  CUSTOM_DOMAIN_EDGE_HOSTNAME=<edge hostname> \
  CUSTOM_DOMAIN_EDGE_IPV4=<every IPv4 of the edge, comma separated> \
  CUSTOM_DOMAIN_EDGE_IPV6=<every IPv6 of the edge, comma separated> \
  CUSTOM_DOMAIN_ASK_TOKEN=<secret 1> \
  CUSTOM_DOMAIN_EDGE_SECRET=<secret 2>
```

| Setting | Note |
| --- | --- |
| `CUSTOM_DOMAIN_EDGE_HOSTNAME` | The CNAME target shown to customers: `wheelsai-edge[-staging].fly.dev`, or `edge.<your domain>` with `A` and `AAAA` records at the edge's addresses. |
| `CUSTOM_DOMAIN_EDGE_IPV4` / `_IPV6` | **Every** public address of the edge. A domain counts as routed only when all of its addresses are in these lists, and the certificate prober connects to these addresses and nowhere else. Private and reserved addresses are refused. |
| `CUSTOM_DOMAIN_ASK_TOKEN` | At least 32 characters. It travels in a URL (Caddy logs the ask URL when it is refused), so it authorizes only the certificate question. |
| `CUSTOM_DOMAIN_EDGE_SECRET` | At least 32 characters, **different from the ask token**. It travels only in a header. Requests carrying it are routed by customer hostname. |
| `CUSTOM_DOMAIN_DNS_SERVERS` | Optional, for example `1.1.1.1,8.8.8.8`. |
| `CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM` | Staging only (refused when `NODE_ENV=production`): trusts the Let's Encrypt staging root when the edge runs with `ACME_CA` set to the staging directory. |

A partial or malformed set does not half-work: `GET /api/domains/config` reports
`configured: false`, the start-up warning `Custom domain check queue disabled` names the setting
at fault in its `reason`, and custom domains stay unavailable. To rotate
either secret, set the new value on both apps; each `secrets set` redeploys its app.

### 7.3 Deploy

The API must listen on `::` to be reachable on the private network (`API_HOST = "::"` in
`apps/api/fly.*.toml`; it serves IPv4 too). Deploy the API first, then the edge, both from the
repository root:

```bash
flyctl deploy --config apps/api/fly.staging.toml --dockerfile apps/api/Dockerfile --remote-only
flyctl deploy --config infra/edge/fly.staging.toml --dockerfile infra/edge/Dockerfile --remote-only
```

The edge image build runs `caddy validate`, so a Caddyfile that does not parse fails the build,
not the running proxy.

### 7.4 Check it

```bash
# The API says it is configured, and names the edge. If configured is false, the
# start-up warning "Custom domain check queue disabled" names the setting at fault.
curl -fsS https://wheelsai-api-staging.fly.dev/api/domains/config -H "Authorization: Bearer $KEY" | jq '.data | {configured, edge}'

# The edge reaches the API, and the API refuses a hostname nobody verified:
# the forwarded request is a 404, never the platform API.
curl -s -o /dev/null -w '%{http_code}\n' http://<edge IPv4>/v1/models -H 'Host: not-a-customer.example.org'   # 404

# No certificate for an unknown name: the handshake fails.
curl -sv --resolve not-a-customer.example.org:443:<edge IPv4> https://not-a-customer.example.org/ 2>&1 | grep -i 'alert\|error'
```

If **every** connection to the edge fails or hangs, the PROXY protocol allow-list is wrong:
`EDGE_PROXY_PROTOCOL_ALLOW` in `infra/edge/fly.*.toml` must contain the network Fly's proxy
reaches the machine from (`flyctl logs -a wheelsai-edge-staging` shows the remote address Caddy
saw). If the plain-HTTP check answers 502, the edge cannot reach the API: check
`API_HOST = "::"` and `WHEELS_API_INTERNAL`.

Then add a real domain from the dashboard, publish its records, and confirm it serves
`https://<your domain>/v1/models`.

### 7.5 Operating notes

- Caddy renews a certificate about 30 days before it expires. The checker re-reads each serving
  domain's certificate every 6 hours (hourly within 14 days of expiry), so `sslExpiringSoon`
  above zero in `GET /api/domains/stats` means a renewal is failing.
- Let's Encrypt limits that matter: 5 failed validations per hostname per hour, 50 certificates
  per registered domain per week, 300 new orders per account per 3 hours. The API allows a
  certificate only for a domain whose DNS already points at the edge, and the checker makes at
  most 4 handshakes per hour for a hostname without a certificate.
- The API spends the account's order limit from a budget. Each "yes" to the edge for a hostname
  without an observed certificate is recorded (`custom_domain_issuance_grants`) and refused with
  429 once the hostname (5 per hour), its organization (`CUSTOM_DOMAIN_ISSUANCE_ORG_LIMIT`, 30
  per 3 hours) or the platform (`CUSTOM_DOMAIN_ISSUANCE_PLATFORM_LIMIT`, 200 per 3 hours) has
  used its share. A hostname whose certificate the checker has observed is exempt, so an edge
  restart is not throttled. The log line `Certificate refused: issuance budget spent` at level
  `error` with `reason: issuance_budget_platform` means no new certificate is being issued for
  anyone: find the organization with the most rows in `custom_domain_issuance_grants` over the
  last 3 hours before raising the limit.
- One organization can have `CUSTOM_DOMAIN_MAX_PER_ORG` domains (25), and a checker pass takes
  at most 10 due domains of one organization, one from each organization in turn, so a backlog in
  one organization delays only that organization.
- A handshake for a hostname the API no longer allows can still succeed while Caddy holds its
  unexpired certificate. The API is what stops serving: such a request is answered
  `404 custom_domain_not_active`.
- An edge, private-network or DNS outage does not pause domains: a probe that cannot reach the
  edge changes nothing, and a tick in which most probes are unreachable is disregarded.
- The host routing table lives in each API machine's memory and reloads every
  `CUSTOM_DOMAIN_ROUTE_REFRESH_MS` (10 s). Switching a domain off or deleting it applies at once
  on the machine that handled it and within one reload on the others. If a reload has not
  succeeded for 60 seconds, custom-domain requests answer 503 instead of being routed on stale
  data.

## 8. Background workers

The workers run inside the API process and share Redis through BullMQ. Each one has an interval
or a concurrency setting; `0` turns it off. The defaults suit production. These matter most:

| Setting (default) | Worker | With it off |
| --- | --- | --- |
| `DEPLOYMENT_STATUS_INTERVAL_MS` (30000) | Follows GPU deployments on Nosana and sweeps GPU jobs that were not confirmed stopped. | Deployment status stops updating; fine-tuning refuses new jobs. Keep it on. |
| `GPU_BILLING_INTERVAL_MS` | Bills running deployments per second of GPU time. | Dedicated deployments refuse requests (`503 gpu_billing_disabled`) rather than serve them unbilled. |
| `TRAINING_POLL_INTERVAL_MS` (15000) | Follows fine-tuning jobs. | Fine-tuning refuses new jobs. |
| `SCHEDULER_INTERVAL_MS` (30000), `SCHEDULER_CONCURRENCY` (4) | Fires scheduled tasks. | Tasks can be saved and run by hand; none fires on its own. |
| `WORKFLOW_RUN_CONCURRENCY` (4), `WORKFLOW_REAP_INTERVAL_MS` (60000) | Runs workflows and reaps lost runs. | Starting a workflow run answers `501`. |
| `JOB_RUNNER_CONCURRENCY` (2), `JOB_SWEEP_INTERVAL_MS` (60000) | Runs paid jobs; the sweeper refunds overdue jobs and settles jobs whose review window closed. | Hiring and activating offerings answer `501`. Never run with the sweeper off while jobs are on. |
| `SUBSCRIPTION_RENEWAL_INTERVAL_MS` (3600000) | Renews monthly marketplace subscriptions. | Monthly subscriptions are not renewed. |
| `ANALYTICS_SNAPSHOT_INTERVAL_MS` (3600000) | Analytics snapshots, and deletes per-request timing rows older than `LATENCY_SAMPLE_RETENTION_DAYS` (30). | The timing table only grows. Keep it on. |
| `ALERT_EVALUATOR_INTERVAL_MS` (60000) | Evaluates alert rules, latency rules included. | No alerts fire. |
| `UPTIME_PROBER_INTERVAL_MS` (30000) | Uptime monitors and the status page. | Monitors stop updating. |
| `PAYMENT_SUBMIT_INTERVAL_MS`, `PAYMENT_POLL_INTERVAL_MS`, `PAYMENT_REAP_INTERVAL_MS` | Submit, confirm and reap on-chain payments. | On-chain payments stay pending. |
| `PAYOUT_EXECUTOR_INTERVAL_MS` (0) | Sends crypto payouts. Needs `PAYOUTS_ENABLED=true`. | Payout requests wait. |
| `FEE_ROUTER_INTERVAL_MS` (0), `REPUTATION_ATTESTATION_INTERVAL_MS` (0) | Route trading fees to treasuries; write reputation attestations. Each needs its funded or whitelisted key. | Fees and attestations wait. |

`.env.example` lists the rest, under "Background workers".

## 9. GPU compute on Nosana

Model deployments, agent runtimes and fine-tuning jobs run on Nosana. The platform pays Nosana
with one of two credentials:

- **An API key with prepaid credits** (`NOSANA_API_KEY`, `NOSANA_ACCESS_MODE=api_key`). No
  wallet, NOS or SOL is needed. Create the key in Nosana's dashboard with every permission on, and
  note its expiry date: when it expires, new deployments are refused and running ones can no
  longer be stopped from WheelsAI until the key is replaced.
- **A funded mainnet wallet** (`NOSANA_WALLET_PRIVATE_KEY` holding NOS and SOL, with
  `SOLANA_NETWORK=mainnet-beta` and a paid `SOLANA_RPC_URL`). Market addresses for the 3060, 4070,
  4090, A100 and H100 tiers are built in for mainnet.

If both are set, `NOSANA_ACCESS_MODE` is required and the API refuses to start without it. Keep
the other credential in place while deployments it created are still running; the operator view
lists them.

| Setting (default) | Note |
| --- | --- |
| `NOSANA_MIN_CREDITS_USD` (5) | A deployment is admitted only when its estimated cost plus this floor is available in the Nosana account. |
| `NOSANA_CREDITS_WARN_USD` (20) | Below this the operator view reports the balance as low. Raise both in proportion to what runs. |
| `NOSANA_TIMEOUT_UNIT` (`minutes`) | The unit Nosana applies to a deployment timeout. WheelsAI keeps its settings in seconds and converts them when it submits a job. |
| `NOSANA_JOB_TIMEOUT_SECONDS` (7200) | The timeout of a serving job; Nosana extends it while the deployment runs. 600 to 86400, and **at least 3000 with an API key**: Nosana never assigns a job paid with credits whose timeout is under 50 minutes, and the API refuses to start with a lower value. Nosana reserves the whole timeout in credits when a node takes the job and returns the unused part some minutes after a stop. |
| `NOSANA_BATCH_JOB_TIMEOUT_SECONDS` (21600) | The longest timeout of a fine-tuning job. The same minimum of 3000 with an API key. |
| `NOSANA_PROVISIONING_LIMIT_SECONDS` (1800) | How long a deployment may wait to start serving. After it the deployment is failed (`no_capacity` when no GPU took it, `start_timeout` when the model was not ready), stopped on Nosana and its hold returned; nothing is charged. 300 to 86400. Raise it for very large models. |
| `INFERENCE_TIMEOUT_MS` (120000) | How long a model node may stay silent before a request fails: the time to the first byte of an answer, and the time between chunks of a streamed one. |
| `NOSANA_NETWORK` | `mainnet` with an API key by default; otherwise taken from `SOLANA_NETWORK`. |
| `HF_TOKEN` | Optional. Lets deployments and fine-tuning use gated Hugging Face models. It is only sent inside confidential job definitions. |
| `MAX_ACTIVE_DEPLOYMENTS_PER_ORG` (5) | Active deployments one organization may have. |

Check a key without spending anything (it only reads, and prints the mode, the key's last four
characters, the balance, the account's deployments and the cost of each tier):

```bash
cd apps/api && npx tsx scripts/nosana-access-check.ts
```

The operator view, `GET /api/platform/compute` with `x-admin-key: <PLATFORM_ADMIN_KEY>`, shows
the balance against the floor, cost and margin per tier, what is running, rows that belong to the
other credential, and deployments running on Nosana under a `wheelsai-` name that no row tracks.
That last list is a report: nothing is stopped automatically, so stop anything it names in
Nosana's dashboard.

When new deployments cannot be paid for, customers see that new GPU deployments are temporarily
unavailable and that nothing was reserved or charged, and `/status` shows new deployments as
paused.

A deployment reads `running`, and is billed, only once a node serves it and its model has
answered a request; expect about two minutes on a first start of a small model on the Ollama
engine once a GPU has taken it, and about five on vLLM. The platform probes the node itself, so
a deployment is taken as serving when its node answers even if Nosana still reports the
endpoint offline. While a deployment is starting, or is not serving for a moment, requests to
it are answered 503. A deployment that Nosana cannot
place does not wait for ever. It is failed with one of three reasons, stopped on Nosana, and its
hold is returned; the customer is told that nothing was charged.

| Reason | Meaning | Where to look |
| --- | --- | --- |
| `nosana_list_failed` | Nosana keeps refusing to list the job. | Nosana's own message is in the API log (the error line that begins "Deployment failed: Nosana could not place it or it never became ready") and under `placementFailures` in the operator view. The usual cause is a setting Nosana does not accept. |
| `no_capacity` | No GPU of the tier took the job within `NOSANA_PROVISIONING_LIMIT_SECONDS`. | The market's idle nodes; try again later or on another tier. |
| `start_timeout` | A node took the job, but the model was not ready within the same limit. | The job's result and logs in Nosana's dashboard. |

`placementFailures` lists what the answering process itself has seen since it started. The row's
reason is the durable record.

## 10. Fine-tuning: storage and the training image

Fine-tuning needs four things beyond the API itself:

1. **GPU compute on Nosana** (section 9). A job is admitted only when the Nosana account covers
   its whole timeout (the user's run limit plus `TRAINING_SETUP_ALLOWANCE_SECONDS`, and with an
   API key at least 50 minutes) plus the floor.
2. **An S3-compatible bucket** for datasets and trained adapters (10.1).
3. **The training image**, published and pinned by digest (10.2).
4. **`PUBLIC_API_URL` reachable over HTTPS from GPU nodes.** The trainer reports progress there,
   and a deployment of a fine-tuned model downloads its adapter from there.

With the workers `TRAINING_POLL_INTERVAL_MS` and `DEPLOYMENT_STATUS_INTERVAL_MS` on (section 8),
check the result in the operator view, `GET /api/platform/compute` with
`x-admin-key: <PLATFORM_ADMIN_KEY>`: `training.canStart` is `true` and `training.blockers` is
empty when fine-tuning is ready. Each blocker has a stable `code` and a `message` that names the
setting at fault, for example `training_image_not_configured`, `dataset_storage_not_configured`
or `training_callbacks_not_configured`. The API logs the same blockers at start-up, one warning
each (`Fine-tuning cannot start: …`). `GET /api/training/capabilities` reports the same codes to
signed-in users, with the message customers read.

### 10.1 Object storage

Datasets and adapters live in one private bucket; per-agent files share it. Nothing reads it
without a signed link. Cloudflare R2 avoids egress charges when GPU nodes download datasets; AWS
S3 works the same way without an endpoint.

1. Create the bucket and an access key limited to it (on R2, an API token of type "Object Read &
   Write" scoped to the bucket).
2. Set on the API: `DATASETS_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and for R2
   `S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com` (the region then defaults to
   `auto`, which R2 expects). Leave `S3_FORCE_PATH_STYLE` unset for R2 and AWS; it is for MinIO.
   Leave `STORAGE_DRIVER` unset.
3. Add a CORS rule to the bucket. The dashboard uploads datasets from the browser straight to
   the bucket, so allow the web origin:

   ```json
   [{ "AllowedOrigins": ["https://<the web origin>"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
   ```

4. Run the smoke test with the same settings the API has. It uploads through a signed link,
   checks that the link refuses another size and another content type, reads the object back,
   deletes what it wrote, and prints no credential:

   ```bash
   cd apps/api && npx tsx scripts/object-store-smoke.ts
   ```

5. Upload one dataset from the deployed dashboard to confirm the CORS rule.

`TRAINING_DATASET_MAX_BYTES` (200 MB) and `TRAINING_DATASET_MAX_ROWS` (200,000) set the dataset
limits. Deleting a dataset deletes its object; a bucket lifecycle rule is a good backstop for
objects whose delete failed.

### 10.2 The training image

The image a fine-tuning job runs on a GPU node is built from `infra/training` (base
`pytorch/pytorch` with CUDA, pinned by digest). Its inputs, outputs, callbacks and exit codes are
specified in `infra/training/README.md`.

```bash
docker build -t wheelsai-trainer infra/training     # the build context is this folder
docker tag wheelsai-trainer <registry>/<repository>:<version>
docker push <registry>/<repository>:<version>
docker buildx imagetools inspect <registry>/<repository>:<version>   # read the digest
```

The image is several gigabytes. From GitLab CI, the manual `trainer-image` job builds and pushes
it after the trainer tests pass, and prints the line to set. It pushes to the project's registry
unless the `TRAINER_IMAGE_REPOSITORY`, `TRAINER_REGISTRY`, `TRAINER_REGISTRY_USER` and
`TRAINER_REGISTRY_PASSWORD` CI variables point elsewhere.

Then set on the API:

| Setting | Note |
| --- | --- |
| `TRAINING_IMAGE` | `<registry>/<repository>@sha256:<digest>`. The digest form only: a tag alone is treated as not set. |
| `TRAINING_IMAGE_REGISTRY_SERVER`, `_USERNAME`, `_PASSWORD` | Only for a private registry, all three or none. They travel to the GPU node inside the job definition, so use a read-only token. |

GPU nodes pull the image without your credentials when the repository is public. The image holds
no secrets, so a public repository is the simple choice. After publishing, pull it once from a
machine outside your project to confirm it is readable.

### 10.3 Job settings

| Setting (default) | Note |
| --- | --- |
| `TRAINING_QUEUE_TIMEOUT_SECONDS` (1800) | A job no GPU node takes within this time fails and costs the user nothing. |
| `TRAINING_SETUP_ALLOWANCE_SECONDS` (900) | Added to the user's run limit in the Nosana timeout, for pulling the image. Never billed to the user. With an API key the Nosana timeout is at least 3000 seconds whatever the run limit; the user's hold and charge do not change. |
| `NOSANA_BATCH_JOB_TIMEOUT_SECONDS` (21600) | The longest run limit is this minus the set-up allowance. |
| `TRAINING_MAX_ACTIVE_JOBS_PER_ORG` (2) | Unfinished jobs one organization may have. |
| `TRAINING_FREE_FAILURES_PER_DAY` (3) | Jobs of one organization that may end failed and free of charge in 24 hours. |
| `TRAINING_ADAPTER_MAX_BYTES` (2 GiB) | The largest adapter accepted. |
| `HF_TOKEN` | Without it, only ungated base models are offered. |

## 11. Upgrades and migrations

1. Read the release's changes for new settings and migrations, and set new settings before you
   deploy.
2. Deploy the API first (section 5). Its release step runs
   `npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma` before any new machine
   starts; if a migration fails, the release stops and the running machines keep serving.
3. Deploy the web app, then the edge if `infra/edge` changed.
4. Check `/health/ready`, and the feature checks in section 6 for what you run.

Migrations only move forward. To roll back, redeploy the previous image (`flyctl deploy --image
<previous image>`) only when the release added no migration, or when the previous code works with
the new schema; otherwise restore the database from a backup taken before the deploy. Take a
backup before every release that adds a migration.

Outside Fly, run the same `prisma migrate deploy` command against the database before you start
the new API version.

## 12. Rotating secrets

| Secret | How to rotate |
| --- | --- |
| `JWT_SECRET` | Rotating signs every user out. It also signs fine-tuning callbacks and the adapter links inside running deployments, so rotate when no training job is running, and restart deployments of fine-tuned models afterwards. |
| `ENCRYPTION_KEY` | Agent secrets and channel settings are encrypted with it, so values stored under the old key cannot be read after a change and their owners must enter them again. Keep it stable and backed up, and different from `JWT_SECRET`. |
| `WALLET_MASTER_KEY` | Every treasury authority and derived key comes from it. Rotate the on-chain treasury authorities first with `apps/api/scripts/rotate-treasury-authority.ts` (run it in dry-run mode first): it signs with keys from the old master and accepts with keys from the new one. Change the secret only after that, because the old keys are needed to sign. |
| `CUSTOM_DOMAIN_ASK_TOKEN`, `CUSTOM_DOMAIN_EDGE_SECRET` | Set the new value on both the API and the edge (section 7.2). |
| `PLATFORM_ADMIN_KEY`, `METRICS_TOKEN` | Replace at any time. |
