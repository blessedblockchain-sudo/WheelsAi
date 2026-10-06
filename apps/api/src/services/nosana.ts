import { Connection, Keypair } from "@solana/web3.js";
import { Client } from "@nosana/sdk";
import { env } from "../config/env.js";
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
  createAndStartDeployment,
  ensureVaultRunway,
  readDeployment,
  reclaimVault,
  scaleDeployment,
  stopAndReclaim,
  toBaseUnits,
  type CreateDeploymentBody,
  type DeploymentSnapshot,
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
  /** Vault holding the platform's funding for this deployment. */
  vaultAddress?: string;
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
  name?: string;
}

/** Thrown when Nosana deployments are requested but no platform wallet exists. */
export class NosanaNotConfiguredError extends Error {
  readonly code = "nosana_not_configured";
  constructor(message = "Nosana deployments are not configured: NOSANA_WALLET_PRIVATE_KEY is not set") {
    super(message);
    this.name = "NosanaNotConfiguredError";
  }
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

    logger.info(
      { network: this.network, ipfsConfigured: !!ipfsConfig },
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

  /** True when a platform wallet is loaded (deploys can be funded). */
  isConfigured(): boolean {
    return this.wallet !== null;
  }

  getNetwork(): NosanaNetwork {
    return this.network;
  }

  /**
   * Pre-flight for routes: throws NosanaNotConfiguredError /
   * MarketNotConfiguredError so an unconfigured platform answers 501 BEFORE any
   * credits are reserved. The dev-only mock passes (it never touches Nosana).
   */
  assertCanDeploy(tier: string): void {
    if (isNosanaMockEnabled()) return;
    if (!this.wallet) throw new NosanaNotConfiguredError();
    resolveMarketAddress(tier, this.network);
  }

  /** Market address for a tier on this client's network, or an honest error. */
  resolveMarketAddress(tier: string): string {
    return resolveMarketAddress(tier, this.network);
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
    return {
      create: async (body: CreateDeploymentBody) =>
        (await sdk.deployments.create(
          body as unknown as Parameters<typeof sdk.deployments.create>[0]
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
   */
  async createDeployment(
    definition: NosanaJobDefinition,
    marketTier: string,
    replicas: number,
    options: CreateDeploymentOptions = {}
  ): Promise<NosanaDeployment> {
    const mockEnabled = isNosanaMockEnabled();

    if (!this.wallet) {
      if (mockEnabled) return this.mockDeployment("", replicas, "no wallet configured");
      throw new NosanaNotConfiguredError();
    }
    this.requireSdk();

    const market = await this.getMarket(marketTier);
    if (!market) {
      throw new MarketNotConfiguredError(marketTier, this.network, "unknown_tier");
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
    const jobTimeoutSeconds = batch ? cfg.batchJobTimeoutSeconds : cfg.jobTimeoutSeconds;

    logger.info(
      { market: market.name, replicas, kind: options.kind ?? "service", jobTimeoutSeconds },
      "Creating Nosana deployment"
    );

    try {
      const created = await createAndStartDeployment(this.deploymentsPort(), {
        name: options.name ?? `wheelsai-${Date.now().toString(36)}`,
        marketAddress,
        replicas,
        jobTimeoutSeconds,
        definition,
        fundSeconds: batch ? jobTimeoutSeconds : cfg.vaultFundSeconds,
        strategy: batch ? "SIMPLE" : cfg.strategy,
        solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
        networkFeeBps: cfg.networkFeeBps,
      });

      logger.info(
        {
          deploymentId: created.deploymentId,
          replicas,
          strategy: created.strategy,
          fundedNosBaseUnits: created.funding.nosBaseUnits.toString(),
          fundedSolLamports: created.funding.solLamports.toString(),
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
      };
    } catch (error) {
      if (!mockEnabled) {
        logger.error(
          {
            error: (error as Error).message,
            market: market.name,
            replicas,
            deploymentId: (error as { deploymentId?: string }).deploymentId,
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
  async getDeploymentStatus(deploymentId: string): Promise<DeploymentSnapshot> {
    this.requireSdk();
    if (isMockNosanaId(deploymentId)) {
      throw new Error(`Mock Nosana id cannot be queried: ${deploymentId}`);
    }
    return readDeployment(this.deploymentsPort(), deploymentId);
  }

  /**
   * Stop a deployment and try to reclaim its vault. Throws if the stop did not
   * take effect; `reclaimed: false` means the withdraw must be retried later
   * (reclaimDeploymentVault).
   */
  async stopDeployment(deploymentId: string): Promise<StopAndReclaimResult> {
    this.requireWallet();
    this.requireSdk();

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

    const result = await stopAndReclaim(this.deploymentsPort(), deploymentId);
    logger.info(
      { deploymentId, reclaimed: result.reclaimed, alreadyStopped: result.alreadyStopped },
      "Deployment stopped via Nosana SDK"
    );
    return result;
  }

  /** Retry the vault withdraw for a stopped/failed deployment. */
  async reclaimDeploymentVault(deploymentId: string): Promise<ReclaimResult> {
    this.requireWallet();
    this.requireSdk();
    if (isMockNosanaId(deploymentId)) {
      return {
        deploymentId,
        state: "stopped",
        reclaimed: true,
        remainingNosBaseUnits: 0n,
      };
    }
    return reclaimVault(this.deploymentsPort(), deploymentId);
  }

  /**
   * Scale a RUNNING deployment to a new replica count. Extra replicas are funded
   * before the count changes. Throws NosanaLifecycleError(code
   * "nosana_not_running") when the deployment is not running.
   */
  async scaleDeployment(
    deploymentId: string,
    newReplicas: number,
    marketTier: string
  ): Promise<ScaleResult> {
    this.requireWallet();
    this.requireSdk();

    logger.info({ deploymentId, newReplicas }, "Scaling deployment");

    if (isMockNosanaId(deploymentId)) {
      return { deploymentId, previousReplicas: newReplicas, replicas: newReplicas, funded: null };
    }

    const cfg = getNosanaDeployConfig();
    return scaleDeployment(this.deploymentsPort(), deploymentId, newReplicas, {
      marketAddress: this.resolveMarketAddress(marketTier),
      fundSeconds: cfg.vaultFundSeconds,
      solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
      networkFeeBps: cfg.networkFeeBps,
    });
  }

  /** Refill the vault of a running deployment so its next extension is funded. */
  async ensureDeploymentRunway(
    deploymentId: string,
    marketTier: string,
    replicas: number
  ): Promise<RunwayResult> {
    this.requireWallet();
    this.requireSdk();
    const cfg = getNosanaDeployConfig();
    return ensureVaultRunway(this.deploymentsPort(), deploymentId, {
      marketAddress: this.resolveMarketAddress(marketTier),
      replicas,
      minRunwaySeconds: cfg.vaultMinRunwaySeconds,
      fundSeconds: cfg.vaultFundSeconds,
      solFeeLamportsPerReplica: cfg.vaultSolLamportsPerReplica,
      networkFeeBps: cfg.networkFeeBps,
    });
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
