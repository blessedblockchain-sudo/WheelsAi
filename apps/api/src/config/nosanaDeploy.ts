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
 * NOSANA_JOB_TIMEOUT_SECONDS          (default 7200 = 2h, range 600..86400;
 *                                      at least 3000 when credits pay)
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
 *   From the Deployment Manager's source (nosana-deployment-manager at
 *   127f915, read 2026-10-07), not from a run of ours:
 *   SIMPLE-EXTEND keeps ONE job alive. When the job turns RUNNING an EXTEND
 *   task is scheduled at `timeout` minus a buffer (10% of the timeout, at
 *   least 1 and at most 5 minutes), and each EXTEND adds one full timeout to
 *   the same job, charged then; the next follows a timeout later
 *   (strategies/simple-extended/jobRunningUpdate.ts:22-29,
 *   tasks/utils/getNextExtendTime.ts, tasks/task/extend/worker.ts:31-45). So
 *   the model is NOT reloaded every period (a vLLM cold start is minutes) and
 *   only the next extension has to be funded.
 *   SIMPLE runs the job once: it ends at `timeout`, and the deployment
 *   becomes STOPPED when no queued or running job is left
 *   (strategies/all/jobAllActiveJobsStop.ts).
 *   INFINITE lists a replacement job `rotation_time` minutes (default 20)
 *   before the old one ends: a full cold start each period, with both jobs
 *   prepaid while they overlap.
 *   INFINITE needs NOSANA_JOB_TIMEOUT_SECONDS >= 3600: the Deployment Manager
 *   refuses an INFINITE create with a timeout under 60 minutes (400
 *   INVALID_TIMEOUT; deployment-manager 127f915, deploymentCreate.ts), so such
 *   a configuration is refused here, at boot, instead of at every deploy.
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
 * NOSANA_BATCH_JOB_TIMEOUT_SECONDS    (default 21600 = 6h; at least 3000 when
 *                                      credits pay)
 *   Timeout for finite batch jobs (training) created with kind "batch". These use
 *   the SIMPLE strategy and are never auto-extended.
 *
 * The 50-minute minimum for credit-paid jobs
 *   Nosana refuses to assign a job paid with prepaid credits whose timeout is
 *   under 3000 seconds (CREDIT_PAID_MIN_TIMEOUT_SECONDS). It does not refuse
 *   the create or the start: the deployment reports RUNNING and every listing
 *   attempt fails with JOB_LIST_ERROR, for ever (first live run, 2026-10-08).
 *   So when the API key is the paying credential (config/nosanaAccess.ts), a
 *   configured NOSANA_JOB_TIMEOUT_SECONDS or NOSANA_BATCH_JOB_TIMEOUT_SECONDS
 *   below it is refused at start-up. Wallet access keeps the range above.
 *
 * NOSANA_PROVISIONING_LIMIT_SECONDS   (default 1800 = 30 min, range 300..86400)
 *   How long a deployment may wait to start serving (no GPU free, or a node
 *   that never becomes ready) before the status worker fails it, stops it on
 *   Nosana and returns the organization's hold. Without it a deployment
 *   Nosana never places would keep its hold for ever.
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

import { loadNosanaAccessConfig } from "./nosanaAccess.js";

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
  /** How long a deployment may wait to start serving before it is failed. */
  provisioningLimitSeconds: number;
  singleJobTimeoutSeconds: number;
  reclaimMaxAgeHours: number;
  gpuBillingIntervalMs: number;
  hfToken: string | undefined;
  allowLoopbackNodeUrls: boolean;
  marketOverrides: Record<string, MarketOverride>;
}

/** The Deployment Manager's floor for an INFINITE deployment's timeout (60 minutes). */
export const INFINITE_MIN_TIMEOUT_SECONDS = 3_600;

/**
 * Nosana's floor for the timeout of a job paid with prepaid credits (50
 * minutes). Below it the job is never assigned: each attempt logs
 * JOB_LIST_ERROR "Credit-paid jobs must have a timeout of at least 3000
 * seconds" while the deployment keeps reporting RUNNING (live, 2026-10-08).
 */
export const CREDIT_PAID_MIN_TIMEOUT_SECONDS = 3_000;

/**
 * The timeout a credit-paid job is sent with: never under Nosana's floor. A
 * wallet-paid job keeps the value it was given.
 */
export function creditPaidTimeoutSeconds(seconds: number): number {
  return Math.max(seconds, CREDIT_PAID_MIN_TIMEOUT_SECONDS);
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
  NOSANA_PROVISIONING_LIMIT_SECONDS: intFromEnv(300, 86_400).default(1_800),
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

/**
 * Whether prepaid credits pay for new deployments: the API key is the primary
 * credential. An access configuration that does not parse is reported by its
 * own loader (validateEnv runs it first); here it only means "not known to be
 * credit-paid".
 */
function creditsPay(source: Record<string, string | undefined>): boolean {
  try {
    return loadNosanaAccessConfig(source).primary === "api_key";
  } catch {
    return false;
  }
}

export interface LoadNosanaDeployConfigOptions {
  /**
   * Whether prepaid credits pay for new deployments. Default: read from the
   * access variables of the same source (API key as the paying credential).
   */
  creditPaid?: boolean;
}

export function loadNosanaDeployConfig(
  source: Record<string, string | undefined> = process.env,
  options: LoadNosanaDeployConfigOptions = {},
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

  if (raw.NOSANA_DEPLOYMENT_STRATEGY === "INFINITE" && raw.NOSANA_JOB_TIMEOUT_SECONDS < INFINITE_MIN_TIMEOUT_SECONDS) {
    throw new NosanaDeployConfigError(
      `NOSANA_DEPLOYMENT_STRATEGY=INFINITE needs NOSANA_JOB_TIMEOUT_SECONDS >= ${INFINITE_MIN_TIMEOUT_SECONDS}: Nosana refuses an INFINITE deployment with a timeout under 60 minutes`,
    );
  }

  if (options.creditPaid ?? creditsPay(source)) {
    for (const name of ["NOSANA_JOB_TIMEOUT_SECONDS", "NOSANA_BATCH_JOB_TIMEOUT_SECONDS"] as const) {
      if (raw[name] < CREDIT_PAID_MIN_TIMEOUT_SECONDS) {
        throw new NosanaDeployConfigError(
          `${name}=${raw[name]} is below ${CREDIT_PAID_MIN_TIMEOUT_SECONDS}: with API-key access (prepaid credits) Nosana never assigns a job whose timeout is under ${CREDIT_PAID_MIN_TIMEOUT_SECONDS} seconds (50 minutes). Set ${name} to ${CREDIT_PAID_MIN_TIMEOUT_SECONDS} or more`,
        );
      }
    }
  }

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
    provisioningLimitSeconds: raw.NOSANA_PROVISIONING_LIMIT_SECONDS,
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
