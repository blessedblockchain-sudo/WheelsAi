# Founder actions

Everything the code now needs from outside the repository before the matching claim can go live. Each item names the setting it fills (see the full list in `.env.example`) and what it unlocks. Until an item is done, the feature behind it answers honestly: a 501 or 503 with the reason, or a "not configured" state in the dashboard. Nothing is faked.

Updated 2026-10-11. Tick items off here as they land.

## 1. Domain, hosting and origins

- [ ] **A domain the product can use in its claims.** `wheelsai.io` is unregistered and `wheelsai.com` belongs to someone else.
- [ ] **Fly account** and `FLY_API_TOKEN` in CI (deploy jobs in `.gitlab-ci.yml`, runbook in `docs/DEPLOY-RUNBOOK.md`).
- [ ] **Origins.** Set `PUBLIC_API_URL`, `PUBLIC_WEB_URL`, `CORS_ORIGIN` and `COOKIE_DOMAIN` on the API, and `NEXT_PUBLIC_API_URL` on Netlify. These unlock: endpoints shown to users, Telegram webhooks, OAuth redirects, links in emails, and the session cookie being seen by the web app.
- [ ] `TRUST_PROXY_HOPS` must match the real proxy chain (Fly's edge is 1).

## 2. Payments

- [ ] **Prove payments with real wallets, then with real money.** Every money path has been run on a local chain (`docs/PAYMENTS-RUN.md`, 2026-10-11). Two runs are left, and both need you:
  - Devnet, at a browser, at no cost: one $5 payment in USDC with Phantom and one with Solflare, using devnet USDC from Circle's faucet. This is the gate before mainnet: it shows the transfer each real wallet signs is one the server accepts.
  - Mainnet, on your go-ahead: about $16 in USDC and SOL and 0.11 SOL moving between your own wallets through every path (paying in, an exchange withdrawal to the deposit address, the treasury proof, a sweep, a sale, two payouts). It needs a mainnet RPC that serves history, a new master key kept offline, two wallets, an exchange account and a cold wallet. The steps are in `docs/PAYMENTS-RUN.md`.
- [ ] **Stripe account.** Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRO_PRICE_ID` (a recurring $49/month Price). This unlocks card checkout for credits, the Pro plan and trial, and the billing portal.
- [ ] **Wallet top-ups in USDC and SOL.** Set `WALLET_TOPUPS_ENABLED=true` and `WALLET_MASTER_KEY`, and `SOL_PRICE_SOURCE=pyth` to offer SOL. Production takes them only on mainnet: `SOLANA_NETWORK=mainnet-beta` with a mainnet `SOLANA_RPC_URL`.
- [ ] **Deposit addresses (USDC and SOL sent from an exchange or any wallet).**
  - Set `DEPOSITS_ENABLED=true`. It needs wallet top-ups on (the line above) and the scan worker running: `DEPOSIT_SCAN_INTERVAL_MS` above 0 (60000 by default). `DEPOSIT_SCAN_MAX_ADDRESSES` (500) is the most addresses one run looks at.
  - "Prepare address" spends from the paying wallet (the one that pays creators): about 0.002 SOL for each USDC account it opens. Decide the limits if the defaults do not suit: 25 accounts a day in all (`DEPOSIT_ACCOUNT_OPENS_PER_DAY`), and none while that wallet holds under 0.05 SOL (`HOT_WALLET_MIN_SOL`). Keep the wallet funded.
  - Back up `WALLET_MASTER_KEY` and never change it once customers have saved their addresses: every deposit address is derived from it.
- [ ] **Sweeps (moving what customers paid off their deposit addresses).** Do these before `SWEEPS_ENABLED=true`:
  - Apply migration `20261017200000_chain_transfers`.
  - Create the treasury wallet: the wallet everything above the paying wallet's float is sent to. Keep its key off the product: not in any setting, not on the API's host, not in the repository. A hardware wallet is the place for it. It must be an ordinary wallet you can sign a transfer with: not an exchange deposit address, not a token account or a multisig vault (an address with no key of its own is refused), and not the paying wallet or a customer's deposit address. Back the key up: what is swept there can be moved by that key only.
  - Set `TREASURY_WALLET_ADDRESS` to its address. x402 payments go to the same address.
  - Prove it. From the treasury wallet, send 0.1 SOL to the paying wallet (the API logs its address at start when payouts are scheduled), then run `npx tsx scripts/treasury-verify.ts` in `apps/api`. Until this has succeeded nothing is sent to the treasury. Do it again whenever `TREASURY_WALLET_ADDRESS` changes. Steps in `docs/DEPLOY-RUNBOOK.md`, section 13.1.
  - Decide the floats if the defaults do not suit: what the paying wallet keeps to pay creators with, $200 of USDC and $100 of SOL (`HOT_WALLET_FLOAT_USDC`, `HOT_WALLET_FLOAT_SOL_USD`). It can hold up to about twice that before the excess goes to the treasury. The floats set how much `WALLET_MASTER_KEY` alone can reach: about twice the floats, plus what sits at deposit addresses and has not been swept yet (`docs/THREAT-MODEL.md`, section 2). Also the least worth moving, $25 (`SWEEP_MIN_USD`), and the most transfers a run, 20 (`SWEEP_MAX_PER_RUN`).
  - Then set `SWEEPS_ENABLED=true`. It needs deposit addresses on (the item above) and `SWEEP_INTERVAL_MS` above 0 (300000 by default), and `SOL_PRICE_SOURCE=pyth` for SOL to be swept.
  - Read the money report after the first sweeps land: `GET /api/platform/money` with `x-admin-key` (it needs `PLATFORM_ADMIN_KEY`, section 8). The reconciliation difference should be 0 for USDC and for SOL (`docs/DEPLOY-RUNBOOK.md`, section 13.2).
- [ ] **Enterprise customers.** An organization is put on Enterprise by hand: `npx tsx scripts/set-plan.ts <organization> enterprise` in `apps/api` (`docs/DEPLOY-RUNBOOK.md`, section 13.3).
- [ ] **Creator payouts.**
  - Set `PAYOUTS_ENABLED=true` and `PAYOUT_EXECUTOR_INTERVAL_MS`. Payouts to a wallet also need the paying wallet derived from `WALLET_MASTER_KEY` to hold USDC, SOL and a little SOL for fees (the API logs its address at start), and `SOL_PRICE_SOURCE=pyth` to offer SOL.
  - Decide the limits if the defaults do not suit: $500 a payout, $1,000 a creator a day, $5,000 a day in all (`PAYOUT_MAX_PER_PAYOUT_USD`, `PAYOUT_MAX_PER_DAY_USD`, `PAYOUT_PLATFORM_MAX_PER_DAY_USD`).
  - Compliance (checking wallets against the US sanctions list, and identity checks) was deferred on 2026-10-10. No check of who is paid exists yet.
- [ ] **x402.** Set `X402_ENABLED`, `X402_INFERENCE_MODE`, `X402_SUBMIT_TRANSACTIONS` and the settlement worker flags once the receiving treasury is live (`TREASURY_WALLET_ADDRESS`).

## 3. Nosana compute (mainnet)

The platform pays Nosana in one of two ways. Pick one; both unlock model and agent deployments. Migration `20261011100000_nosana_access_mode` must be applied either way (each row records which of the two created its Nosana deployment).

- [ ] **Option A: a dashboard API key and prepaid USD credits.** No wallet, no NOS, no SOL, no paid RPC for Nosana.
  - Create the key in Nosana's dashboard ([FOUNDER: confirm the page; public docs say deploy.nosana.com, Account, API Keys]), with every permission left on. Note its expiry date: when it expires, new deployments answer 503 and running ones can no longer be stopped from here until the key is replaced.
  - Set `NOSANA_API_KEY` in the API's environment only, and `NOSANA_ACCESS_MODE=api_key`. `NOSANA_NETWORK` defaults to `mainnet` with a key; `SOLANA_NETWORK` can stay as it is for the app's own programs. If a wallet key stays set beside the API key, leave `NOSANA_NETWORK` unset unless both really are on one network: unset, the wallet keeps the network of `SOLANA_NETWORK` for the deployments it created and the key uses mainnet (the API logs one warning naming both); set, it moves both.
  - Load credits. **Minimum balance:** a deployment is admitted only when its estimated cost plus `NOSANA_MIN_CREDITS_USD` (default 5) is available, so the balance must stay above $5 plus what the next deployment needs. For the first paid run load **$15**. Below `NOSANA_CREDITS_WARN_USD` (default 20) the operator view reads "low"; raise both before a public launch in proportion to what runs.
  - Confirm `NOSANA_TIMEOUT_UNIT`. Public sources say Nosana reads a deployment's timeout in minutes, and `minutes` is the default here. The first paid run measures it (`docs/NOSANA-DEPLOY-RUN.md`, step 5); set the variable to what it shows. Do not start a long deployment before that.
  - Check the key without spending anything: `cd apps/api && npx tsx scripts/nosana-access-check.ts`. It only reads, and prints the mode, the key's last four characters, the balance, the account's deployments and the cost of each tier.
  - **The operator view:** `GET /api/platform/compute` with the header `x-admin-key: <PLATFORM_ADMIN_KEY>` (section 8). It shows the balance against the floor, cost and margin per tier, what is running, rows that belong to the other credential, and deployments Nosana runs under a `wheelsai-` name that no row tracks. That last list is a report: nothing is stopped automatically, so stop anything it names in Nosana's dashboard.
  - When new deployments cannot be paid for, customers see "GPU deployments are paused right now. Nothing was charged." and `/status` shows GPU compute as "New deployments paused". Neither says why.
  - One-shot jobs have no private equivalent with a key, so **OpenClaw start and restart answer 501** in this mode until OpenClaw moves to a deployment.
  - Run the first paid run by the checklist in `docs/NOSANA-DEPLOY-RUN.md` and fill in its results table.
- [ ] **If both a key and a wallet are set,** `NOSANA_ACCESS_MODE` is required: the API refuses to boot rather than guess which account pays. Keep the other credential in place for as long as rows it created are still running or not confirmed released (the operator view lists them under `unreachable` once it is gone); remove it after that so there is one payer. While it is missing, those deployments are not billed to their owners (the platform carries the GPU time), an owner's stop marks the row stopped without stopping anything on Nosana, and the deployment itself is only stopped once the credential is back or by hand in Nosana's dashboard.
- [ ] **Option B: a funded mainnet wallet** (NOS + SOL) in `NOSANA_WALLET_PRIVATE_KEY`, with `SOLANA_NETWORK=mainnet-beta` and a paid RPC in `SOLANA_RPC_URL`. This unlocks model and agent deployments (fund, start, per-second GPU billing, vault reclaim). Market addresses for 3060, 4070, 4090, A100 and H100 are built in for mainnet. Devnet needs `NOSANA_MARKETS_JSON`.
- [ ] `HF_TOKEN` for gated Hugging Face models. It is only ever sent inside confidential job definitions.
- [ ] **Confirm on the first funded run** what the code could not verify without funds:
  - that `confidential: true` delivers the job definition to hosts;
  - the strategy semantics (`SIMPLE-EXTEND`);
  - whether endpoints are one URL per replica;
  - the 10% network fee;
  - withdraw-after-stop timing;
  - that the vLLM and Ollama image versions run on these markets (the markets list vLLM 0.9.2/0.10.2 and Ollama 0.15.4/0.32.6).

  Record the results in `docs/NOSANA-DEPLOY-RUN.md`.
- [ ] **Build and publish the hardened OpenClaw image** named in `OPENCLAW_DEFAULT_IMAGE`. It does not exist yet.

## 4. Models and search

- [ ] **Free model keys:** `GROQ_API_KEY` (in use), `GOOGLE_GEMINI_API_KEY`, `TOGETHER_API_KEY`. These cover the "free models, no API key" claim for Gemini and Together.
- [ ] **Embeddings.** `EMBEDDING_PROVIDER` and `EMBEDDING_MODEL` (any OpenAI-compatible `/embeddings` provider; later the self-hosted model on Nosana). They unlock semantic knowledge search; without them search runs in keyword mode and says so.
- [ ] **Web search.** `TAVILY_API_KEY` enables the `web_search` skill.

## 5. Code sandbox and storage

- [ ] **A sandbox runner service** at `SANDBOX_RUNNER_URL` (+ `SANDBOX_RUNNER_TOKEN`). It unlocks the `code_interpreter` skill and graph `code` nodes. The HTTP contract is in the header of `apps/api/src/services/skills/sandboxRunner.ts`: a fresh isolated sandbox per request, no network egress, a read-only root filesystem, CPU/memory/pid limits, and a kill on timeout. It must be reachable at a public address.
- [ ] **An S3 or R2 bucket.** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and `DATASETS_BUCKET` unlock fine-tuning datasets and per-agent files (`file_read`/`file_write`). For R2 or any other S3-compatible store also set `S3_ENDPOINT`. The bucket's settings and the test to run on it are in section 15.

## 6. Channels and integrations

- [ ] **Telegram.** Works once `PUBLIC_API_URL` is set: saving a channel registers the bot with Telegram.
- [ ] **Slack app registration.** Set `SLACK_OAUTH_ENABLED`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`.
- [ ] **A GitHub App under a working account or org** (the personal account is suspended). Set `GITHUB_APP_ENABLED`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`. This unlocks private-repo import and push-to-redeploy.

## 7. Email

- [ ] **Resend.** Set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM` on a domain with SPF and DKIM set up. This unlocks email verification (and with it the $5 signup credit), password reset, team invites and alert emails.
- [ ] The same provider sends a buyer the "deliverable ready, review it" email for a paid job. Without it that notice is in the app and by webhook only, and a buyer who misses it loses the right to reject after 72 hours. Set `PUBLIC_WEB_URL` too, so the email can link to the job.
- [ ] `SALES_EMAIL` for Contact Sales requests (they are stored either way).

## 8. Operations

- [ ] **The public `/status` page.** Create an organisation for the platform, add uptime monitors for its public endpoints, and set `STATUS_PAGE_ORG_ID`.
- [ ] **Measured latency.** Apply migrations `20261010200000_request_latency` and `20261010210000_null_legacy_snapshot_percentiles` (the second clears the stored analytics percentiles that were averages of hourly averages). Then:
  - set `PUBLIC_LATENCY_EXCLUDED_ORG_IDS` to every internal and test organisation, including the `STATUS_PAGE_ORG_ID` organisation if it ever sends chat traffic, so our own requests are not in the published figure;
  - confirm the publication thresholds (`PUBLIC_LATENCY_MIN_SAMPLES=50`, `PUBLIC_LATENCY_MIN_ORGS=3`, `PUBLIC_LATENCY_WINDOW_HOURS=24`); until both are met, `/status` and `GET /api/public/stats` say "measuring" and state no number. Each organisation counts for at most its 17 most recent answered requests (50 / 3, rounded up; it follows the two thresholds), so the figure needs real traffic from at least three organisations and cannot be set by one;
  - keep `ANALYTICS_SNAPSHOT_INTERVAL_MS` above 0 in production: that worker is what deletes timing rows older than `LATENCY_SAMPLE_RETENTION_DAYS` (30), and with it off the table only grows;
  - keep `ALERT_EVALUATOR_INTERVAL_MS` above 0 for latency alerts to be evaluated.
  - decide whether the running count should be public before a figure exists. The landing page says only "measuring"; `/status` ("So far: N answered requests"), `wheelsai deploy` ("measuring (N of 50 requests)") and `GET /api/public/stats` (`sampleCount`) state how many requests are in so far, which tells a reader how much traffic the platform has.
  - the landing page's "Latency:" line and the note under it read `GET /api/public/stats` from the browser, so `NEXT_PUBLIC_API_URL` must be set on Netlify and the site's origin must be in `CORS_ORIGIN`; until then the line reads "live figure unavailable" (it never shows a number it did not read). `wheelsai deploy` prints the same field.
- [ ] **Latency alert rules created before this release.** `latency_p95` and `latency_avg` rules were accepted and never evaluated; they are evaluated now, with the threshold read as milliseconds. A rule saved with `5` meaning seconds fires on every window slower than 5 ms. List them (`SELECT id, org_id, name, threshold FROM alert_rules WHERE metric IN ('latency_p95','latency_avg')`) and tell their owners, or disable them until confirmed.
- [ ] `SENTRY_DSN` for error tracking.
- [ ] `METRICS_TOKEN` if `/metrics` is reachable outside Fly's private network.
- [ ] `PLATFORM_ADMIN_KEY` for marketplace curation (featured listings) and for the operator views: the GPU compute account, `GET /api/platform/compute` (section 3), and the money report, `GET /api/platform/money` (section 2). Without it those views answer 503.
- [ ] **Offerings and Jobs.** Apply migrations `20261009100000_offerings_jobs_runner` and `20261009110000_job_model_usage`. The runner and the sweeper start with the API (`JOB_RUNNER_CONCURRENCY=2`, `JOB_SWEEP_INTERVAL_MS=60000`, `JOB_MAX_RUN_MS=900000`); size the concurrency for the jobs you expect, and never run with the sweeper off where jobs are on, because the sweeper is what refunds an overdue job and settles one whose review window closed.
- [ ] **Run one paid model job for real.** The proof run (`docs/AGENT-JOBS-RUN.md`) hired, ran and settled agent and workflow jobs; a model offering needs a running GPU deployment, which the local machine does not have, so that path is covered by unit tests only. With a deployment running: create a model offering on it, hire it from a second organization, accept, and add the transcript to the proof doc.
- [ ] **Decide what a paid job's use of the platform's free-model keys costs the publisher.** The defaults are the model catalog's small-model rate, 15 cents per million input tokens and 60 per million output (`JOB_PLATFORM_MODEL_INPUT_CENTS_PER_MTOK`, `JOB_PLATFORM_MODEL_OUTPUT_CENTS_PER_MTOK`), taken from the publisher's share when a job settles. Check the providers' terms for commercial use of those keys before launch.

## 9. Tokens

- [ ] `PUMPFUN_API_KEY` and a mainnet proof of a pump.fun launch before `NEXT_PUBLIC_ENABLE_TOKEN_UI=true` (in-app trading also needs `NEXT_PUBLIC_ENABLE_TRADING`).
- [ ] The fee router: a funded `FEE_ROUTER_WALLET_PRIVATE_KEY`, then `FEE_ROUTER_INTERVAL_MS`.
- [ ] The reputation attestor: whitelist the wallet with the oracle's `add_attestor`, then set `REPUTATION_ATTESTOR_PRIVATE_KEY` and `REPUTATION_ATTESTATION_INTERVAL_MS`.
- [ ] Bags (mainnet only): `LAUNCHPAD=bags`, `BAGS_API_KEY`, `BAGS_FEE_RECIPIENT`.

## 10. Company and legal content

The pages render unconfirmed details visibly as `[FOUNDER: ...]` so none can ship unnoticed.

- [ ] **Privacy and terms** (both marked draft pending legal review):
  - per-request timing records (organisation, agent or deployment, model, outcome, durations; no content) and their retention period, in sections 2 and 10 of the privacy page
  - legal entity name and registered address
  - hosting providers and the primary data region
  - log and backup retention periods
  - post-termination data retention period
  - security, privacy and legal-notices contact emails
  - minimum age
  - refund policy for unused credits
  - governing law, courts or arbitration venue
  - effective date
- [ ] **About:** team names and bios, entity name and location.
- [ ] **Careers:** location and remote-work policy.
- [ ] **Community links in the footer:**
  - confirm the X handle `@Wheels_Ai`
  - create the Discord, GitHub and Telegram communities (the links point at /contact until then)

## 11. Grant proofs (Nosana)

These all need Nosana compute paid for as in section 3 (API-key credits or the funded mainnet wallet):

- [ ] a paid mainnet deployment answering `/v1` (`docs/NOSANA-DEPLOY-RUN.md`)
- [ ] the first creator payout with its transaction signature
- [ ] at least 10 external products deployed with public receipts pages

## 12. Custom domains (the edge proxy)

Custom domains are sold on the Pro plan and are fully built, but they need infrastructure that does not exist yet: an edge proxy with its own public addresses that terminates TLS for customer hostnames. Until every item below is done the API answers `501 custom_domains_not_configured` to adding, checking and switching on a domain, the Domains page shows "Custom domains are not configured on this server", no certificate is requested and no request to a customer hostname is served. Step by step: `docs/DEPLOY-RUNBOOK.md`, "Custom-domain edge". What has and has not been proven: `docs/CUSTOM-DOMAIN-RUN.md`.

- [ ] **The edge app on Fly.** Create `wheelsai-edge` (and `wheelsai-edge-staging`), deployed from `infra/edge` (stock Caddy, one machine):
  - a **dedicated IPv4 address** (paid; Fly needs one because the app terminates TLS itself on raw TCP) and an IPv6 address;
  - a 1 GB volume named `caddy_data` mounted at `/data`. It holds the certificates, their keys and the ACME account. Losing it re-requests every certificate, and the certificate authority allows 5 per hostname per week.
- [ ] **A hostname for the edge that the platform controls** (the CNAME target customers point at). Either `edge.<the platform domain>` with `A` and `AAAA` records pointing at the two edge addresses (needs the domain from section 1), or `wheelsai-edge.fly.dev` to start with: it needs no domain purchase, and customers who used it keep working after a later move.
- [ ] **An ACME account email** (`ACME_EMAIL` on the edge): a monitored mailbox. Using it accepts the Let's Encrypt subscriber agreement. Expiry and policy notices go there.
- [ ] **Two shared secrets**, each at least 32 random characters and different from each other, set to the same values on the edge app and on the API:
  - `CUSTOM_DOMAIN_ASK_TOKEN`: the edge presents it when it asks the API whether it may obtain a certificate for a hostname;
  - `CUSTOM_DOMAIN_EDGE_SECRET`: the edge sends it with every request it forwards. Only requests carrying it are routed by customer hostname.

  Rotating either one means setting it on both apps and redeploying both.
- [ ] **API settings** (`flyctl secrets set` on `wheelsai-api`): the two secrets above, plus
  - `CUSTOM_DOMAIN_EDGE_HOSTNAME`: the edge hostname chosen above;
  - `CUSTOM_DOMAIN_EDGE_IPV4` and `CUSTOM_DOMAIN_EDGE_IPV6`: **every** public address of the edge (`flyctl ips list -a wheelsai-edge`). A domain counts as routed only when all of its addresses are in these lists, so an address the edge answers on but that is missing here makes every customer read as "DNS points elsewhere". Update them whenever an address is added or released.
  - optionally `CUSTOM_DOMAIN_DNS_SERVERS` (for example `1.1.1.1,8.8.8.8`), so verification does not depend on the host's resolver.
- [ ] **Confirm or change the three shared-capacity limits** (API settings; the defaults apply if you set nothing). Every organization shares the edge's one account with the certificate authority (Let's Encrypt allows 300 new orders per account per 3 hours, counted even when validation fails) and one checker, so one organization must not be able to use all of either:
  - `CUSTOM_DOMAIN_MAX_PER_ORG` (default 25): how many custom domains one organization may have, in any state. The 26th answers `403 domain_limit_reached`. This is a platform safety limit, the same for Pro and Enterprise; it is stated on the Domains page, in the guide and in `GET /api/domains/config`. Raising it for one customer means raising it for all, so raise the two below with care at the same time.
  - `CUSTOM_DOMAIN_ISSUANCE_ORG_LIMIT` (default 30): how many times in 3 hours the edge may be told to obtain a certificate for one organization's hostnames that have none yet.
  - `CUSTOM_DOMAIN_ISSUANCE_PLATFORM_LIMIT` (default 200): the same across all organizations. Keep it below the certificate authority's account limit; the difference is the room left for renewals, which the edge makes on its own. If you request a higher account limit from Let's Encrypt, raise this afterwards.
- [ ] **Redeploy the API** with the `API_HOST = "::"` change in `apps/api/fly.*.toml`. The edge reaches the API over Fly's private network, which is IPv6 only. Confirm on staging that the public API still answers afterwards (`/health/ready`).
- [ ] **A real hostname for the proof run**: a domain or subdomain whose DNS you can edit. Do the staging run in `docs/CUSTOM-DOMAIN-RUN.md` ("The run that remains") and record its output there: the certificate issued by a public certificate authority, what the checker observed, and a request answered through the hostname. Add the changelog entry only after it passes.
- [ ] **Stripe Pro live** (section 2), so the entitlement the feature checks is a real subscription.

Decisions already made and built, listed so nobody re-opens them by accident: HTTPS is always enforced on a custom domain; a plan either includes custom domains or it does not (Pro and Enterprise do, with no count, because the plan table states none); a verified domain whose TXT record disappears keeps serving for 72 hours; a domain that never verifies expires after 14 days.

## 13. Web chat widget and Try it

The web chat channel (a widget an owner embeds on their own site) and Try it (a free preview chat on every published listing) are built and mounted. Both serve people nobody can identify, so every limit below is enforced on a limiter that refuses when it cannot count: while its Redis is unreachable they answer `503 rate_limiter_unavailable`. What is left is configuration and decisions.

- [ ] **Cloudflare Turnstile keys** (`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, set together; the API refuses to start with only one). Create a Turnstile widget for the web app's hostname. Until both are set, Try it requires sign-in: an anonymous visitor is shown "Sign in to try this agent" and `POST /api/marketplace/listings/:slug/try/session` answers `401 signin_required`. It never runs without a check.
- [ ] **The price of a publisher-funded Try it message** (`TRIAL_FUNDED_MESSAGE_CENTS`, whole cents, no default on purpose: a made-up price would debit real credits). Until it is set, a publisher who asks for more daily messages than the platform pays for gets `501 trial_funding_not_configured`, and no publisher is charged anything. Once set, each message above the platform's daily ones debits the publisher's credits by this amount before the model is called, and is refunded if no answer is delivered.
- [ ] **Confirm or change the limits** (API settings; the defaults apply if you set nothing, and they were chosen by engineering, not by you):
  - `TRIAL_BASE_DAILY_MESSAGES` (default 50): Try it messages a day the platform pays for, per listing. This is the platform's own cost on its free-model keys.
  - `TRIAL_MESSAGES_PER_SESSION` (default 10), `TRIAL_PER_IP_PER_HOUR` (default 30), `TRIAL_SIGNED_IN_PER_DAY` (default 100, per signed-in organization across all listings), `TRIAL_GLOBAL_PER_MINUTE` (default 20, every Try it message on the platform: they share the free-model providers' rate limits).
  - `WIDGET_PER_IP_PER_MINUTE` (default 10), `WIDGET_PER_IP_PER_DAY` (default 200), `WIDGET_PER_KEY_PER_MINUTE` (default 60), `WIDGET_DEFAULT_DAILY_CAP` (default 1,000: a widget key's messages a day when its owner set no cap of their own; an owner can set 1 to 100,000).
  - Fixed in code, listed so they are known: a widget's configuration can be loaded 60 times a minute per address; 10 Try it sessions an hour per address and 30 per signed-in organization; 20 live widget keys per agent; a publisher-funded cap of at most 10,000 messages a day per listing.
- [ ] **`PUBLIC_WEB_URL` and `PUBLIC_API_URL`** (section 1) are what the embed snippet is written from. Outside development, while either is unset the dashboard shows "this server does not know its public address" instead of a snippet.
- [ ] **Redis for the limiter**: the public chat limiter uses `REDIS_URL` with its own connection. It must not evict keys (`maxmemory-policy noeviction`), or a daily cap can silently start over.
- [ ] **Legal review of the privacy page section** for the widget and Try it (section 9 of `/privacy`, marked `[FOUNDER: legal review]`, including a retention period for saved widget conversations and Cloudflare Turnstile as a processor): the widget keeps a conversation in the visitor's browser on the host site, transcripts are stored only when the key's owner opts in, and Turnstile is a third-party script on listing pages once its keys are set.
- [ ] **A real site for the embed proof.** `docs/WEB-WIDGET-RUN.md` proves the widget from another local origin (a different port). It has not been pasted into a page on a real third-party domain over HTTPS, behind the production proxy. Paste a key's snippet into a page you control, allow that origin on the key, and check the chat answers and that a page on another domain is refused; record it in that document (section K lists this and the other things the run could not prove without you: Turnstile, the funded-message price).
- [ ] **Two `[FOUNDER: ...]` marks in the docs guide** (`/docs/guides/web-chat-widget`): the default widget limits and the default Try it limits are printed there as numbers. Confirm them (or change the settings above and the guide with them) and remove the marks.

Decisions already made and built, listed so nobody re-opens them by accident: Try it is on for every published listing and has no off switch; it always runs on a free model the platform provides, never on the publisher's provider keys, and the panel says so when the listing's own model differs; a public audience gets no tool that moves money, writes or reads the agent's saved data, or sends a request out; widget messages count against the key owner's monthly API calls; "Powered by WheelsAI" can be hidden only while the owner's plan has white-labelling (Enterprise), and comes back by itself on a downgrade; a revoked widget key is kept, not deleted.

One limit of what is built: a listing whose agent answers through a saved graph cannot be previewed yet (`501 not_supported`, reason `graph_agent_preview`); see `docs/HARDENING-BACKLOG.md`.

## 14. Fine-tuning: the training image

The container a fine-tuning job runs on a GPU node is written and tested on CPU (`infra/training/`, contract and measured runs in its README). It has never been built or published, and no job can run until it is.

- [ ] **Decide where the training image is published.** A GPU node pulls it without credentials of ours, and the image holds no secrets, so the simple choice is a public repository: a small public GitLab project's registry, or Docker Hub. The fallback is this project's private registry plus a read-only deploy token that the API places in the job definition. Set the `TRAINER_IMAGE_REPOSITORY`, `TRAINER_REGISTRY`, `TRAINER_REGISTRY_USER` and `TRAINER_REGISTRY_PASSWORD` CI variables (masked and protected) for anything other than this project's own registry.
- [ ] **Press the `trainer-image` job** in a pipeline on the default branch (it is manual and has never run: allow 45 minutes, the image is several gigabytes). It prints `TRAINING_IMAGE=<repository>@sha256:<digest>`. Set that line on the API as it is: `TRAINING_IMAGE` takes the digest form only, and a tag is treated as not configured (`501 training_image_not_configured`). For a private repository also set `TRAINING_IMAGE_REGISTRY_SERVER`, `TRAINING_IMAGE_REGISTRY_USERNAME` and `TRAINING_IMAGE_REGISTRY_PASSWORD` (all three or none; they travel to the node inside the job definition, so use a read-only token).
- [ ] **Pull the published image once from a machine outside the project** to confirm it is readable without credentials.
- [ ] **`HF_TOKEN`** (section 3) with the Llama and Mistral licences accepted on Hugging Face. Without it only ungated base models can be fine-tuned; a gated one ends with exit 12, `base_model_gated`.
- [ ] **Confirm on the first GPU run** what the CPU proof cannot show (the full list closes `infra/training/README.md`): that the image builds and a node pulls it, QLoRA 4-bit loading on the node's driver, peak VRAM and tokens per second per base model and tier, and that vLLM loads the adapter with `--lora-modules`.

## 15. Fine-tuning: object storage

Datasets and trained adapters live in one S3-compatible bucket; per-agent files share it. The storage code is built and proven against a local MinIO (`docs/OBJECT-STORAGE-RUN.md`). No real bucket exists yet, so a deployed server answers `503 dataset_storage_not_configured` and the datasets page says uploads are not available.

- [ ] **Create the bucket and an access key limited to it.** The default is one Cloudflare R2 bucket (no egress charge when a GPU node downloads a dataset) with an API token of type "Object Read & Write" scoped to that bucket. AWS S3 works the same way without the endpoint. Keep the bucket private: nothing reads it without a signed link.
- [ ] **Set on the API:** `DATASETS_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and for R2 `S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com` (the region then defaults to `auto`, which is what R2 expects). Leave `S3_FORCE_PATH_STYLE` unset for R2 and AWS; it is for MinIO. Leave `STORAGE_DRIVER` unset: `local` is refused outside development.
- [ ] **Add a CORS rule to the bucket.** The dashboard uploads a dataset from the browser straight to the bucket, and the provider refuses that without one. Allow the web origin only:

  ```json
  [{ "AllowedOrigins": ["https://<the web origin>"], "AllowedMethods": ["PUT"], "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
  ```

- [ ] **Run the smoke test against the real bucket** with the same variables the API will have: `cd apps/api && npx tsx scripts/object-store-smoke.ts`. It uploads through a presigned link, checks that a link refuses another size and another content type, reads the object back, deletes what it wrote, and prints no credential. One thing it settles that MinIO could not: whether R2 enforces the signed upload size. If that check fails, the size limit is still enforced at validation (an oversize object is deleted), but say so in `docs/HARDENING-BACKLOG.md`.
- [ ] **Then upload one dataset from the deployed dashboard**, which is the only test of the CORS rule.
- [ ] **Decide the dataset limits** if the defaults do not suit: `TRAINING_DATASET_MAX_BYTES` (200 MB) and `TRAINING_DATASET_MAX_ROWS` (200,000).
- [ ] **Decide what happens to old objects.** Deleting a dataset removes its object; if that delete fails the object stays and is only logged. A lifecycle rule on the bucket, or a sweep, is not built (see the backlog).

## 16. Fine-tuning: running jobs for real

The job service, the worker that follows a run, billing, the fine-tuned model and its serving are built. They were proven end to end on one machine with a stand-in for Nosana and a small model on CPU (`docs/FINE-TUNE-RUN.md`, part 1). **No job has run on a GPU.** Until every item in the first list is done, `POST /api/training/jobs` refuses with the named reason before any credit moves, and the dashboard says why. `GET /api/training/capabilities` lists the reasons that apply to a server.

What must exist:

- [ ] **Nosana compute** (section 3), and the timeout unit confirmed by the first paid deployment run (`docs/NOSANA-DEPLOY-RUN.md`, step 5) before any training job is started: a training job's Nosana timeout is the run limit plus the set-up allowance, sent in that unit. Default in place: no credential, so jobs answer `501 nosana_not_configured`.
- [ ] **The training image published and `TRAINING_IMAGE` set** (section 14). Default in place: unset, `501 training_image_not_configured`.
- [ ] **The bucket** (section 15). Default in place: none, `503 dataset_storage_not_configured`.
- [ ] **`PUBLIC_API_URL` reachable from a GPU node over HTTPS** (section 1). The trainer posts its progress there and a serving deployment downloads its adapter from there. Default in place: unset, `503 training_callbacks_not_configured`, and a deployment of a fine-tuned model answers `503 adapter_download_not_configured`.
- [ ] **Migration `20261012100000_fine_tuning` applied.**
- [ ] **The workers on.** `TRAINING_POLL_INTERVAL_MS` (default 15000; with 0 jobs answer `503 training_poller_disabled`) needs Redis. `DEPLOYMENT_STATUS_INTERVAL_MS` must be above 0 as well (with 0 jobs answer `503 training_orphan_sweep_disabled`): its sweep is what confirms a training deployment stopped when the stop could not be confirmed at once (a record is written for it in most runs). `GPU_BILLING_INTERVAL_MS` bills a deployment that serves a fine-tuned model.
- [ ] **Platform credits on Nosana for the job.** A job is admitted only when Nosana credits cover its whole timeout (run limit plus allowance) plus the floor (section 3). One 4070 job with a 15-minute run limit needs about $0.05 on top of the floor.
- [ ] **`HF_TOKEN`** only if gated base models are to be offered (section 14). Default in place: unset, so Phi-3 mini and Qwen2 7B are offered and the Llama and Mistral models read "needs a Hugging Face token".
- [ ] **Do the first paid run** by the checklist in `docs/FINE-TUNE-RUN.md`, part 2, and fill in its results table and both receipts.

Decisions, each with what the code does today:

- [ ] **What a training second costs.** Today: the tier's retail deployment price (3060 $0.36, 4070 $0.54, 4090 $0.90, A100 $2.88, H100 $5.40 an hour). Training has no price of its own. The hold is that price times the run limit the user chose; the charge is that price times the seconds run, rounded up to a cent, never above the hold.
- [ ] **Who pays for a run that did not finish.** Today (`classifyTrainingOutcome`, one test per row):
  - charged for the seconds run: a completed run, including one the trainer stopped at its own run limit with a partial adapter; a run the user cancelled (to the moment of the request, not for the time the stop takes); a failure the data caused (rows that cannot be read or trained on, a dataset that is not the one validated, a loss that diverged);
  - charged nothing: a submit that failed; no node within the queue time; a base model or image that could not be pulled; a dataset that could not be downloaded from our storage; an upload that failed; a missing or invalid adapter; out of memory; an unexpected crash; an interruption the user did not ask for, at the run limit or not; a deployment that went to error or ran out of platform funds; anything with no exit code and no final event.
  - A cancel cannot change what already happened: a run that had completed before the cancel was requested is finished and charged as completed (the user gets the model); one that had failed first ends "cancelled" with the failure's reason, charged as that failure is; once the trainer has reported its end, cancel is refused. Decided on review: an interruption at the run limit is free (it was charged before), and the failed dataset download stays free.
- [ ] **The time rules.** `TRAINING_QUEUE_TIMEOUT_SECONDS` (default 1800): a job no node takes in that time fails and costs nothing. `TRAINING_SETUP_ALLOWANCE_SECONDS` (default 900): added to the run limit for the Nosana timeout so pulling the image cannot use up the user's run; the platform pays Nosana for it and never bills it. The run limit is between 300 seconds and `NOSANA_BATCH_JOB_TIMEOUT_SECONDS` (default 21600) minus the allowance, so 5 hours 45 minutes at most.
- [ ] **How many jobs at once.** `TRAINING_MAX_ACTIVE_JOBS_PER_ORG` (default 2). There is no platform-wide limit; the Nosana credit gate is the only brake.
- [ ] **How many free failures.** `TRAINING_FREE_FAILURES_PER_DAY` (default 3): jobs of one organization that may end failed and charged nothing in a rolling 24 hours, since the platform pays Nosana for each. At the limit the organization's next job is refused until the oldest is a day old, with that time in the message. Today every free failure counts, including ones caused by an outage on our side (no node, an image that cannot be pulled), which can lock organizations out for a day.
- [ ] **The largest adapter accepted.** `TRAINING_ADAPTER_MAX_BYTES` (default 2 GiB).
- [ ] **The catalog.** Six base models with planning figures for the memory each needs (`apps/api/src/config/trainingCatalog.ts`); only LoRA and QLoRA; one GPU. Confirm or correct the figures from the first runs (part 2 of the run document records peak memory).
- [ ] **The estimate shown before a job.** It is a planning figure (labelled so in the API): it assumes 240 s to pull the image, 185 s of set-up and 60 s to wrap up, and a throughput worked out from the model size. Replace the constants with measured ones after the first runs.
- [ ] **The README line "fine-tuned models served per-request via x402".** Left as it is. What is built: a fine-tuned model is served by a dedicated deployment that its owner pays for per GPU-second, and requests to it are included in that. A per-request x402 price on a fine-tuned model is not built. Decide whether to build it or reword the line.
- [ ] **Rotating `JWT_SECRET`.** It signs the trainer's callbacks and the adapter links inside running deployments. After a rotation a running training job can only be finished from its Nosana logs, and a running fine-tuned deployment cannot fetch its adapter again until it is restarted. Rotate when no training job is running.

## 17. Deploying: internal notes moved from the deploy runbook

`docs/DEPLOY-RUNBOOK.md` was rewritten on 2026-10-07 as a self-hosting guide for outside operators. Everything internal it held is kept here, as it stood, so nothing is lost. The runbook used to be titled "Deploy Runbook — Fly.io Staging & Production (B7)"; B7 is the plan's ticket for the deploy pipeline.

### Blockers that are user actions

1. **GitLab runner identity verification.** CI has NEVER executed (1,400+ tests, zero CI runs). Until GitLab verifies the account, no pipeline, including the deploy jobs, runs at all.
2. **Fly.io account with billing.** The apps, Postgres and Upstash Redis are paid resources.
3. **`FLY_API_TOKEN` in GitLab.** `flyctl tokens create deploy -x 999999h`, then Settings → CI/CD → Variables, masked and protected. The deploy jobs in `.gitlab-ci.yml` only appear when this variable exists.

### Ticket codes the runbook carried

- Stripe checkout: T3/T4. Wallet top-ups: T5. x402 pay-per-request: T7. (The runbook's "Optional rails" table, now section 3.4 of the guide, "Features", without the codes.)

### CI status and history

- The deploy jobs `deploy:staging:api` and `deploy:staging:web` (`.gitlab-ci.yml`, manual trigger, default branch only) run the guide's deploy commands after the unit and migration gates, "once the runner is verified".
- The old GitHub deploy workflow omitted the `NEXT_PUBLIC_*` build args: any web bundle it shipped pointed at `http://localhost:4000`.

### Known good / known gaps (as the runbook stated them)

- Boot assertions verified by unit tests: mainnet ⇒ non-devnet RPC, `ENCRYPTION_KEY` ≠ `JWT_SECRET`, CORS pinned, mock gates off in production, x402 treasury real, wallet-topup master key present.
- **No staging environment has actually been stood up yet.** The runbook is the corrected procedure, executed zero times. The first real run should be staging, manually, before wiring the CI trigger habitually.

### Custom-domain edge: internal notes

- After the edge smoke test, do the proof run with a real hostname exactly as listed in `docs/CUSTOM-DOMAIN-RUN.md` ("The run that remains"), and record it there.
- The API release that first ships the edge applies migration `20261009200000_custom_domain_edge`. It also resets every certificate status the old code invented: such domains show "No certificate" until a real one is observed, and each gets an `ssl_status_reset` entry in its history.
- One edge machine, one volume: a second machine needs shared certificate storage first (not built; tracked in `docs/HARDENING-BACKLOG.md`, "Custom domains").
- Until the edge is set up, `GET /api/domains/config` reports `configured: false` with the reason, writes answer `501 custom_domains_not_configured`, and the checker and the host router stay off. A partial or malformed set of `CUSTOM_DOMAIN_*` settings reports "misconfigured" with the variable at fault in `GET /api/domains/config`.
