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

  // IPFS
  PINATA_API_KEY: z.string().optional(),
  PINATA_SECRET_KEY: z.string().optional(),

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
  // Reputation-attestation BullMQ worker: posts on-chain
  // submit_attestation per active tokenized agent. Disabled by default
  // (interval=0); enable once the attestor wallet is whitelisted via
  // the reputation-oracle program's admin add_attestor instruction.
  REPUTATION_ATTESTATION_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  REPUTATION_ATTESTOR_PRIVATE_KEY: z.string().optional(),
  // Dev-only: when true, nosana.submitJob returns mock_job_* IDs if the SDK fails.
  // Forced to false in production.
  ALLOW_NOSANA_MOCK: z
    .union([z.boolean(), z.string()])
    .transform((value) => value === true || value === "true")
    .default(false),

  // GitHub Integration
  GITHUB_TOKEN: z.string().optional(),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid environment variables:");
    console.error(result.error.format());
    process.exit(1);
  }

  const data = result.data;

  // Production safety checks
  if (data.NODE_ENV === "production") {
    if (!data.ENCRYPTION_KEY) {
      console.error("ENCRYPTION_KEY is required in production (must be distinct from JWT_SECRET)");
      process.exit(1);
    }
    if (data.CORS_ORIGIN === "http://localhost:3000") {
      console.error("CORS_ORIGIN must be explicitly set in production");
      process.exit(1);
    }
    if (data.ALLOW_NOSANA_MOCK) {
      console.error("ALLOW_NOSANA_MOCK must not be enabled in production");
      process.exit(1);
    }
  }

  return data;
}

export const env = parseEnv();
export type Env = z.infer<typeof envSchema>;
