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
| `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` | verification, password reset and alert emails. Without them those flows answer 501, and new accounts cannot verify, so they never receive the $5 signup credits. `EMAIL_PROVIDER=log` is refused outside development. |
| `PUBLIC_WEB_URL` | the web origin used in email links (falls back to `CORS_ORIGIN`) |

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

## 7. Custom-domain edge (optional; custom domains answer 501 without it)

Custom domains (Pro plan) are served by a second Fly app, `wheelsai-edge`
(`infra/edge`: stock Caddy, pinned in the Dockerfile). It terminates TLS
for customer hostnames and forwards every request to the API over Fly's
private network. It keeps no list of domains: before it obtains a
certificate for a hostname it asks the API
(`GET /internal/edge/ask?domain=…&token=…`), and anything but a 200 means
no certificate. The API decides what a hostname serves.

Until this section is done, `GET /api/domains/config` reports
`configured: false` with the reason, writes answer
`501 custom_domains_not_configured`, and the checker and the host router
stay off. Nothing else about the API changes.

### 7.1 Create the edge app

```bash
flyctl apps create wheelsai-edge[-staging]
flyctl ips allocate-v4 -a wheelsai-edge[-staging]        # DEDICATED IPv4 (paid). A shared one cannot carry raw TCP 443.
flyctl ips allocate-v6 -a wheelsai-edge[-staging]
flyctl volumes create caddy_data --size 1 --region lax -a wheelsai-edge[-staging]
flyctl ips list -a wheelsai-edge[-staging]               # note every address: the API needs all of them
```

The volume holds the certificates, their private keys and the ACME
account. One machine, one volume: a second machine needs shared
certificate storage first (not built). If the volume is lost every
certificate is requested again, and Let's Encrypt allows 5 certificates per
hostname per week.

### 7.2 Secrets

Generate the two shared secrets once (`openssl rand -hex 32`, twice; they
must differ) and set the same values on both apps:

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
| `CUSTOM_DOMAIN_EDGE_HOSTNAME` | the CNAME target shown to customers: `wheelsai-edge[-staging].fly.dev`, or `edge.<platform domain>` with `A`/`AAAA` records at the edge addresses |
| `CUSTOM_DOMAIN_EDGE_IPV4` / `_IPV6` | **every** public address of the edge. A domain is "routed" only when all of its addresses are in these lists, and the certificate prober connects to these addresses and nowhere else. Private or reserved addresses are refused. |
| `CUSTOM_DOMAIN_ASK_TOKEN` | ≥32 chars. Travels in a URL (Caddy logs the ask URL when it is refused), so it authorises only the certificate question |
| `CUSTOM_DOMAIN_EDGE_SECRET` | ≥32 chars, **must differ from the ask token**. Travels only in a header. Requests carrying it are routed by customer hostname |
| `CUSTOM_DOMAIN_DNS_SERVERS` | optional, e.g. `1.1.1.1,8.8.8.8` |
| `CUSTOM_DOMAIN_PROBE_EXTRA_CA_PEM` | staging only (refused when `NODE_ENV=production`): trust the Let's Encrypt staging root if the edge runs with `ACME_CA` set to the staging directory |

A partial or malformed set does not half-work: the API reports
"misconfigured" with the variable at fault in `GET /api/domains/config`
and stays in the 501 state. Rotating either secret means setting it on
both apps; each `secrets set` redeploys its app.

### 7.3 Deploy

The API must listen on `::` to be reachable on the private network
(`API_HOST = "::"` in `apps/api/fly.*.toml`; it serves IPv4 too). Deploy
the API first, then the edge, both from the **repo root**:

```bash
flyctl deploy --config apps/api/fly.staging.toml --dockerfile apps/api/Dockerfile --remote-only
flyctl deploy --config infra/edge/fly.staging.toml --dockerfile infra/edge/Dockerfile --remote-only
```

The API release applies migration `20261009200000_custom_domain_edge`. It
also resets every certificate status the old code invented: such domains
show "No certificate" until a real one is observed, and each gets an
`ssl_status_reset` entry in its history. The edge image build runs
`caddy validate`, so a Caddyfile that does not parse fails the build, not
the running proxy.

### 7.4 Smoke

```bash
# The API says it is configured, and names the edge.
curl -fsS https://wheelsai-api-staging.fly.dev/api/domains/config -H "Authorization: Bearer $KEY" | jq '.data | {configured, unavailableReason, edge}'

# The edge reaches the API, and the API refuses a hostname nobody verified:
# the forwarded request is a 404, never the platform API.
curl -s -o /dev/null -w '%{http_code}\n' http://<edge IPv4>/v1/models -H 'Host: not-a-customer.example.org'   # 404

# No certificate for an unknown name: the handshake fails.
curl -sv --resolve not-a-customer.example.org:443:<edge IPv4> https://not-a-customer.example.org/ 2>&1 | grep -i 'alert\|error'
```

If **every** connection to the edge fails or hangs, the PROXY protocol
allow-list is wrong: `EDGE_PROXY_PROTOCOL_ALLOW` in `infra/edge/fly.*.toml`
must contain the network Fly's proxy reaches the machine from
(`flyctl logs -a wheelsai-edge-staging` shows the remote address Caddy
saw). If the plain-HTTP check answers 502, the edge cannot reach the API:
check `API_HOST = "::"` and `WHEELS_API_INTERNAL`.

Then do the proof run with a real hostname, exactly as listed in
`docs/CUSTOM-DOMAIN-RUN.md` ("The run that remains"), and record it there.

### 7.5 Operating notes

- Caddy renews a certificate about 30 days before it expires. The checker
  re-reads each serving domain's certificate every 6 hours (hourly inside
  14 days of expiry), so `sslExpiringSoon` in `GET /api/domains/stats`
  above zero means a renewal is failing.
- Let's Encrypt limits that matter: 5 failed validations per hostname per
  hour, 50 certificates per registered domain per week, 300 new orders per
  account per 3 hours. The API allows a certificate only for a domain whose
  DNS already points at the edge, and the checker makes at most 4
  handshakes per hour for a hostname without a certificate.
- The API spends the account's order limit from a budget. Each "yes" to
  the edge for a hostname without an observed certificate is recorded
  (`custom_domain_issuance_grants`) and refused with 429 once the hostname
  (5 per hour), its organization (`CUSTOM_DOMAIN_ISSUANCE_ORG_LIMIT`, 30
  per 3 hours) or the platform (`CUSTOM_DOMAIN_ISSUANCE_PLATFORM_LIMIT`,
  200 per 3 hours) has used its share. A hostname whose certificate the
  checker has observed is exempt, so an edge restart is not throttled. The
  log line `Certificate refused: issuance budget spent` at level `error`
  with `reason: issuance_budget_platform` means no new certificate is
  being issued for anyone: find the organization with the most rows in
  `custom_domain_issuance_grants` over the last 3 hours before raising
  the limit.
- One organization can have `CUSTOM_DOMAIN_MAX_PER_ORG` domains (25), and
  a checker pass takes at most 10 due domains of one organization, one
  from each organization in turn, so a backlog in one organization delays
  only that organization.
- A handshake for a hostname the API no longer allows can still succeed
  while Caddy holds its unexpired certificate. The API is what stops
  serving: such a request is answered `404 custom_domain_not_active`.
- An edge, private-network or DNS outage does not pause domains: a probe
  that cannot reach the edge changes nothing, and a tick in which most
  probes are unreachable is disregarded.
- The host routing table lives in each API machine's memory and reloads
  every `CUSTOM_DOMAIN_ROUTE_REFRESH_MS` (10 s). A switch-off or delete
  applies at once on the machine that handled it and within one reload on
  the others. If a reload has not succeeded for 60 seconds, custom-domain
  requests answer 503 instead of being routed on stale data.

## Known good / known gaps

- Boot assertions verified by unit tests: mainnet⇒non-devnet RPC,
  ENCRYPTION_KEY≠JWT_SECRET, CORS pinned, mock gates off in production,
  x402 treasury real, wallet-topup master key present.
- No staging environment has actually been stood up yet — this runbook
  is the corrected procedure, executed zero times. First real run should
  be staging, manually, before wiring the CI trigger habitually.
