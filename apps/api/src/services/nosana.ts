import { Connection, Keypair } from "@solana/web3.js";
import { Client } from "@nosana/sdk";
import { env } from "../config/env.js";
import {
  getNosanaAccessConfig,
  NOSANA_BACKEND_URLS,
  effectiveTimeoutSeconds,
  secondsToSdkTimeout,
  type NosanaAccessMode,
  type NosanaPrimaryMode,
  type NosanaTimeoutUnit,
} from "../config/nosanaAccess.js";
import { getNosanaDeployConfig } from "../config/nosanaDeploy.js";
import { createLogger } from "../utils/logger.js";
import {
  isAllowedNodeUrl,
  loopbackNodeUrlsAllowed,
  type NodeUrlAllowlistOptions,
} from "./nodeUrlAllowlist.js";
import { isMockNosanaId } from "./nosanaIds.js";
import {
  MARKETS,
  MarketNotConfiguredError,
  resolveMarketAddress,
  toNosanaNetwork,
  type NosanaMarket,
  type NosanaNetwork,
} from "./nosanaMarkets.js";
import {
  checkCreditGate,
  makeCreditBalanceFetcher,
  makeCreditReader,
  NosanaCreditsError,
  requiredCreditsMicroUsd,
  type CreditBalance,
  type CreditReader,
  type FetchLike,
} from "./nosanaCredits.js";
import {
  MARKET_COST_STALE_MAX_MS,
  makeMarketCostReader,
  makeMarketListFetcher,
  retailMicroUsdPerSecond,
  type MarketCost,
  type MarketCostReader,
} from "./nosanaMarketCosts.js";
import {
  createAndStartDeployment,
  creditsFunding,
  ensureVaultRunway,
  normalizeStatus,
  NosanaLifecycleError,
  readDeployment,
  reclaimVault,
  scaleDeployment,
  stopAndReclaim,
  toBaseUnits,
  vaultFunding,
  type CreateDeploymentBody,
  type DeploymentFunding,
  type DeploymentSnapshot,
  type DeploymentState,
  type EndpointSnapshot,
  type NosanaDeploymentsPort,
  type ReclaimResult,
  type RunwayResult,
  type ScaleResult,
  type SdkDeploymentLike,
  type StopAndReclaimResult,
} from "./nosanaDeploymentLifecycle.js";

const logger = createLogger("nosana-service");

// The GPU tier catalog lives in nosanaMarkets.ts (SDK-free); re-exported here
// because billing and routes have always imported it from this module.
export { MARKETS, MarketNotConfiguredError, type NosanaMarket };
export type { NosanaAccessMode };

// ============================================
// Types
// ============================================

export interface NosanaJobDefinition {
  version: string;
  type: string;
  meta: {
    trigger: string;
  };
  ops: NosanaOperation[];
}

export interface NosanaOperation {
  type: string;
  id: string;
  args: {
    image: string;
    cmd?: string[];
    env?: Record<string, string>;
    gpu?: boolean;
    expose?: number[];
    work?: string;
    output?: string;
    resources?: {
      memory?: string;
      cpu?: string;
    };
  };
}

/** A market as read from the chain. Prices here are NOS base units, never USD. */
export interface ChainMarket {
  address: string;
  /** market.jobPrice: NOS base units (1e-6 NOS) per second. */
  jobPriceNosBaseUnitsPerSecond: bigint;
  queueLength: number;
}

export interface NosanaJob {
  id: string;
  market: string;
  status: "queued" | "running" | "completed" | "failed";
  nodeUrl?: string;
  /** Base58 pubkey of the host node executing the job. Source-of-truth
   * recipient for treasury auto-pay (plan A3). Undefined when the job
   * isn't yet picked up by a host (queue state) or the SDK reports the
   * SystemProgram zero-pubkey sentinel. */
  nodePubkey?: string;
  startTime?: Date;
  endTime?: Date;
  cost?: number;
}

const SYSTEM_PROGRAM_ZERO_PUBKEY = "11111111111111111111111111111111";

/** What createDeployment returns: a started Nosana deployment. */
export interface NosanaDeployment {
  /** Nosana Deployment-Manager id (store it in `nosanaJobIds`). */
  id: string;
  market: string;
  replicas: number;
  status: "active" | "stopped";
  /**
   * Public endpoints Nosana has reported. Always empty right after creation -
   * a deployment has no URL until a host picks the job up; the status worker
   * learns the real URLs from the Nosana API. Never synthesised.
   */
  endpoints: EndpointSnapshot[];
  /** Vault holding the platform's funding for this deployment (wallet access only). */
  vaultAddress?: string;
  /**
   * The credential that created it. Store it with the id: every later stop,
   * reclaim, scale and status read must go through the same account. Absent
   * only on the dev-only mock.
   */
  accessMode?: NosanaAccessMode;
  /** True ONLY for the dev-only mock: such an id does not exist on Nosana. */
  mock?: boolean;
}

export interface CreateDeploymentOptions {
  /**
   * "service" (default): long-running inference, kept alive by the configured
   * strategy (SIMPLE-EXTEND). "batch": finite work (training) - strategy SIMPLE,
   * never auto-extended, bounded by NOSANA_BATCH_JOB_TIMEOUT_SECONDS.
   */
  kind?: "service" | "batch";
  /**
   * The name on Nosana. Pass a DETERMINISTIC one (wheelsaiDeploymentName) so a
   * deployment whose create call threw can still be found by name.
   */
  name?: string;
  /**
   * Per-job timeout for THIS deployment, in seconds, instead of the configured
   * default for its kind. It sizes the vault funding (wallet) or the credit
   * estimate (API key). Must be an integer >= 60.
   */
  timeoutSeconds?: number;
}

/** Thrown when Nosana deployments are requested but no platform credential exists. */
export class NosanaNotConfiguredError extends Error {
  readonly code = "nosana_not_configured";
  constructor(
    message = "Nosana deployments are not configured: set NOSANA_API_KEY (prepaid credits) or NOSANA_WALLET_PRIVATE_KEY (Solana wallet)",
  ) {
    super(message);
    this.name = "NosanaNotConfiguredError";
  }
}

/**
 * A row was created by an access mode this process holds no credential for
 * (the wallet key was removed after a switch to an API key, or the reverse).
 * Nothing can be read or stopped for it from here; it is named, not guessed.
 */
export class NosanaAccessModeUnavailableError extends Error {
  readonly code = "nosana_access_mode_unavailable";
  constructor(readonly mode: NosanaAccessMode) {
    super(
      `This deployment was created with Nosana ${mode === "wallet" ? "wallet" : "API-key"} access, which is not configured in this process`,
    );
    this.name = "NosanaAccessModeUnavailableError";
  }
}

/**
 * One-shot jobs (submitJob) are listed on chain by a wallet. With an API key
 * the only equivalent pins the job definition to PUBLIC IPFS, so it is refused.
 */
export class NosanaOneShotUnavailableError extends Error {
  readonly code = "nosana_one_shot_unavailable";
  constructor() {
    super("One-shot Nosana jobs are not available with API-key access");
    this.name = "NosanaOneShotUnavailableError";
  }
}

/** Name prefix of every deployment this platform creates on Nosana. */
export const NOSANA_DEPLOYMENT_NAME_PREFIX = "wheelsai-";

/**
 * A deterministic Nosana deployment name for one of our rows, e.g.
 * wheelsaiDeploymentName("model", row.id). Knowing the name before the create
 * call is what lets a deployment be found when that call throws.
 */
export function wheelsaiDeploymentName(scope: string, rowId: string): string {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${NOSANA_DEPLOYMENT_NAME_PREFIX}${clean(scope)}-${clean(rowId)}`.slice(0, 96);
}

/** One row of Nosana's own deployment list. */
export interface NosanaDeploymentSummary {
  id: string;
  name: string;
  /** "unknown" when Nosana reports a status this code does not know. */
  status: DeploymentState | "unknown";
  rawStatus: string;
  replicas: number | null;
  market: string | null;
  createdAt: Date | null;
  /** The credential the list was read with. */
  accessMode: NosanaAccessMode;
}

export type DeploymentJobState = "queued" | "running" | "completed" | "stopped" | "unknown";

/** A job of a deployment, as GET /api/deployments/{id}/jobs/{job} reports it. */
export interface DeploymentJobSnapshot {
  deploymentId: string;
  job: string;
  state: DeploymentJobState;
  /** What Nosana sent: a number or a string, depending on the backend version. */
  rawState: string | number | null;
  jobStatus: string | null;
  /** Host node public key; null until a host has taken the job. */
  node: string | null;
  market: string | null;
  revision: number | null;
  /**
   * UNVERIFIED UNIT. The schema types these as bare numbers. They are read as
   * unix SECONDS (the on-chain convention), or as milliseconds when the value
   * is too large to be seconds; zero or negative means "not yet". Compare with
   * `raw` before billing anything from them.
   */
  timeStart: Date | null;
  timeEnd: Date | null;
  listedAt: Date | null;
  raw: { timeStart: unknown; timeEnd: unknown; listedAt: unknown };
  jobResult: unknown;
}

const JOB_STATE_BY_NUMBER: readonly DeploymentJobState[] = ["queued", "running", "completed", "stopped"];
const JOB_STATE_BY_NAME: Readonly<Record<string, DeploymentJobState>> = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  DONE: "completed",
  STOPPED: "stopped",
};

function jobTime(value: unknown): Date | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  // Seconds until the year 5138; anything larger can only be milliseconds.
  const date = new Date(n >= 1e11 ? n : n * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Normalises a raw deployment-job body. Never throws on an odd field. */
export function normalizeDeploymentJob(
  deploymentId: string,
  job: string,
  raw: unknown,
): DeploymentJobSnapshot {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const rawState =
    typeof body.state === "number" || typeof body.state === "string" ? body.state : null;
  let state: DeploymentJobState = "unknown";
  if (typeof rawState === "number" || (typeof rawState === "string" && /^\d+$/.test(rawState))) {
    state = JOB_STATE_BY_NUMBER[Number(rawState)] ?? "unknown";
  } else if (typeof rawState === "string") {
    state = JOB_STATE_BY_NAME[rawState.toUpperCase()] ?? "unknown";
  }
  const node = typeof body.node === "string" && body.node !== "" ? body.node : null;
  return {
    deploymentId,
    job,
    state,
    rawState,
    jobStatus: typeof body.jobStatus === "string" ? body.jobStatus : null,
    node: node === SYSTEM_PROGRAM_ZERO_PUBKEY ? null : node,
    market: typeof body.market === "string" ? body.market : null,
    revision: typeof body.revision === "number" ? body.revision : null,
    timeStart: jobTime(body.timeStart),
    timeEnd: jobTime(body.timeEnd),
    listedAt: jobTime(body.listedAt),
    raw: { timeStart: body.timeStart, timeEnd: body.timeEnd, listedAt: body.listedAt },
    jobResult: body.jobResult ?? null,
  };
}

/** How one access mode reaches Nosana and pays for it. */
interface NosanaAccess {
  mode: NosanaAccessMode;
  port: NosanaDeploymentsPort;
  funding: DeploymentFunding;
}

/** The part of an API-key SDK client this service uses. */
interface ApiSdkLike {
  deployments: {
    create(body: unknown): Promise<unknown>;
    get(id: string): Promise<unknown>;
  };
}

/** Service estimates cover at least this long, whatever the job timeout. */
const MIN_CREDIT_ESTIMATE_SECONDS = 3_600;
/** The SDK refuses an updateTimeout value below this (its own guard). */
const SDK_MIN_UPDATE_TIMEOUT = 60;

function toSummaryDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDeploymentSummary(raw: unknown, accessMode: NosanaAccessMode): NosanaDeploymentSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== "string" || row.id === "") return null;
  const rawStatus = String(row.status ?? "");
  let status: NosanaDeploymentSummary["status"];
  try {
    status = normalizeStatus(rawStatus);
  } catch {
    status = "unknown";
  }
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : "",
    status,
    rawStatus,
    replicas: typeof row.replicas === "number" ? row.replicas : null,
    market: typeof row.market === "string" ? row.market : null,
    createdAt: toSummaryDate(row.created_at),
    accessMode,
  };
}

// isMockNosanaId lives in nosanaIds.ts (import-free); re-exported because
// routes and tests have always imported it from here.
export { isMockNosanaId };

/**
 * The dev-only mock is honoured only when ALLOW_NOSANA_MOCK is set AND this is a
 * development process. Production boot already rejects the flag (validateEnv);
 * the NODE_ENV check makes the mock structurally unreachable in staging too.
 */
export function isNosanaMockEnabled(
  source: { ALLOW_NOSANA_MOCK?: boolean; NODE_ENV?: string } = env,
): boolean {
  return source.ALLOW_NOSANA_MOCK === true && source.NODE_ENV === "development";
}

/**
 * Options every server-side node fetch (the /v1 proxy, the playground proxy and
 * the health probe) passes to the SSRF allowlist. Loopback needs a development
 * process AND the explicit ALLOW_LOOPBACK_NODE_URLS opt-in.
 */
export function nodeUrlAllowlistOptions(): NodeUrlAllowlistOptions {
  return {
    allowLoopback: loopbackNodeUrlsAllowed(
      env.NODE_ENV,
      getNosanaDeployConfig().allowLoopbackNodeUrls,
    ),
  };
}

/** Engine-specific readiness probe: vLLM serves /health; Ollama does not. */
export function nodeHealthPath(engine?: string): string {
  return engine === "ollama" ? "/api/tags" : "/health";
}

// ============================================
// Nosana Client
// ============================================

export class NosanaClient {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private sdk: Client | null = null;
  private isInitialized = false;
  private network: NosanaNetwork;
  /**
   * The network the API key is used on. Its own field: `network` stays the
   * WALLET client's, so making the API key primary never moves wallet-created
   * deployments to another backend and other program addresses.
   */
  private apiNetwork: NosanaNetwork = "mainnet";
  // API-key access, beside the wallet client and never instead of it: `sdk`,
  // `wallet` and `network` keep meaning exactly what they always meant.
  private apiSdk: ApiSdkLike | null = null;
  private apiAccess: { apiKey: string; backendUrl: string } | null = null;
  /** Set by initialize() from config; null means "derive it from what is loaded". */
  private primaryMode: NosanaPrimaryMode | null = null;
  private credits: CreditReader | null = null;
  /** One per backend: with two credentials the two networks price different markets. */
  private marketCosts = new Map<string, MarketCostReader>();
  private authProbe: { at: number; failed: boolean } | null = null;
  /** HTTP seam for the direct credit, market and deployment-list reads. */
  private fetcher: FetchLike = (url, init) => fetch(url, init);

  constructor() {
    this.connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
    // SOLANA_NETWORK is typed as "devnet" | "mainnet-beta"; Nosana SDK only accepts "devnet" | "mainnet"
    this.network = toNosanaNetwork(env.SOLANA_NETWORK);
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (env.NOSANA_WALLET_PRIVATE_KEY) {
      try {
        const secretKey = Uint8Array.from(
          JSON.parse(env.NOSANA_WALLET_PRIVATE_KEY)
        );
        this.wallet = Keypair.fromSecretKey(secretKey);
        logger.info(
          { publicKey: this.wallet.publicKey.toBase58() },
          "Nosana wallet loaded"
        );
      } catch (error) {
        logger.error({ error }, "Failed to load Nosana wallet");
        throw new Error("Invalid NOSANA_WALLET_PRIVATE_KEY format");
      }
    } else {
      logger.warn("No Nosana wallet configured - job submission disabled");
    }

    const access = getNosanaAccessConfig();
    for (const warning of access.warnings) logger.warn(warning);
    // The wallet client keeps the network it always derived from
    // SOLANA_NETWORK, whichever credential is primary; only an explicit
    // NOSANA_NETWORK moves it. The API key has its own (mainnet by default).
    if (access.networkExplicit) this.network = access.walletNetwork;
    this.apiNetwork = access.apiNetwork;

    // Initialise SDK even without a wallet so read-only operations still work.
    // When no wallet is present pass a dummy key; the SDK needs something for
    // the Anchor provider but we guard all write paths explicitly.
    const sdkWallet = this.wallet ?? Keypair.generate();

    const ipfsConfig =
      env.PINATA_API_KEY && env.PINATA_SECRET_KEY
        ? {
            api: "https://api.pinata.cloud",
            gateway: "https://nosana.mypinata.cloud/ipfs/",
          }
        : undefined;

    // Use OUR RPC for the SDK's on-chain calls (vault top-ups, job listing,
    // market reads) instead of the SDK's built-in shared endpoint.
    this.sdk = new Client(this.network, sdkWallet, {
      solana: { network: env.SOLANA_RPC_URL },
      ...(ipfsConfig ? { ipfs: ipfsConfig } : {}),
    });

    if (access.apiKey) {
      // An explicit throwaway keypair: with no wallet argument the SDK would
      // pick up process.env.SOLANA_WALLET. It signs nothing - every request
      // carries the Bearer key. The SDK shares one Solana preset per network
      // between clients, so both are given the same `solana` config.
      this.apiSdk = new Client(this.apiNetwork, Keypair.generate(), {
        apiKey: access.apiKey,
        solana: { network: env.SOLANA_RPC_URL },
        ...(access.apiUrl ? { api: { backend_url: access.apiUrl } } : {}),
        ...(ipfsConfig ? { ipfs: ipfsConfig } : {}),
      }) as unknown as ApiSdkLike;
      this.apiAccess = {
        apiKey: access.apiKey,
        backendUrl: access.apiUrl ?? NOSANA_BACKEND_URLS[this.apiNetwork],
      };
      logger.info(
        { keySuffix: access.apiKeySuffix, network: this.apiNetwork, customBackend: !!access.apiUrl },
        "Nosana API key loaded"
      );
    }
    this.primaryMode = access.primary;

    logger.info(
      {
        network: this.getNetwork(),
        ...(this.wallet && this.apiSdk
          ? { walletNetwork: this.network, apiKeyNetwork: this.apiNetwork }
          : {}),
        ipfsConfigured: !!ipfsConfig,
        accessMode: this.getAccessMode(),
        timeoutUnit: access.timeoutUnit,
      },
      "Nosana SDK initialised"
    );

    this.isInitialized = true;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private requireWallet(): Keypair {
    if (!this.wallet) {
      throw new NosanaNotConfiguredError("Wallet not configured - cannot submit jobs");
    }
    return this.wallet;
  }

  private requireSdk(): Client {
    if (!this.sdk) {
      throw new Error("Nosana SDK not initialised - call initialize() first");
    }
    return this.sdk;
  }

  /** True when a platform credential is loaded (deploys can be paid for). */
  isConfigured(): boolean {
    return this.getAccessMode() !== "none";
  }

  /**
   * The credential that creates NEW deployments. Derived from what is actually
   * loaded: a configured mode whose credential is missing counts as absent,
   * and with no configured mode a loaded wallet means "wallet".
   */
  getAccessMode(): NosanaPrimaryMode {
    if (this.primaryMode === "api_key") return this.apiSdk ? "api_key" : "none";
    if (this.primaryMode === "wallet") return this.wallet ? "wallet" : "none";
    if (this.primaryMode === null) {
      if (this.wallet) return "wallet";
      if (this.apiSdk) return "api_key";
    }
    return "none";
  }

  /** Whether this process holds the credential for `mode` (primary or not). */
  hasAccessMode(mode: NosanaAccessMode): boolean {
    return mode === "wallet" ? this.wallet !== null : this.apiSdk !== null;
  }

  /**
   * The port and funding for an access mode. Omitted `mode` = the primary one.
   * A row passes ITS OWN mode (rowAccessMode(row.nosanaAccessMode)); when this
   * process has no credential for it the error says so by name. A process
   * with no credential at all is "not configured", as it always was - only a
   * process that holds the OTHER credential answers "other account".
   */
  private accessFor(mode?: NosanaAccessMode): NosanaAccess {
    const resolved = mode ?? this.getAccessMode();
    if (resolved === "none") throw new NosanaNotConfiguredError();
    if (!this.hasAccessMode(resolved)) {
      if (this.getAccessMode() === "none") throw new NosanaNotConfiguredError();
      throw new NosanaAccessModeUnavailableError(resolved);
    }
    if (resolved === "api_key") {
      return { mode: resolved, port: this.apiDeploymentsPort(), funding: this.creditsFundingFor() };
    }
    const port = this.deploymentsPort();
    return { mode: resolved, port, funding: vaultFunding(port) };
  }

  /**
   * accessFor for a call about an existing id. A mock id was never on Nosana,
   * so a row's stamped mode needs no credential (null = handle it as a mock).
   */
  private accessForId(id: string, mode?: NosanaAccessMode): NosanaAccess | null {
    if (mode !== undefined && isMockNosanaId(id)) return null;
    return this.accessFor(mode);
  }

  private timeoutUnit(): NosanaTimeoutUnit {
    return getNosanaAccessConfig().timeoutUnit;
  }

  /** The network NEW deployments are created on (the primary credential's). */
  getNetwork(): NosanaNetwork {
    return this.networkFor();
  }

  /**
   * The network a credential's deployments live on. Omitted `mode` = the
   * primary one. A row passes its own mode, as for accessFor.
   */
  private networkFor(mode?: NosanaAccessMode): NosanaNetwork {
    const resolved = mode ?? this.getAccessMode();
    return resolved === "api_key" ? this.apiNetwork : this.network;
  }

  /**
   * Pre-flight for routes: throws NosanaNotConfiguredError /
   * MarketNotConfiguredError so an unconfigured platform answers 501 BEFORE any
   * credits are reserved. The dev-only mock passes (it never touches Nosana).
   */
  assertCanDeploy(tier: string): void {
    if (isNosanaMockEnabled()) return;
    if (this.getAccessMode() === "none") throw new NosanaNotConfiguredError();
    this.resolveMarketAddress(tier);
  }

  /**
   * assertCanDeploy plus, with API-key access, the checks that need Nosana:
   * retail must not be below the market's cost, and the credit balance (read
   * FRESH, fail closed) must cover the estimate plus the floor. Call it before
   * anything is reserved. Wallet access adds no outbound call here.
   *
   * Throws NosanaLifecycleError with code gpu_price_below_cost,
   * nosana_credits_low, nosana_credits_unavailable or nosana_auth_failed.
   */
  async preflightDeploy(
    tier: string,
    replicas: number,
    kind: "service" | "batch" = "service",
    options: { timeoutSeconds?: number } = {},
  ): Promise<void> {
    this.assertCanDeploy(tier);
    if (isNosanaMockEnabled() || this.getAccessMode() !== "api_key") return;

    const marketAddress = this.resolveMarketAddress(tier);
    const estimate = await this.admittingCost(tier, marketAddress);

    const gate = await checkCreditGate({
      reader: this.creditReader(),
      costMicroUsdPerSecond: estimate.costMicroUsdPerSecond,
      replicas,
      reserveSeconds: this.creditEstimateSeconds(kind, options.timeoutSeconds),
      floorMicroUsd: getNosanaAccessConfig().minCreditsMicroUsd,
    });
    if (gate.ok) return;
    logger.error(
      {
        reason: gate.code,
        tier,
        replicas,
        requiredMicroUsd: gate.requiredMicroUsd?.toString(),
        availableMicroUsd: gate.availableMicroUsd?.toString(),
      },
      "New Nosana deployment refused by the platform credit gate"
    );
    throw new NosanaLifecycleError(
      gate.code === "nosana_credits_low"
        ? "The platform's Nosana credits do not cover this deployment and the required floor"
        : gate.code === "nosana_auth_failed"
          ? "Nosana rejected the platform API key"
          : "The platform's Nosana credits could not be read",
      "create",
      { code: gate.code },
    );
  }

  /**
   * The job timeout in seconds, as Nosana will apply it: a value that is not a
   * whole number of the unit it is sent in counts for what it rounds up to, so
   * the vault funding and the credit estimate cover the timeout that is sent.
   */
  private jobTimeoutFor(kind: "service" | "batch", timeoutSeconds?: number): number {
    if (timeoutSeconds !== undefined) {
      if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60) {
        throw new RangeError(`timeoutSeconds must be an integer >= 60, got ${timeoutSeconds}`);
      }
      return effectiveTimeoutSeconds(timeoutSeconds, this.timeoutUnit());
    }
    const cfg = getNosanaDeployConfig();
    return effectiveTimeoutSeconds(
      kind === "batch" ? cfg.batchJobTimeoutSeconds : cfg.jobTimeoutSeconds,
      this.timeoutUnit(),
    );
  }

  /** Seconds a credit estimate covers: a batch its whole timeout, a service at least an hour. */
  private creditEstimateSeconds(kind: "service" | "batch", timeoutSeconds?: number): number {
    const timeout = this.jobTimeoutFor(kind, timeoutSeconds);
    return kind === "batch" ? timeout : Math.max(timeout, MIN_CREDIT_ESTIMATE_SECONDS);
  }

  // ---------------------------------------------------------------------------
  // API-key access: credits, market cost, auth failures
  // ---------------------------------------------------------------------------

  private requireApiAccess(): { apiKey: string; backendUrl: string } {
    if (!this.apiAccess) {
      throw new NosanaNotConfiguredError("Nosana API-key access is not configured: NOSANA_API_KEY is not set");
    }
    return this.apiAccess;
  }

  private creditReader(): CreditReader {
    if (!this.credits) {
      const { apiKey, backendUrl } = this.requireApiAccess();
      this.credits = makeCreditReader({
        fetchBalance: makeCreditBalanceFetcher({ backendUrl, apiKey, fetch: this.fetcher }),
        now: () => new Date(),
        cacheMs: getNosanaAccessConfig().creditsCacheMs,
      });
    }
    return this.credits;
  }

  /**
   * The public market list of the backend `mode`'s deployments live on
   * (omitted = the primary one). No credential is sent.
   */
  private marketCostReader(mode?: NosanaAccessMode): MarketCostReader {
    const access = getNosanaAccessConfig();
    const resolved = mode ?? this.getAccessMode();
    const backendUrl =
      access.apiUrl ?? NOSANA_BACKEND_URLS[resolved === "api_key" ? this.apiNetwork : this.network];
    let reader = this.marketCosts.get(backendUrl);
    if (!reader) {
      reader = makeMarketCostReader({
        fetchMarkets: makeMarketListFetcher({ backendUrl, fetch: this.fetcher }),
        now: () => new Date(),
        cacheMs: access.costCacheMs,
        staleMs: MARKET_COST_STALE_MAX_MS,
        onStale: ({ marketAddress, ageMs, reason }) =>
          logger.warn(
            { marketAddress, ageSeconds: Math.round(ageMs / 1000), reason },
            "Nosana market cost not in the current list - using the last one seen"
          ),
      });
      this.marketCosts.set(backendUrl, reader);
    }
    return reader;
  }

  /**
   * Prepaid credit balance (API-key access only, whether or not it is the
   * primary mode). Cached for NOSANA_CREDITS_CACHE_MS unless `fresh`.
   * Throws NosanaLifecycleError: nosana_auth_failed or nosana_credits_unavailable.
   */
  async getCreditBalance(opts: { fresh?: boolean } = {}): Promise<CreditBalance> {
    try {
      return await this.creditReader().read(opts);
    } catch (err) {
      if (err instanceof NosanaCreditsError) {
        throw new NosanaLifecycleError(err.message, "read", { code: err.code, cause: err });
      }
      throw err;
    }
  }

  /**
   * What each tier's market costs the platform in USD, from Nosana's public
   * market list (no credential; works in either mode). A tier the list does not
   * price is null. THROWS when the list cannot be read.
   */
  async getMarketCosts(): Promise<Record<string, MarketCost | null>> {
    const costs = await this.marketCostReader().read();
    const out: Record<string, MarketCost | null> = {};
    for (const [tier, market] of Object.entries(MARKETS)) {
      out[tier] = costs.get(market.address) ?? null;
    }
    return out;
  }

  /**
   * The smallest available balance the credit gate admits anything with: the
   * floor plus one service replica of the cheapest deployable tier, estimated
   * as preflightDeploy does (except that a tier whose cost is unknown is
   * taken at retail here, where the gate itself refuses it). Null when no tier is deployable here.
   * For the operator view and the public status component, which compare a
   * (cached) balance with it; the gate itself always reads fresh.
   */
  async minimumDeployCreditsMicroUsd(): Promise<bigint | null> {
    let cheapest: bigint | null = null;
    for (const tier of Object.keys(MARKETS)) {
      let marketAddress: string;
      try {
        marketAddress = this.resolveMarketAddress(tier);
      } catch {
        continue; // not deployable on this network
      }
      const { costMicroUsdPerSecond } = await this.estimateCost(marketAddress);
      if (cheapest === null || costMicroUsdPerSecond < cheapest) cheapest = costMicroUsdPerSecond;
    }
    if (cheapest === null) return null;
    return requiredCreditsMicroUsd({
      costMicroUsdPerSecond: cheapest,
      replicas: 1,
      reserveSeconds: this.creditEstimateSeconds("service"),
      floorMicroUsd: getNosanaAccessConfig().minCreditsMicroUsd,
    });
  }

  /**
   * Per-replica cost of a market for a figure that ADMITS NOTHING: the
   * operator view, the public status minimum, the credits runway. The market
   * list is the source; when it is unreadable or does not price the market,
   * the tier's retail price stands in. Never use it to admit a deployment -
   * an unknown cost may be ABOVE retail; that is what admittingCost is for.
   */
  private async estimateCost(
    marketAddress: string,
    mode?: NosanaAccessMode,
  ): Promise<{
    costMicroUsdPerSecond: bigint;
    market: MarketCost | null;
    retailMicroUsdPerSecond: bigint | null;
  }> {
    let market: MarketCost | null = null;
    try {
      market = await this.marketCostReader(mode).costFor(marketAddress);
    } catch (err) {
      logger.warn(
        { error: (err as Error).message, marketAddress },
        "Nosana market list unreadable - estimating from the retail price"
      );
    }
    const retail = this.retailFor(marketAddress);
    if (market) {
      return { costMicroUsdPerSecond: market.costMicroUsdPerSecond, market, retailMicroUsdPerSecond: retail };
    }
    if (retail !== null) {
      return { costMicroUsdPerSecond: retail, market: null, retailMicroUsdPerSecond: retail };
    }
    throw new NosanaLifecycleError(
      `No cost is known for Nosana market ${marketAddress}; refusing to estimate`,
      "market_price",
      { code: "nosana_credits_unavailable" },
    );
  }

  private retailFor(marketAddress: string): bigint | null {
    const catalogEntry = Object.values(MARKETS).find((m) => m.address === marketAddress);
    return catalogEntry ? retailMicroUsdPerSecond(catalogEntry.pricePerSecond) : null;
  }

  /**
   * What one replica of an API-key market costs, for a decision that ADMITS a
   * deployment or extra replicas (pre-flight, create, scale-up). Fails CLOSED:
   * the cost comes from Nosana's market list, or from the last value seen for
   * that market within MARKET_COST_STALE_MAX_MS; with neither, nothing is
   * admitted (code gpu_cost_unavailable). Retail never stands in here - when
   * the cost cannot be read it may have risen above retail, and both the
   * below-cost guard and the credit estimate would pass on a guess.
   *
   * With `tier`, also refuses to sell below cost (code gpu_price_below_cost).
   */
  private async admittingCost(
    tier: string | null,
    marketAddress: string,
  ): Promise<{ costMicroUsdPerSecond: bigint; market: MarketCost }> {
    let market: MarketCost | null;
    let cause: unknown;
    try {
      market = await this.marketCostReader("api_key").costFor(marketAddress);
    } catch (err) {
      market = null;
      cause = err;
    }
    if (!market) {
      logger.error(
        {
          tier,
          marketAddress,
          reason: cause ? "market_list_unreadable" : "market_unpriced",
          ...(cause ? { error: (cause as Error).message } : {}),
        },
        "Nosana cost of a GPU market is unknown - nothing is admitted on it"
      );
      throw new NosanaLifecycleError(
        `The compute cost of Nosana market ${marketAddress} could not be confirmed`,
        "market_price",
        { code: "gpu_cost_unavailable", ...(cause ? { cause } : {}) },
      );
    }
    if (tier !== null) {
      this.assertRetailCoversCost(tier, {
        market,
        retailMicroUsdPerSecond: this.retailFor(marketAddress),
      });
    }
    return { costMicroUsdPerSecond: market.costMicroUsdPerSecond, market };
  }

  /** Refuses (API-key request path) to sell a tier below what Nosana charges for it. */
  private assertRetailCoversCost(
    tier: string,
    estimate: { market: MarketCost | null; retailMicroUsdPerSecond: bigint | null },
  ): void {
    const { market, retailMicroUsdPerSecond: retail } = estimate;
    if (!market || retail === null || retail >= market.costMicroUsdPerSecond) return;
    logger.error(
      {
        tier,
        retailMicroUsdPerSecond: retail.toString(),
        costMicroUsdPerSecond: market.costMicroUsdPerSecond.toString(),
      },
      "GPU tier is priced below its Nosana cost - deployment refused"
    );
    throw new NosanaLifecycleError(
      `GPU tier ${tier} is priced below its compute cost`,
      "market_price",
      { code: "gpu_price_below_cost" },
    );
  }

  private creditsFundingFor(): DeploymentFunding {
    return creditsFunding({
      getAvailableMicroUsd: async () =>
        (await this.creditReader().read({ fresh: true })).availableMicroUsd,
      getCachedAvailableMicroUsd: async () => (await this.creditReader().read()).availableMicroUsd,
      // The gate (create, scale-up) refuses on an unknown cost; the runway
      // figure admits nothing and may approximate.
      costMicroUsdPerSecond: async (marketAddress) =>
        (await this.admittingCost(null, marketAddress)).costMicroUsdPerSecond,
      runwayCostMicroUsdPerSecond: async (marketAddress) =>
        (await this.estimateCost(marketAddress, "api_key")).costMicroUsdPerSecond,
      minMicroUsd: getNosanaAccessConfig().minCreditsMicroUsd,
    });
  }

  private authFailed(cause: unknown): NosanaLifecycleError {
    return new NosanaLifecycleError("Nosana rejected the platform API key", "read", {
      code: "nosana_auth_failed",
      cause,
    });
  }

  /**
   * Names an authentication failure. The SDK cannot: a 401 body is the bare
   * string "Unauthorized", which its error formatter drops, leaving the same
   * message as any other failure. So when an API-key call fails, the credit
   * balance endpoint (whose HTTP status we do see) is asked once, and the
   * answer is remembered for NOSANA_CREDITS_CACHE_MS.
   */
  private async classifyApiError(err: unknown): Promise<unknown> {
    if (err instanceof NosanaLifecycleError) return err;
    if (/unauthori[sz]ed/i.test(err instanceof Error ? err.message : String(err))) {
      return this.authFailed(err);
    }
    const now = Date.now();
    const cacheMs = getNosanaAccessConfig().creditsCacheMs;
    if (this.authProbe === null || now - this.authProbe.at >= cacheMs) {
      let failed = false;
      try {
        await this.creditReader().read({ fresh: true });
      } catch (probeError) {
        failed = probeError instanceof NosanaCreditsError && probeError.code === "nosana_auth_failed";
      }
      this.authProbe = { at: now, failed };
    }
    return this.authProbe.failed ? this.authFailed(err) : err;
  }

  private async apiCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw await this.classifyApiError(err);
    }
  }

  private requireApiSdk(): ApiSdkLike {
    if (!this.apiSdk) throw new NosanaAccessModeUnavailableError("api_key");
    return this.apiSdk;
  }

  /**
   * Wraps an API-key SDK deployment. It has no vault. The SDK mutates its own
   * object after start/stop/scale, so status and replicas are read through.
   */
  private adaptApiDeployment(raw: unknown): SdkDeploymentLike {
    const sdkDeployment = raw as SdkDeploymentLike;
    const call = <T>(fn: () => Promise<T>) => this.apiCall(fn);
    return {
      get id() {
        return String(sdkDeployment.id);
      },
      get status() {
        return sdkDeployment.status;
      },
      get replicas() {
        return sdkDeployment.replicas;
      },
      get endpoints() {
        return sdkDeployment.endpoints;
      },
      get jobs() {
        return sdkDeployment.jobs;
      },
      get events() {
        return sdkDeployment.events;
      },
      start: () => call(() => sdkDeployment.start()),
      stop: () => call(() => sdkDeployment.stop()),
      updateReplicaCount: (replicas: number) =>
        call(() => sdkDeployment.updateReplicaCount(replicas)),
    };
  }

  /** The lifecycle port over the API-key client: same REST API, no chain reads. */
  private apiDeploymentsPort(): NosanaDeploymentsPort {
    const sdk = this.requireApiSdk();
    const unit = this.timeoutUnit();
    return {
      create: async (body: CreateDeploymentBody) =>
        this.adaptApiDeployment(
          await this.apiCall(() =>
            sdk.deployments.create({
              ...body,
              timeout: secondsToSdkTimeout(body.timeout, unit),
            }),
          ),
        ),
      get: async (id: string) =>
        this.adaptApiDeployment(await this.apiCall(() => sdk.deployments.get(id))),
      getMarketJobPrice: async () => {
        throw new Error("The on-chain market price is not used with API-key access");
      },
    };
  }

  /**
   * Market address for a tier on the network of `mode`'s deployments (omitted
   * = the primary credential's), or an honest error.
   */
  resolveMarketAddress(tier: string, mode?: NosanaAccessMode): string {
    return resolveMarketAddress(tier, this.networkFor(mode));
  }

  /**
   * Map a raw SDK Market onto ChainMarket. `jobPrice` is a u64 (an anchor BN at
   * runtime, typed `number` by the SDK) in NOS base units per second.
   */
  private mapSdkMarket(sdkMarket: {
    address?: unknown;
    jobPrice?: unknown;
    queue?: unknown;
  }): ChainMarket {
    const rawAddress = sdkMarket.address as { toBase58?: () => string } | string | undefined;
    const address =
      typeof rawAddress === "object" && rawAddress !== null && typeof rawAddress.toBase58 === "function"
        ? rawAddress.toBase58()
        : String(rawAddress ?? "");

    return {
      address,
      jobPriceNosBaseUnitsPerSecond: toBaseUnits(sdkMarket.jobPrice),
      queueLength: Array.isArray(sdkMarket.queue) ? sdkMarket.queue.length : 0,
    };
  }

  /**
   * Map a Nosana SDK Job state number to our status string.
   * Nosana job states: 0 = queued, 1 = running, 2 = completed, 3 = failed/stopped
   */
  private mapJobState(state: string | number): NosanaJob["status"] {
    const n = typeof state === "string" ? parseInt(state, 10) : state;
    switch (n) {
      case 0:
        return "queued";
      case 1:
        return "running";
      case 2:
        return "completed";
      default:
        return "failed";
    }
  }

  /** The lifecycle module's port, backed by the real SDK. */
  private deploymentsPort(): NosanaDeploymentsPort {
    const sdk = this.requireSdk();
    const unit = this.timeoutUnit();
    return {
      // `timeout` is seconds everywhere in our code; it becomes the Deployment
      // Manager's unit here and nowhere else (a no-op for "seconds").
      create: async (body: CreateDeploymentBody) =>
        (await sdk.deployments.create(
          { ...body, timeout: secondsToSdkTimeout(body.timeout, unit) } as unknown as Parameters<
            typeof sdk.deployments.create
          >[0]
        )) as unknown as SdkDeploymentLike,
      get: async (id: string) =>
        (await sdk.deployments.get(id)) as unknown as SdkDeploymentLike,
      getMarketJobPrice: async (marketAddress: string) => {
        const market = await sdk.jobs.getMarket(marketAddress);
        return toBaseUnits((market as { jobPrice?: unknown }).jobPrice);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Live chain read of every Nosana market. Prices are NOS base units per
   * second - a different unit from MARKETS[tier].pricePerSecond (USD), which is
   * why this returns its own type. THROWS on RPC failure: the static catalog is
   * pricing configuration, not a stand-in for chain state.
   */
  async getChainMarkets(): Promise<ChainMarket[]> {
    const sdk = this.requireSdk();
    const rawMarkets = await sdk.jobs.allMarkets();
    logger.debug({ count: rawMarkets.length }, "Fetched markets from chain");
    return rawMarkets.map((m) => this.mapSdkMarket(m as never));
  }

  /** On-chain job price (NOS base units / second) for one market. */
  async getMarketJobPrice(marketAddress: string): Promise<bigint> {
    return this.deploymentsPort().getMarketJobPrice(marketAddress);
  }

  /**
   * Get specific market by tier key. Static catalog (USD retail pricing, VRAM);
   * never queries chain individually to avoid latency on the hot path.
   */
  async getMarket(tier: string): Promise<NosanaMarket | null> {
    return Object.hasOwn(MARKETS, tier) ? (MARKETS[tier] ?? null) : null;
  }

  /** The platform wallet's address (public), or null when no wallet is loaded. */
  getWalletAddress(): string | null {
    return this.wallet ? this.wallet.publicKey.toBase58() : null;
  }

  /**
   * Get real NOS + SOL balance for the configured wallet.
   */
  async getWalletBalance(): Promise<{ sol: number; nos: number }> {
    this.requireWallet(); // guard: wallet must be configured
    const sdk = this.requireSdk();

    const [solLamports, nosToken] = await Promise.all([
      this.connection.getBalance(this.wallet!.publicKey),
      sdk.solana.getNosBalance(this.wallet!.publicKey).catch((err: unknown) => {
        logger.warn(
          { error: (err as Error).message },
          "Failed to fetch NOS balance - defaulting to 0"
        );
        return undefined;
      }),
    ]);

    return {
      sol: solLamports / 1e9,
      nos: nosToken ? Number(nosToken.uiAmount ?? 0) : 0,
    };
  }

  /**
   * Submit a single one-shot job to a Nosana market (legacy path, used by
   * OpenClaw). It has NO extend strategy: the job ends at
   * NOSANA_SINGLE_JOB_TIMEOUT_SECONDS. Long-running inference goes through
   * createDeployment.
   *
   * Flow:
   *  1. Resolve the market address for the tier on this network.
   *  2. Pin job definition to IPFS via the SDK (uses Pinata under the hood).
   *  3. Call nosana.jobs.list() to create the on-chain job listing.
   *  4. Return a NosanaJob with the on-chain job address as the ID.
   *
   * A failure is a failure. Only the dev-only mock (isNosanaMockEnabled) may
   * substitute a fake `mock_job_*` id, and it logs loudly when it does.
   */
  async submitJob(
    definition: NosanaJobDefinition,
    marketTier: string
  ): Promise<NosanaJob> {
    // Never guess which account pays: with API-key access as the primary mode
    // a one-shot job is refused, even when a wallet is also loaded.
    if (this.getAccessMode() === "api_key") throw new NosanaOneShotUnavailableError();
    this.requireWallet();
    const sdk = this.requireSdk();

    const market = await this.getMarket(marketTier);
    if (!market) {
      throw new MarketNotConfiguredError(marketTier, this.network, "unknown_tier");
    }
    const marketAddress = this.resolveMarketAddress(marketTier);

    logger.info(
      { market: market.name, jobType: definition.type },
      "Submitting job to Nosana"
    );

    try {
      // nosana.jobs.list() accepts a JobDefinition directly; it will pin to
      // IPFS internally and create the on-chain listing.
      const result = await sdk.jobs.list(
        definition as unknown as Parameters<typeof sdk.jobs.list>[0],
        getNosanaDeployConfig().singleJobTimeoutSeconds,
        marketAddress
      );

      // result is { tx, job, run } when instructionOnly is false (default)
      const { job: jobAddress } =
        result as { tx: string; job: string; run: string };

      logger.info({ jobId: jobAddress, market: market.name }, "Job listed on-chain");

      return {
        id: jobAddress,
        market: marketAddress,
        status: "queued",
        startTime: new Date(),
      };
    } catch (error) {
      if (!isNosanaMockEnabled()) {
        logger.error(
          { error: (error as Error).message, market: market.name },
          "Nosana job submission failed"
        );
        throw error;
      }
      logger.warn(
        { error: (error as Error).message, market: market.name, mock: true },
        "MOCK: SDK job submission failed - returning a FAKE mock_job id (ALLOW_NOSANA_MOCK, development only)"
      );

      return {
        id: `mock_job_${Date.now().toString(36)}`,
        market: marketAddress,
        status: "queued",
        startTime: new Date(),
      };
    }
  }

  /** Map a raw SDK job onto our NosanaJob shape. */
  private toNosanaJob(
    jobId: string,
    sdkJob: {
      node?: unknown;
      market?: { toBase58?: () => string };
      state: string | number;
      timeStart?: number | null;
      timeEnd?: number | null;
      price?: number | null;
    }
  ): NosanaJob {
    const nodeStr = sdkJob.node ? String(sdkJob.node) : "";
    const hasRealNode = nodeStr && nodeStr !== SYSTEM_PROGRAM_ZERO_PUBKEY;
    const nodeUrl = hasRealNode ? `https://${nodeStr}.node.nos.ci` : undefined;
    const nodePubkey = hasRealNode ? nodeStr : undefined;

    return {
      id: jobId,
      market: sdkJob.market?.toBase58?.() ?? "",
      status: this.mapJobState(sdkJob.state),
      nodeUrl,
      nodePubkey,
      startTime: sdkJob.timeStart
        ? new Date(sdkJob.timeStart * 1000)
        : undefined,
      endTime: sdkJob.timeEnd
        ? new Date(sdkJob.timeEnd * 1000)
        : undefined,
      cost: sdkJob.price ? sdkJob.price / 1e6 : undefined,
    };
  }

  /**
   * Query on-chain job status for a given ON-CHAIN JOB address (not a
   * Deployment-Manager id - use getDeploymentStatus for those).
   * Falls back to a "running" stub if the RPC call fails.
   */
  async getJobStatus(jobId: string): Promise<NosanaJob | null> {
    const sdk = this.requireSdk();

    logger.debug({ jobId }, "Getting job status");

    // Mock IDs (created by the dev-only fallback) cannot be queried on-chain
    if (jobId.startsWith("mock_job_")) {
      return {
        id: jobId,
        market: "",
        status: "running",
        startTime: new Date(),
      };
    }

    try {
      const sdkJob = await sdk.jobs.get(jobId);
      return this.toNosanaJob(jobId, sdkJob);
    } catch (error) {
      logger.warn(
        { jobId, error: (error as Error).message },
        "Failed to fetch job from chain - returning stub"
      );

      return {
        id: jobId,
        market: "",
        status: "running",
        startTime: new Date(),
      };
    }
  }

  /**
   * Strict on-chain job read: THROWS on SDK/RPC failure instead of returning a
   * "running" stub. Mock IDs also throw - mock handling is env-gated at the
   * tick layer, not here.
   *
   * NOTE: takes an on-chain job address. Deployment-Manager ids (what
   * `Deployment.nosanaJobIds` holds) are NOT job addresses and make
   * `jobs.get` throw; use getDeploymentStatus for those.
   */
  async getJobStatusStrict(jobId: string): Promise<NosanaJob> {
    const sdk = this.requireSdk();

    if (isMockNosanaId(jobId)) {
      throw new Error(`Mock Nosana id cannot be queried on-chain: ${jobId}`);
    }

    const sdkJob = await sdk.jobs.get(jobId);
    return this.toNosanaJob(jobId, sdkJob);
  }

  private mockDeployment(
    marketAddress: string,
    replicas: number,
    reason: string
  ): NosanaDeployment {
    logger.warn(
      { reason, mock: true },
      "MOCK: returning a FAKE mock_deploy id - nothing is running on Nosana (ALLOW_NOSANA_MOCK, development only)"
    );
    return {
      id: `mock_deploy_${Date.now().toString(36)}`,
      market: marketAddress,
      replicas,
      status: "active",
      endpoints: [],
      mock: true,
    };
  }

  /**
   * Create, FUND and START a deployment via the Nosana Deployment Manager.
   *
   * `sdk.deployments.create()` alone yields a DRAFT with an empty vault - no GPU
   * host would ever run it. The lifecycle (nosanaDeploymentLifecycle.ts) tops the
   * vault up with NOS + SOL and calls start(); on any failure after creation it
   * stops and withdraws so platform funds are not stranded, then throws a
   * NosanaLifecycleError carrying the Nosana deployment id for the caller to
   * persist.
   *
   * With API-key access there is no vault: the credit gate runs first, then
   * create and start. The result names the access mode that was used.
   */
  async createDeployment(
    definition: NosanaJobDefinition,
    marketTier: string,
    replicas: number,
    options: CreateDeploymentOptions = {}
  ): Promise<NosanaDeployment> {
    const mockEnabled = isNosanaMockEnabled();

    if (this.getAccessMode() === "none") {
      if (mockEnabled) return this.mockDeployment("", replicas, "no wallet configured");
      throw new NosanaNotConfiguredError();
    }
    const access = this.accessFor();

    const market = await this.getMarket(marketTier);
    if (!market) {
      throw new MarketNotConfiguredError(marketTier, this.getNetwork(), "unknown_tier");
    }

    let marketAddress: string;
    try {
      marketAddress = this.resolveMarketAddress(marketTier);
    } catch (error) {
      if (mockEnabled && error instanceof MarketNotConfiguredError) {
        return this.mockDeployment("", replicas, error.message);
      }
      throw error;
    }

    const cfg = getNosanaDeployConfig();
    const batch = options.kind === "batch";
    const kind = batch ? "batch" : "service";
    const jobTimeoutSeconds = this.jobTimeoutFor(kind, options.timeoutSeconds);
    // Wallet: seconds of run-time the vault is funded for. API key: seconds the
    // credit estimate covers. A per-call timeout never funds less than itself.
    const fundSeconds =
      access.mode === "api_key"
        ? this.creditEstimateSeconds(kind, options.timeoutSeconds)
        : batch
          ? jobTimeoutSeconds
          : Math.max(cfg.vaultFundSeconds, jobTimeoutSeconds);

    logger.info(
      { market: market.name, replicas, kind: options.kind ?? "service", jobTimeoutSeconds },
      "Creating Nosana deployment"
    );

    try {
      if (access.mode === "api_key") await this.admittingCost(marketTier, marketAddress);
      const created = await createAndStartDeployment(
        access.port,
        {
          name: options.name ?? `${NOSANA_DEPLOYMENT_NAME_PREFIX}${Date.now().toString(36)}`,
          marketAddress,
          replicas,
          jobTimeoutSeconds,
          definition,
          fundSeconds,
          strategy: batch ? "SIMPLE" : cfg.strategy,
          solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
          networkFeeBps: cfg.networkFeeBps,
        },
        access.funding,
      );

      logger.info(
        {
          deploymentId: created.deploymentId,
          replicas,
          strategy: created.strategy,
          accessMode: access.mode,
          fundedNosBaseUnits: created.funding?.nosBaseUnits.toString(),
          fundedSolLamports: created.funding?.solLamports.toString(),
          estimateMicroUsd: created.estimateMicroUsd?.toString(),
        },
        "Nosana deployment created, funded and started"
      );

      return {
        id: created.deploymentId,
        market: marketAddress,
        replicas,
        status: "active",
        endpoints: [],
        vaultAddress: created.vaultAddress,
        accessMode: access.mode,
      };
    } catch (error) {
      if (error instanceof NosanaLifecycleError) error.accessMode = access.mode;
      if (!mockEnabled) {
        logger.error(
          {
            error: (error as Error).message,
            market: market.name,
            replicas,
            deploymentId: (error as { deploymentId?: string }).deploymentId,
            deploymentName: (error as { deploymentName?: string }).deploymentName,
            mayExistOnNosana: (error as { mayExistOnNosana?: boolean }).mayExistOnNosana,
          },
          "Nosana deployment creation failed"
        );
        throw error;
      }
      return this.mockDeployment(marketAddress, replicas, (error as Error).message);
    }
  }

  /**
   * STRICT read of a Deployment-Manager deployment: status, REAL endpoints
   * reported by Nosana, jobs and events. Throws on API failure (and on mock
   * ids) - a failed read must never become a fabricated state.
   */
  async getDeploymentStatus(
    deploymentId: string,
    mode?: NosanaAccessMode
  ): Promise<DeploymentSnapshot> {
    if (isMockNosanaId(deploymentId)) {
      this.requireSdk();
      throw new Error(`Mock Nosana id cannot be queried: ${deploymentId}`);
    }
    return readDeployment(this.readPort(mode), deploymentId);
  }

  /**
   * The port for a read. With no credential at all, the wallet client's
   * keyless read stays available, as it always was (whatever mode is named).
   */
  private readPort(mode?: NosanaAccessMode): NosanaDeploymentsPort {
    if (this.getAccessMode() === "none") {
      this.requireSdk();
      return this.deploymentsPort();
    }
    return this.accessFor(mode).port;
  }

  /** The raw SDK deployment object, for the actions the lifecycle port does not carry. */
  private async rawDeployment(
    deploymentId: string,
    mode?: NosanaAccessMode
  ): Promise<{ access: NosanaAccess; deployment: Record<string, unknown> }> {
    const access = this.accessFor(mode);
    const deployment =
      access.mode === "api_key"
        ? await this.apiCall(() => this.requireApiSdk().deployments.get(deploymentId))
        : await this.requireSdk().deployments.get(deploymentId);
    return { access, deployment: deployment as unknown as Record<string, unknown> };
  }

  /**
   * Nosana's own list of this account's deployments (read-only). With an API
   * key it is a direct GET: the SDK's list() parses every `owner` as a Solana
   * public key and throws for the whole list if one is not.
   */
  async listDeployments(mode?: NosanaAccessMode): Promise<NosanaDeploymentSummary[]> {
    const access = this.accessFor(mode);
    let rows: unknown;
    if (access.mode === "api_key") {
      const { apiKey, backendUrl } = this.requireApiAccess();
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.fetcher(`${backendUrl}/api/deployments`, {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
      } catch (err) {
        throw new NosanaLifecycleError("Nosana's deployment list could not be fetched", "read", {
          cause: err,
        });
      }
      if (response.status === 401 || response.status === 403) throw this.authFailed(undefined);
      if (!response.ok) {
        throw new NosanaLifecycleError(
          `Nosana's deployment list answered HTTP ${response.status}`,
          "read",
        );
      }
      rows = await response.json().catch(() => null);
    } else {
      const sdk = this.requireSdk() as unknown as { deployments: { list(): Promise<unknown[]> } };
      try {
        rows = await sdk.deployments.list();
      } catch (err) {
        throw new NosanaLifecycleError(
          `Nosana's deployment list could not be read: ${(err as Error).message}`,
          "read",
          { cause: err },
        );
      }
    }
    if (!Array.isArray(rows)) {
      throw new NosanaLifecycleError("Nosana's deployment list is not an array", "read");
    }
    return rows
      .map((row) => toDeploymentSummary(row, access.mode))
      .filter((row): row is NosanaDeploymentSummary => row !== null);
  }

  /**
   * The deployment with exactly this name, newest first when Nosana holds
   * several; null when there is none. This is how a deployment whose create
   * call threw (NosanaLifecycleError.mayExistOnNosana) is looked for.
   */
  async findDeploymentByName(
    name: string,
    mode?: NosanaAccessMode
  ): Promise<NosanaDeploymentSummary | null> {
    const matches = (await this.listDeployments(mode))
      .filter((row) => row.name === name)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    return matches[0] ?? null;
  }

  /**
   * One job of a deployment (state, host node, start/end), via the SDK's
   * deployment.getJob. The state arrives as a number or a string and the time
   * fields have no documented unit: see DeploymentJobSnapshot.
   */
  async getDeploymentJob(
    deploymentId: string,
    jobAddress: string,
    mode?: NosanaAccessMode
  ): Promise<DeploymentJobSnapshot> {
    if (isMockNosanaId(deploymentId)) {
      throw new Error(`Mock Nosana id cannot be queried: ${deploymentId}`);
    }
    const { access, deployment } = await this.rawDeployment(deploymentId, mode);
    const getJob = deployment.getJob as ((job: string) => Promise<unknown>) | undefined;
    if (typeof getJob !== "function") {
      throw new NosanaLifecycleError(
        `Nosana deployment ${deploymentId} does not expose its jobs`,
        "read",
        { deploymentId },
      );
    }
    let raw: unknown;
    try {
      raw =
        access.mode === "api_key"
          ? await this.apiCall(() => getJob(jobAddress))
          : await getJob(jobAddress);
    } catch (err) {
      if (err instanceof NosanaLifecycleError) throw err;
      throw new NosanaLifecycleError(
        `Could not read job ${jobAddress} of Nosana deployment ${deploymentId}: ${(err as Error).message}`,
        "read",
        { deploymentId, cause: err },
      );
    }
    return normalizeDeploymentJob(deploymentId, jobAddress, raw);
  }

  /**
   * Change a deployment's per-job timeout. `timeoutSeconds` is ours (seconds);
   * the Deployment Manager is sent the value in NOSANA_TIMEOUT_UNIT, rounded
   * up. The SDK refuses a value below 60 in whatever unit that is, so in
   * "minutes" nothing under one hour can be set this way.
   */
  async updateDeploymentTimeout(
    deploymentId: string,
    timeoutSeconds: number,
    mode?: NosanaAccessMode
  ): Promise<{ deploymentId: string; timeoutSeconds: number; sentTimeout: number; unit: NosanaTimeoutUnit }> {
    const unit = this.timeoutUnit();
    const sentTimeout = secondsToSdkTimeout(timeoutSeconds, unit);
    if (sentTimeout < SDK_MIN_UPDATE_TIMEOUT) {
      throw new NosanaLifecycleError(
        `A timeout of ${timeoutSeconds}s is ${sentTimeout} ${unit}; the Nosana SDK refuses an update below ${SDK_MIN_UPDATE_TIMEOUT}`,
        "scale",
        { deploymentId, code: "nosana_timeout_too_short" },
      );
    }
    const { access, deployment } = await this.rawDeployment(deploymentId, mode);
    const updateTimeout = (deployment.updateTimeout as (timeout: number) => Promise<void>).bind(deployment);
    try {
      if (access.mode === "api_key") await this.apiCall(() => updateTimeout(sentTimeout));
      else await updateTimeout(sentTimeout);
    } catch (err) {
      if (err instanceof NosanaLifecycleError) throw err;
      throw new NosanaLifecycleError(
        `Updating the timeout of Nosana deployment ${deploymentId} failed: ${(err as Error).message}`,
        "scale",
        { deploymentId, cause: err },
      );
    }
    return { deploymentId, timeoutSeconds, sentTimeout, unit };
  }

  /**
   * Stop a deployment and try to reclaim its vault. Throws if the stop did not
   * take effect; `reclaimed: false` means the withdraw must be retried later
   * (reclaimDeploymentVault).
   */
  async stopDeployment(
    deploymentId: string,
    mode?: NosanaAccessMode
  ): Promise<StopAndReclaimResult> {
    const access = this.accessForId(deploymentId, mode);

    logger.info({ deploymentId }, "Stopping deployment");

    if (isMockNosanaId(deploymentId)) {
      logger.debug({ deploymentId, mock: true }, "Mock deployment - stop is a no-op");
      return {
        deploymentId,
        stopped: true,
        alreadyStopped: false,
        reclaimed: true,
        remainingNosBaseUnits: 0n,
      };
    }

    const result = await stopAndReclaim(access!.port, deploymentId, access!.funding);
    logger.info(
      { deploymentId, reclaimed: result.reclaimed, alreadyStopped: result.alreadyStopped },
      "Deployment stopped via Nosana SDK"
    );
    return result;
  }

  /**
   * Retry the vault withdraw for a stopped/failed deployment. With API-key
   * access there is nothing to withdraw: `reclaimed` means Nosana is no longer
   * running the deployment and will not schedule more work for it.
   */
  async reclaimDeploymentVault(
    deploymentId: string,
    mode?: NosanaAccessMode
  ): Promise<ReclaimResult> {
    const access = this.accessForId(deploymentId, mode);
    if (isMockNosanaId(deploymentId)) {
      return {
        deploymentId,
        state: "stopped",
        reclaimed: true,
        remainingNosBaseUnits: 0n,
      };
    }
    return reclaimVault(access!.port, deploymentId, access!.funding);
  }

  /**
   * Scale a RUNNING deployment to a new replica count. Extra replicas are funded
   * before the count changes. Throws NosanaLifecycleError(code
   * "nosana_not_running") when the deployment is not running.
   */
  async scaleDeployment(
    deploymentId: string,
    newReplicas: number,
    marketTier: string,
    mode?: NosanaAccessMode
  ): Promise<ScaleResult> {
    const access = this.accessForId(deploymentId, mode);

    logger.info({ deploymentId, newReplicas }, "Scaling deployment");

    if (isMockNosanaId(deploymentId)) {
      return { deploymentId, previousReplicas: newReplicas, replicas: newReplicas, funded: null };
    }

    const cfg = getNosanaDeployConfig();
    return scaleDeployment(
      access!.port,
      deploymentId,
      newReplicas,
      {
        marketAddress: this.resolveMarketAddress(marketTier, access!.mode),
        fundSeconds:
          access!.mode === "api_key" ? this.creditEstimateSeconds("service") : cfg.vaultFundSeconds,
        solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
        networkFeeBps: cfg.networkFeeBps,
      },
      access!.funding,
    );
  }

  /**
   * Refill the vault of a running deployment so its next extension is funded.
   * With API-key access nothing is ever topped up: the result carries reason
   * "credits" and the seconds the shared balance would cover.
   */
  async ensureDeploymentRunway(
    deploymentId: string,
    marketTier: string,
    replicas: number,
    mode?: NosanaAccessMode
  ): Promise<RunwayResult> {
    const access = this.accessFor(mode);
    const cfg = getNosanaDeployConfig();
    return ensureVaultRunway(
      access.port,
      deploymentId,
      {
        marketAddress: this.resolveMarketAddress(marketTier, access.mode),
        replicas,
        minRunwaySeconds: cfg.vaultMinRunwaySeconds,
        fundSeconds: cfg.vaultFundSeconds,
        solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
        networkFeeBps: cfg.networkFeeBps,
      },
      access.funding,
    );
  }

  /**
   * Probe a node's readiness over HTTP. The path depends on the engine: vLLM
   * serves /health, Ollama does not (it serves /api/tags). The URL is checked
   * against the SSRF allowlist first; a disallowed URL is simply unhealthy.
   * Never throws.
   */
  async checkNodeHealth(
    nodeUrl: string,
    engine?: string
  ): Promise<{ healthy: boolean; latencyMs: number }> {
    const startTime = Date.now();

    if (!isAllowedNodeUrl(nodeUrl, nodeUrlAllowlistOptions())) {
      logger.warn({ nodeUrl }, "Refusing to probe a node URL outside the allowlist");
      return { healthy: false, latencyMs: 0 };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`${nodeUrl}${nodeHealthPath(engine)}`, {
          signal: controller.signal,
          // Never follow a redirect off the allowlisted host.
          redirect: "manual",
        });
        return {
          healthy: response.ok,
          latencyMs: Date.now() - startTime,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return {
        healthy: false,
        latencyMs: Date.now() - startTime,
      };
    }
  }
}

// ============================================
// Singleton Instance
// ============================================

let nosanaClient: NosanaClient | null = null;

export async function getNosanaClient(): Promise<NosanaClient> {
  if (!nosanaClient) {
    nosanaClient = new NosanaClient();
    await nosanaClient.initialize();
  }
  return nosanaClient;
}

// ============================================
// Job Definition Generator
// ============================================

export interface ModelDeploymentConfig {
  modelId: string;
  hfModelId: string;
  engine: "vllm" | "ollama";
  maxTokens: number;
  gpuMemoryUtilization: number;
  quantization?: string;
  /**
   * Hugging Face token for gated models. Only ever set on jobs created with
   * `confidential: true` (createDeployment always does), because Nosana pins
   * non-confidential job definitions to PUBLIC IPFS. Omitted => no HF_TOKEN.
   */
  hfToken?: string;
}

/** The vLLM image every deployment ran on before tool calling was wired. */
const VLLM_IMAGE = "vllm/vllm-openai:v0.6.0";

interface VllmToolCalling {
  /** vLLM's --tool-call-parser value for this model family. */
  parser: "hermes" | "mistral" | "llama3_json";
  /** The oldest pinned image whose server has that parser. */
  image: string;
}

/**
 * Model families vLLM can parse tool calls for, by Hugging Face id prefix.
 * `hermes` and `mistral` shipped with automatic tool choice in v0.6.0;
 * `llama3_json` came later, so those models run a newer pinned image and
 * every other model stays on the image it has always run on.
 *
 * Deliberately short: a parser pointed at a model whose chat template has no
 * tool section yields malformed calls, which is worse than the server's own
 * "tool choice is not enabled" answer.
 */
const VLLM_TOOL_CALLING: ReadonlyArray<{ prefix: string } & VllmToolCalling> = [
  { prefix: "meta-llama/Meta-Llama-3.1-", parser: "llama3_json", image: "vllm/vllm-openai:v0.6.3" },
  { prefix: "meta-llama/Llama-3.2-", parser: "llama3_json", image: "vllm/vllm-openai:v0.6.3" },
  { prefix: "mistralai/Mistral-7B-Instruct-v0.3", parser: "mistral", image: VLLM_IMAGE },
  { prefix: "Qwen/Qwen2.5-", parser: "hermes", image: VLLM_IMAGE },
];

/**
 * How vLLM is started so `tool_choice: "auto"` works for this model, or null
 * when the model has no parser. Without one, a request with `tools` still
 * reaches the model server, which answers 400 for "auto" - passed through to
 * the caller as it is (routes/inference.ts).
 */
export function vllmToolCalling(hfModelId: string): VllmToolCalling | null {
  const match = VLLM_TOOL_CALLING.find((entry) => hfModelId.startsWith(entry.prefix));
  return match ? { parser: match.parser, image: match.image } : null;
}

export function generateVllmJobDefinition(
  config: ModelDeploymentConfig
): NosanaJobDefinition {
  const vllmArgs = [
    "--model",
    config.hfModelId,
    "--host",
    "0.0.0.0",
    "--port",
    "8000",
    "--max-model-len",
    config.maxTokens.toString(),
    "--gpu-memory-utilization",
    config.gpuMemoryUtilization.toString(),
  ];

  if (config.quantization) {
    vllmArgs.push("--quantization", config.quantization);
  }

  // Function calling on /v1: the model decides when to call a tool
  // (tool_choice "auto"), and vLLM turns its output into `tool_calls`.
  const toolCalling = vllmToolCalling(config.hfModelId);
  if (toolCalling) {
    vllmArgs.push("--enable-auto-tool-choice", "--tool-call-parser", toolCalling.parser);
  }

  return {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "wheelsai",
    },
    ops: [
      {
        type: "container/run",
        id: "vllm-inference",
        args: {
          image: toolCalling?.image ?? VLLM_IMAGE,
          cmd: vllmArgs,
          gpu: true,
          expose: [8000],
          // The old literal "${HF_TOKEN}" was never substituted by anything, so
          // gated models were handed that string as their token. Real token or
          // nothing.
          ...(config.hfToken ? { env: { HF_TOKEN: config.hfToken } } : {}),
        },
      },
    ],
  };
}

export function generateOllamaJobDefinition(
  config: ModelDeploymentConfig
): NosanaJobDefinition {
  // Map HF model ID to Ollama model name
  const ollamaModel = mapToOllamaModel(config.hfModelId);

  return {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "wheelsai",
    },
    ops: [
      {
        type: "container/run",
        id: "ollama-inference",
        args: {
          image: "ollama/ollama:latest",
          // Start Ollama, pull model, then keep serving
          cmd: [
            "/bin/sh",
            "-c",
            `ollama serve & sleep 5 && ollama pull ${ollamaModel} && wait`,
          ],
          gpu: true,
          expose: [11434],
          env: {
            OLLAMA_HOST: "0.0.0.0:11434",
            OLLAMA_NUM_CTX: config.maxTokens.toString(),
            OLLAMA_NUM_GPU: "999", // Use all available GPU layers
            OLLAMA_KEEP_ALIVE: "24h", // Keep model loaded
          },
        },
      },
    ],
  };
}

/**
 * Generate Ollama job with OpenAI-compatible proxy
 * This uses a sidecar container to provide /v1/chat/completions endpoint
 */
export function generateOllamaWithProxyJobDefinition(
  config: ModelDeploymentConfig
): NosanaJobDefinition {
  const ollamaModel = mapToOllamaModel(config.hfModelId);

  return {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "wheelsai",
    },
    ops: [
      {
        type: "container/run",
        id: "ollama-server",
        args: {
          image: "ollama/ollama:latest",
          cmd: [
            "/bin/sh",
            "-c",
            `ollama serve & sleep 5 && ollama pull ${ollamaModel} && wait`,
          ],
          gpu: true,
          expose: [11434],
          env: {
            OLLAMA_HOST: "0.0.0.0:11434",
            OLLAMA_NUM_CTX: config.maxTokens.toString(),
            OLLAMA_NUM_GPU: "999",
            OLLAMA_KEEP_ALIVE: "24h",
          },
        },
      },
      {
        type: "container/run",
        id: "openai-proxy",
        args: {
          image: "ghcr.io/wheelsai/ollama-openai-proxy:latest",
          cmd: [
            "--ollama-host", "http://localhost:11434",
            "--model", ollamaModel,
            "--port", "8000",
          ],
          expose: [8000],
          env: {
            OLLAMA_BASE_URL: "http://localhost:11434",
            DEFAULT_MODEL: ollamaModel,
          },
        },
      },
    ],
  };
}

/**
 * The model name the engine of a deployment answers to: the HF id on vLLM
 * (started without --served-model-name), the pulled tag on Ollama. The /v1
 * proxy rewrites a request's `model` to this.
 */
export function servedModelName(engine: string | null | undefined, hfModelId: string): string {
  return engine === "ollama" ? mapToOllamaModel(hfModelId) : hfModelId;
}

function mapToOllamaModel(hfModelId: string): string {
  // Map common HuggingFace model IDs to Ollama equivalents
  const mapping: Record<string, string> = {
    // Llama 3.1 family
    "meta-llama/Meta-Llama-3.1-8B-Instruct": "llama3.1:8b",
    "meta-llama/Meta-Llama-3.1-70B-Instruct": "llama3.1:70b",
    "meta-llama/Meta-Llama-3.1-405B-Instruct": "llama3.1:405b",
    // Llama 3.2 family
    "meta-llama/Llama-3.2-1B-Instruct": "llama3.2:1b",
    "meta-llama/Llama-3.2-3B-Instruct": "llama3.2:3b",
    // Mistral family
    "mistralai/Mistral-7B-Instruct-v0.2": "mistral:7b",
    "mistralai/Mistral-7B-Instruct-v0.3": "mistral:7b",
    "mistralai/Mixtral-8x7B-Instruct-v0.1": "mixtral:8x7b",
    "mistralai/Mixtral-8x22B-Instruct-v0.1": "mixtral:8x22b",
    // Qwen family
    "Qwen/Qwen2-7B-Instruct": "qwen2:7b",
    "Qwen/Qwen2-72B-Instruct": "qwen2:72b",
    "Qwen/Qwen2.5-7B-Instruct": "qwen2.5:7b",
    "Qwen/Qwen2.5-14B-Instruct": "qwen2.5:14b",
    "Qwen/Qwen2.5-32B-Instruct": "qwen2.5:32b",
    "Qwen/Qwen2.5-72B-Instruct": "qwen2.5:72b",
    // Phi family
    "microsoft/Phi-3-mini-4k-instruct": "phi3:mini",
    "microsoft/Phi-3-medium-4k-instruct": "phi3:medium",
    "microsoft/Phi-3.5-mini-instruct": "phi3.5:mini",
    // Gemma family
    "google/gemma-2-2b-it": "gemma2:2b",
    "google/gemma-2-9b-it": "gemma2:9b",
    "google/gemma-2-27b-it": "gemma2:27b",
    // Code models
    "Qwen/Qwen2.5-Coder-7B-Instruct": "qwen2.5-coder:7b",
    "deepseek-ai/deepseek-coder-6.7b-instruct": "deepseek-coder:6.7b",
    "codellama/CodeLlama-7b-Instruct-hf": "codellama:7b",
    "codellama/CodeLlama-34b-Instruct-hf": "codellama:34b",
  };

  return mapping[hfModelId] ?? hfModelId.split("/").pop() ?? hfModelId;
}

/**
 * Check if a model is available in Ollama
 */
export function isOllamaSupported(hfModelId: string): boolean {
  const ollamaModels = [
    // Llama family
    "meta-llama/Meta-Llama-3.1-8B-Instruct",
    "meta-llama/Meta-Llama-3.1-70B-Instruct",
    "meta-llama/Llama-3.2-1B-Instruct",
    "meta-llama/Llama-3.2-3B-Instruct",
    // Mistral family
    "mistralai/Mistral-7B-Instruct-v0.2",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "mistralai/Mixtral-8x7B-Instruct-v0.1",
    // Qwen family
    "Qwen/Qwen2-7B-Instruct",
    "Qwen/Qwen2.5-7B-Instruct",
    "Qwen/Qwen2.5-14B-Instruct",
    "Qwen/Qwen2.5-32B-Instruct",
    "Qwen/Qwen2.5-72B-Instruct",
    // Phi family
    "microsoft/Phi-3-mini-4k-instruct",
    "microsoft/Phi-3-medium-4k-instruct",
    "microsoft/Phi-3.5-mini-instruct",
    // Gemma family
    "google/gemma-2-2b-it",
    "google/gemma-2-9b-it",
    "google/gemma-2-27b-it",
    // Code models
    "Qwen/Qwen2.5-Coder-7B-Instruct",
    "deepseek-ai/deepseek-coder-6.7b-instruct",
    "codellama/CodeLlama-7b-Instruct-hf",
  ];

  return ollamaModels.includes(hfModelId);
}

export function generateJobDefinition(
  config: ModelDeploymentConfig
): NosanaJobDefinition {
  switch (config.engine) {
    case "vllm":
      return generateVllmJobDefinition(config);
    case "ollama":
      return generateOllamaJobDefinition(config);
    default:
      throw new Error(`Unsupported engine: ${config.engine}`);
  }
}
