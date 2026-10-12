import { z } from "zod";
import { loadNosanaAccessConfig, NosanaAccessConfigError } from "./nosanaAccess.js";
import { loadNosanaDeployConfig, NosanaDeployConfigError } from "./nosanaDeploy.js";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "staging", "production"])
    .default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // API
  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // Database
  DATABASE_URL: z.string(),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),
  // Number of reverse proxies in front of the API whose X-Forwarded-For
  // entries are trusted (Fly's edge = 1). The client IP is taken that many
  // hops from the right, never the attacker-controlled leftmost entry.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  // Parent domain for the session cookie (e.g. ".wheelsai.app") when the
  // web app and API run on sibling subdomains. Without it the cookie is
  // host-only: the API sees it, but the web app's middleware never does
  // and bounces every signed-in user back to /login.
  COOKIE_DOMAIN: z
    .string()
    .regex(/^\.?[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "COOKIE_DOMAIN must be a domain like .example.com")
    .optional(),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("24h"),
  // Dedicated key for AES-256-GCM encryption of sensitive configs (e.g. OpenClaw env vars,
  // channel credentials). Falls back to JWT_SECRET when not set for backward compatibility.
  ENCRYPTION_KEY: z.string().min(32).optional(),

  // Solana / Nosana
  SOLANA_RPC_URL: z.string().default("https://api.devnet.solana.com"),
  SOLANA_NETWORK: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  NOSANA_WALLET_PRIVATE_KEY: z.string().optional(),
  WALLET_MASTER_KEY: z.string().optional(),
  TREASURY_WALLET_ADDRESS: z
    .string()
    .default("11111111111111111111111111111111"),

  // Token launchpad selection. pumpfun works on devnet + mainnet (cheap
  // dev loop, default); bags is mainnet-only (Bags fee-share programs are
  // not deployed on devnet — see memory/bags-ecosystem-eval).
  LAUNCHPAD: z.enum(["pumpfun", "bags"]).default("pumpfun"),
  BAGS_API_KEY: z.string().optional(),
  // Optional static override for the platform fee-claimer wallet that
  // receives Bags fee-share payouts (which the treasury sweep then claims
  // into the PDA). It MUST be a WheelsAI-controlled wallet — when the Bags
  // adapter lands it defaults to the fee-router wallet. Never falls back to
  // TREASURY_WALLET_ADDRESS (whose default is the all-ones system address,
  // which would make 100% of fees permanently unclaimable).
  BAGS_FEE_RECIPIENT: z.string().optional(),

  // X402 Payments
  X402_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  X402_INFERENCE_MODE: z
    .enum(["off", "fallback", "required"])
    .default("off"),
  X402_DEFAULT_ASSET: z.enum(["USDC", "SOL", "NOS"]).default("USDC"),
  // How long the SOL rate in a "payment required" answer holds: the paid
  // retry is priced at that rate if it arrives inside this many seconds.
  X402_QUOTE_TTL_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
  // How long a paid request waits for its payment to land before it
  // answers "not confirmed". The settlement worker finishes it after that.
  X402_CONFIRM_WAIT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  X402_SUBMIT_TRANSACTIONS: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  X402_SETTLEMENT_WORKER_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  X402_SETTLEMENT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
  X402_SETTLEMENT_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  X402_METRICS_HISTORY_LIMIT: z.coerce.number().int().min(1).max(1000).default(168),
  X402_METRICS_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  X402_METRICS_PRUNE_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 7)
    .default(60),
  X402_ALERT_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  X402_ALERT_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  X402_ALERT_NOTIFY_COOLDOWN_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 7)
    .default(30),
  X402_ALERT_MAX_PENDING: z.coerce.number().int().min(1).default(25),
  X402_ALERT_MAX_FAILED: z.coerce.number().int().min(1).default(15),
  X402_ALERT_MAX_RETRIABLE: z.coerce.number().int().min(1).default(20),
  X402_ALERT_MAX_FAILURE_RATE_PERCENT: z.coerce.number().min(0).max(100).default(20),
  X402_ALERT_MAX_OLDEST_PENDING_MINUTES: z.coerce.number().int().min(1).default(30),

  // Stripe
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Recurring Stripe Price for the Pro plan ($49/month).
  STRIPE_PRO_PRICE_ID: z.string().optional(),
  // Where "Contact sales" requests are emailed (they are also stored).
  SALES_EMAIL: z.string().email().optional(),

  // IPFS
  PINATA_API_KEY: z.string().optional(),
  PINATA_SECRET_KEY: z.string().optional(),

  // Dataset object storage (S3 or any S3-compatible store, e.g. R2).
  // All three of AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
  // DATASETS_BUCKET must be set for dataset uploads to be enabled;
  // otherwise the dataset routes refuse with an honest 503
  // (isDatasetStorageConfigured in services/dataset.ts).
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  DATASETS_BUCKET: z.string().optional(),
  // The storage settings themselves (endpoint, path style, the dataset
  // limits) are parsed by config/training.ts. Only the driver is declared
  // here, for the deployed-environment guard below: "local" keeps uploads on
  // one machine's disk and exists for development alone.
  STORAGE_DRIVER: z.enum(["s3", "local"]).optional(),

  // Inference Proxy
  // How long a model node may stay silent before a request fails. A first
  // answer after a restart loads the model, and a long answer on a small GPU
  // takes more than 30 seconds (first live run, 2026-10-08).
  INFERENCE_TIMEOUT_MS: z.coerce.number().default(120000),
  MAX_RETRIES: z.coerce.number().default(2),

  // OpenClaw
  OPENCLAW_DEFAULT_IMAGE: z.string().default("wheelsai/openclaw-hardened:latest"),
  OPENCLAW_SUBDOMAIN_BASE: z.string().default("openclaw.wheelsai.com"),

  // Free Model Providers
  GROQ_API_KEY: z.string().optional(),
  GOOGLE_GEMINI_API_KEY: z.string().optional(),
  TOGETHER_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Embeddings (W2 RAG). Unset/"none" ⇒ semantic search is unavailable
  // and the knowledge path reports mode:"keyword" honestly. Valid
  // providers expose an OpenAI-compatible /embeddings endpoint;
  // validateEnv refuses groq BY NAME (chat-only, no embeddings route).
  EMBEDDING_PROVIDER: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  // Backfill worker: embeds rows that predate the provider being turned
  // on. 0 disables.
  EMBEDDING_BACKFILL_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  EMBEDDING_BACKFILL_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  FREE_TIER_RPM: z.coerce.number().default(20),
  FREE_TIER_RPD: z.coerce.number().default(200),
  // Wall-clock limit for one agent chat (every tool round, and a stream until
  // its last byte). A provider that hangs past it fails the request (504 on
  // /v1) and refunds any marketplace charge. Keep it below the platform's
  // shutdown drain window so an in-flight chat settles or refunds before the
  // process is killed.
  AGENT_CHAT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  // How long one attempt to connect out may take before Node tries the host's
  // next address. Node's own 250 ms fails a request on a slow link, or where
  // IPv6 is advertised but broken, although the host is up (2026-10-11).
  OUTBOUND_CONNECT_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(250).max(30_000).default(2_500),
  // A dedicated GPU for an agent (POST /api/agents/:id/deploy). Off until
  // the agent runtime images exist: the route then answers 501
  // agent_gpu_unavailable before anything is looked up, reserved or charged,
  // and the agent keeps answering on the platform.
  AGENT_GPU_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),

  // Public chat: the web chat widget and Try it. These callers are anonymous,
  // so every limit here is enforced on a limiter that fails closed
  // (services/failClosedLimiter.ts): when Redis cannot count, they get 503.
  //
  // Widget. Per visitor address across every key; per key; and a key's
  // messages a day when its owner set no cap of their own.
  WIDGET_PER_IP_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  WIDGET_PER_IP_PER_DAY: z.coerce.number().int().min(1).default(200),
  WIDGET_PER_KEY_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  WIDGET_DEFAULT_DAILY_CAP: z.coerce.number().int().min(1).default(1_000),
  // Try it. Messages a day the platform pays for per listing, per session,
  // per visitor address an hour, per signed-in organization a day, and
  // across the whole platform a minute (it runs on shared free models).
  TRIAL_BASE_DAILY_MESSAGES: z.coerce.number().int().min(0).default(50),
  TRIAL_MESSAGES_PER_SESSION: z.coerce.number().int().min(1).default(10),
  TRIAL_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(30),
  TRIAL_SIGNED_IN_PER_DAY: z.coerce.number().int().min(1).default(100),
  TRIAL_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  // What a publisher pays for one Try it message above the platform's daily
  // ones. Deliberately not defaulted: a made-up price would debit real
  // credits. Unset = publisher-funded caps answer 501.
  TRIAL_FUNDED_MESSAGE_CENTS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).optional(),
  ),
  // Cloudflare Turnstile, the human check for an anonymous Try it visitor.
  // Both or neither. Without them Try it requires sign-in.
  TURNSTILE_SITE_KEY: z.preprocess((value) => (value === "" ? undefined : value), z.string().optional()),
  TURNSTILE_SECRET_KEY: z.preprocess((value) => (value === "" ? undefined : value), z.string().optional()),

  // Token Marketplace
  PUMPFUN_API_KEY: z.string().optional(),
  TOKEN_INDEXER_INTERVAL_MS: z.coerce.number().int().min(0).default(30000),

  // Treasury auto-pay pipeline (set to 0 to disable a worker)
  TREASURY_SETTLEMENT_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  TREASURY_SETTLEMENT_BATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),
  PAYMENT_SUBMIT_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  PAYMENT_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(15_000),
  PAYMENT_REAP_INTERVAL_MS: z.coerce.number().int().min(0).default(120_000),
  PAYMENT_BATCH_LIMIT: z.coerce.number().int().min(1).default(50),
  PAYMENT_REAP_MAX_AGE_SECONDS: z.coerce.number().int().min(60).default(150),
  PAYMENT_REAP_BATCH_LIMIT: z.coerce.number().int().min(1).default(100),
  // Fee-router BullMQ worker: scans new agent_token_trades and forwards
  // 1% of volume to the corresponding treasury via fee_receive. Disabled
  // by default (interval=0) until the platform fee-router wallet is
  // funded — see FEE_ROUTER_WALLET_PRIVATE_KEY.
  FEE_ROUTER_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  FEE_ROUTER_WALLET_PRIVATE_KEY: z.string().optional(),
  // Bags fee-claim sweep worker: claims REAL Meteora fees accrued to the
  // platform fee wallet (Bags fee-share) and deposits them into each
  // bags-launched token's treasury PDA via fee_receive. Disabled by default
  // (interval=0); only meaningful when LAUNCHPAD=bags and the adapter is
  // validated (see services/launchpad/bagsAdapter.ts BAGS_ADAPTER_IMPLEMENTED).
  BAGS_FEE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  // Reputation-attestation BullMQ worker: posts on-chain
  // submit_attestation per active tokenized agent. Disabled by default
  // (interval=0); enable once the attestor wallet is whitelisted via
  // the reputation-oracle program's admin add_attestor instruction.
  REPUTATION_ATTESTATION_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  REPUTATION_ATTESTOR_PRIVATE_KEY: z.string().optional(),
  // Bearer token guarding GET /metrics (H1). Optional: Fly's built-in
  // Prometheus scraper reaches the app over the private 6PN network and
  // cannot attach headers, so leaving this unset keeps `[metrics]` in the
  // fly tomls working out of the box. Set it when the app is reachable from
  // anywhere the scrape path is not, and the route demands
  // `Authorization: Bearer <token>`.
  METRICS_TOKEN: z.string().optional(),
  // Error tracking (B7). Optional — unset disables Sentry entirely.
  SENTRY_DSN: z
    .string()
    .optional()
    .transform((value) => (value && value.trim().length > 0 ? value : undefined)),
  // Dev-only: when true, nosana.submitJob returns mock_job_* IDs if the SDK fails.
  // Forced to false in production.
  ALLOW_NOSANA_MOCK: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  // Dev-only: when true, POST /api/billing/checkout grants credits directly
  // with no Stripe payment ("mock checkout"). Forbidden in production —
  // credits buy real GPU compute, so an ungated grant is a fund-loss path.
  ALLOW_MOCK_CHECKOUT: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  // Wallet top-up rail (B2/T5): master gate for /api/billing/topups/*.
  // When false the endpoints answer 501, mirroring the checkout honesty
  // gate. Enabling requires WALLET_MASTER_KEY (checked below) — the
  // per-org deposit addresses are derived from it.
  WALLET_TOPUPS_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  // The worker that finishes wallet top-ups from what the chain says
  // (queues/topup-reconcile.queue.ts): it credits a transfer that landed
  // after the page was closed, sends a signed transfer again while it can
  // still land, and ends one that can no longer land. 0 turns it off;
  // outside development the wallet rail refuses to start without it
  // (checked below), because a top-up would then depend on the customer
  // keeping the page open.
  TOPUP_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).default(15_000),

  // GitHub Integration
  GITHUB_TOKEN: z.string().optional(),

  // Public origins. OAuth redirect URIs must be absolute and reachable
  // by Slack/GitHub, so they cannot be derived from the request.
  PUBLIC_API_URL: z.string().url().optional(),
  PUBLIC_WEB_URL: z.string().url().optional(),
  // The address a container on a GPU node uses to reach this API: the
  // progress address of a training run and the adapter download of a
  // deployed fine-tuned model, nothing else. Unset means PUBLIC_API_URL
  // (config/training.ts, resolveGpuFacingApiUrl).
  GPU_FACING_API_URL: z.string().url().optional(),

  // Transactional email (verification, password reset, invites, alerts).
  // "log" writes the message to the API log and is refused outside
  // development; unset means email is not configured and the flows that
  // need it answer 501.
  EMAIL_PROVIDER: z.enum(["resend", "log"]).optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(), // e.g. "WheelsAI <no-reply@wheelsai.app>"

  // Slack distributed app (W2). Master gate; the routes stay mounted and
  // answer 501 when off, because Slack must be able to probe the Events
  // URL before anything is installed.
  SLACK_OAUTH_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),
  // App-level signing secret — an app configuration value, not an OAuth
  // artifact, and the key inbound event verification uses.
  SLACK_SIGNING_SECRET: z.string().optional(),

  // GitHub App (W2). Installation ids are stored; installation TOKENS are
  // minted on demand and never persisted.
  GITHUB_APP_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  /** PEM, or base64-encoded PEM (env transport mangles newlines). */
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16).optional(),

  // Per-org cap on concurrently active GPU deployments (model + agent
  // deployments each enforce it). Nosana jobs are platform-paid, so the
  // cap plus the credit reservation bound the platform's exposure.
  MAX_ACTIVE_DEPLOYMENTS_PER_ORG: z.coerce.number().int().min(1).default(5),

  // Deployment-status BullMQ worker (plan D8): polls Nosana job state
  // for non-terminal model/agent deployments and persists OBSERVED
  // transitions — replaces the deleted setTimeout status simulation.
  // Set to 0 to disable.
  DEPLOYMENT_STATUS_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),

  // Scheduler BullMQ worker (Wave 1): fires due ScheduledTask rows
  // through the real execution engine. Set to 0 to disable.
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  // How many due tasks one scheduler tick runs at the same time, so one
  // slow task does not hold up the tasks behind it.
  SCHEDULER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),

  // Workflow runs: a run is a queued row that a BullMQ worker claims and
  // executes. WORKFLOW_RUN_CONCURRENCY is how many runs one process
  // executes at once; 0 switches the worker off, and starting a run then
  // answers 501 instead of queueing work nobody will pick up.
  WORKFLOW_RUN_CONCURRENCY: z.coerce.number().int().min(0).max(50).default(4),
  // Reaper for runs left 'queued' or 'running' by a lost job or a dead
  // worker. Set to 0 to disable.
  WORKFLOW_REAP_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  // How many workflow runs one organization may have queued or running at
  // the same time; the next start answers 429.
  WORKFLOW_MAX_ACTIVE_RUNS_PER_ORG: z.coerce.number().int().min(1).max(100).default(5),

  // Offerings and Jobs. JOB_RUNNER_CONCURRENCY is how many paid jobs one
  // process runs at once; 0 switches the runner off, and hiring or
  // activating an offering then answers 501 instead of taking money for
  // work nobody will pick up.
  JOB_RUNNER_CONCURRENCY: z.coerce.number().int().min(0).max(50).default(2),
  // The sweeper: expires jobs past their delivery time (refund), completes
  // submitted jobs whose review window closed (settle), and re-queues jobs
  // a lost queue entry or a dead worker left behind. 0 disables it; do not
  // disable it where jobs are enabled.
  JOB_SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  // The longest one job may run, whatever delivery time its offering
  // promises.
  JOB_MAX_RUN_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(900_000),
  // What a paid job's use of the platform's own model keys (the free
  // models) costs the publisher, in cents per million tokens; taken out of
  // their share when the job settles. The defaults are the catalog's
  // small-model rate ($0.15 in, $0.60 out per million).
  JOB_PLATFORM_MODEL_INPUT_CENTS_PER_MTOK: z.coerce.number().min(0).max(100_000).default(15),
  JOB_PLATFORM_MODEL_OUTPUT_CENTS_PER_MTOK: z.coerce.number().min(0).max(100_000).default(60),

  // Uptime-prober BullMQ worker (Wave 1): probes due UptimeMonitors and
  // records real up/down events + rolling stats. Each monitor still
  // honors its own checkIntervalSeconds. Set to 0 to disable.
  UPTIME_PROBER_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),

  // Alert-evaluator BullMQ worker (Wave 1): evaluates enabled AlertRules
  // against real usage/uptime metrics and fires alerts + notifications.
  // Set to 0 to disable.
  ALERT_EVALUATOR_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),

  // Analytics-snapshot BullMQ worker (Wave 1): maintains today's rolling
  // daily snapshot + finalizes yesterday's for orgs with recent usage.
  // Set to 0 to disable.
  ANALYTICS_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),

  // Monthly marketplace subscription renewals: charges due periods,
  // marks unpaid ones past_due and expires them after the grace window.
  // Set to 0 to disable.
  SUBSCRIPTION_RENEWAL_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),

  // Public /status page: the organisation whose uptime monitors are public
  // (the operator's own monitors of the platform's endpoints). Unset = the
  // page says there are no public monitors yet.
  STATUS_PAGE_ORG_ID: z.string().uuid().optional(),

  // Measured latency (services/latencySamples.ts). The public figure is the
  // p50 of successful chat answers over a rolling window, and is published
  // only once enough requests from enough different organizations are in it;
  // below either threshold the page says "measuring" and shows no number.
  PUBLIC_LATENCY_WINDOW_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PUBLIC_LATENCY_MIN_SAMPLES: z.coerce.number().int().min(1).default(50),
  PUBLIC_LATENCY_MIN_ORGS: z.coerce.number().int().min(1).default(3),
  // Comma-separated organization ids left out of the public figure: the
  // operator's own and any used for testing.
  PUBLIC_LATENCY_EXCLUDED_ORG_IDS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    )
    .pipe(z.array(z.string().uuid())),
  // How long per-request timing rows are kept. At least 2 days: the longest
  // alert window is 24 hours and the analytics tick re-reads yesterday.
  LATENCY_SAMPLE_RETENTION_DAYS: z.coerce.number().int().min(2).max(365).default(30),

  // Payout-executor BullMQ worker (W2 money keystone): settles requested
  // CreatorPayout rows — credits grants and/or on-chain crypto transfers
  // from the platform payout wallet. Set to 0 to disable (the default:
  // the executor only runs where PAYOUTS_ENABLED is on and, for crypto,
  // WALLET_MASTER_KEY funds the payout wallet).
  PAYOUT_EXECUTOR_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  PAYOUT_EXECUTOR_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  // Master gate for payouts. When off, the executor never runs and the
  // credits/crypto rails stay dormant. Crypto payouts additionally need
  // WALLET_MASTER_KEY (the payout wallet is derived from it).
  PAYOUTS_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  // Deposit addresses: an organization is paid at its own address from
  // anywhere (a withdrawal from an exchange, a transfer from any wallet),
  // with no prepared top-up. Needs the wallet rail, since it is the same
  // address and the same master key.
  DEPOSITS_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  // The worker that finds transfers sent to deposit addresses and credits
  // them (queues/deposit-scan.queue.ts). 0 turns it off; outside
  // development deposits refuse to start without it (checked below).
  DEPOSIT_SCAN_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  // The most addresses one run looks at. One balance read covers 50 of
  // them; only an address whose balance changed has its history read.
  DEPOSIT_SCAN_MAX_ADDRESSES: z.coerce.number().int().min(1).max(10_000).default(500),
  // "Prepare address": the platform opens the USDC account at a deposit
  // address, paying its rent from the hot wallet, at most this many times a
  // day in all, and only while the hot wallet holds HOT_WALLET_MIN_SOL.
  DEPOSIT_ACCOUNT_OPENS_PER_DAY: z.coerce.number().int().min(0).max(100_000).default(25),
  HOT_WALLET_MIN_SOL: z.coerce.number().min(0).max(1000).default(0.05),
  // Sweeps: what customers paid is moved off their deposit addresses
  // (queues/deposit-sweep.queue.ts). An address is emptied of an asset
  // once it holds SWEEP_MIN_USD of it. The transfer goes to the hot wallet
  // (the wallet that pays creators) while that holds less than its float,
  // and otherwise to TREASURY_WALLET_ADDRESS, a wallet whose key is not in
  // the product, once that address has been proven
  // (scripts/treasury-verify.ts). A hot wallet holding more than twice a
  // float sends the excess over the float to the treasury. What the
  // master key alone can move is then about twice the floats plus what
  // has not been swept yet.
  SWEEPS_ENABLED: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  // How often the sweep worker runs. 0 turns it off.
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),
  SWEEP_MIN_USD: z.coerce.number().int().min(1).max(1_000_000).default(25),
  // The most transfers one run starts.
  SWEEP_MAX_PER_RUN: z.coerce.number().int().min(1).max(1000).default(20),
  // What the hot wallet keeps to pay creators with: USDC, and SOL by its
  // dollar value.
  HOT_WALLET_FLOAT_USDC: z.coerce.number().int().min(0).max(10_000_000).default(200),
  HOT_WALLET_FLOAT_SOL_USD: z.coerce.number().int().min(0).max(10_000_000).default(100),

  // Limits on payouts to a wallet, in dollars. A payout taken as credits
  // has none: it never leaves the platform.
  //   per payout            the most one request may be for
  //   per day               the most one creator may request in a UTC day
  //   platform per day      the most the paying wallet sends in a UTC day
  //                         in all; past it, payouts wait as pending
  // They bound what a mistake or a stolen session can cost, since the
  // wallet that pays out holds its key in this process.
  PAYOUT_MAX_PER_PAYOUT_USD: z.coerce.number().int().min(5).max(1_000_000).default(500),
  PAYOUT_MAX_PER_DAY_USD: z.coerce.number().int().min(5).max(10_000_000).default(1000),
  PAYOUT_PLATFORM_MAX_PER_DAY_USD: z.coerce.number().int().min(5).max(100_000_000).default(5000),
  // How many transfers may be signed for one payout. When the last one
  // fails on the chain or can no longer land, the payout fails and the
  // creator's earnings go back.
  PAYOUT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),

  // Live SOL/USD price for anything that turns SOL into dollars or back
  // (services/solPrice.ts). There is no fallback number: a price is a
  // quote or a refusal.
  //   off    - no SOL price. SOL is unavailable; USDC is unaffected.
  //   pyth   - Pyth's SOL/USD price account, read through SOLANA_RPC_URL
  //            together with the chain's clock.
  //   static - SOL_PRICE_STATIC_USD, for a local chain. Refused on
  //            mainnet and in production (checked below).
  SOL_PRICE_SOURCE: z.enum(["off", "pyth", "static"]).default("off"),
  SOL_PRICE_STATIC_USD: z.coerce.number().positive().optional(),
  // Pyth's SOL/USD price account (the same address on mainnet and
  // devnet), its feed id in hex, and the program or programs allowed to
  // own it, comma-separated. Read from both clusters on 2026-10-10. A
  // wrong value makes the price refuse; it cannot misprice.
  PYTH_SOL_USD_ACCOUNT: z.string().default("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  PYTH_SOL_USD_FEED_ID: z
    .string()
    .default("ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"),
  PYTH_PROGRAM_IDS: z.string().default("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ"),
  // A price is refused when it is older than this by the chain's own
  // clock. Pyth refreshes the account every 60 seconds or on a 0.5% move
  // and calls that a target, so the default is two refreshes.
  SOL_PRICE_MAX_AGE_SECONDS: z.coerce.number().int().min(5).max(3600).default(120),
  // Refused when the price's stated uncertainty is above this share of
  // the price, or the price is further than this from its own moving
  // average. Basis points: 100 is 1%.
  SOL_PRICE_MAX_CONF_BPS: z.coerce.number().int().min(1).max(10_000).default(100),
  SOL_PRICE_MAX_EMA_DEVIATION_BPS: z.coerce.number().int().min(1).max(10_000).default(1000),
  // A further margin on every quote, against the customer. 0 by default:
  // a quote already leans by the price's own stated uncertainty.
  SOL_QUOTE_MARGIN_BPS: z.coerce.number().int().min(0).max(1000).default(0),
  // Optional sanity band, in dollars. A price outside it is refused.
  SOL_PRICE_MIN_USD: z.coerce.number().positive().optional(),
  SOL_PRICE_MAX_USD: z.coerce.number().positive().optional(),
  // How far past a transaction's last valid block height the finalized
  // chain must be before the transaction is treated as unable to land
  // (services/signatureFate.ts).
  CHAIN_EXPIRY_MARGIN_BLOCKS: z.coerce.number().int().min(0).max(1000).default(32),

  // Platform curation key (Wave 1): gates the marketplace isFeatured
  // toggle — curation is an OPERATOR action, not a publisher one. The
  // route reads process.env at request time (rotation without reboot);
  // declared here for documentation. Unset ⇒ curation endpoint 503s.
  PLATFORM_ADMIN_KEY: z.string().min(16).optional(),
});

export class EnvValidationError extends Error {}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// True when the text is base58 for exactly 32 bytes, the size of a Solana
// public key. Decoded here rather than matched by length: 32 bytes come
// out as 32 to 44 characters, and so do some values that are not 32 bytes.
function isBase58PublicKey(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) {
    number >>= 8n;
    bytes += 1;
  }
  // Each leading "1" is one leading zero byte.
  for (const char of value) {
    if (char !== "1") break;
    bytes += 1;
  }
  return bytes === 32;
}

/**
 * Pure validation: parses + applies the production safety assertions and
 * THROWS EnvValidationError on any violation. Exported so the boot-fatal
 * invariants are unit-testable without process.exit side effects.
 */
export function validateEnv(raw: Record<string, string | undefined>) {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    throw new EnvValidationError(
      `Invalid environment variables:\n${JSON.stringify(result.error.format(), null, 2)}`
    );
  }

  const data = result.data;

  // Half a Turnstile configuration is worse than none: a site key alone
  // would show visitors a challenge nothing can verify, and a secret alone
  // verifies tokens no page can produce. Refused in every environment.
  if (Boolean(data.TURNSTILE_SITE_KEY) !== Boolean(data.TURNSTILE_SECRET_KEY)) {
    throw new EnvValidationError(
      "TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be set together (or both left unset)"
    );
  }

  // Safety checks for every deployed environment. Staging is a rehearsal
  // of production with real keys: before, it skipped all of these and
  // reflected any CORS origin with credentials.
  const deployed = data.NODE_ENV !== "development";
  if (deployed) {
    if (!data.ENCRYPTION_KEY) {
      throw new EnvValidationError(
        "ENCRYPTION_KEY is required outside development (must be distinct from JWT_SECRET)"
      );
    }
    if (data.ENCRYPTION_KEY === data.JWT_SECRET) {
      throw new EnvValidationError(
        "ENCRYPTION_KEY must be distinct from JWT_SECRET outside development"
      );
    }
    if (data.CORS_ORIGIN === "http://localhost:3000") {
      throw new EnvValidationError("CORS_ORIGIN must be explicitly set outside development");
    }
    if (data.ALLOW_NOSANA_MOCK) {
      throw new EnvValidationError("ALLOW_NOSANA_MOCK must not be enabled outside development");
    }
    if (data.STORAGE_DRIVER === "local") {
      throw new EnvValidationError("STORAGE_DRIVER=local must not be used outside development");
    }
    if (data.ALLOW_MOCK_CHECKOUT) {
      throw new EnvValidationError(
        "ALLOW_MOCK_CHECKOUT must not be enabled outside development"
      );
    }
    for (const [name, value] of [
      ["PUBLIC_API_URL", data.PUBLIC_API_URL],
      ["PUBLIC_WEB_URL", data.PUBLIC_WEB_URL],
      ["GPU_FACING_API_URL", data.GPU_FACING_API_URL],
    ] as const) {
      if (!value) continue;
      // An http redirect_uri puts the OAuth code in cleartext, and
      // Slack/GitHub will not call localhost anyway.
      if (!value.startsWith("https://") || /localhost|127\.0\.0\.1/.test(value)) {
        throw new EnvValidationError(
          `${name} must be an https URL on a public host outside development`
        );
      }
    }
    if (data.X402_ENABLED && !data.X402_SUBMIT_TRANSACTIONS) {
      throw new EnvValidationError(
        "X402_ENABLED requires X402_SUBMIT_TRANSACTIONS outside development — verification-only mode accepts payments that never land on-chain"
      );
    }
    if (data.X402_ENABLED && !data.X402_SETTLEMENT_WORKER_ENABLED) {
      throw new EnvValidationError(
        "X402_ENABLED requires X402_SETTLEMENT_WORKER_ENABLED outside development — without the worker, verified payments are never settled on-chain"
      );
    }
  }

  // Taking card payments without the webhook secret would charge buyers and
  // never grant their credits.
  if (deployed && data.STRIPE_SECRET_KEY && !data.STRIPE_WEBHOOK_SECRET) {
    throw new EnvValidationError(
      "STRIPE_SECRET_KEY requires STRIPE_WEBHOOK_SECRET outside development: credits are only granted from signature-verified webhooks"
    );
  }
  if (deployed && data.EMAIL_PROVIDER === "log") {
    throw new EnvValidationError(
      "EMAIL_PROVIDER=log only writes emails to the API log; it is refused outside development"
    );
  }
  if (data.EMAIL_PROVIDER === "resend" && (!data.RESEND_API_KEY || !data.EMAIL_FROM)) {
    throw new EnvValidationError("EMAIL_PROVIDER=resend requires RESEND_API_KEY and EMAIL_FROM");
  }

  // A deposit address is the wallet rail's address, watched. Without the
  // rail there is no master key to derive it from, and without the scan a
  // transfer sent to it would never be credited.
  if (data.DEPOSITS_ENABLED && !data.WALLET_TOPUPS_ENABLED) {
    throw new EnvValidationError("DEPOSITS_ENABLED requires WALLET_TOPUPS_ENABLED");
  }
  if (data.NODE_ENV !== "development" && data.DEPOSITS_ENABLED && data.DEPOSIT_SCAN_INTERVAL_MS <= 0) {
    throw new EnvValidationError(
      "DEPOSITS_ENABLED requires DEPOSIT_SCAN_INTERVAL_MS above 0 outside development: the scan is what credits a transfer sent to a deposit address"
    );
  }

  // A sweep empties deposit addresses: without deposits there is nothing
  // it may touch.
  if (data.SWEEPS_ENABLED && !data.DEPOSITS_ENABLED) {
    throw new EnvValidationError("SWEEPS_ENABLED requires DEPOSITS_ENABLED");
  }

  // A creator's day limit below the per-payout limit would make the larger
  // figure a lie on the Earnings page.
  if (data.PAYOUT_MAX_PER_DAY_USD < data.PAYOUT_MAX_PER_PAYOUT_USD) {
    throw new EnvValidationError(
      "PAYOUT_MAX_PER_DAY_USD must not be below PAYOUT_MAX_PER_PAYOUT_USD"
    );
  }

  // A top-up is finished by the reconcile worker whenever the request that
  // sent it could not wait for the chain. Without the worker a customer
  // who closes the page can pay and stay uncredited.
  if (
    data.NODE_ENV !== "development" &&
    data.WALLET_TOPUPS_ENABLED &&
    data.TOPUP_RECONCILE_INTERVAL_MS <= 0
  ) {
    throw new EnvValidationError(
      "WALLET_TOPUPS_ENABLED requires TOPUP_RECONCILE_INTERVAL_MS above 0 outside development: the worker is what credits a transfer that lands after the page is closed"
    );
  }

  // Config contradictions that are wrong in EVERY environment — catch them
  // at boot, not as a runtime 500 on the first prepare request.
  if (data.WALLET_TOPUPS_ENABLED && !data.WALLET_MASTER_KEY) {
    throw new EnvValidationError(
      "WALLET_TOPUPS_ENABLED requires WALLET_MASTER_KEY — deposit addresses are derived from it"
    );
  }
  // The payout executor can settle in credits with no wallet, but the
  // instant it needs to run the crypto rail it needs the payout wallet.
  // Requiring the key whenever the executor is scheduled keeps a crypto
  // payout from failing at settle time for a reason config already knew.
  if (
    data.PAYOUTS_ENABLED &&
    data.PAYOUT_EXECUTOR_INTERVAL_MS > 0 &&
    !data.WALLET_MASTER_KEY
  ) {
    throw new EnvValidationError(
      "PAYOUTS_ENABLED with the executor scheduled requires WALLET_MASTER_KEY — the platform payout wallet is derived from it"
    );
  }

  // SOLANA_RPC_URL defaults to DEVNET. With SOLANA_NETWORK=mainnet-beta
  // and the URL unset (exactly what fly.production.toml shipped), every
  // consumer silently talks to devnet while believing it's on mainnet —
  // payments "confirm" against the wrong chain. Mainnet mode therefore
  // demands an explicitly non-devnet RPC URL, in every environment (B7).
  if (
    data.SOLANA_NETWORK === "mainnet-beta" &&
    (!data.SOLANA_RPC_URL || data.SOLANA_RPC_URL.includes("devnet"))
  ) {
    throw new EnvValidationError(
      "SOLANA_NETWORK=mainnet-beta requires an explicitly set, non-devnet SOLANA_RPC_URL (the default is the devnet endpoint — mainnet mode would silently verify against the wrong chain)"
    );
  }

  // The other way round. SOLANA_RPC_URL is now used on every network, so
  // SOLANA_NETWORK=devnet with a mainnet address would read and send on
  // mainnet while the product believes it is on a test chain. The address
  // can only be judged by its text here; the cluster check in
  // lib/solana.ts asks the node itself before money moves.
  if (data.SOLANA_NETWORK === "devnet" && /mainnet/i.test(data.SOLANA_RPC_URL)) {
    throw new EnvValidationError(
      "SOLANA_NETWORK=devnet must not be used with a mainnet SOLANA_RPC_URL: set SOLANA_NETWORK=mainnet-beta, or point SOLANA_RPC_URL at a devnet or local node"
    );
  }

  // A money rail in production runs on mainnet or not at all. On devnet
  // the tokens are worth nothing: a top-up would grant real credits for
  // them, and a payout or an x402 payment would "settle" in them. Staging
  // and development keep devnet.
  if (data.NODE_ENV === "production" && data.SOLANA_NETWORK !== "mainnet-beta") {
    for (const [name, enabled] of [
      ["WALLET_TOPUPS_ENABLED", data.WALLET_TOPUPS_ENABLED],
      ["PAYOUTS_ENABLED", data.PAYOUTS_ENABLED],
      ["X402_ENABLED", data.X402_ENABLED],
    ] as const) {
      if (enabled) {
        throw new EnvValidationError(
          `${name} requires SOLANA_NETWORK=mainnet-beta in production (it is ${data.SOLANA_NETWORK}): a money rail must not run on a test chain`
        );
      }
    }
  }

  // Credits granted without a payment are for a local demo. On mainnet
  // they could buy a sale, become a creator's earnings and be paid out in
  // real money, in development as much as anywhere.
  if (data.ALLOW_MOCK_CHECKOUT && data.SOLANA_NETWORK === "mainnet-beta") {
    throw new EnvValidationError(
      "ALLOW_MOCK_CHECKOUT must not be used with SOLANA_NETWORK=mainnet-beta: credits granted without a payment could be paid out in real money"
    );
  }

  // The SOL price. A static price is an operator's number for a local
  // chain; it never prices real SOL.
  if (data.SOL_PRICE_SOURCE === "static") {
    if (data.NODE_ENV === "production") {
      throw new EnvValidationError(
        "SOL_PRICE_SOURCE=static must not be used in production: use pyth or off"
      );
    }
    if (data.SOLANA_NETWORK === "mainnet-beta") {
      throw new EnvValidationError(
        "SOL_PRICE_SOURCE=static must not be used with SOLANA_NETWORK=mainnet-beta: use pyth or off"
      );
    }
    if (data.SOL_PRICE_STATIC_USD === undefined) {
      throw new EnvValidationError("SOL_PRICE_SOURCE=static requires SOL_PRICE_STATIC_USD");
    }
  }
  if (
    data.SOL_PRICE_MIN_USD !== undefined &&
    data.SOL_PRICE_MAX_USD !== undefined &&
    data.SOL_PRICE_MIN_USD >= data.SOL_PRICE_MAX_USD
  ) {
    throw new EnvValidationError("SOL_PRICE_MIN_USD must be below SOL_PRICE_MAX_USD");
  }
  if (data.SOL_PRICE_SOURCE === "pyth") {
    if (!isBase58PublicKey(data.PYTH_SOL_USD_ACCOUNT)) {
      throw new EnvValidationError("PYTH_SOL_USD_ACCOUNT must be a base58 Solana public key");
    }
    if (!/^[0-9a-fA-F]{64}$/.test(data.PYTH_SOL_USD_FEED_ID)) {
      throw new EnvValidationError("PYTH_SOL_USD_FEED_ID must be 64 hex characters");
    }
    const programIds = data.PYTH_PROGRAM_IDS.split(",").map((id) => id.trim());
    for (const programId of programIds) {
      if (!isBase58PublicKey(programId)) {
        throw new EnvValidationError(
          "PYTH_PROGRAM_IDS must be a comma-separated list of base58 Solana public keys"
        );
      }
    }
  }

  // Nosana access (config/nosanaAccess.ts parses its own variables). Two
  // credentials with no NOSANA_ACCESS_MODE, or a mode naming a credential
  // that is missing, would leave "which account pays" to a guess: refused at
  // boot in every environment. Neither credential set is fine (deploys 501).
  try {
    loadNosanaAccessConfig(raw);
  } catch (error) {
    if (error instanceof NosanaAccessConfigError) throw new EnvValidationError(error.message);
    throw error;
  }

  // Nosana deploy settings (config/nosanaDeploy.ts parses its own variables).
  // Checked here so a value Nosana will not run stops the boot instead of
  // failing every deployment: above all a job timeout under Nosana's 50-minute
  // minimum for credit-paid jobs, which Nosana accepts at create and then
  // never assigns to a node.
  try {
    loadNosanaDeployConfig(raw);
  } catch (error) {
    if (error instanceof NosanaDeployConfigError) throw new EnvValidationError(error.message);
    throw error;
  }

  // Slack: an enabled install flow with missing credentials would 302 a
  // user to a Slack URL that cannot complete, or accept events it cannot
  // verify. Fail at boot instead, in every environment.
  if (data.SLACK_OAUTH_ENABLED) {
    const missing = [
      !data.SLACK_CLIENT_ID && "SLACK_CLIENT_ID",
      !data.SLACK_CLIENT_SECRET && "SLACK_CLIENT_SECRET",
      !data.SLACK_SIGNING_SECRET && "SLACK_SIGNING_SECRET",
      !data.PUBLIC_API_URL && "PUBLIC_API_URL",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new EnvValidationError(
        `SLACK_OAUTH_ENABLED requires ${missing.join(", ")}`
      );
    }
  }

  // GitHub App: an enabled App with missing credentials would 302 users to
  // a GitHub page that cannot complete, or accept webhooks it cannot
  // verify. A malformed private key is boot-fatal too — otherwise every
  // import 500s at runtime with an error nobody connects back to config.
  if (data.GITHUB_APP_ENABLED) {
    const missing = [
      !data.GITHUB_APP_ID && "GITHUB_APP_ID",
      !data.GITHUB_APP_SLUG && "GITHUB_APP_SLUG",
      !data.GITHUB_APP_PRIVATE_KEY && "GITHUB_APP_PRIVATE_KEY",
      !data.GITHUB_WEBHOOK_SECRET && "GITHUB_WEBHOOK_SECRET",
      !data.PUBLIC_API_URL && "PUBLIC_API_URL",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new EnvValidationError(
        `GITHUB_APP_ENABLED requires ${missing.join(", ")}`
      );
    }
    if (!/^\d+$/.test(data.GITHUB_APP_ID!)) {
      throw new EnvValidationError("GITHUB_APP_ID must be numeric");
    }
  }

  // Embeddings: a configured provider must actually be able to serve
  // embeddings and must have its key + model. Groq is refused BY NAME
  // because it is the platform's most commonly configured key and serves
  // chat only — misconfiguring it would 404 on the first search instead
  // of failing here (W2 RAG).
  const embeddingProvider = data.EMBEDDING_PROVIDER;
  if (embeddingProvider && embeddingProvider !== "none") {
    if (embeddingProvider === "groq") {
      throw new EnvValidationError(
        "EMBEDDING_PROVIDER=groq is not valid — Groq serves chat completions only and has no /embeddings endpoint. Use openai, together, or google."
      );
    }
    const providerKeys: Record<string, keyof typeof data> = {
      openai: "OPENAI_API_KEY",
      together: "TOGETHER_API_KEY",
      google: "GOOGLE_GEMINI_API_KEY",
    };
    const keyName = providerKeys[embeddingProvider];
    if (!keyName) {
      throw new EnvValidationError(
        `Unknown EMBEDDING_PROVIDER "${embeddingProvider}" — valid values are openai, together, google, or none`
      );
    }
    if (!data[keyName]) {
      throw new EnvValidationError(
        `EMBEDDING_PROVIDER=${embeddingProvider} requires ${String(keyName)}`
      );
    }
    if (!data.EMBEDDING_MODEL) {
      throw new EnvValidationError(
        "EMBEDDING_PROVIDER requires EMBEDDING_MODEL — the embedding model is never guessed (its dimensions define every stored vector)"
      );
    }
  }

  // x402 payments flow to TREASURY_WALLET_ADDRESS, and its default is the
  // all-ones System Program address — an address NOBODY controls. An
  // enabled x402 rail advertising that as payTo directs client funds into
  // a black hole, so the combination is refused everywhere, not just in
  // production (a dev client following the 402 would burn real devnet
  // funds too).
  // A payment is priced in the asset it is asked for. NOS has no live price
  // anywhere in the product, and SOL has one only when a source is set.
  if (data.X402_ENABLED && data.X402_DEFAULT_ASSET === "NOS") {
    throw new EnvValidationError(
      "X402_ENABLED cannot ask for NOS: there is no live NOS price. Set X402_DEFAULT_ASSET to USDC or SOL"
    );
  }
  if (data.X402_ENABLED && data.X402_DEFAULT_ASSET === "SOL" && data.SOL_PRICE_SOURCE === "off") {
    throw new EnvValidationError(
      "X402_DEFAULT_ASSET=SOL requires a SOL price: set SOL_PRICE_SOURCE, or ask for USDC"
    );
  }

  if (data.X402_ENABLED) {
    if (data.TREASURY_WALLET_ADDRESS === "11111111111111111111111111111111") {
      throw new EnvValidationError(
        "X402_ENABLED requires a real TREASURY_WALLET_ADDRESS — the default is the System Program address, which nobody controls; payments sent there are unrecoverable"
      );
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(data.TREASURY_WALLET_ADDRESS)) {
      throw new EnvValidationError(
        "TREASURY_WALLET_ADDRESS must be a base58 Solana public key"
      );
    }
  }

  return data;
}

/**
 * Settings that no longer exist. A value left in the environment is
 * ignored; it does not stop the start, because an old value can change
 * nothing: SOL is priced by SOL_PRICE_SOURCE or not offered at all.
 */
export const RETIRED_SETTINGS: Record<string, string> = {
  ALLOW_DEVNET_WALLET_TOPUPS:
    "SOL top-ups are offered whenever SOL_PRICE_SOURCE is pyth, or static on a local chain",
  WALLET_TOPUP_SOL_PRICE_USD:
    "use SOL_PRICE_SOURCE=static with SOL_PRICE_STATIC_USD on a local chain, or SOL_PRICE_SOURCE=pyth",
  PAYOUT_SOL_PRICE_USD:
    "SOL payouts are priced by SOL_PRICE_SOURCE (pyth, or static with SOL_PRICE_STATIC_USD on a local chain)",
  X402_SETTLEMENT_MAX_RETRIES:
    "an x402 payment is ended by what the chain says became of it, never by a count of attempts",
};

/** The retired settings that are still set, each with what replaced it. */
export function retiredSettingsIn(raw: Record<string, string | undefined>): string[] {
  return Object.entries(RETIRED_SETTINGS)
    .filter(([name]) => raw[name] !== undefined && raw[name] !== "")
    .map(([name, instead]) => `${name} is no longer a setting and is ignored: ${instead}`);
}

function parseEnv() {
  try {
    for (const line of retiredSettingsIn(process.env)) console.warn(line);
    return validateEnv(process.env);
  } catch (error) {
    console.error(error instanceof EnvValidationError ? error.message : error);
    process.exit(1);
  }
}

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
