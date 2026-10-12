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
13. [Money: the treasury, the money report and plans](#13-money-the-treasury-the-money-report-and-plans)
14. [Agent tokens: turning the launchpad on](#14-agent-tokens-turning-the-launchpad-on)

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
| `GPU_FACING_API_URL` | Optional. The address a container on a GPU node uses to reach the API, when it is not `PUBLIC_API_URL`: a training run reports its progress there and a deployed fine-tuned model downloads its adapter from there. Unset means `PUBLIC_API_URL`. An address on this machine or a private network is refused before a GPU is rented (`training_callbacks_not_reachable`, `adapter_download_not_reachable`). |
| `PUBLIC_WEB_URL` | The web app's public origin, used in email links and listing URLs. Falls back to `CORS_ORIGIN`. |

### 3.3 Platform keys

| Setting | Note |
| --- | --- |
| `WALLET_MASTER_KEY` | The root secret from which treasury, creator and deposit keys are derived. Set it once and back it up: changing it changes every derived address (section 12), each organization's deposit address included, so it must never change once customers have saved their addresses. Required when token launches, wallet top-ups or deposit addresses are on. |
| `NOSANA_API_KEY` or `NOSANA_WALLET_PRIVATE_KEY` | Pays for GPU jobs (section 9). |
| `PLATFORM_ADMIN_KEY` | At least 16 characters. Unlocks marketplace curation and the two operator views, each read with the header `x-admin-key`: GPU compute at `GET /api/platform/compute`, and the money report at `GET /api/platform/money` (section 13.2). |
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
| Wallet top-ups (USDC and SOL) | `WALLET_TOPUPS_ENABLED=true` and `WALLET_MASTER_KEY`. Outside development it also needs `TOPUP_RECONCILE_INTERVAL_MS` above 0 (15000 by default): that worker credits a transfer that lands after the customer has closed the page, and until the chain says what became of a transfer it sends the customer's own signed bytes again on every run (the same transaction cannot pay twice). The request that submits a payment asks the node about it for up to 30 seconds; it needs no WebSocket. The log line "signed top-up accepted" says whether a wallet handed back the transfer as prepared or added instructions of its own, and of which programs. USDC needs nothing more. SOL is offered when `SOL_PRICE_SOURCE=pyth`, which reads Pyth's SOL/USD price account through `SOLANA_RPC_URL`; with no fresh price SOL is refused and USDC still works. In production the rail runs only on mainnet. |
| Deposit addresses (USDC and SOL sent from an exchange or any wallet) | `DEPOSITS_ENABLED=true` (off by default). It needs the wallet top-up rail above (`WALLET_TOPUPS_ENABLED=true` and `WALLET_MASTER_KEY`): the API refuses to start with deposits on and top-ups off, because an organization's deposit address is the address its top-ups already pay into, derived from the same key. Outside development it also needs the scan worker: `DEPOSIT_SCAN_INTERVAL_MS` above 0 (60000 by default; 0 turns the worker off and the API then refuses to start). The scan is what finds a transfer and credits it, once, and it credits only finalized transfers. It reads each address's transaction history, so `SOLANA_RPC_URL` must be a node that serves history (`getSignaturesForAddress` and `getTransaction`); the log line "a balance its history does not explain" on run after run means the node is not serving it, and a transfer at that address is waiting to be credited. `DEPOSIT_SCAN_MAX_ADDRESSES` (500) is the most addresses one run looks at; one balance read covers 50 of them, and only an address whose balance changed has its history read. "Prepare address" opens the USDC account at a customer's address and is paid for by the paying wallet, the one creator payouts are sent from (derived from `WALLET_MASTER_KEY`): about 0.002 SOL an account. `DEPOSIT_ACCOUNT_OPENS_PER_DAY` (25) is how many the platform opens in a UTC day in all, and `HOT_WALLET_MIN_SOL` (0.05) is the SOL the paying wallet must hold for one to be opened; at the limit or under that balance the customer is told to try again later, and transfers are still credited. SOL is credited when `SOL_PRICE_SOURCE=pyth`; with no fresh price a SOL transfer is recorded and credited by a later run. **Never change `WALLET_MASTER_KEY` once customers have saved their addresses**: every deposit address is derived from it, a changed key gives every organization a different address, and whatever is sent to a saved address is then not credited. While the stored address and the derived one differ, the deposit routes answer `503` and show no address. |
| Sweeps (moving what customers paid off their deposit addresses) | `SWEEPS_ENABLED=true` (off by default). It needs deposit addresses on (the row above): the API refuses to start with sweeps on and `DEPOSITS_ENABLED` off. It also needs its worker, `SWEEP_INTERVAL_MS` above 0 (300000 by default; 0 turns the worker off and nothing is swept), and the node at `SOLANA_RPC_URL` answering for the chain in `SOLANA_NETWORK`: while that check fails a run moves nothing. A run first settles the transfers it sent earlier, from the chain. It then looks at each deposit address and moves an asset only when what the address holds, finalized, equals what the deposit scan last accounted for, so nothing leaves an address before the scan has read it, and only while no earlier transfer of that asset from that address is still in flight. `SWEEP_MIN_USD` (25) is the least worth moving, in dollars: USDC is swept whole once an address holds that much, and SOL once what can be moved is worth that much. `SWEEP_MAX_PER_RUN` (20) is the most transfers one run starts, largest first. **Where it goes.** `HOT_WALLET_FLOAT_USDC` (200, dollars of USDC) and `HOT_WALLET_FLOAT_SOL_USD` (100, dollars of SOL at the current price) are what the hot wallet keeps to pay creators with. The hot wallet is the paying wallet of the rows around this one, derived from `WALLET_MASTER_KEY`. A transfer goes to it, whole, while it holds less than its float of that asset plus what open payouts need of it, counting what is already on its way there; otherwise the transfer goes to the treasury, `TREASURY_WALLET_ADDRESS`. What open payouts need is the sum of the payouts to a wallet that are waiting to be sent, in that asset, while payouts are running, and never more than `PAYOUT_PLATFORM_MAX_PER_DAY_USD` (5000) for USDC and SOL together: a payout larger than the float is paid from the deposits that come next, with nobody refilling the wallet. **Nothing goes to the treasury until it is proven** (section 13.1): with no proven treasury only transfers to the hot wallet happen, and once the hot wallet is at its float the rest stays at the deposit addresses. When the hot wallet holds more than twice a float on top of what open payouts need (those waiting and those being sent) and the treasury is proven, it sends what it holds above the float and that need to the treasury, one transfer an asset; of SOL it always keeps `HOT_WALLET_MIN_SOL` as well, after every fee it pays in the same run. Keep the SOL float worth well above `HOT_WALLET_MIN_SOL`: the hot wallet pays fees and opens USDC accounts from it. **What stays behind.** A SOL sweep leaves 890,880 lamports at the address, what an empty account must keep, so a later transfer of any size can still arrive. USDC is swept whole. **Who pays each fee** (5,000 lamports a signature). A USDC sweep is paid for by the hot wallet, which also opens the destination's USDC account when it is missing; no USDC is swept while the hot wallet holds less than `HOT_WALLET_MIN_SOL` (0.05). A SOL sweep is paid for by the deposit address itself, out of what it holds, so SOL sweeps do not need the hot wallet and are how it gets its SOL. The hot wallet pays for its own transfers to the treasury. SOL is swept only with a price (`SOL_PRICE_SOURCE=pyth`): with no fresh price no SOL moves in that run, and USDC still does. `TREASURY_WALLET_ADDRESS` is the same setting x402 payments are sent to (the row below). The deposit scan warns in the log about any transfer out of a deposit address that is not one of these sweeps. |
| x402 pay-per-request | `X402_ENABLED=true`, `X402_INFERENCE_MODE`, `X402_SUBMIT_TRANSACTIONS=true`, `X402_SETTLEMENT_WORKER_ENABLED=true` and `TREASURY_WALLET_ADDRESS` (a real address: the all-ones default is refused). **The asset.** `X402_DEFAULT_ASSET` (USDC by default) is what a request is asked to be paid in, and with x402 on it must be `USDC` or `SOL`: the API refuses to start with `NOS`, which has no live price. `SOL` also needs a SOL price: the API refuses to start with `X402_DEFAULT_ASSET=SOL` and `SOL_PRICE_SOURCE=off`. With `SOL` chosen and no fresh price at the moment of a request, that request is asked for USDC instead, so USDC always works. USDC is paid to the treasury wallet's own USDC token account (its associated token account for the chain's USDC mint), which the "payment required" answer names; that account must exist before the first USDC payment. **Two timings.** `X402_QUOTE_TTL_SECONDS` (120; 30 to 600) is how long the SOL price in a "payment required" answer holds: a paid retry inside it is priced at that rate, and one after it is asked again with a new price and its transaction is not sent. `X402_CONFIRM_WAIT_MS` (30000; 1000 to 120000) is how long a paid request waits for its payment to land before it answers "not confirmed"; the settlement worker finishes that payment afterwards. **What happens to a payment.** Its row is written as `submitted`, with the signed transaction, before the transaction is sent; after that only the chain decides. Landed: `verified`, and the request is served. Landed and failed, or never landed once its blockhash has certainly expired (3 minutes): `failed`, and nothing was taken. A served payment becomes `settled` when its transaction is final. **"Returned" in the settlement worker's log** (the `returned` count in its line "Completed X402 settlement tick") means a payment that landed for a request that was never answered was given back to the paying organization as credits, once: the row goes to `refunded` with `refundedAt` and `refundMicroUsd` (what was actually sent, in millionths of a dollar; SOL at the row's rate), and the organization's balance gets the whole cents with one ledger row of type `x402_refund` ("Paid request returned as credits") while the part under a cent waits on `x402RefundCarryMicroUsd` until later returns complete a cent. The worker returns a payment in two cases: it landed after its request had already answered "not confirmed", or it was `verified` and the request neither answered nor failed within 10 minutes (the process stopped mid-request). A request that fails while the process is up is returned by the request itself, not by the worker. Nothing is sent back on the chain: the transfer stays in the treasury, and a return is a credit. A steady stream of returns means requests are failing after payment (look at the GPU nodes) or payments are landing late (look at the node at `SOLANA_RPC_URL`, or raise `X402_CONFIRM_WAIT_MS`). No number of failed status reads ends a payment: a row the worker cannot read the fate of is left for the next run. `docs/X402-RUN.md` has the proof script. |
| Creator payouts | `PAYOUTS_ENABLED=true` and `PAYOUT_EXECUTOR_INTERVAL_MS`. A payout taken as credits needs nothing more. A payout to a wallet is sent from the paying wallet derived from `WALLET_MASTER_KEY` (the API logs its address at start); it must hold the USDC or SOL to send plus a little SOL for fees, and while it is short a payout waits as pending and its creator can cancel it. SOL payouts are offered when `SOL_PRICE_SOURCE=pyth`. Limits, each a setting: `PAYOUT_MAX_PER_PAYOUT_USD` (500), `PAYOUT_MAX_PER_DAY_USD` per creator (1000), `PAYOUT_PLATFORM_MAX_PER_DAY_USD` in all (5000). `PAYOUT_MAX_ATTEMPTS` (3) is how many transfers may be signed for one payout before its amount goes back to the creator. In production the rail runs only on mainnet. |
| GPU deployments | Section 9. |
| Free models | `GROQ_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `TOGETHER_API_KEY`. Each provider's models appear once its key is set. |
| Semantic knowledge search | `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` (any OpenAI-compatible `/embeddings` provider). Without them, search runs in keyword mode. |
| Web search | `TAVILY_API_KEY`. |
| Code interpreter | `SANDBOX_RUNNER_URL` and `SANDBOX_RUNNER_TOKEN`. The contract is in the header of `apps/api/src/services/skills/sandboxRunner.ts`: a fresh isolated sandbox per request, no network egress, a read-only root filesystem, CPU, memory and process limits, and a kill on timeout. |
| Try it without signing in | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (Cloudflare Turnstile). Without them, visitors sign in to use Try it. |
| Funded Try it messages | `TRIAL_FUNDED_MESSAGE_CENTS`, the price of one funded message. |
| Fine-tuning | Section 10. |
| Agent tokens | Section 14. |
| Custom domains | Section 7. |
| Public status page | `STATUS_PAGE_ORG_ID`: an organization whose uptime monitors `/status` shows. |

The web chat widget, Try it and the public response-time figure have limits and thresholds you
can tune (`WIDGET_*`, `TRIAL_*`, `PUBLIC_LATENCY_*`); `.env.example` lists them with their
defaults.

### 3.5 Development switches

These exist for local development and are refused in production: `ALLOW_NOSANA_MOCK`,
`ALLOW_MOCK_CHECKOUT`, x402 verification-only mode, `SOL_PRICE_SOURCE=static` (a stated SOL price, for a local chain),
`STORAGE_DRIVER=local`, `EMAIL_PROVIDER=log`, and a default `CORS_ORIGIN`. Two of them are refused on
mainnet in every environment, development included: a stated SOL price, and `ALLOW_MOCK_CHECKOUT`,
whose credits could otherwise be paid out in real money.

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
| `NEXT_PUBLIC_LAUNCHPAD` | The token launchpad, `pumpfun` by default. The launch wizard asks the API which launchpad it uses (section 14) and falls back to this value only when that call fails, so keep it equal to the API's `LAUNCHPAD`. |
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
- `GET /api/platform/money` with `x-admin-key: <PLATFORM_ADMIN_KEY>`: what customers and creators
  are owed, what came in, what the platform's wallets hold, and in `health` which money rails and
  workers are on (section 13.2).

The API also logs, once at start-up, a warning for each optional setting whose absence switches a
feature off, naming the setting: every fine-tuning blocker (`Fine-tuning cannot start: …`, also
`HF_TOKEN` when gated models are in the catalog), custom domains
(`Custom domain check queue disabled`, with the reason in `reason`), `TRIAL_FUNDED_MESSAGE_CENTS`,
`TAVILY_API_KEY` and `SANDBOX_RUNNER_URL`. Read them with `flyctl logs -a wheelsai-api[-staging]`
after a deploy.

If requests to a model provider, to Nosana or to the chain fail at once with `fetch failed` and
`ETIMEDOUT` in the log, the host is slow to connect out, or has an IPv6 route that does not work.
Each attempt to connect is given `OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS` (2500 unless set; Node's
own default of 250 is too short for such a host): raise it. A model request whose connection
fails is sent again by itself, three times at most, and so is one the provider answered with a
429 that asks for a wait of 5 seconds or less; the log says so each time
(`Model request is being sent again`).

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
| `DEPOSIT_SCAN_INTERVAL_MS` (60000), `DEPOSIT_SCAN_MAX_ADDRESSES` (500) | Finds transfers sent to deposit addresses and credits them. Needs `DEPOSITS_ENABLED=true`. | Transfers sent to a deposit address are not credited until it runs again; nothing is lost. Outside development the API refuses to start with deposits on and this off. |
| `SWEEP_INTERVAL_MS` (300000), `SWEEP_MAX_PER_RUN` (20) | Moves what customers paid off their deposit addresses, to the hot wallet while it is under its float and to the proven treasury otherwise, and settles the transfers it sent (section 3.4). Needs `SWEEPS_ENABLED=true`. | Nothing is swept and no transfer already sent is settled until it runs again; what was paid stays at the deposit addresses, and customers are credited as before. |
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
# From a machine that is logged in to the registry (docker login):
bash infra/training/scripts/publish-image.sh <registry host>/<account>/wheelsai-trainer          # build
python infra/training/scripts/cpu_proof.py --image <registry host>/<account>/wheelsai-trainer:<short commit>   # run it here, no GPU
bash infra/training/scripts/publish-image.sh <registry host>/<account>/wheelsai-trainer --push   # publish
```

The last line the script prints is `TRAINING_IMAGE=<repository>@sha256:<digest>`: the value to
set. It refuses to publish while a file that goes into the image is not committed, and after a
push to Docker Hub it asks the registry for the manifest with no login, as a GPU node would.

The image is 6.32 GB on disk and 3.27 GB to pull; all but 117 MB of that is the base, which the
registry takes from `pytorch/pytorch` and is not uploaded. On a poor link the packages still go
up in four layers of at most 42 MB, because a registry restarts a layer from nothing when the
connection drops. From GitLab CI, the manual `trainer-image` job builds and pushes
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
| `WALLET_MASTER_KEY` | Every treasury authority and derived key comes from it. Rotate the on-chain treasury authorities first with `apps/api/scripts/rotate-treasury-authority.ts` (run it in dry-run mode first): it signs with keys from the old master and accepts with keys from the new one. Change the secret only after that, because the old keys are needed to sign. Deposit addresses cannot be rotated this way: each one is derived from this key and customers save theirs, so with deposit addresses on (section 3.4) this key must not change. |
| `CUSTOM_DOMAIN_ASK_TOKEN`, `CUSTOM_DOMAIN_EDGE_SECRET` | Set the new value on both the API and the edge (section 7.2). |
| `PLATFORM_ADMIN_KEY`, `METRICS_TOKEN` | Replace at any time. |

## 13. Money: the treasury, the money report and plans

The two commands in this section are operator scripts in `apps/api/scripts`. The API's image does
not contain them: run them from a checkout of the repository, in `apps/api`, with the API's
settings in the environment (the database, `SOLANA_NETWORK`, `SOLANA_RPC_URL`, and for the first
one `WALLET_MASTER_KEY` and `TREASURY_WALLET_ADDRESS`). Each takes `--dry-run`, which writes
nothing.

### 13.1 Proving the treasury

The treasury is the wallet sweeps send to once the hot wallet has its float (section 3.4). Its key
is not a setting and is never given to the API: the API only knows its address,
`TREASURY_WALLET_ADDRESS`. Because a wrong address would send customers' payments somewhere
nobody controls, a sweep sends nothing to the treasury until the address is proven: the wallet at
that address has signed a transfer to the hot wallet, which only the holder of its key can do.

1. Set `TREASURY_WALLET_ADDRESS` to the wallet's address. It must be an ordinary wallet address,
   and not the all-ones default, the hot wallet or a deposit address; each of those is refused.
   An exchange deposit address will not do: you cannot sign a transfer from it. Nor will a token
   account or a multisig vault: an address with no key of its own is not an ordinary wallet
   address.
2. Find the hot wallet's address. With creator payouts scheduled, the API logs it at start
   (`Platform payout wallet: fund this address for payouts to a wallet`). The money report gives
   it as `onChain.hotWallet.address` (section 13.2), and the command in step 4 also prints it
   when it finds no proof.
3. From the treasury wallet, send at least 0.1 SOL to the hot wallet, and wait for the transfer
   to be finalized. The SOL is not lost: it is in the hot wallet, where it pays fees.
4. Run:

   ```bash
   cd apps/api
   npx tsx scripts/treasury-verify.ts --dry-run   # looks, and writes nothing
   npx tsx scripts/treasury-verify.ts
   ```

   It looks through the hot wallet's finalized history, newest first, up to 1,000 signatures, for
   a transaction that did not fail, that the treasury address signed, and that left the hot wallet
   with at least 0.1 SOL (100,000,000 lamports) more. When it finds one it records the address as
   proven for this chain, with that signature, and says so. When it finds none it writes nothing
   and says: "Send 0.1 SOL from the treasury wallet to <hot wallet address>, then run this again."
   When it finds none and some transactions could not be loaded, one of those may be the proof: it
   says to run it again before sending anything, and exits with 3 where a plain "not found" exits
   with 1.

The proof is for one address on one chain. The treasury counts as proven only while the recorded
address is exactly `TREASURY_WALLET_ADDRESS`, so after changing the setting nothing goes to the
treasury until the new address is proven the same way (steps 3 and 4); the record is then replaced.
`onChain.treasury.proven` in the money report (section 13.2) says where this stands.

### 13.2 The money report

```bash
curl -fsS -H "x-admin-key: $PLATFORM_ADMIN_KEY" \
  "https://<api>/api/platform/money?from=2026-10-01&to=2026-10-31"
```

`GET /api/platform/money` is gated the way `GET /api/platform/compute` is: `503
platform_admin_not_configured` while `PLATFORM_ADMIN_KEY` is not set, `401 invalid_admin_key` for
a wrong key, and the answer is never cached. `from` and `to` are dates (`YYYY-MM-DD`); without
them the range is from the first day of the current UTC month to now, and a date that cannot be
read answers `400 invalid_range`. The report only reads.

Amounts in cents, lamports and USDC base units (a millionth of a USDC) are strings of digits.
Every section has a `state`: `ok`, or `unreadable` when that section could not be read. One
section failing does not fail the report, so check each `state` before trusting its figures.

| Section | What it says |
| --- | --- |
| `customers` | What the platform owes its customers in service: the sum of every credit balance (`balanceCents`), and how many organizations hold more than 0. |
| `creators` | What creators are owed and have not asked for (`owedCents`); payouts that are pending or processing now (`openPayouts`) and payouts completed in the range (`paidOutInRange`), each by payout method. |
| `income` | In the range. `creditsSold` by rail: `wallet_topup` and `deposit` by asset, `stripe`, and `other`, which is every other credit purchase. `bonusesGrantedCents`: credits given as a bonus. `creditsUsed`: what customers spent, by type. `marketplaceFeesCents`: the platform's fee on settled marketplace revenue. `x402Received`: settled x402 payments by asset. |
| `onChain` | `hotWallet` and `treasury`: the address and what it holds in lamports and USDC, read from the chain as the report is made. `treasury` is null when no address is set, and `proven` is the answer of section 13.1. `depositAddresses`: how many there are on this chain and what they hold in all, as the deposit scan last accounted for it. That figure is not read from the chain here. |
| `sweeps` | `sent`: transfers in flight now. `landedInRange`: transfers that landed in the range, by kind (`sweep_to_hot`, `sweep_to_treasury`, `hot_to_treasury`) and asset. `failedInRange`: how many failed. |
| `reconciliation` | Whether what sits at the deposit addresses is explained, for USDC and for SOL, over everything ever recorded on this chain (not the range). See below. |
| `health` | `cluster`: `ok`, `wrong_cluster` (the node at `SOLANA_RPC_URL` is not on the chain in `SOLANA_NETWORK`) or `unreachable`. `walletTopups`, `deposits`, `depositScan`, `sweeps`, `payouts`: whether each is switched on with its worker scheduled. `solPrice`: where the SOL price comes from, whether there is one now, and its age in seconds. |

**Reading the reconciliation.** `usdc` is in USDC base units and its fields end in `Raw`
(`receivedRaw`, `sweptRaw`, `expectedRaw`, `heldRaw`, `differenceRaw`); `sol` is in lamports and
its fields end in `Lamports` (`receivedLamports`, and so on, with `feeLamports` as well). For each
asset:

- `received` is everything recorded as arriving at a deposit address, credited or not.
- `swept` is every sweep off a deposit address that landed. For SOL, `feeLamports` is the fees
  sweeps paid out of the address: those that landed, and those that failed on the chain, which
  moved nothing and still paid their fee.
- `expected` is `received` less `swept` (and, for SOL, less those fees): what should still be
  there.
- `held` is the `depositAddresses` figure of `onChain`.
- `difference` is `held` less `expected`.

**A difference of 0 is the healthy answer**: every lamport and every USDC base unit at the deposit
addresses is explained by a recorded receipt or a landed sweep. It speaks only of what the scan
has read: `held` is each address's balance as of the newest transaction the scan has processed,
so a transfer the scan has not read yet is in neither `held` nor `received` and does not show
here. The scan's log line "a balance its history does not explain" (section 3.4) is what tells
you about one of those. When the difference is not 0:

1. Read the report again after a deposit scan and a sweep run have passed
   (`DEPOSIT_SCAN_INTERVAL_MS`, `SWEEP_INTERVAL_MS`). `held` moves when the scan reads an address
   and `swept` moves when the sweep worker settles a transfer, so a sweep in flight (`sweeps.sent`
   above 0) can show as a difference that goes away once both have run.
2. Check `health`: `cluster` must be `ok` and `depositScan` true, and `sweeps` true where sweeps
   are on. With a worker off, its figures stop moving.
3. A difference above 0 that stays is a landed sweep the scan has not yet read as leaving its
   address: the scan records a receipt for everything it reads arriving, so nothing else puts
   `held` above `expected`. Look in the API log for the scan's errors at an address, and check
   that the node at `SOLANA_RPC_URL` serves history (section 3.4). The scan stops at a
   transaction it cannot load and tries again on the next run. It also changes nothing for an
   address whose history it could not read back to where it last stopped: when it has not seen
   that signature itself, it believes what it found only if the oldest transaction starts from
   the balance the last read left, so a node that answers with part of the history cannot move
   it past a transfer it has not read.
4. A difference below 0 is money that left a deposit address without a sweep to account for
   it. Look in the API log for the scan's warning about a transfer out of a deposit address.
   Nothing but a sweep should ever send from one, and only `WALLET_MASTER_KEY` can sign for one:
   treat a transfer out that is not a sweep as a leak of that key until it is explained
   (`docs/THREAT-MODEL.md`, section 4).
5. If the reconciliation's `state` is `unreadable`, or `onChain` is, the report could not read
   what it needed. That is a fault in reading, not in the money: fix the database or the node and
   read it again.

### 13.3 Setting an organization's plan

```bash
cd apps/api
npx tsx scripts/set-plan.ts <organization> <starter|pro|enterprise> --dry-run
npx tsx scripts/set-plan.ts <organization> <starter|pro|enterprise>
```

This puts an organization on a plan by hand; it is how an organization gets Enterprise. Name the
organization by its id, its slug, or the email of one of its owners. A name that matches no
organization, or more than one, changes nothing and says so. The command prints the plan before
and after.

- `starter` removes the grant.
- An organization whose plan a Stripe subscription drives is refused, because the next Stripe
  webhook would undo the change. Change that plan in Stripe, or pass `--force` to set it anyway
  knowing that.
- `--dry-run` prints what would change and writes nothing.

## 14. Agent tokens: turning the launchpad on

An agent that passes the launch gate can launch a token. `LAUNCHPAD` on the API chooses where:
`pumpfun` (the default), `bags` (mainnet only), or `meteora`, which is Meteora's Dynamic Bonding
Curve used directly, on devnet and mainnet. This section covers `meteora`; the feature, its
routes and what it leaves unbuilt are in `docs/METEORA-TOKENS.md`.

**No key of the API's signs a transaction that moves money here.** It builds each transaction,
the person's browser wallet signs it, and the API checks the signed transaction is the one it
built before sending it. A wallet may add its own priority-fee instructions to a buy, a sell, a
fee claim or the locker step, which it alone signs, and nothing else; the launch and the move to
the Meteora pool must come back byte for byte. The API does need `WALLET_MASTER_KEY` (section
3.3), which here signs only the short-lived tokens that tie a submit to its prepare.

| Setting (API) | Value |
| --- | --- |
| `LAUNCHPAD` | `meteora`. |
| `WALLET_MASTER_KEY` | Required, as for every launchpad. Without it the API starts, logs that `/api/tokens/launch/{prepare,submit}` are disabled, and the trade, fee and graduation routes that need a login answer `503 prepare_unavailable`. |
| `METEORA_FEE_CLAIMER_ADDRESS` | Required: the API refuses to start without it, or with a value that is not a Solana address. The address of the wallet that may claim the platform's share of trading fees. It is written into the curve config of every token launched and cannot be changed for that token afterwards, so set it to a wallet you will keep. An address only: never put its key on the server. |
| `METEORA_LEFTOVER_RECEIVER_ADDRESS` | Optional. Where a curve's unsold tokens go after graduation. Defaults to the fee wallet. |
| `METEORA_CURVE_CACHE_MS` | How long a pool's state read from the chain is kept. 5000 by default. Raise it if your RPC provider limits requests; 0 reads every time. |
| `SOLANA_RPC_URL`, `SOLANA_NETWORK` | The node and the network (`devnet` or `mainnet-beta`). A public endpoint limits requests and answers `429` under little load; use a provider's endpoint for anything people rely on. |
| `TOKEN_LAUNCH_MIN_REPUTATION` | The launch gate: the reputation an agent needs. 50 by default. |
| `TOKEN_LAUNCH_MIN_DEPLOYMENT_AGE_DAYS` | The launch gate: the days its oldest running deployment must have run. 7 by default. |
| `NODE_ENV` | Outside `development` and `test`, a token's picture link that leads to this machine or a private network is refused (`400 picture_link_refused`), at the first address and at every redirect. Unset counts as `development`, which allows such links, so set it on any server people can reach. |

Leave the two gate settings unset in production: the defaults are the rule the product states.
They exist so that a devnet rehearsal can walk a new agent through a launch. The wizard, the
eligibility route and the launch route all read them from one place, so whatever is set is both
what people are shown and what is enforced. An API that starts with either number below its
default says so once in its log: "The token launch gate is lower than the rule", with both
numbers and the network. Nothing refuses lowered numbers on mainnet, so look for that line after
a deploy.

The RPC endpoint is asked for more than reads. A submit asks for the status of the signed
transaction's signature with a search of the node's history (`getSignatureStatuses`), once
before it sends and once more when the wait for the confirmation fails, and reads the confirmed
transaction back for a trade's amounts. A provider's endpoint must serve those.

A launch is built for the wallet linked to the account, which the API reads from the login
session. Linking a wallet under Settings issues the session cookie again, so it takes effect at
once in that browser. A session issued before the link keeps the old value until it is refreshed
(`POST /api/auth/refresh`) or signed in again. A launch from an account with no linked wallet
answers `400 wallet_required`.

A token's picture and metadata are uploaded to `https://pump.fun/api/ipfs`, so the API must be
able to reach that host and the picture's own link.

On the web app, build with `NEXT_PUBLIC_ENABLE_TOKEN_UI=true` and `NEXT_PUBLIC_ENABLE_TRADING=true`
to show the token pages and the trade panel, and with `NEXT_PUBLIC_SOLANA_CLUSTER` and
`NEXT_PUBLIC_SOLANA_RPC_URL` for the same network as the API (section 4).

Check it:

```bash
# Public, no login. "launchpad" is "meteora", "network" is the API's network,
# "presets" lists the curves on offer (the "rehearsal" curve only on devnet),
# and "gate" carries the numbers in force.
curl -s https://<api>/api/tokens/launchpad
```

No migration is needed and no worker is added: a pool's state is read from the chain when a page
asks for it. Two older workers leave Meteora tokens alone: the pump.fun trade indexer takes only
tokens whose launchpad is `pumpfun`, and the fee router (`FEE_ROUTER_INTERVAL_MS`) pays 1% of
recorded volume on pump.fun tokens' trades only. A Meteora token shares its fees on chain,
through its curve.

A buy, a sell, a claim or a graduation step that was sent and not seen confirmed answers
`502 transaction_not_confirmed` with the transaction's `signature`. The same submit may be posted
again, which is what the page's "Check again" button does: a transaction that has landed is
recorded and not sent a second time, for up to ten minutes after its prepare token ran out. One
the chain refused answers `409 transaction_failed`. A launch that was sent and not seen confirmed
is saved through `POST /api/tokens/launch/reconcile` while its prepare token lasts (5 minutes).

On mainnet Meteora's own service graduates full pools. The token's row is brought in line the
next time its curve is read (the token's page, a quote, any prepare), not on a schedule.

Changing `LAUNCHPAD` later does not move tokens already launched. Each token keeps the launchpad
it was launched on, and the curve routes answer `404 not_a_curve_token` for a token that is not
on Meteora.
