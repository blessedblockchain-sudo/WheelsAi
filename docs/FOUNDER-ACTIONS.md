# Founder actions

Everything the code now needs from outside the repository before the matching claim can go live. Each item names the setting it fills (see the full list in `.env.example`) and what it unlocks. Until an item is done, the feature behind it answers honestly: a 501 or 503 with the reason, or a "not configured" state in the dashboard. Nothing is faked.

Updated 2026-10-01. Tick items off here as they land.

## 1. Domain, hosting and origins

- [ ] **A domain the product can use in its claims.** `wheelsai.io` is unregistered and `wheelsai.com` belongs to someone else.
- [ ] **Fly account** and `FLY_API_TOKEN` in CI (deploy jobs in `.gitlab-ci.yml`, runbook in `docs/DEPLOY-RUNBOOK.md`).
- [ ] **Origins.** Set `PUBLIC_API_URL`, `PUBLIC_WEB_URL`, `CORS_ORIGIN` and `COOKIE_DOMAIN` on the API, and `NEXT_PUBLIC_API_URL` on Netlify. These unlock: endpoints shown to users, Telegram webhooks, OAuth redirects, links in emails, and the session cookie being seen by the web app.
- [ ] `TRUST_PROXY_HOPS` must match the real proxy chain (Fly's edge is 1).

## 2. Payments

- [ ] **Stripe account.** Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRO_PRICE_ID` (a recurring $49/month Price). This unlocks card checkout for credits, the Pro plan and trial, and the billing portal.
- [ ] **USDC wallet top-ups.** Set `WALLET_TOPUPS_ENABLED=true` and `WALLET_MASTER_KEY`.
- [ ] **Creator payouts.**
  - Set `PAYOUTS_ENABLED=true` and `PAYOUT_EXECUTOR_INTERVAL_MS`. Crypto payouts also need a funded payout wallet derived from `WALLET_MASTER_KEY`, and `PAYOUT_SOL_PRICE_USD` for SOL.
  - A payout compliance provider (KYC and sanctions screening) is still to be chosen.
- [ ] **x402.** Set `X402_ENABLED`, `X402_INFERENCE_MODE`, `X402_SUBMIT_TRANSACTIONS` and the settlement worker flags once the receiving treasury is live (`TREASURY_WALLET_ADDRESS`).

## 3. Nosana compute (mainnet)

- [ ] **A funded mainnet wallet** (NOS + SOL) in `NOSANA_WALLET_PRIVATE_KEY`, with `SOLANA_NETWORK=mainnet-beta` and a paid RPC in `SOLANA_RPC_URL`. This unlocks model and agent deployments (fund, start, per-second GPU billing, vault reclaim). Market addresses for 3060, 4070, 4090, A100 and H100 are built in for mainnet. Devnet needs `NOSANA_MARKETS_JSON`.
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
- [ ] **An S3 or R2 bucket.** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` and `DATASETS_BUCKET` unlock fine-tuning datasets and per-agent files (`file_read`/`file_write`).

## 6. Channels and integrations

- [ ] **Telegram.** Works once `PUBLIC_API_URL` is set: saving a channel registers the bot with Telegram.
- [ ] **Slack app registration.** Set `SLACK_OAUTH_ENABLED`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET`.
- [ ] **A GitHub App under a working account or org** (the personal account is suspended). Set `GITHUB_APP_ENABLED`, `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`. This unlocks private-repo import and push-to-redeploy.

## 7. Email

- [ ] **Resend.** Set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and `EMAIL_FROM` on a domain with SPF and DKIM set up. This unlocks email verification (and with it the $5 signup credit), password reset, team invites and alert emails.
- [ ] `SALES_EMAIL` for Contact Sales requests (they are stored either way).

## 8. Operations

- [ ] **The public `/status` page.** Create an organisation for the platform, add uptime monitors for its public endpoints, and set `STATUS_PAGE_ORG_ID`.
- [ ] `SENTRY_DSN` for error tracking.
- [ ] `METRICS_TOKEN` if `/metrics` is reachable outside Fly's private network.
- [ ] `PLATFORM_ADMIN_KEY` for marketplace curation (featured listings).

## 9. Tokens

- [ ] `PUMPFUN_API_KEY` and a mainnet proof of a pump.fun launch before `NEXT_PUBLIC_ENABLE_TOKEN_UI=true` (in-app trading also needs `NEXT_PUBLIC_ENABLE_TRADING`).
- [ ] The fee router: a funded `FEE_ROUTER_WALLET_PRIVATE_KEY`, then `FEE_ROUTER_INTERVAL_MS`.
- [ ] The reputation attestor: whitelist the wallet with the oracle's `add_attestor`, then set `REPUTATION_ATTESTOR_PRIVATE_KEY` and `REPUTATION_ATTESTATION_INTERVAL_MS`.
- [ ] Bags (mainnet only): `LAUNCHPAD=bags`, `BAGS_API_KEY`, `BAGS_FEE_RECIPIENT`.

## 10. Company and legal content

The pages render unconfirmed details visibly as `[FOUNDER: ...]` so none can ship unnoticed.

- [ ] **Privacy and terms** (both marked draft pending legal review):
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

These all need the funded mainnet wallet from section 3:

- [ ] a paid mainnet deployment answering `/v1` (`docs/NOSANA-DEPLOY-RUN.md`)
- [ ] the first creator payout with its transaction signature
- [ ] at least 10 external products deployed with public receipts pages
