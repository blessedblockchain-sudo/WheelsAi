/**
 * Configuration for the Nosana Deployment-Manager lifecycle (W2: make DEPLOY
 * real on Nosana).
 *
 * This module parses its OWN environment variables (it deliberately does not
 * extend config/env.ts) so the deploy lifecycle can be configured, tested and
 * reasoned about on its own. Every variable is optional and has a default that
 * is safe for a platform-paid workload.
 *
 * Environment variables
 * ---------------------
 *
 * NOSANA_JOB_TIMEOUT_SECONDS          (default 7200 = 2h, range 600..86400)
 *   Per-JOB timeout for long-running (service) deployments. Nosana escrows
 *   `jobPrice x timeout` per replica when a job is listed, so the timeout is the
 *   platform's worst-case exposure per replica if we ever lose control of a job.
 *   The old default was 30 days, which would escrow ~720x more than a 1h job
 *   up-front and had never been verified against a funded wallet. With the
 *   SIMPLE-EXTEND strategy the job is extended before it expires, so a short
 *   timeout costs nothing in availability.
 *
 * NOSANA_DEPLOYMENT_STRATEGY          (default "SIMPLE-EXTEND")
 *   One of "SIMPLE-EXTEND" | "INFINITE" | "SIMPLE".
 *   The SDK (0.4.74) does not document strategy semantics. What the SDK does
 *   expose is the task vocabulary the Deployment Manager schedules
 *   (`Task.task: "LIST" | "EXTEND" | "STOP"`). SIMPLE-EXTEND is the strategy that
 *   maps onto LIST + repeated EXTEND: one job stays alive by being extended
 *   before `timeout` elapses, so the model is NOT reloaded every period (a vLLM
 *   cold start is minutes) and only the next extension has to be funded.
 *   INFINITE re-lists a fresh job when one ends (a full cold start each period);
 *   SIMPLE runs the job once and stops at `timeout`. Semantics are inferred,
 *   not verified against a live funded run - see the W2 report.
 *
 * NOSANA_VAULT_FUND_SECONDS           (default 2 x NOSANA_JOB_TIMEOUT_SECONDS)
 *   How many seconds of run-time (all replicas) the vault is funded for at
 *   deploy time. Must be >= NOSANA_JOB_TIMEOUT_SECONDS (the first listing alone
 *   escrows one full timeout). The GPU billing worker tops the vault up while
 *   the org keeps paying, so this is a runway, not the deployment's lifetime.
 *
 * NOSANA_VAULT_MIN_RUNWAY_SECONDS     (default NOSANA_JOB_TIMEOUT_SECONDS)
 *   When the vault's remaining NOS covers fewer seconds than this, the billing
 *   worker tops it back up to NOSANA_VAULT_FUND_SECONDS.
 *
 * NOSANA_VAULT_SOL_LAMPORTS_PER_REPLICA (default 10000000 = 0.01 SOL)
 *   SOL (lamports) sent to the vault per replica for transaction fees / account
 *   rent. UNVERIFIED without a funded mainnet wallet - tune after the first
 *   real deploy (the surplus is reclaimed by vault.withdraw on stop).
 *
 * NOSANA_NETWORK_FEE_BPS              (default 1000 = 10%)
 *   Nosana network fee applied ON TOP of the on-chain market jobPrice when sizing
 *   vault funding. Source: the dashboard API reports
 *   nos_job_price_per_second = nos_reward_per_second x 1.10 with
 *   network_fee_percentage = 10 (verified 2026-09-30). Over-funding is safe
 *   (recoverable), under-funding stalls the deployment, so this errs high.
 *
 * NOSANA_BATCH_JOB_TIMEOUT_SECONDS    (default 21600 = 6h)
 *   Timeout for finite batch jobs (training) created with kind "batch". These use
 *   the SIMPLE strategy and are never auto-extended.
 *
 * NOSANA_SINGLE_JOB_TIMEOUT_SECONDS   (default 86400 = 24h)
 *   Timeout for the legacy one-shot `sdk.jobs.list` path (NosanaClient.submitJob).
 *   That path has no extend strategy, so the job simply ends at this timeout.
 *
 * NOSANA_RECLAIM_MAX_AGE_HOURS        (default 72)
 *   How long after a deployment stops/fails the status worker keeps retrying
 *   `vault.withdraw` to recover the platform's funds before giving up.
 *
 * GPU_BILLING_INTERVAL_MS             (default 60000; 0 disables the worker)
 *   Cadence of the per-second GPU billing worker (queues/gpu-billing.queue.ts).
 *   With the worker disabled nothing bills a running deployment, so /v1 refuses
 *   to serve dedicated deployments (503 gpu_billing_disabled) rather than
 *   serving them free.
 *
 * ALLOW_LOOPBACK_NODE_URLS            (default false; development only)
 *   Lets the /v1 proxy, the playground chat proxy and the node health probe
 *   reach http(s)://localhost and 127.0.0.1 (a local model server standing in for
 *   a Nosana node). Honoured ONLY when NODE_ENV=development as well - NODE_ENV
 *   defaults to "development", so the explicit opt-in is what keeps an unset
 *   variable from opening localhost to a server-side fetch.
 *
 * HF_TOKEN                            (optional)
 *   Hugging Face token injected into vLLM job definitions for gated models. Only
 *   ever placed in CONFIDENTIAL job definitions (Nosana does not pin those to
 *   public IPFS). When unset the job simply has no HF_TOKEN.
 *
 * NOSANA_MARKETS_JSON                 (optional)
 *   JSON object mapping a GPU tier id to a Nosana market address, or to a full
 *   market definition:
 *     {"4090": "97G9Nn...", "5090": {"address": "6Xt8hg...", "name": "RTX 5090",
 *       "gpuModel": "RTX 5090", "vram": 32, "pricePerSecond": 0.0004}}
 *   A bare address overrides only the address of a built-in tier. A new tier id
 *   must give name, gpuModel, vram and pricePerSecond (USD/second retail, the
 *   unit billing uses). Required on devnet, where the built-in (mainnet)
 *   addresses do not exist.
 */

import { z } from "zod";

export class NosanaDeployConfigError extends Error {
  constructor(message: string) {
    super(`Invalid Nosana deploy configuration: ${message}`);
    this.name = "NosanaDeployConfigError";
  }
}

export const DEPLOYMENT_STRATEGIES = ["SIMPLE-EXTEND", "INFINITE", "SIMPLE"] as const;
export type DeploymentStrategyName = (typeof DEPLOYMENT_STRATEGIES)[number];

export interface MarketOverride {
  address: string;
  name?: string;
  gpuModel?: string;
  vram?: number;
  /** USD per second, per replica (retail - what billing uses). */
  pricePerSecond?: number;
}

export interface NosanaDeployConfig {
  jobTimeoutSeconds: number;
  strategy: DeploymentStrategyName;
  vaultFundSeconds: number;
  vaultMinRunwaySeconds: number;
  vaultSolLamportsPerReplica: bigint;
  networkFeeBps: number;
  batchJobTimeoutSeconds: number;
  singleJobTimeoutSeconds: number;
  reclaimMaxAgeHours: number;
  gpuBillingIntervalMs: number;
  hfToken: string | undefined;
  allowLoopbackNodeUrls: boolean;
  marketOverrides: Record<string, MarketOverride>;
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TIER_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const intFromEnv = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max);

const rawSchema = z.object({
  NOSANA_JOB_TIMEOUT_SECONDS: intFromEnv(600, 86_400).default(7_200),
  NOSANA_DEPLOYMENT_STRATEGY: z.enum(DEPLOYMENT_STRATEGIES).default("SIMPLE-EXTEND"),
  NOSANA_VAULT_FUND_SECONDS: intFromEnv(600, 30 * 86_400).optional(),
  NOSANA_VAULT_MIN_RUNWAY_SECONDS: intFromEnv(60, 30 * 86_400).optional(),
  NOSANA_VAULT_SOL_LAMPORTS_PER_REPLICA: z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer (lamports)")
    .default("10000000"),
  NOSANA_NETWORK_FEE_BPS: intFromEnv(0, 5_000).default(1_000),
  NOSANA_BATCH_JOB_TIMEOUT_SECONDS: intFromEnv(600, 7 * 86_400).default(21_600),
  NOSANA_SINGLE_JOB_TIMEOUT_SECONDS: intFromEnv(600, 30 * 86_400).default(86_400),
  NOSANA_RECLAIM_MAX_AGE_HOURS: intFromEnv(1, 24 * 30).default(72),
  GPU_BILLING_INTERVAL_MS: intFromEnv(0, 3_600_000).default(60_000),
  HF_TOKEN: z.string().optional(),
  ALLOW_LOOPBACK_NODE_URLS: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  NOSANA_MARKETS_JSON: z.string().optional(),
});

const addressSchema = z
  .string()
  .regex(BASE58_ADDRESS, "must be a base58 Solana address");

const marketDefinitionSchema = z
  .object({
    address: addressSchema,
    name: z.string().min(1).max(64).optional(),
    gpuModel: z.string().min(1).max(64).optional(),
    vram: z.number().int().positive().max(1024).optional(),
    pricePerSecond: z.number().positive().max(1).optional(),
  })
  .strict();

/** A bare address string, or a full market definition object. */
function parseMarketOverride(
  value: unknown,
): { ok: true; value: MarketOverride } | { ok: false; message: string } {
  const parsed =
    typeof value === "string"
      ? addressSchema.safeParse(value)
      : marketDefinitionSchema.safeParse(value);
  if (parsed.success) {
    return {
      ok: true,
      value: typeof parsed.data === "string" ? { address: parsed.data } : parsed.data,
    };
  }
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    message: `${issue?.path.join(".") || "value"} ${issue?.message ?? "is invalid"}`,
  };
}

/** Parses NOSANA_MARKETS_JSON. Empty / unset means no overrides. */
export function parseMarketOverrides(
  raw: string | undefined,
): Record<string, MarketOverride> {
  if (raw === undefined || raw.trim() === "") return {};

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new NosanaDeployConfigError(
      `NOSANA_MARKETS_JSON is not valid JSON (${(err as Error).message})`,
    );
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new NosanaDeployConfigError(
      "NOSANA_MARKETS_JSON must be a JSON object of tier id -> address or market definition",
    );
  }

  const out: Record<string, MarketOverride> = {};
  for (const [tier, value] of Object.entries(json)) {
    if (!TIER_ID.test(tier)) {
      throw new NosanaDeployConfigError(
        `NOSANA_MARKETS_JSON tier id '${tier}' must match ${TIER_ID}`,
      );
    }
    const parsed = parseMarketOverride(value);
    if (!parsed.ok) {
      throw new NosanaDeployConfigError(`NOSANA_MARKETS_JSON['${tier}']: ${parsed.message}`);
    }
    out[tier] = parsed.value;
  }
  return out;
}

export function loadNosanaDeployConfig(
  source: Record<string, string | undefined> = process.env,
): NosanaDeployConfig {
  // Empty strings (e.g. `FOO=` in a .env file) mean "unset".
  const cleaned: Record<string, string | undefined> = {};
  for (const key of Object.keys(rawSchema.shape)) {
    const value = source[key];
    cleaned[key] = value === undefined || value.trim() === "" ? undefined : value.trim();
  }

  const parsed = rawSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new NosanaDeployConfigError(
      `${issue?.path.join(".") ?? "config"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  const raw = parsed.data;

  const vaultFundSeconds =
    raw.NOSANA_VAULT_FUND_SECONDS ?? raw.NOSANA_JOB_TIMEOUT_SECONDS * 2;
  if (vaultFundSeconds < raw.NOSANA_JOB_TIMEOUT_SECONDS) {
    throw new NosanaDeployConfigError(
      "NOSANA_VAULT_FUND_SECONDS must be >= NOSANA_JOB_TIMEOUT_SECONDS (the first listing alone escrows one full timeout)",
    );
  }
  const vaultMinRunwaySeconds =
    raw.NOSANA_VAULT_MIN_RUNWAY_SECONDS ?? raw.NOSANA_JOB_TIMEOUT_SECONDS;
  if (vaultMinRunwaySeconds > vaultFundSeconds) {
    throw new NosanaDeployConfigError(
      "NOSANA_VAULT_MIN_RUNWAY_SECONDS must be <= NOSANA_VAULT_FUND_SECONDS",
    );
  }

  return {
    jobTimeoutSeconds: raw.NOSANA_JOB_TIMEOUT_SECONDS,
    strategy: raw.NOSANA_DEPLOYMENT_STRATEGY,
    vaultFundSeconds,
    vaultMinRunwaySeconds,
    vaultSolLamportsPerReplica: BigInt(raw.NOSANA_VAULT_SOL_LAMPORTS_PER_REPLICA),
    networkFeeBps: raw.NOSANA_NETWORK_FEE_BPS,
    batchJobTimeoutSeconds: raw.NOSANA_BATCH_JOB_TIMEOUT_SECONDS,
    singleJobTimeoutSeconds: raw.NOSANA_SINGLE_JOB_TIMEOUT_SECONDS,
    reclaimMaxAgeHours: raw.NOSANA_RECLAIM_MAX_AGE_HOURS,
    gpuBillingIntervalMs: raw.GPU_BILLING_INTERVAL_MS,
    hfToken: raw.HF_TOKEN,
    allowLoopbackNodeUrls: raw.ALLOW_LOOPBACK_NODE_URLS,
    marketOverrides: parseMarketOverrides(raw.NOSANA_MARKETS_JSON),
  };
}

let cached: NosanaDeployConfig | null = null;

/** Process-wide config, parsed once from process.env on first use. */
export function getNosanaDeployConfig(): NosanaDeployConfig {
  if (!cached) cached = loadNosanaDeployConfig(process.env);
  return cached;
}

/** Test seam: drop the cached parse so the next call re-reads process.env. */
export function resetNosanaDeployConfigForTests(): void {
  cached = null;
}
