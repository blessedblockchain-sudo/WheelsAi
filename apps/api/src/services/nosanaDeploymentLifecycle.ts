/**
 * Nosana Deployment-Manager lifecycle (W2: make DEPLOY real on Nosana).
 *
 * `sdk.deployments.create()` only creates a DRAFT deployment with an (empty)
 * vault. Nothing runs until the vault is funded AND `deployment.start()` is
 * called. This module owns that whole lifecycle - create, fund, start, observe,
 * scale, stop, reclaim - as PURE functions over an injected port, so every path
 * (including the failure paths that could strand platform funds) is unit-tested
 * without a network, a wallet or an RPC. services/nosana.ts supplies the real
 * port built on @nosana/sdk.
 *
 * Units (verified, 2026-09-30)
 * ----------------------------
 * - NOS has 6 decimals. node_modules/@nosana/sdk/dist/services/deployments/
 *   deployment/actions/vaultTopup.js converts whole NOS with `NOS * 1e6` when
 *   `lamports` is false, and vaultGetBalance.js divides the token balance by
 *   1e6. With `lamports: true` the amounts are raw base units (NOS: 1e-6 NOS,
 *   SOL: lamports) - that is what this module always passes.
 * - `market.jobPrice` (sdk.jobs.getMarket) is a u64 (types/nosana_jobs.d.ts;
 *   the `Market` TS type says `number` but anchor returns a BN) in NOS BASE UNITS
 *   PER SECOND. The SDK source does not state the unit; it was established
 *   empirically: a live mainnet read returned jobPrice 24 (3060 market), 202
 *   (4090) and 757 (H100), identical to the Nosana dashboard API's
 *   `nos_reward_per_second` (0.000024 / 0.000202 / 0.000757 NOS) x 1e6.
 *   The dashboard's `nos_job_price_per_second` is that reward x 1.10
 *   (`network_fee_percentage: 10`), i.e. the network fee is charged ON TOP of
 *   jobPrice; planVaultFunding therefore applies `networkFeeBps` (default 1000).
 *   Whether the on-chain program debits exactly jobPrice x 1.10 per second could
 *   not be proven without a funded mainnet run, so funding deliberately rounds up
 *   and the surplus is recovered by `vault.withdraw` when the deployment stops.
 *
 * Failure model
 * -------------
 * Every step after `create` can leave platform money in a vault. Any failure in
 * createAndStartDeployment therefore attempts stop + withdraw (verified against
 * the vault balance, because the SDK's withdraw swallows a failed transaction)
 * and throws a NosanaLifecycleError that carries the Nosana deployment id and a
 * cleanup report, so the caller can persist the id and let a later sweep retry
 * the reclaim.
 *
 * Two ways of paying (the funding seam)
 * -------------------------------------
 * Everything above describes WALLET access: a vault per deployment. With a
 * dashboard API key the same REST API is paid from prepaid USD credits and the
 * deployment has no vault. The steps that differ sit behind DeploymentFunding:
 * `vaultFunding` (the default of every function here, so wallet callers pass
 * nothing and run the statements they always ran) and `creditsFunding` (a
 * balance gate before create, nothing to top up, and "released" decided from
 * the state Nosana reports instead of a vault balance).
 */

import { NosanaCreditsError, requiredCreditsMicroUsd } from "./nosanaCredits.js";

// ============================================
// Units
// ============================================

export const NOS_DECIMALS = 6;
export const NOS_BASE_UNITS_PER_NOS = 1_000_000n;
export const LAMPORTS_PER_SOL_BIG = 1_000_000_000n;
/** Nosana network fee on top of market.jobPrice (see header). */
export const DEFAULT_NETWORK_FEE_BPS = 1_000;
/** 0.01 SOL per replica for fees / rent. Unverified; tunable via config. */
export const DEFAULT_SOL_FEE_LAMPORTS_PER_REPLICA = 10_000_000n;
const BPS_DENOMINATOR = 10_000n;

// ============================================
// Port (the subset of @nosana/sdk this module uses)
// ============================================

export type DeploymentStrategyName = "SIMPLE-EXTEND" | "INFINITE" | "SIMPLE";

export interface SdkEndpointLike {
  opId: string;
  port: number | string;
  url: string;
}

export interface SdkJobLike {
  job: string;
  status: string;
  tx?: string;
  deployment?: string;
  revision?: number;
  created_at?: string;
}

export interface SdkEventLike {
  type: string;
  message: string;
  category?: string;
  deploymentId?: string;
  tx?: string;
  created_at?: string | Date;
}

export interface SdkVaultLike {
  publicKey: { toBase58(): string };
  topup(options: { SOL?: number; NOS?: number; lamports?: boolean }): Promise<void>;
  getBalance(): Promise<{ SOL: number; NOS: number }>;
  withdraw(): Promise<void>;
}

export interface SdkDeploymentLike {
  id: string;
  status: string;
  replicas: number;
  endpoints?: SdkEndpointLike[];
  jobs?: SdkJobLike[];
  events?: SdkEventLike[];
  /**
   * Present only for a wallet-owned deployment. With an API key the SDK
   * returns no vault at all: the deployment is paid from prepaid credits.
   */
  vault?: SdkVaultLike;
  start(): Promise<void>;
  stop(): Promise<void>;
  updateReplicaCount(replicas: number): Promise<void>;
}

export interface CreateDeploymentBody {
  name: string;
  market: string;
  replicas: number;
  /** Per-job timeout, seconds. */
  timeout: number;
  strategy: DeploymentStrategyName;
  /** Keeps the job definition (and any secrets in it) off public IPFS. */
  confidential: boolean;
  job_definition: unknown;
}

export interface NosanaDeploymentsPort {
  create(body: CreateDeploymentBody): Promise<SdkDeploymentLike>;
  get(id: string): Promise<SdkDeploymentLike>;
  /** market.jobPrice: NOS base units (1e-6 NOS) per second. */
  getMarketJobPrice(marketAddress: string): Promise<bigint>;
}

// ============================================
// Errors
// ============================================

export type LifecycleStage =
  | "market_price"
  | "create"
  | "topup"
  | "start"
  | "read"
  | "stop"
  | "scale"
  | "reclaim";

export interface CleanupReport {
  stopped: boolean;
  /** True only when the vault's NOS balance was verified to be zero afterwards. */
  reclaimed: boolean;
  errors: string[];
}

export class NosanaLifecycleError extends Error {
  readonly stage: LifecycleStage;
  readonly deploymentId?: string;
  readonly cleanup?: CleanupReport;
  readonly code: string;
  /** The name the deployment was (or was to be) created under. */
  readonly deploymentName?: string;
  /**
   * True when the create call itself threw. The SDK parses the response (the
   * `owner` field as a Solana public key) AFTER the server has created the
   * deployment, so a throw here does not prove nothing exists on Nosana: the
   * caller has no id, only `deploymentName` to look for.
   */
  readonly mayExistOnNosana: boolean;
  /**
   * The credential the failed call was made with ("wallet" | "api_key"), set by
   * NosanaClient.createDeployment so a partial id is stored with its mode.
   */
  accessMode?: "wallet" | "api_key";

  constructor(
    message: string,
    stage: LifecycleStage,
    details: {
      deploymentId?: string;
      cause?: unknown;
      cleanup?: CleanupReport;
      code?: string;
      deploymentName?: string;
      mayExistOnNosana?: boolean;
    } = {},
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "NosanaLifecycleError";
    this.stage = stage;
    this.deploymentId = details.deploymentId;
    this.cleanup = details.cleanup;
    this.code = details.code ?? `nosana_${stage}_failed`;
    this.deploymentName = details.deploymentName;
    this.mayExistOnNosana = details.mayExistOnNosana === true;
  }
}

/**
 * Codes that say WHY platform funding refused, raised below a lifecycle step
 * (the credit gate, an API key Nosana rejects). A step that wraps such an error
 * keeps its code, so a caller still sees the reason and not `nosana_<stage>_failed`.
 */
export const FUNDING_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "nosana_credits_low",
  "nosana_credits_unavailable",
  "nosana_auth_failed",
  // API-key access: what the market costs is unknown, so nothing is admitted.
  "gpu_cost_unavailable",
]);

function refusalCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && FUNDING_REFUSAL_CODES.has(code) ? code : undefined;
}

/** `{ code }` to spread into error details when `err` carries a refusal code. */
function keepRefusalCode(err: unknown): { code?: string } {
  const code = refusalCode(err);
  return code ? { code } : {};
}

export class UnknownDeploymentStatusError extends Error {
  constructor(readonly rawStatus: string) {
    super(`Unrecognised Nosana deployment status '${rawStatus}'`);
    this.name = "UnknownDeploymentStatusError";
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================
// Number helpers (bigint only - no floats in money math)
// ============================================

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * Coerces an on-chain integer (bigint | number | decimal string | anchor BN)
 * into a bigint. Throws on anything that is not a non-negative integer, so a
 * malformed chain read can never turn into a fabricated price.
 */
export function toBaseUnits(value: unknown): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError(`negative base-unit value ${value}`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`base-unit value must be a non-negative safe integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (value !== null && value !== undefined) {
    const text = String(value);
    if (/^\d+$/.test(text)) return BigInt(text);
  }
  throw new RangeError(`cannot interpret ${String(value)} as a non-negative integer of base units`);
}

function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${what} ${value} exceeds Number.MAX_SAFE_INTEGER; refusing to lose precision`);
  }
  return Number(value);
}

// ============================================
// Vault funding
// ============================================

export interface VaultFundingInput {
  /** Raw market.jobPrice: NOS base units per second (before network fee). */
  jobPriceBaseUnitsPerSecond: bigint;
  replicas: number;
  /** Seconds of run-time (per replica) the NOS amount must cover. */
  fundSeconds: number;
  solFeeLamportsPerReplica: bigint;
  /** Fee charged on top of jobPrice, in basis points. Default 1000 (10%). */
  networkFeeBps?: number;
}

export interface VaultFundingPlan {
  /** NOS base units (1e-6 NOS) to send to the vault. */
  nosBaseUnits: bigint;
  /** SOL lamports to send to the vault. */
  solLamports: bigint;
  /** Fee-inclusive NOS base units per second for ONE replica, rounded up. */
  nosBaseUnitsPerSecondPerReplica: bigint;
}

/**
 * Exact vault funding: NOS = ceil(jobPrice x (1 + fee) x replicas x seconds),
 * SOL = solFeeLamportsPerReplica x replicas. Integer arithmetic only; the single
 * rounding step rounds UP so the vault is never under-funded by a fraction.
 */
export function planVaultFunding(input: VaultFundingInput): VaultFundingPlan {
  const feeBps = input.networkFeeBps ?? DEFAULT_NETWORK_FEE_BPS;
  assertPositiveInt("replicas", input.replicas);
  assertPositiveInt("fundSeconds", input.fundSeconds);
  if (!Number.isInteger(feeBps) || feeBps < 0) {
    throw new RangeError(`networkFeeBps must be a non-negative integer, got ${feeBps}`);
  }
  if (input.jobPriceBaseUnitsPerSecond < 0n) {
    throw new RangeError("jobPriceBaseUnitsPerSecond must be >= 0");
  }
  if (input.solFeeLamportsPerReplica < 0n) {
    throw new RangeError("solFeeLamportsPerReplica must be >= 0");
  }

  const replicas = BigInt(input.replicas);
  const seconds = BigInt(input.fundSeconds);
  const feeFactor = BPS_DENOMINATOR + BigInt(feeBps);

  return {
    nosBaseUnits: ceilDiv(
      input.jobPriceBaseUnitsPerSecond * feeFactor * replicas * seconds,
      BPS_DENOMINATOR,
    ),
    solLamports: input.solFeeLamportsPerReplica * replicas,
    nosBaseUnitsPerSecondPerReplica: ceilDiv(
      input.jobPriceBaseUnitsPerSecond * feeFactor,
      BPS_DENOMINATOR,
    ),
  };
}

async function topupVault(vault: SdkVaultLike, plan: { nosBaseUnits: bigint; solLamports: bigint }) {
  await vault.topup({
    NOS: toSafeNumber(plan.nosBaseUnits, "NOS top-up"),
    SOL: toSafeNumber(plan.solLamports, "SOL top-up"),
    lamports: true,
  });
}

// ============================================
// Status + snapshot normalisation
// ============================================

export type DeploymentState =
  | "draft"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "insufficient_funds"
  | "error"
  | "archived";

const STATUS_MAP: Readonly<Record<string, DeploymentState>> = {
  DRAFT: "draft",
  ERROR: "error",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  INSUFFICIENT_FUNDS: "insufficient_funds",
  ARCHIVED: "archived",
};

/** Maps the SDK status to ours; an unknown value THROWS rather than guessing. */
export function normalizeStatus(raw: string): DeploymentState {
  const mapped = Object.hasOwn(STATUS_MAP, String(raw).toUpperCase())
    ? STATUS_MAP[String(raw).toUpperCase()]
    : undefined;
  if (!mapped) throw new UnknownDeploymentStatusError(String(raw));
  return mapped;
}

export interface EndpointSnapshot {
  url: string;
  port: number | string;
  opId: string;
}

export interface JobSnapshot {
  job: string;
  status: string;
}

export interface EventSnapshot {
  type: string;
  message: string;
  createdAt: string | null;
  tx?: string;
}

export interface DeploymentSnapshot {
  id: string;
  status: DeploymentState;
  endpoints: EndpointSnapshot[];
  jobs: JobSnapshot[];
  replicas: number;
  events: EventSnapshot[];
  /** Endpoints the SDK returned that were not valid https URLs (dropped). */
  invalidEndpointCount: number;
}

/**
 * Keeps only real https URLs exactly as Nosana reported them (trailing slash
 * trimmed). Nothing is ever constructed from an id or a hostname pattern.
 */
export function normalizeEndpoints(
  raw: SdkEndpointLike[] | undefined,
): { endpoints: EndpointSnapshot[]; invalid: number } {
  const endpoints: EndpointSnapshot[] = [];
  const seen = new Set<string>();
  let invalid = 0;

  for (const endpoint of raw ?? []) {
    const url = typeof endpoint?.url === "string" ? endpoint.url.trim() : "";
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
      invalid += 1;
      continue;
    }
    const clean = url.replace(/\/+$/, "");
    const key = `${clean}|${endpoint.port}|${endpoint.opId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    endpoints.push({ url: clean, port: endpoint.port, opId: String(endpoint.opId ?? "") });
  }
  return { endpoints, invalid };
}

function toIso(value: string | Date | undefined): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function snapshotFromSdk(deployment: SdkDeploymentLike): DeploymentSnapshot {
  const { endpoints, invalid } = normalizeEndpoints(deployment.endpoints);
  return {
    id: String(deployment.id),
    status: normalizeStatus(deployment.status),
    endpoints,
    jobs: (deployment.jobs ?? []).map((j) => ({ job: String(j.job), status: String(j.status) })),
    replicas: deployment.replicas,
    events: (deployment.events ?? []).map((e) => ({
      type: String(e.type),
      message: String(e.message),
      createdAt: toIso(e.created_at),
      ...(e.tx ? { tx: e.tx } : {}),
    })),
    invalidEndpointCount: invalid,
  };
}

/** Strict read: an API/RPC failure throws, it never becomes a fabricated state. */
export async function readDeployment(
  port: NosanaDeploymentsPort,
  id: string,
): Promise<DeploymentSnapshot> {
  let deployment: SdkDeploymentLike;
  try {
    deployment = await port.get(id);
  } catch (err) {
    throw new NosanaLifecycleError(
      `Could not read Nosana deployment ${id}: ${errMessage(err)}`,
      "read",
      { deploymentId: id, cause: err, ...keepRefusalCode(err) },
    );
  }
  return snapshotFromSdk(deployment);
}

// ============================================
// Vault withdraw (verified)
// ============================================

export interface WithdrawOutcome {
  /** True only when the vault's NOS balance was read back as zero. */
  reclaimed: boolean;
  /** NOS base units still in the vault, null when the balance could not be read. */
  remainingNosBaseUnits: bigint | null;
  error?: string;
}

/**
 * vault.withdraw() in SDK 0.4.74 swallows a failed transaction (it calls
 * errorFormatter() without `throw`), so "it did not throw" proves nothing. The
 * balance is read back and only a zero NOS balance counts as reclaimed.
 * Failures such as "deployment still running" are returned, never thrown, so a
 * later sweep can retry.
 */
export async function withdrawAndVerify(vault: SdkVaultLike): Promise<WithdrawOutcome> {
  let error: string | undefined;
  try {
    await vault.withdraw();
  } catch (err) {
    error = errMessage(err);
  }

  try {
    const balance = await vault.getBalance();
    const nosBaseUnits = BigInt(Math.round(balance.NOS * Number(NOS_BASE_UNITS_PER_NOS)));
    return {
      reclaimed: nosBaseUnits === 0n,
      remainingNosBaseUnits: nosBaseUnits,
      ...(error ? { error } : {}),
    };
  } catch (err) {
    return {
      reclaimed: false,
      remainingNosBaseUnits: null,
      error: error ?? `balance read failed: ${errMessage(err)}`,
    };
  }
}

async function bestEffortCleanup(
  port: NosanaDeploymentsPort,
  deployment: SdkDeploymentLike,
  funding: DeploymentFunding,
): Promise<CleanupReport> {
  const errors: string[] = [];
  let stopped = false;
  try {
    await deployment.stop();
    stopped = true;
  } catch (err) {
    errors.push(`stop: ${errMessage(err)}`);
  }
  const withdraw = await funding.release(
    deployment,
    await stateForRelease(port, String(deployment.id), funding, null),
  );
  if (withdraw.error) errors.push(`withdraw: ${withdraw.error}`);
  return { stopped, reclaimed: withdraw.reclaimed, errors };
}

// ============================================
// Funding seam (who pays Nosana, and how the money comes back)
// ============================================

export type FundingKind = "vault" | "credits";

/** Same shape as WithdrawOutcome: what a stop left behind. */
export interface ReleaseOutcome {
  /**
   * vault: the vault's NOS balance was verified to be zero.
   * credits: Nosana is not running the deployment and will not schedule more work.
   */
  reclaimed: boolean;
  remainingNosBaseUnits: bigint | null;
  error?: string;
}

export interface FundingPrepareParams {
  marketAddress: string;
  replicas: number;
  /** vault: seconds of run-time to fund. credits: seconds the estimate covers. */
  fundSeconds: number;
  jobTimeoutSeconds: number;
  solFeeLamportsPerReplica?: bigint;
  networkFeeBps?: number;
}

export interface FundingExtraReplicasParams {
  marketAddress: string;
  /** Replicas being ADDED (always > 0). */
  added: number;
  fundSeconds: number;
  solFeeLamportsPerReplica?: bigint;
  networkFeeBps?: number;
}

/**
 * The one place the two ways of paying Nosana differ. `vaultFunding` is the
 * wallet path exactly as it always was (and the default of every lifecycle
 * function); `creditsFunding` is the API-key path, where there is nothing to
 * send and nothing to withdraw.
 */
export interface DeploymentFunding {
  kind: FundingKind;
  /** Before create. vault: read the market price and plan. credits: the balance gate. Throws to refuse. */
  prepare(
    p: FundingPrepareParams,
  ): Promise<{ funding: VaultFundingPlan | null; estimateMicroUsd: bigint | null }>;
  /** After create, before start. vault: top the vault up. credits: nothing. */
  fund(deployment: SdkDeploymentLike, plan: VaultFundingPlan | null): Promise<void>;
  /**
   * After a stop (or instead of one). `state` is what Nosana reports NOW, read
   * again through the port by the lifecycle; null when that read failed or was
   * not needed. vault ignores it - the vault balance is its authority.
   */
  release(deployment: SdkDeploymentLike, state: DeploymentState | null): Promise<ReleaseOutcome>;
  /** Before a scale-up. vault: fund the added replicas. credits: the balance gate. */
  fundExtraReplicas(
    deployment: SdkDeploymentLike,
    p: FundingExtraReplicasParams,
  ): Promise<VaultFundingPlan | null>;
  /** For a running/starting deployment. vault: refill. credits: measure, never pay. */
  ensureRunway(deployment: SdkDeploymentLike, id: string, params: RunwayParams): Promise<RunwayResult>;
}

function requireVault(deployment: SdkDeploymentLike, stage: LifecycleStage): SdkVaultLike {
  if (!deployment.vault) {
    throw new NosanaLifecycleError(
      `Nosana deployment ${String(deployment.id)} has no vault; it was not created by the platform wallet`,
      stage,
      { deploymentId: String(deployment.id), code: "nosana_vault_missing" },
    );
  }
  return deployment.vault;
}

/**
 * Wallet funding: a vault per deployment, topped up in NOS + SOL before start
 * and withdrawn (verified against its balance) after a stop. These are the
 * statements the lifecycle has always run, moved behind the seam unchanged.
 */
export function vaultFunding(port: NosanaDeploymentsPort): DeploymentFunding {
  return {
    kind: "vault",

    async prepare(p) {
      // Price first: a bad/unknown market must fail BEFORE anything is created.
      let jobPrice: bigint;
      try {
        jobPrice = await port.getMarketJobPrice(p.marketAddress);
      } catch (err) {
        throw new NosanaLifecycleError(
          `Could not read the price of Nosana market ${p.marketAddress}: ${errMessage(err)}`,
          "market_price",
          { cause: err },
        );
      }

      const funding = planVaultFunding({
        jobPriceBaseUnitsPerSecond: jobPrice,
        replicas: p.replicas,
        fundSeconds: p.fundSeconds,
        solFeeLamportsPerReplica:
          p.solFeeLamportsPerReplica ?? DEFAULT_SOL_FEE_LAMPORTS_PER_REPLICA,
        networkFeeBps: p.networkFeeBps,
      });
      return { funding, estimateMicroUsd: null };
    },

    async fund(deployment, plan) {
      if (!plan) throw new RangeError("vault funding needs a funding plan");
      await topupVault(deployment.vault as SdkVaultLike, plan);
    },

    async release(deployment) {
      return withdrawAndVerify(deployment.vault as SdkVaultLike);
    },

    async fundExtraReplicas(deployment, p) {
      const jobPrice = await port.getMarketJobPrice(p.marketAddress);
      const funded = planVaultFunding({
        jobPriceBaseUnitsPerSecond: jobPrice,
        replicas: p.added,
        fundSeconds: p.fundSeconds,
        solFeeLamportsPerReplica:
          p.solFeeLamportsPerReplica ?? DEFAULT_SOL_FEE_LAMPORTS_PER_REPLICA,
        networkFeeBps: p.networkFeeBps,
      });
      await topupVault(deployment.vault as SdkVaultLike, funded);
      return funded;
    },

    async ensureRunway(deployment, id, params) {
      const jobPrice = await port.getMarketJobPrice(params.marketAddress);
      const solFee = params.solFeeLamportsPerReplica ?? DEFAULT_SOL_FEE_LAMPORTS_PER_REPLICA;
      const perSecond = planVaultFunding({
        jobPriceBaseUnitsPerSecond: jobPrice,
        replicas: params.replicas,
        fundSeconds: 1,
        solFeeLamportsPerReplica: solFee,
        networkFeeBps: params.networkFeeBps,
      }).nosBaseUnits;
      if (perSecond === 0n) {
        return { deploymentId: id, toppedUp: false, runwaySeconds: null, funded: null, reason: "zero_price" };
      }

      const vault = requireVault(deployment, "topup");
      const balance = await vault.getBalance();
      const nosNow = BigInt(Math.round(balance.NOS * Number(NOS_BASE_UNITS_PER_NOS)));
      const solNow = BigInt(Math.round(balance.SOL * Number(LAMPORTS_PER_SOL_BIG)));
      const runwaySeconds = Number(nosNow / perSecond);

      const target = perSecond * BigInt(params.fundSeconds);
      const nosTopup = runwaySeconds < params.minRunwaySeconds && target > nosNow ? target - nosNow : 0n;
      const minSol = solFee * BigInt(params.replicas);
      const solTopup = solNow < minSol ? minSol - solNow : 0n;

      if (nosTopup === 0n && solTopup === 0n) {
        return { deploymentId: id, toppedUp: false, runwaySeconds, funded: null };
      }

      await topupVault(vault, { nosBaseUnits: nosTopup, solLamports: solTopup });
      return {
        deploymentId: id,
        toppedUp: true,
        runwaySeconds,
        funded: { nosBaseUnits: nosTopup, solLamports: solTopup },
      };
    },
  };
}

export interface CreditsFundingDeps {
  /**
   * Available credits, read FRESH from Nosana. Rejects with a NosanaCreditsError
   * (or any error carrying one of FUNDING_REFUSAL_CODES) when unreadable.
   */
  getAvailableMicroUsd(): Promise<bigint>;
  /** For the runway measurement only, where a recent value is good enough. Never used to admit. */
  getCachedAvailableMicroUsd?(): Promise<bigint>;
  /** What one replica of this market costs per second, fee included. */
  costMicroUsdPerSecond(marketAddress: string): Promise<bigint>;
  /**
   * The same for the runway measurement, which admits nothing and so may use
   * an approximation where the gate must refuse. Default: costMicroUsdPerSecond.
   */
  runwayCostMicroUsdPerSecond?(marketAddress: string): Promise<bigint>;
  /** The floor that must remain available after the estimate. */
  minMicroUsd: bigint;
}

/**
 * In credits mode Nosana still owes nothing back to us; "released" means it is
 * not running the deployment and will not schedule more work for it - every
 * state except these three. A halted state (error, insufficient_funds) counts
 * as released: nothing is listed for it any more, and treating it otherwise
 * would block a restart for ever in exactly the credits-ran-out case.
 */
const CREDITS_HELD: ReadonlySet<DeploymentState> = new Set(["starting", "running", "stopping"]);

function creditsRefusal(err: unknown, stage: LifecycleStage, deploymentId?: string): NosanaLifecycleError {
  if (err instanceof NosanaLifecycleError) return err;
  const code =
    err instanceof NosanaCreditsError ? err.code : (refusalCode(err) ?? "nosana_credits_unavailable");
  return new NosanaLifecycleError(
    code === "nosana_auth_failed"
      ? "Nosana rejected the platform API key"
      : `The platform's Nosana credits could not be checked: ${errMessage(err)}`,
    stage,
    { cause: err, code, ...(deploymentId ? { deploymentId } : {}) },
  );
}

/**
 * API-key funding: prepaid USD credits. There is no top-up and no withdraw;
 * what is left is a gate before anything is created (estimate + floor must be
 * available, read fresh, fail closed) and a state check afterwards.
 */
export function creditsFunding(deps: CreditsFundingDeps): DeploymentFunding {
  async function gate(
    marketAddress: string,
    replicas: number,
    seconds: number,
    stage: LifecycleStage,
    deploymentId?: string,
  ): Promise<bigint> {
    let estimate: bigint;
    let available: bigint;
    try {
      const cost = await deps.costMicroUsdPerSecond(marketAddress);
      const required = requiredCreditsMicroUsd({
        costMicroUsdPerSecond: cost,
        replicas,
        reserveSeconds: seconds,
        floorMicroUsd: deps.minMicroUsd,
      });
      estimate = required - deps.minMicroUsd;
      available = await deps.getAvailableMicroUsd();
    } catch (err) {
      if (err instanceof RangeError) throw err;
      throw creditsRefusal(err, stage, deploymentId);
    }
    if (available < estimate + deps.minMicroUsd) {
      // No amounts in the message: it can reach an end user.
      throw new NosanaLifecycleError(
        "The platform's Nosana credits do not cover this deployment and the required floor",
        stage,
        { code: "nosana_credits_low", ...(deploymentId ? { deploymentId } : {}) },
      );
    }
    return estimate;
  }

  return {
    kind: "credits",

    async prepare(p) {
      const estimateMicroUsd = await gate(p.marketAddress, p.replicas, p.fundSeconds, "create");
      return { funding: null, estimateMicroUsd };
    },

    async fund() {
      // Nosana reserves credits itself when it lists the job.
    },

    async release(_deployment, state) {
      if (state === null) {
        return {
          reclaimed: false,
          remainingNosBaseUnits: null,
          error: "the deployment's state could not be read back from Nosana",
        };
      }
      if (CREDITS_HELD.has(state)) {
        return { reclaimed: false, remainingNosBaseUnits: null, error: `still ${state} on Nosana` };
      }
      return { reclaimed: true, remainingNosBaseUnits: 0n };
    },

    async fundExtraReplicas(deployment, p) {
      await gate(p.marketAddress, p.added, p.fundSeconds, "scale", String(deployment.id));
      return null;
    },

    async ensureRunway(_deployment, id, params) {
      let cost: bigint;
      let available: bigint;
      try {
        cost = await (deps.runwayCostMicroUsdPerSecond ?? deps.costMicroUsdPerSecond)(
          params.marketAddress,
        );
        available = await (deps.getCachedAvailableMicroUsd ?? deps.getAvailableMicroUsd)();
      } catch (err) {
        throw creditsRefusal(err, "read", id);
      }
      const perSecond = cost * BigInt(params.replicas);
      if (perSecond === 0n) {
        return { deploymentId: id, toppedUp: false, runwaySeconds: null, funded: null, reason: "zero_price" };
      }
      const seconds = available / perSecond;
      return {
        deploymentId: id,
        toppedUp: false,
        // The balance is shared by every deployment; this is how long THIS one
        // could run if it had the balance to itself.
        runwaySeconds: seconds > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(seconds),
        funded: null,
        reason: "credits",
      };
    },
  };
}

/**
 * The state `release` is told about. Vault funding does not need one (and must
 * not cost an extra read); credits funding gets a FRESH read, because the SDK
 * object's own status is only what it was when it was fetched.
 */
async function stateForRelease(
  port: NosanaDeploymentsPort,
  id: string,
  funding: DeploymentFunding,
  known: DeploymentState | null,
): Promise<DeploymentState | null> {
  if (funding.kind !== "credits") return known;
  try {
    return normalizeStatus((await port.get(id)).status);
  } catch {
    return null;
  }
}

// ============================================
// Create + fund + start
// ============================================

export interface CreateAndStartParams {
  name: string;
  marketAddress: string;
  replicas: number;
  /** Per-job timeout in seconds (NOT the deployment's lifetime; see strategy). */
  jobTimeoutSeconds: number;
  definition: unknown;
  /** Seconds of run-time to fund at deploy time. Must be >= jobTimeoutSeconds. */
  fundSeconds: number;
  /**
   * Default "SIMPLE-EXTEND": the Deployment Manager schedules LIST then EXTEND
   * tasks (Task.task: "LIST" | "EXTEND" | "STOP" in the SDK schema), so ONE job
   * is kept alive by extending it before `timeout` elapses. That keeps the model
   * loaded (no cold start per period) and bounds up-front escrow to one short
   * timeout instead of 30 days. "SIMPLE" runs once and stops at the timeout
   * (batch work); "INFINITE" re-lists a fresh job when one ends.
   */
  strategy?: DeploymentStrategyName;
  solFeeLamportsPerReplica?: bigint;
  networkFeeBps?: number;
}

export interface CreateAndStartResult {
  deploymentId: string;
  vaultAddress: string;
  funding: VaultFundingPlan;
  strategy: DeploymentStrategyName;
}

/** What createAndStartDeployment returns when a funding is passed explicitly. */
export interface FundedCreateResult {
  deploymentId: string;
  /** Undefined with credits: there is no vault. */
  vaultAddress: string | undefined;
  /** Null with credits: nothing was sent. */
  funding: VaultFundingPlan | null;
  strategy: DeploymentStrategyName;
  fundingKind: FundingKind;
  /** credits: what the gate estimated for this deployment. vault: null. */
  estimateMicroUsd: bigint | null;
}

export async function createAndStartDeployment(
  port: NosanaDeploymentsPort,
  params: CreateAndStartParams,
): Promise<CreateAndStartResult>;
export async function createAndStartDeployment(
  port: NosanaDeploymentsPort,
  params: CreateAndStartParams,
  funding: DeploymentFunding,
): Promise<FundedCreateResult>;
export async function createAndStartDeployment(
  port: NosanaDeploymentsPort,
  params: CreateAndStartParams,
  funder: DeploymentFunding = vaultFunding(port),
): Promise<CreateAndStartResult | FundedCreateResult> {
  assertPositiveInt("replicas", params.replicas);
  assertPositiveInt("jobTimeoutSeconds", params.jobTimeoutSeconds);
  assertPositiveInt("fundSeconds", params.fundSeconds);
  if (params.fundSeconds < params.jobTimeoutSeconds) {
    throw new RangeError(
      "fundSeconds must be >= jobTimeoutSeconds: the first listing alone escrows one full timeout",
    );
  }
  const strategy = params.strategy ?? "SIMPLE-EXTEND";

  // Funding first: a bad/unknown market (vault) or a balance that does not
  // cover the deployment (credits) must fail BEFORE anything is created.
  const { funding, estimateMicroUsd } = await funder.prepare({
    marketAddress: params.marketAddress,
    replicas: params.replicas,
    fundSeconds: params.fundSeconds,
    jobTimeoutSeconds: params.jobTimeoutSeconds,
    solFeeLamportsPerReplica: params.solFeeLamportsPerReplica,
    networkFeeBps: params.networkFeeBps,
  });

  let deployment: SdkDeploymentLike;
  try {
    deployment = await port.create({
      name: params.name,
      market: params.marketAddress,
      replicas: params.replicas,
      timeout: params.jobTimeoutSeconds,
      strategy,
      confidential: true,
      job_definition: params.definition,
    });
  } catch (err) {
    // No id came back, but the deployment MAY exist (see mayExistOnNosana):
    // the name is all a later look-up has to go on.
    throw new NosanaLifecycleError(
      `Nosana deployment creation failed: ${errMessage(err)}`,
      "create",
      { cause: err, deploymentName: params.name, mayExistOnNosana: true, ...keepRefusalCode(err) },
    );
  }
  const deploymentId = String(deployment.id);

  try {
    await funder.fund(deployment, funding);
  } catch (err) {
    const cleanup = await bestEffortCleanup(port, deployment, funder);
    throw new NosanaLifecycleError(
      `Funding the vault of Nosana deployment ${deploymentId} failed: ${errMessage(err)} ` +
        `(cleanup: stopped=${cleanup.stopped}, reclaimed=${cleanup.reclaimed})`,
      "topup",
      { deploymentId, cause: err, cleanup, deploymentName: params.name },
    );
  }

  try {
    await deployment.start();
  } catch (err) {
    const cleanup = await bestEffortCleanup(port, deployment, funder);
    throw new NosanaLifecycleError(
      `Starting Nosana deployment ${deploymentId} failed: ${errMessage(err)} ` +
        `(cleanup: stopped=${cleanup.stopped}, reclaimed=${cleanup.reclaimed})`,
      "start",
      { deploymentId, cause: err, cleanup, deploymentName: params.name, ...keepRefusalCode(err) },
    );
  }

  return {
    deploymentId,
    vaultAddress: deployment.vault?.publicKey.toBase58(),
    funding,
    strategy,
    fundingKind: funder.kind,
    estimateMicroUsd,
  };
}

// ============================================
// Stop + reclaim
// ============================================

export interface StopAndReclaimResult {
  deploymentId: string;
  /** True once the deployment is stopping/stopped/archived on Nosana. */
  stopped: boolean;
  /** It was already stopping/stopped/archived/draft before this call. */
  alreadyStopped: boolean;
  /** True only when the vault's NOS balance was verified to be zero. */
  reclaimed: boolean;
  remainingNosBaseUnits: bigint | null;
  reclaimError?: string;
}

const NO_STOP_NEEDED: ReadonlySet<DeploymentState> = new Set([
  "draft",
  "stopping",
  "stopped",
  "archived",
]);

/**
 * States in which the Deployment Manager has already given up on the deployment:
 * a stop is attempted (jobs may linger) but a refusal is not fatal - the vault
 * is reclaimed regardless and the status worker moves the row to `failed`.
 */
const HALTED: ReadonlySet<DeploymentState> = new Set(["error", "insufficient_funds"]);

/**
 * Stops the deployment, then tries to pull the vault's funds back. The stop
 * MUST take effect (it throws NosanaLifecycleError("stop") otherwise - the GPU
 * would keep burning platform money). The withdraw is best effort: Nosana ends
 * the jobs asynchronously, so it commonly fails right after a stop; that is
 * reported as `reclaimed: false` and retried later by reclaimVault.
 */
export async function stopAndReclaim(
  port: NosanaDeploymentsPort,
  id: string,
  funding: DeploymentFunding = vaultFunding(port),
): Promise<StopAndReclaimResult> {
  let deployment: SdkDeploymentLike;
  try {
    deployment = await port.get(id);
  } catch (err) {
    throw new NosanaLifecycleError(
      `Could not read Nosana deployment ${id} to stop it: ${errMessage(err)}`,
      "stop",
      { deploymentId: id, cause: err, ...keepRefusalCode(err) },
    );
  }

  const before = normalizeStatus(deployment.status);
  const alreadyStopped = NO_STOP_NEEDED.has(before);

  if (!alreadyStopped) {
    try {
      await deployment.stop();
    } catch (err) {
      // A deployment Nosana already halted (ERROR / INSUFFICIENT_FUNDS) may
      // refuse a stop; that must not leave the user unable to stop it.
      if (HALTED.has(before)) {
        const withdraw = await funding.release(
          deployment,
          await stateForRelease(port, id, funding, before),
        );
        return {
          deploymentId: id,
          stopped: true,
          alreadyStopped: true,
          reclaimed: withdraw.reclaimed,
          remainingNosBaseUnits: withdraw.remainingNosBaseUnits,
          ...(withdraw.error ? { reclaimError: withdraw.error } : {}),
        };
      }
      // Lost a race with another stopper? Re-read before declaring failure.
      let after: DeploymentState | null = null;
      try {
        after = normalizeStatus((await port.get(id)).status);
      } catch {
        after = null;
      }
      if (after === null || !NO_STOP_NEEDED.has(after)) {
        throw new NosanaLifecycleError(
          `Stopping Nosana deployment ${id} failed: ${errMessage(err)}`,
          "stop",
          { deploymentId: id, cause: err, ...keepRefusalCode(err) },
        );
      }
    }
  }

  const withdraw = await funding.release(
    deployment,
    // Nothing was asked of Nosana when it was already stopped: `before` is current.
    alreadyStopped && before !== "stopping"
      ? before
      : await stateForRelease(port, id, funding, before),
  );
  return {
    deploymentId: id,
    stopped: true,
    alreadyStopped,
    reclaimed: withdraw.reclaimed,
    remainingNosBaseUnits: withdraw.remainingNosBaseUnits,
    ...(withdraw.error ? { reclaimError: withdraw.error } : {}),
  };
}

export interface ReclaimResult {
  deploymentId: string;
  state: DeploymentState;
  reclaimed: boolean;
  remainingNosBaseUnits: bigint | null;
  reason?: string;
}

/**
 * Retry of the withdraw half of stopAndReclaim, for the status worker's sweep
 * over stopped/failed deployments whose vault has not been verified empty (and
 * for restart, which needs the previous run's funds back before forgetting its
 * id).
 *
 * The caller only ever asks about a deployment that is already TERMINAL in our
 * database, so a Nosana deployment that is still running/starting (a stop that
 * never reached Nosana, a start that raced a stop) is burning platform NOS with
 * nobody paying for it: it is STOPPED here, not merely reported. A stop that
 * cannot be issued throws - the sweep counts it as a failure - because a silent
 * `reclaimed: false` would leave the GPU running indefinitely.
 */
export async function reclaimVault(
  port: NosanaDeploymentsPort,
  id: string,
  funding: DeploymentFunding = vaultFunding(port),
): Promise<ReclaimResult> {
  const deployment = await port.get(id);
  const state = normalizeStatus(deployment.status);
  let stopAttempted = false;

  if (state === "running" || state === "starting") {
    stopAttempted = true;
    try {
      await deployment.stop();
    } catch (err) {
      // Lost a race with another stopper? Re-read before declaring failure.
      let after: DeploymentState | null = null;
      try {
        after = normalizeStatus((await port.get(id)).status);
      } catch {
        after = null;
      }
      if (after === null || !NO_STOP_NEEDED.has(after)) {
        throw new NosanaLifecycleError(
          `Stopping Nosana deployment ${id} (terminal in our records, still ${state} on Nosana) failed: ${errMessage(err)}`,
          "stop",
          { deploymentId: id, cause: err, ...keepRefusalCode(err) },
        );
      }
    }
  } else if (HALTED.has(state)) {
    stopAttempted = true;
    // Halted for us, but jobs may linger; stopping is idempotent and cheap.
    try {
      await deployment.stop();
    } catch {
      // Tolerated: the withdraw below is the authority on whether funds are free.
    }
  }

  const withdraw = await funding.release(
    deployment,
    // Only a stop can have moved the state since the read above.
    stopAttempted ? await stateForRelease(port, id, funding, state) : state,
  );
  return {
    deploymentId: id,
    state,
    reclaimed: withdraw.reclaimed,
    remainingNosBaseUnits: withdraw.remainingNosBaseUnits,
    ...(withdraw.error ? { reason: withdraw.error } : {}),
  };
}

// ============================================
// Scale
// ============================================

export interface ScaleParams {
  marketAddress: string;
  fundSeconds: number;
  solFeeLamportsPerReplica?: bigint;
  networkFeeBps?: number;
}

export interface ScaleResult {
  deploymentId: string;
  previousReplicas: number;
  replicas: number;
  funded: VaultFundingPlan | null;
}

/**
 * Changes the replica count of a RUNNING deployment. Added replicas are funded
 * first (an unfunded replica would make the whole deployment INSUFFICIENT_FUNDS
 * at its next extension), then the count is updated. The top-up stays in the
 * deployment's own vault, so a later stop reclaims it - nothing is stranded if
 * the count update then fails.
 */
export async function scaleDeployment(
  port: NosanaDeploymentsPort,
  id: string,
  replicas: number,
  params: ScaleParams,
  funding: DeploymentFunding = vaultFunding(port),
): Promise<ScaleResult> {
  assertPositiveInt("replicas", replicas);

  let deployment: SdkDeploymentLike;
  try {
    deployment = await port.get(id);
  } catch (err) {
    throw new NosanaLifecycleError(
      `Could not read Nosana deployment ${id} to scale it: ${errMessage(err)}`,
      "scale",
      { deploymentId: id, cause: err, ...keepRefusalCode(err) },
    );
  }

  const state = normalizeStatus(deployment.status);
  if (state !== "running") {
    throw new NosanaLifecycleError(
      `Nosana deployment ${id} is ${state}; replicas can only change while it is running`,
      "scale",
      { deploymentId: id, code: "nosana_not_running" },
    );
  }

  const previous = deployment.replicas;
  if (replicas === previous) {
    return { deploymentId: id, previousReplicas: previous, replicas, funded: null };
  }

  let funded: VaultFundingPlan | null = null;
  if (replicas > previous) {
    try {
      funded = await funding.fundExtraReplicas(deployment, {
        marketAddress: params.marketAddress,
        added: replicas - previous,
        fundSeconds: params.fundSeconds,
        solFeeLamportsPerReplica: params.solFeeLamportsPerReplica,
        networkFeeBps: params.networkFeeBps,
      });
    } catch (err) {
      throw new NosanaLifecycleError(
        `Funding ${replicas - previous} extra replica(s) for Nosana deployment ${id} failed: ${errMessage(err)}`,
        "scale",
        { deploymentId: id, cause: err, ...keepRefusalCode(err) },
      );
    }
  }

  try {
    await deployment.updateReplicaCount(replicas);
  } catch (err) {
    throw new NosanaLifecycleError(
      `Updating the replica count of Nosana deployment ${id} failed: ${errMessage(err)}`,
      "scale",
      { deploymentId: id, cause: err, ...keepRefusalCode(err) },
    );
  }

  return { deploymentId: id, previousReplicas: previous, replicas, funded };
}

// ============================================
// Vault runway (keeps a billed, running deployment funded)
// ============================================

export interface RunwayParams {
  marketAddress: string;
  replicas: number;
  /** Top up when the vault covers fewer seconds than this. */
  minRunwaySeconds: number;
  /** Target runway after a top-up. */
  fundSeconds: number;
  solFeeLamportsPerReplica?: bigint;
  networkFeeBps?: number;
}

export interface RunwayResult {
  deploymentId: string;
  toppedUp: boolean;
  /** Seconds of extension funding left before the check; null if not measured. */
  runwaySeconds: number | null;
  funded: { nosBaseUnits: bigint; solLamports: bigint } | null;
  /** "credits": measured against the shared credit balance; nothing is ever topped up. */
  reason?: "not_running" | "zero_price" | "credits";
}

/**
 * The job listing escrows the first `timeout` of funds, but every extension
 * draws from the vault; without a refill a running deployment would reach
 * INSUFFICIENT_FUNDS after the initial runway. Called by the GPU billing worker
 * only for deployments whose org has just paid, so the platform never funds an
 * org that stopped paying.
 */
export async function ensureVaultRunway(
  port: NosanaDeploymentsPort,
  id: string,
  params: RunwayParams,
  funding: DeploymentFunding = vaultFunding(port),
): Promise<RunwayResult> {
  assertPositiveInt("replicas", params.replicas);
  const deployment = await port.get(id);
  const state = normalizeStatus(deployment.status);
  if (state !== "running" && state !== "starting") {
    return { deploymentId: id, toppedUp: false, runwaySeconds: null, funded: null, reason: "not_running" };
  }

  return funding.ensureRunway(deployment, id, params);
}
