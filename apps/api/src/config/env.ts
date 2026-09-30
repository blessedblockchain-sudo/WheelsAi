import { z } from "zod";

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
  X402_SETTLEMENT_MAX_RETRIES: z.coerce.number().int().min(1).max(20).default(5),
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

  // Inference Proxy
  INFERENCE_TIMEOUT_MS: z.coerce.number().default(30000),
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
  // Dev-only: enables the SOL asset on the top-up rail, priced by the
  // operator-stated WALLET_TOPUP_SOL_PRICE_USD quote instead of an
  // oracle. This is the devnet TESTING rail — forbidden in production,
  // where the wallet rail is USDC-only (1 USDC = $1, no oracle needed).
  ALLOW_DEVNET_WALLET_TOPUPS: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),
  // SOL/USD quote for the devnet SOL rail. Deliberately operator-stated,
  // not defaulted — a made-up default price would grant made-up credit
  // amounts. Recorded on every WalletTopUp row as quotedSolPriceUsd.
  WALLET_TOPUP_SOL_PRICE_USD: z.coerce.number().positive().optional(),

  // GitHub Integration
  GITHUB_TOKEN: z.string().optional(),

  // Public origins. OAuth redirect URIs must be absolute and reachable
  // by Slack/GitHub, so they cannot be derived from the request.
  PUBLIC_API_URL: z.string().url().optional(),
  PUBLIC_WEB_URL: z.string().url().optional(),

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
  // SOL/USD quote for crypto_sol payouts — operator-stated (no oracle in
  // the path), mirroring the wallet-topup SOL rail. Required only when a
  // crypto_sol payout is actually settled.
  PAYOUT_SOL_PRICE_USD: z.coerce.number().positive().optional(),

  // Platform curation key (Wave 1): gates the marketplace isFeatured
  // toggle — curation is an OPERATOR action, not a publisher one. The
  // route reads process.env at request time (rotation without reboot);
  // declared here for documentation. Unset ⇒ curation endpoint 503s.
  PLATFORM_ADMIN_KEY: z.string().min(16).optional(),
});

export class EnvValidationError extends Error {}

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
    if (data.ALLOW_MOCK_CHECKOUT) {
      throw new EnvValidationError(
        "ALLOW_MOCK_CHECKOUT must not be enabled outside development"
      );
    }
    for (const [name, value] of [
      ["PUBLIC_API_URL", data.PUBLIC_API_URL],
      ["PUBLIC_WEB_URL", data.PUBLIC_WEB_URL],
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

  // Production only: staging may run the devnet SOL test rail.
  if (data.NODE_ENV === "production" && data.ALLOW_DEVNET_WALLET_TOPUPS) {
    throw new EnvValidationError(
      "ALLOW_DEVNET_WALLET_TOPUPS must not be enabled in production — the SOL rail grants credits from an operator-stated quote, not an oracle"
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

function parseEnv() {
  try {
    return validateEnv(process.env);
  } catch (error) {
    console.error(error instanceof EnvValidationError ? error.message : error);
    process.exit(1);
  }
}

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
