import { Connection, Keypair } from "@solana/web3.js";
import { Client, type Market as NosanaSDKMarket } from "@nosana/sdk";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("nosana-service");

// Default job timeout for inference deployments: 30 days in seconds
const DEFAULT_JOB_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;

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

export interface NosanaMarket {
  address: string;
  name: string;
  gpuModel: string;
  vram: number;
  pricePerSecond: number;
  nodeCount: number;
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

export interface NosanaDeployment {
  id: string;
  market: string;
  replicas: number;
  status: "active" | "stopped";
  nodes: Array<{
    id: string;
    url: string;
    status: string;
  }>;
}

// ============================================
// GPU Market Configuration
// ============================================

// Known Nosana market addresses (devnet/mainnet).
// Exported so compute-metering and treasury settlement can price jobs against
// the same source of truth the scheduler uses.
export const MARKETS: Record<string, NosanaMarket> = {
  "3060": {
    address: "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf", // Example
    name: "RTX 3060",
    gpuModel: "RTX 3060",
    vram: 12,
    pricePerSecond: 0.0001,
    nodeCount: 150,
    queueLength: 0,
  },
  "4070": {
    address: "4070MarketAddressPlaceholder",
    name: "RTX 4070",
    gpuModel: "RTX 4070",
    vram: 12,
    pricePerSecond: 0.00015,
    nodeCount: 80,
    queueLength: 0,
  },
  "4090": {
    address: "4090MarketAddressPlaceholder",
    name: "RTX 4090",
    gpuModel: "RTX 4090",
    vram: 24,
    pricePerSecond: 0.00025,
    nodeCount: 45,
    queueLength: 0,
  },
  a100: {
    address: "A100MarketAddressPlaceholder",
    name: "A100 40GB",
    gpuModel: "A100",
    vram: 40,
    pricePerSecond: 0.0008,
    nodeCount: 20,
    queueLength: 0,
  },
  h100: {
    address: "H100MarketAddressPlaceholder",
    name: "H100 80GB",
    gpuModel: "H100",
    vram: 80,
    pricePerSecond: 0.0015,
    nodeCount: 5,
    queueLength: 0,
  },
};

// ============================================
// Nosana Client
// ============================================

export class NosanaClient {
  private connection: Connection;
  private wallet: Keypair | null = null;
  private sdk: Client | null = null;
  private isInitialized = false;
  private network: "devnet" | "mainnet";

  constructor() {
    this.connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
    // SOLANA_NETWORK is typed as "devnet" | "mainnet-beta"; Nosana SDK only accepts "devnet" | "mainnet"
    this.network = env.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet";
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

    this.sdk = new Client(
      this.network,
      sdkWallet,
      ipfsConfig ? { ipfs: ipfsConfig } : undefined
    );

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
      throw new Error("Wallet not configured - cannot submit jobs");
    }
    return this.wallet;
  }

  private requireSdk(): Client {
    if (!this.sdk) {
      throw new Error("Nosana SDK not initialised - call initialize() first");
    }
    return this.sdk;
  }

  /**
   * Map raw Nosana SDK Market onto our NosanaMarket interface.
   * jobPrice is stored on-chain in µNOS (1e6 per NOS); convert to NOS/second.
   */
  private mapSdkMarket(
    sdkMarket: NosanaSDKMarket & { address?: { toBase58?: () => string } }
  ): NosanaMarket {
    const address =
      typeof sdkMarket.address === "object" &&
      typeof (sdkMarket.address as { toBase58?: () => string }).toBase58 === "function"
        ? (sdkMarket.address as { toBase58: () => string }).toBase58()
        : String(sdkMarket.address ?? "");

    // jobPrice is in µNOS; convert to NOS/second
    const pricePerSecond = (sdkMarket.jobPrice ?? 0) / 1e6;
    const queueLength = Array.isArray(sdkMarket.queue) ? sdkMarket.queue.length : 0;

    return {
      address,
      name: address.slice(0, 6) + "…",
      gpuModel: "Unknown",
      vram: 0,
      pricePerSecond,
      nodeCount: 0,
      queueLength,
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

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get available GPU markets.
   * Attempts a live chain query via nosana.jobs.allMarkets(); falls back to
   * the static MARKETS table if the RPC call fails.
   */
  async getMarkets(): Promise<NosanaMarket[]> {
    const sdk = this.requireSdk();

    try {
      const rawMarkets = await sdk.jobs.allMarkets();

      if (Array.isArray(rawMarkets) && rawMarkets.length > 0) {
        logger.debug(
          { count: rawMarkets.length },
          "Fetched markets from chain"
        );
        return rawMarkets.map((m: NosanaSDKMarket) => this.mapSdkMarket(m));
      }

      logger.warn(
        "Chain returned empty market list - falling back to static data"
      );
    } catch (error) {
      logger.warn(
        { error: (error as Error).message },
        "Failed to fetch markets from chain - falling back to static data"
      );
    }

    return Object.values(MARKETS);
  }

  /**
   * Get specific market by tier key.
   * Falls back to static data; never queries chain individually to avoid
   * unnecessary latency on the hot path.
   */
  async getMarket(tier: string): Promise<NosanaMarket | null> {
    return MARKETS[tier] ?? null;
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
   * Submit a single job to a Nosana market.
   *
   * Flow:
   *  1. Resolve market address from tier key.
   *  2. Pin job definition to IPFS via the SDK (uses Pinata under the hood).
   *  3. Call nosana.jobs.list() to create the on-chain job listing.
   *  4. Return a NosanaJob with the on-chain job address as the ID.
   *
   * Falls back to a mock job ID if the SDK call fails, so callers are not
   * broken during development without a funded wallet.
   */
  async submitJob(
    definition: NosanaJobDefinition,
    marketTier: string
  ): Promise<NosanaJob> {
    this.requireWallet();
    const sdk = this.requireSdk();

    const market = await this.getMarket(marketTier);
    if (!market) {
      throw new Error(`Unknown market tier: ${marketTier}`);
    }

    logger.info(
      { market: market.name, jobType: definition.type },
      "Submitting job to Nosana"
    );

    try {
      // nosana.jobs.list() accepts a JobDefinition directly; it will pin to
      // IPFS internally and create the on-chain listing.
      const result = await sdk.jobs.list(
        definition as unknown as Parameters<typeof sdk.jobs.list>[0],
        DEFAULT_JOB_TIMEOUT_SECONDS,
        market.address
      );

      // result is { tx, job, run } when instructionOnly is false (default)
      const { job: jobAddress } =
        result as { tx: string; job: string; run: string };

      logger.info({ jobId: jobAddress, market: market.name }, "Job listed on-chain");

      return {
        id: jobAddress,
        market: market.address,
        status: "queued",
        startTime: new Date(),
      };
    } catch (error) {
      if (!env.ALLOW_NOSANA_MOCK) {
        logger.error(
          { error: (error as Error).message, market: market.name },
          "Nosana job submission failed and mock fallback is disabled"
        );
        throw error;
      }
      logger.warn(
        { error: (error as Error).message, market: market.name },
        "SDK job submission failed - returning mock job ID (ALLOW_NOSANA_MOCK=true)"
      );

      const fallbackId = `mock_job_${Date.now().toString(36)}`;
      return {
        id: fallbackId,
        market: market.address,
        status: "queued",
        startTime: new Date(),
      };
    }
  }

  /**
   * Query on-chain job status for a given job address.
   * Falls back to a "running" stub if the RPC call fails (e.g. mock IDs).
   */
  async getJobStatus(jobId: string): Promise<NosanaJob | null> {
    const sdk = this.requireSdk();

    logger.debug({ jobId }, "Getting job status");

    // Mock IDs (created by the fallback path) cannot be queried on-chain
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
   * Create a deployment (multiple replicas with auto-restart) via the Nosana
   * Deployments API.
   *
   * Uses nosana.deployments.create() which provisions a vault, submits
   * replica jobs, and returns a managed Deployment object.
   */
  async createDeployment(
    definition: NosanaJobDefinition,
    marketTier: string,
    replicas: number
  ): Promise<NosanaDeployment> {
    this.requireWallet();
    const sdk = this.requireSdk();

    const market = await this.getMarket(marketTier);
    if (!market) {
      throw new Error(`Unknown market tier: ${marketTier}`);
    }

    logger.info(
      { market: market.name, replicas },
      "Creating Nosana deployment"
    );

    try {
      const deployment = await sdk.deployments.create({
        name: `wheelsai-${Date.now().toString(36)}`,
        market: market.address,
        replicas,
        timeout: DEFAULT_JOB_TIMEOUT_SECONDS,
        strategy: "INFINITE" as const,
        job_definition: definition as unknown as Parameters<
          typeof sdk.deployments.create
        >[0]["job_definition"],
      });

      const deploymentId =
        typeof deployment.id === "string"
          ? deployment.id
          : String(deployment.id);

      logger.info(
        { deploymentId, replicas },
        "Deployment created via Nosana SDK"
      );

      const tasks = await deployment.getTasks().catch(() => []);
      const nodes = tasks.map((task: { id?: string; url?: string; status?: string }, i: number) => ({
        id: task.id ?? `node_${i}`,
        url: task.url ?? "",
        status: task.status ?? "provisioning",
      }));

      return {
        id: deploymentId,
        market: market.address,
        replicas,
        status: "active",
        nodes,
      };
    } catch (error) {
      if (!env.ALLOW_NOSANA_MOCK) {
        logger.error(
          { error: (error as Error).message, market: market.name, replicas },
          "Nosana deployment creation failed and mock fallback is disabled"
        );
        throw error;
      }
      logger.warn(
        { error: (error as Error).message, market: market.name, replicas },
        "SDK deployment creation failed - returning mock deployment (ALLOW_NOSANA_MOCK=true)"
      );

      const fallbackId = `mock_deploy_${Date.now().toString(36)}`;
      const nodes = Array.from({ length: replicas }, (_, i) => ({
        id: `node_${i}`,
        url: "",
        status: "provisioning",
      }));

      return {
        id: fallbackId,
        market: market.address,
        replicas,
        status: "active",
        nodes,
      };
    }
  }

  /**
   * Query current status of a deployment and its replica jobs.
   */
  async getDeploymentStatus(
    deploymentId: string
  ): Promise<NosanaDeployment | null> {
    const sdk = this.requireSdk();

    logger.debug({ deploymentId }, "Getting deployment status");

    if (deploymentId.startsWith("mock_deploy_")) {
      return {
        id: deploymentId,
        market: "",
        replicas: 1,
        status: "active",
        nodes: [{ id: "node_0", url: "", status: "running" }],
      };
    }

    try {
      const deployment = await sdk.deployments.get(deploymentId);
      const tasks = await deployment.getTasks().catch(() => []);

      const sdkStatus = String(deployment.status ?? "").toUpperCase();
      const status: NosanaDeployment["status"] =
        sdkStatus === "STOPPED" ||
        sdkStatus === "STOPPING" ||
        sdkStatus === "ARCHIVED"
          ? "stopped"
          : "active";

      const nodes = tasks.map((task: { id?: string; url?: string; status?: string }, i: number) => ({
        id: task.id ?? `node_${i}`,
        url: task.url ?? "",
        status: (task.status ?? "unknown").toLowerCase(),
      }));

      return {
        id: deploymentId,
        market: "",
        replicas: deployment.replicas ?? nodes.length,
        status,
        nodes,
      };
    } catch (error) {
      logger.warn(
        { deploymentId, error: (error as Error).message },
        "Failed to fetch deployment status - returning null"
      );
      return null;
    }
  }

  /**
   * Stop all replica jobs for a deployment.
   */
  async stopDeployment(deploymentId: string): Promise<void> {
    this.requireWallet();
    const sdk = this.requireSdk();

    logger.info({ deploymentId }, "Stopping deployment");

    if (deploymentId.startsWith("mock_deploy_")) {
      logger.debug({ deploymentId }, "Mock deployment - stop is a no-op");
      return;
    }

    try {
      const deployment = await sdk.deployments.get(deploymentId);
      await deployment.stop();
      logger.info({ deploymentId }, "Deployment stopped via Nosana SDK");
    } catch (error) {
      logger.error(
        { deploymentId, error: (error as Error).message },
        "Failed to stop deployment"
      );
      throw error;
    }
  }

  /**
   * Scale a deployment to a new replica count.
   */
  async scaleDeployment(
    deploymentId: string,
    newReplicas: number
  ): Promise<NosanaDeployment> {
    this.requireWallet();
    const sdk = this.requireSdk();

    logger.info({ deploymentId, newReplicas }, "Scaling deployment");

    if (deploymentId.startsWith("mock_deploy_")) {
      return {
        id: deploymentId,
        market: "",
        replicas: newReplicas,
        status: "active",
        nodes: Array.from({ length: newReplicas }, (_, i) => ({
          id: `node_${i}`,
          url: "",
          status: "provisioning",
        })),
      };
    }

    try {
      const deployment = await sdk.deployments.get(deploymentId);
      await deployment.updateReplicaCount(newReplicas);

      logger.info(
        { deploymentId, newReplicas },
        "Deployment scaled via Nosana SDK"
      );

      // Re-fetch tasks to get updated node list
      const tasks = await deployment.getTasks().catch(() => []);
      const nodes = tasks.map((task: { id?: string; url?: string; status?: string }, i: number) => ({
        id: task.id ?? `node_${i}`,
        url: task.url ?? "",
        status: (task.status ?? "provisioning").toLowerCase(),
      }));

      return {
        id: deploymentId,
        market: "",
        replicas: newReplicas,
        status: "active",
        nodes,
      };
    } catch (error) {
      logger.error(
        { deploymentId, newReplicas, error: (error as Error).message },
        "Failed to scale deployment"
      );
      throw error;
    }
  }

  /**
   * Check node health by making an HTTP request to the node's /health endpoint.
   */
  async checkNodeHealth(
    nodeUrl: string
  ): Promise<{ healthy: boolean; latencyMs: number }> {
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${nodeUrl}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      return {
        healthy: response.ok,
        latencyMs: Date.now() - startTime,
      };
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
          image: "vllm/vllm-openai:v0.6.0",
          cmd: vllmArgs,
          gpu: true,
          expose: [8000],
          env: {
            HF_TOKEN: "${HF_TOKEN}",
          },
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
