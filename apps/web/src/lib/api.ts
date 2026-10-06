// API Client for WheelsAI backend

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/**
 * The API origin the app is actually talking to — for user-facing surfaces
 * that print endpoint URLs (deployment cards, code snippets). Never
 * hardcode a hostname in a component: an endpoint is only true on the host
 * this build is configured against.
 */
export const API_BASE_URL = API_URL.replace(/\/+$/, "");

/**
 * An endpoint the API returned, as a URL a user can paste. The API answers
 * absolute URLs when PUBLIC_API_URL is configured and host-relative paths
 * (`/v1/...`) when it is not; a relative one is resolved against the API
 * origin this app talks to.
 */
export function absoluteApiUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${API_BASE_URL}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public data: unknown
  ) {
    super(`API Error: ${status} ${statusText}`);
    this.name = "ApiError";
  }
}

/**
 * Turn anything thrown by the API client (or a wallet / fetch call) into a
 * message fit for a toast.
 *
 *   - ApiError: the server's `message`, else its `error` string (Fastify
 *     shape `{ statusCode, error, message }`, and our `{ error: { message } }`).
 *   - any other Error: its `message`, unless it is the generic
 *     "API Error: 500 ..." text, which tells the user nothing.
 *   - anything else (or an empty message): `fallback`.
 *
 * Non-JSON error bodies (an nginx 502 page) are deliberately not surfaced.
 */
export function getErrorMessage(
  err: unknown,
  fallback = "Something went wrong"
): string {
  if (err instanceof ApiError) {
    const data = err.data;
    if (typeof data === "object" && data !== null) {
      const { message, error } = data as { message?: unknown; error?: unknown };
      if (typeof message === "string" && message.trim()) return message;
      if (typeof error === "string" && error.trim()) return error;
      if (typeof error === "object" && error !== null) {
        const nested = (error as { message?: unknown }).message;
        if (typeof nested === "string" && nested.trim()) return nested;
      }
    }
    return fallback;
  }
  if (err instanceof Error) {
    if (err.message && !/^API Error: \d+/.test(err.message)) return err.message;
    return fallback;
  }
  return fallback;
}

/**
 * Read a response body without assuming it is JSON.
 *
 * `res.json()` throws on anything that is not well-formed JSON, including two
 * cases this client hits routinely:
 *
 *   - 204 No Content, which the API returns from its DELETE routes. The body
 *     is empty, so json() threw "Unexpected end of JSON input" and every
 *     successful delete surfaced in the UI as a failure.
 *   - a non-JSON error body — an nginx/Fly 502 HTML page, a proxy timeout,
 *     a rate-limit text response. json() threw a SyntaxError whose message is
 *     about parsing, so the real status was lost and the user got
 *     "Unexpected token '<'" instead of "the server is down".
 *
 * Reads once as text and parses opportunistically, so a body that is not JSON
 * is still returned to the caller rather than destroying the response.
 */
async function readBody(res: Response): Promise<unknown> {
  // 204/205 are defined to have no body; don't even read.
  if (res.status === 204 || res.status === 205) return null;

  const text = await res.text();
  if (text === "") return null;

  try {
    return JSON.parse(text);
  } catch {
    // Not JSON. Hand back the raw text — ApiError carries it as `data`, which
    // is far more useful when debugging than a parser error.
    return text;
  }
}

async function api<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, headers = {} } = options;
  const hasBody = Boolean(body);

  const res = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers: {
      // Only with a body. The API (Fastify) answers a JSON content type on
      // an empty body with a 400 before the route runs, which made every
      // bodiless action ("Run now", "Cancel") fail from the dashboard.
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
    credentials: "include",
  });

  // Status first: an error response must surface its real status even when
  // the body is unreadable. Previously the body was parsed before res.ok was
  // consulted, so a malformed error body masked the status entirely.
  const data = await readBody(res);

  if (!res.ok) {
    throw new ApiError(res.status, res.statusText, data);
  }

  return data as T;
}

// ============================================
// Auth API
// ============================================

export interface User {
  id: string;
  email?: string;
  walletAddress?: string;
  emailVerified?: boolean;
  createdAt: string;
}

export interface Organization {
  id: string;
  name: string;
}

export interface AuthResponse {
  user: User;
  organization: Organization;
  token: string;
  /** Registration only: whether the verification email went out. */
  emailVerificationSent?: boolean;
}

/**
 * A 2FA-gated login answers with a challenge instead of a session (B5) —
 * no cookie is set until the code is verified at /login/2fa.
 */
export interface TwoFactorChallengeResponse {
  requires2FA: true;
  challengeToken: string;
  expiresAt: string;
}

export type LoginResponse = AuthResponse | TwoFactorChallengeResponse;

export function isTwoFactorChallenge(
  res: LoginResponse,
): res is TwoFactorChallengeResponse {
  return (res as TwoFactorChallengeResponse).requires2FA === true;
}

export const authApi = {
  register: (email: string, password: string) =>
    api<AuthResponse>("/api/auth/register", {
      method: "POST",
      body: { email, password },
    }),

  login: (email: string, password: string) =>
    api<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    }),

  /** Redeem a 2FA challenge for a session (B5). */
  completeTwoFactorLogin: (challengeToken: string, token: string) =>
    api<AuthResponse>("/api/auth/login/2fa", {
      method: "POST",
      body: { challengeToken, token },
    }),

  logout: () =>
    api<{ message: string }>("/api/auth/logout", { method: "POST" }),

  /** Organizations the signed-in user belongs to. */
  listOrgs: () =>
    api<{ organizations: { id: string; name: string; role: string; current: boolean }[] }>(
      "/api/auth/orgs"
    ),

  /** Move the session into another organization the user belongs to. */
  switchOrg: (orgId: string) =>
    api<{ organization: Organization; role: string }>("/api/auth/switch-org", {
      method: "POST",
      body: { orgId },
    }),

  /** (Re)send the verification link to the signed-in user's email. */
  requestEmailVerification: () =>
    api<{ sent: boolean; alreadyVerified?: boolean }>("/api/auth/email/verify/request", {
      method: "POST",
    }),

  /** Redeem a verification link; the first one grants the signup bonus. */
  confirmEmail: (token: string) =>
    api<{ verified: boolean; bonusGrantedCents: number }>("/api/auth/email/verify/confirm", {
      method: "POST",
      body: { token },
    }),

  forgotPassword: (email: string) =>
    api<{ message: string }>("/api/auth/password/forgot", {
      method: "POST",
      body: { email },
    }),

  resetPassword: (token: string, password: string) =>
    api<{ reset: boolean }>("/api/auth/password/reset", {
      method: "POST",
      body: { token, password },
    }),

  me: () =>
    api<{ user: User; organization: Organization; authType: string }>(
      "/api/auth/me"
    ),

  walletNonce: (walletAddress: string) =>
    api<{ nonce: string; walletAddress: string }>("/api/auth/wallet/nonce", {
      method: "POST",
      body: { walletAddress },
    }),

  // Can answer with a 2FA challenge instead of a session (B5) — a wallet
  // signature is one factor, so 2FA gates this door too.
  walletVerify: (walletAddress: string, signature: string, nonce: string) =>
    api<LoginResponse>("/api/auth/wallet/verify", {
      method: "POST",
      body: { walletAddress, signature, nonce },
    }),

  refresh: () => api<{ token: string }>("/api/auth/refresh", { method: "POST" }),
};

// ============================================
// Models API
// ============================================

export interface Model {
  id: string;
  hfId: string;
  ollamaModelId?: string | null;
  displayName: string;
  description: string;
  provider: string;
  parameters: number;
  minGpuTier: string;
  supportedEngines: string[];
  defaultEngine: string;
  contextLength: number;
  license: string;
  tags: string[];
  pricingTier: string;
  pricing?: {
    inputPer1k: number;
    outputPer1k: number;
  };
}

/**
 * An entry in GET /api/models: a deployable GPU catalog model, or a hosted
 * free chat model (tier "free"), which has none of the GPU catalog fields.
 */
export type ModelListing =
  | (Model & { tier: "gpu" })
  | (Pick<Model, "id" | "displayName" | "description" | "provider" | "contextLength"> &
      Partial<Model> & { tier: "free" });

export interface GpuTier {
  id: string;
  name: string;
  vram: number;
  // Derived from the same market table billing meters against — the one
  // price a tier has anywhere in the product.
  pricePerHour: number;
}

export const modelsApi = {
  // The whole catalog: GPU models plus the hosted free chat models.
  list: (params?: { tag?: string; search?: string }) => {
    const query = new URLSearchParams(params as Record<string, string>);
    return api<{ models: ModelListing[]; gpuTiers: GpuTier[] }>(
      `/api/models?${query}`
    );
  },

  // Only the models that can be deployed on a GPU.
  listDeployable: () =>
    api<{ models: Model[]; gpuTiers: GpuTier[] }>(`/api/models?tier=gpu`),

  get: (modelId: string) =>
    api<{ model: Model; compatibleGpuTiers: GpuTier[] }>(
      `/api/models/${modelId}`
    ),

  estimate: (
    modelId: string,
    gpuTier: string,
    replicas: number,
    hoursPerMonth: number
  ) =>
    api<{ estimate: { computePerMonth: number } }>(
      `/api/models/${modelId}/estimate`,
      {
        method: "POST",
        body: { gpuTier, replicas, hoursPerMonth },
      }
    ),
};

// ============================================
// Deployments API
// ============================================

export interface Deployment {
  id: string;
  name: string;
  slug: string;
  model: string;
  engine: string;
  gpuTier: string;
  replicas: number;
  status: "pending" | "provisioning" | "running" | "degraded" | "stopped" | "failed";
  endpoint: string | null;
  healthyNodes: number;
  totalNodes: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One deployment as GET /api/deployments/:id returns it. Unlike a list row,
 * `model` is the catalog model itself, and there are no node counts: the
 * nodes are listed. Node URLs and ids are withheld by the API, because a raw
 * node is an unauthenticated GPU endpoint.
 */
export interface DeploymentDetail extends Omit<Deployment, "model" | "healthyNodes" | "totalNodes"> {
  model: { id: string; displayName: string };
  config: {
    maxTokens: number;
    gpuMemoryUtilization: number;
  };
  nodes: Array<{
    id: string;
    healthStatus: string;
    latencyMs: number | null;
  }>;
}

export interface CreateDeploymentInput {
  name: string;
  modelId: string;
  gpuTier: string;
  engine?: "vllm" | "ollama";
  replicas?: number;
  config?: {
    maxTokens?: number;
    gpuMemoryUtilization?: number;
  };
}

export const deploymentsApi = {
  list: () =>
    api<{ deployments: Deployment[]; total: number }>("/api/deployments"),

  get: (id: string) =>
    api<{ deployment: DeploymentDetail }>(`/api/deployments/${id}`),

  create: (input: CreateDeploymentInput) =>
    api<{ deployment: Deployment; message: string }>("/api/deployments", {
      method: "POST",
      body: input,
    }),

  update: (id: string, updates: { replicas?: number }) =>
    api<{ deployment: Deployment }>(`/api/deployments/${id}`, {
      method: "PATCH",
      body: updates,
    }),

  delete: (id: string) =>
    api<{ message: string }>(`/api/deployments/${id}`, { method: "DELETE" }),

  restart: (id: string) =>
    api<{ message: string }>(`/api/deployments/${id}/restart`, {
      method: "POST",
    }),

  metrics: (id: string) =>
    api<{
      deploymentId: string;
      period: string;
      metrics: {
        requests: number;
        inputTokens: number;
        outputTokens: number;
        avgLatencyMs: number;
        errorRate: number;
      };
      byHour: Array<{
        period: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
      }>;
    }>(`/api/deployments/${id}/metrics`),
};

// ============================================
// API Keys
// ============================================

export interface ApiKey {
  id: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export const apiKeysApi = {
  list: () => api<{ apiKeys: ApiKey[] }>("/api/auth/keys"),

  create: (name: string, scopes?: string[]) =>
    api<{ apiKey: ApiKey; key: string }>("/api/auth/keys", {
      method: "POST",
      body: { name, scopes },
    }),

  revoke: (id: string) =>
    api<{ message: string }>(`/api/auth/keys/${id}`, { method: "DELETE" }),
};

// ============================================
// Billing API
// ============================================

export interface CreditBalance {
  available: number;
  pending: number;
  total: number;
}

export interface CreditTransaction {
  id: string;
  amount: number;
  type: "purchase" | "bonus" | "usage" | "refund";
  description: string;
  createdAt: string;
}

export interface UsageSummary {
  currentMonth: number;
  gpuHours: number;
  avgCostPerHour: number;
  computeCost: number;
  requests: number;
  requestsCost: number;
  inputTokens: number;
  outputTokens: number;
  tokensCost: number;
}

export interface X402Alert {
  code: string;
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
}

export interface X402WorkerMetrics {
  enabled: boolean;
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  lastError: string | null;
  ticks: number;
  processed: number;
  settled: number;
  failed: number;
  retried: number;
  skipped: number;
}

export interface X402MetricsResponse {
  worker: X402WorkerMetrics;
  thresholds: {
    maxPending: number;
    maxFailed: number;
    maxRetriable: number;
    maxFailureRatePercent: number;
    maxOldestPendingMinutes: number;
  };
  alerts: X402Alert[];
  payments: {
    total: number;
    pending: number;
    verified: number;
    settled: number;
    failed: number;
    retriable: number;
    failureRatePercent: number;
    oldestPendingMinutes: number | null;
  };
  recentFailures: Array<{
    id: string;
    requestId: string;
    txSignature: string | null;
    retryCount: number;
    failureReason: string | null;
    updatedAt: string;
  }>;
}

export interface X402MetricsHistoryPoint {
  timestamp: string;
  totalPayments: number;
  pendingPayments: number;
  verifiedPayments: number;
  settledPayments: number;
  failedPayments: number;
  retriablePayments: number;
  failureRatePercent: number;
  oldestPendingMinutes: number | null;
  alertCount: number;
  alerts: X402Alert[];
  worker: {
    ticks: number;
    processed: number;
    settled: number;
    failed: number;
    retried: number;
    skipped: number;
  };
}

export interface CreditPackage {
  amount: number;
  bonus: number;
  popular?: boolean;
}

/** Which payment rails are actually live on this deployment (B2/T5). */
export interface BillingRails {
  stripeCheckout: boolean;
  /** Pro plan purchasable (Stripe + a Pro price configured). */
  proSubscription?: boolean;
  mockCheckout: boolean;
  wallet: boolean;
  walletAssets: string[];
  network: "devnet" | "mainnet-beta";
}

export interface TopupPrepareResponse {
  topupId: string;
  /** Full unsigned transaction for wallet.signTransaction. */
  unsignedTxBase64: string;
  depositAddress: string;
  asset: "SOL" | "USDC";
  amountUsd: number;
  bonusUsd: number;
  quotedSolPriceUsd?: number;
  expiresAt: string;
}

export interface TopupSettleResponse {
  status: "credited" | "submitted" | "prepared" | "failed" | "expired";
  txSignature?: string;
  grantedUsd?: number;
  balanceUsd?: number;
  alreadyCredited?: boolean;
  pendingConfirmation?: boolean;
  reason?: string;
}

export type PlanId = "starter" | "pro" | "enterprise";

export interface PlanLimits {
  id: PlanId;
  name: string;
  priceMonthlyUsd: number | null;
  maxAgents: number | null;
  monthlyApiCalls: number | null;
  customDomains: boolean;
  advancedAnalytics: boolean;
  priorityPlacement: boolean;
  modelRateMultiplier: number;
  sso: boolean;
  whiteLabel: boolean;
}

export interface PlanInfo {
  plan: PlanId;
  limits: PlanLimits;
  status: string;
  trialEndsAt: string | null;
  trialAvailable: boolean;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasBillingAccount: boolean;
  usage: { agents: number; apiCallsThisMonth: number };
  plans: Record<PlanId, PlanLimits>;
  proSubscriptionAvailable: boolean;
}

export const billingApi = {
  getBalance: () =>
    api<{ balance: CreditBalance }>("/api/billing/balance"),

  /** Current plan, limits and this month's usage. */
  getPlan: () => api<PlanInfo>("/api/billing/plan"),

  /** Start Pro (14-day trial the first time); returns Stripe Checkout. */
  startProCheckout: () =>
    api<{ checkoutUrl: string; trialDays: number }>("/api/billing/subscription/checkout", {
      method: "POST",
      body: { plan: "pro" },
    }),

  /** Stripe billing portal: payment method, invoices, cancellation. */
  openBillingPortal: () => api<{ url: string }>("/api/billing/portal", { method: "POST" }),

  /** The credit ladder the grant math actually uses (B2/T1). */
  getPackages: () =>
    api<{
      packages: CreditPackage[];
      minPurchase: number;
      maxPurchase: number;
      rails: BillingRails;
    }>("/api/billing/packages"),

  // Wallet top-up rail (B2/T5): prepare → wallet signs the EXACT
  // server-built transaction → submit (byte-equality verified server
  // side) → credits granted only after on-chain confirmation.
  prepareTopup: (body: { amountUsd: number; asset: "SOL" | "USDC" }) =>
    api<TopupPrepareResponse>("/api/billing/topups/prepare", {
      method: "POST",
      body,
    }),

  submitTopup: (topupId: string, signedTxBase64: string) =>
    api<TopupSettleResponse>(`/api/billing/topups/${topupId}/submit`, {
      method: "POST",
      body: { signedTxBase64 },
    }),

  reconcileTopup: (topupId: string) =>
    api<TopupSettleResponse>(`/api/billing/topups/${topupId}/reconcile`, {
      method: "POST",
      body: {},
    }),

  getTransactions: () =>
    api<{ transactions: CreditTransaction[] }>("/api/billing/transactions"),

  getUsage: () =>
    api<{ usage: UsageSummary }>("/api/billing/usage"),

  createCheckout: (amount: number) =>
    api<{ checkoutUrl: string }>("/api/billing/checkout", {
      method: "POST",
      body: { amount },
    }),

  getX402Metrics: () =>
    api<X402MetricsResponse>("/api/x402/metrics"),

  getX402MetricsHistory: (hours = 24, limit = 120) =>
    api<{
      history: X402MetricsHistoryPoint[];
      query: { hours: number; limit: number };
    }>(`/api/x402/metrics/history?hours=${hours}&limit=${limit}`),
};

// ============================================
// Playground API
// ============================================

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface PlaygroundAgentChatResponse {
  content: string;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /**
   * Present only when the agent is a per-request marketplace install:
   * what this message cost and how much of it went to the publisher.
   * Null for agents you built yourself.
   */
  billing: {
    listingTitle: string;
    chargedCents: number;
    creatorCents: number;
  } | null;
  /** Every tool the model called in this turn, and how each call ended. */
  toolCalls?: PlaygroundToolCall[];
}

/** One tool call: `unavailable` means the tool is not configured on the server. */
export interface PlaygroundToolCall {
  name: string;
  status: "ok" | "unavailable" | "error" | "unknown";
  detail: string | null;
}

export interface PlaygroundModel {
  id: string;
  displayName: string;
  provider: string;
  contextLength: number;
  notes?: string;
  available: boolean;
}

export interface PlaygroundModelsResponse {
  freeModels: PlaygroundModel[];
  externalModels: Array<{
    id: string;
    displayName: string;
    provider: string;
    requiresApiKey: boolean;
    envKey: string;
  }>;
}

export const playgroundApi = {
  chat: (deploymentId: string, request: ChatCompletionRequest) =>
    api<ChatCompletionResponse>(`/api/deployments/${deploymentId}/chat`, {
      method: "POST",
      body: request,
    }),

  agentChat: (agentId: string, body: { messages: Array<{ role: string; content: string }>; model?: string; stream?: boolean }) =>
    api<PlaygroundAgentChatResponse>(`/api/agents/${agentId}/playground/chat`, {
      method: "POST",
      body,
    }),

  models: (agentId: string) =>
    api<PlaygroundModelsResponse>(`/api/agents/${agentId}/playground/models`),
};

// ============================================
// Skills (agent tools) API — GET /api/skills
// ============================================

export interface Skill {
  key: string;
  version: string;
  name: string;
  description: string;
  /** JSON schema of the arguments (what the model — or a graph node — supplies). */
  inputSchema: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  moneyMoving: boolean;
  /** Server configuration the skill needs (operator-facing). */
  requires: string[];
  /** False when the server cannot run it right now. Still listed and selectable. */
  available: boolean;
  /** Why it is unavailable, in words a user can read. */
  unavailableReason: string | null;
}

export const skillsApi = {
  /** Pass an agentId to include agent-level facts (e.g. a bound knowledge base). */
  list: (agentId?: string) =>
    api<{ skills: Skill[] }>(
      `/api/skills${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`
    ),
};

// ============================================
// Settings API
// ============================================

export interface UserProfile {
  id: string;
  email: string;
  displayName: string | null;
  walletAddress: string | null;
  emailVerified: boolean;
  createdAt: string;
}

export interface UserSettings {
  notifications: {
    deploymentStatus: boolean;
    usageAlerts: boolean;
    billing: boolean;
    productUpdates: boolean;
  };
  preferences: {
    theme: "light" | "dark" | "system";
    timezone: string;
  };
}

export const settingsApi = {
  getProfile: () =>
    api<{ profile: UserProfile }>("/api/settings/profile"),

  updateProfile: (updates: { displayName?: string; email?: string; currentPassword?: string }) =>
    api<{ profile: UserProfile; verificationSent?: boolean }>("/api/settings/profile", {
      method: "PATCH",
      body: updates,
    }),

  getSettings: () =>
    api<{ settings: UserSettings }>("/api/settings"),

  updateSettings: (updates: Partial<UserSettings>) =>
    api<{ settings: UserSettings }>("/api/settings", {
      method: "PATCH",
      body: updates,
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ message: string }>("/api/settings/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),

  linkWallet: (walletAddress: string, signature: string, message: string) =>
    api<{ walletAddress: string; message: string }>("/api/settings/link-wallet", {
      method: "POST",
      body: { walletAddress, signature, message },
    }),

  getBranding: () =>
    api<{ branding: Record<string, string> }>("/api/settings/branding"),

  updateBranding: (branding: {
    logo?: string;
    favicon?: string;
    primaryColor?: string;
    accentColor?: string;
    appName?: string;
    supportEmail?: string;
  }) =>
    api<{ branding: Record<string, string>; message: string }>("/api/settings/branding", {
      method: "PUT",
      body: branding,
    }),
};

// ============================================
// Agents API
// ============================================

export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  framework: "mastra" | "langchain" | "autogen" | "elizaos" | "crewai" | "custom";
  version: string;
  tags: string[];
  isPublic: boolean;
  /**
   * The agent's OpenAI-compatible chat-completions URL, served by the
   * platform API whether or not anything is deployed. null when the API has
   * no PUBLIC_API_URL configured: there is no honest absolute URL to show.
   */
  apiEndpoint: string | null;
  /** `base_url` for an OpenAI client talking to this one agent; null as above. */
  openaiBaseUrl: string | null;
  /** The `model` id that selects this agent on the unified /v1 base: `agent/<slug>`. */
  openaiModel: string;
  /**
   * What answers a chat (playground and /v1): the agent's prompt, model and
   * tools, or the graph saved in the builder.
   */
  entrypoint: AgentEntrypoint;
  latestDeployment: {
    id: string;
    status: string;
    endpoint: string | null;
    createdAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentEntrypoint = "chat" | "graph";

/** Sums of an agent's chat traffic (playground and /v1) over a period. */
export interface AgentUsageSummary {
  requests: number;
  errors: number;
  streamed: number;
  /** Chats that produced an answer: the base of the latency numbers. */
  answered: number;
  inputTokens: number;
  outputTokens: number;
  /** Answered chats whose provider reported no tokens; NOT in the sums above. */
  usageUnreported: number;
  toolCalls: number;
  /** null when nothing was answered. */
  avgLatencyMs: number | null;
  /** Upper bounds of the bucket the percentile falls in; null when unknown. */
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  /** errors / requests, 0..1. */
  errorRate: number;
}

export type AgentUsagePeriod = "24h" | "7d" | "30d";

export interface AgentChatUsage {
  period: AgentUsagePeriod;
  since: string;
  total: AgentUsageSummary;
  /** Per entry point: "playground", "api". */
  bySource: Record<string, AgentUsageSummary>;
  series: Array<{
    periodStart: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export interface AgentDetail extends Omit<Agent, "latestDeployment"> {
  systemPrompt: string | null;
  tools: any[];
  modelConfig: {
    modelId?: string;
    externalModel?: string;
    temperature: number;
    maxTokens: number;
  };
  sourceType: "inline" | "github" | "ipfs";
  sourceUrl: string | null;
  sourceCode: string | null;
  env: Record<string, string>;
  deployments: AgentDeployment[];
}

export interface AgentDeployment {
  id: string;
  agentId: string;
  status: "pending" | "building" | "deploying" | "running" | "stopped" | "failed";
  endpoint: string | null;
  gpuTier: string;
  replicas: number;
  buildLogs: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  framework: "mastra" | "langchain" | "autogen" | "custom";
  systemPrompt?: string;
  tools?: Array<{
    name: string;
    type: "function" | "api" | "mcp";
    description?: string;
    config?: Record<string, any>;
  }>;
  modelConfig: {
    modelId?: string;
    externalModel?: string;
    temperature?: number;
    maxTokens?: number;
  };
  sourceType: "inline" | "github" | "ipfs";
  sourceUrl?: string;
  sourceCode?: string;
  env?: Record<string, string>;
  tags?: string[];
  isPublic?: boolean;
}

export interface DeployAgentInput {
  gpuTier: string;
  replicas?: number;
  modelDeploymentId?: string;
  externalModelUrl?: string;
  enableWallet?: boolean;
  walletConfig?: {
    dailyLimitCents?: number;
    perTxLimitCents?: number;
    allowedDomains?: string[];
  };
}

export const agentsApi = {
  list: () => api<{ agents: Agent[]; total: number }>("/api/agents"),

  get: (id: string) => api<{ agent: AgentDetail }>(`/api/agents/${id}`),

  create: (input: CreateAgentInput) =>
    api<{ agent: { id: string; name: string; slug: string; framework: string }; message: string }>(
      "/api/agents",
      { method: "POST", body: input }
    ),

  update: (id: string, updates: Partial<CreateAgentInput> & { entrypoint?: AgentEntrypoint }) =>
    api<{ agent: AgentDetail }>(`/api/agents/${id}`, {
      method: "PATCH",
      body: updates,
    }),

  usage: (id: string, period: AgentUsagePeriod = "24h") =>
    api<{ usage: AgentChatUsage }>(`/api/agents/${id}/usage?period=${period}`),

  delete: (id: string) =>
    api<{ message: string }>(`/api/agents/${id}`, { method: "DELETE" }),

  deploy: (agentId: string, input: DeployAgentInput) =>
    api<{ deployment: { id: string; status: string }; message: string }>(
      `/api/agents/${agentId}/deploy`,
      { method: "POST", body: input }
    ),

  getDeployment: (agentId: string, deploymentId: string) =>
    api<{ deployment: AgentDeployment }>(
      `/api/agents/${agentId}/deployments/${deploymentId}`
    ),

  stopDeployment: (agentId: string, deploymentId: string) =>
    api<{ message: string }>(
      `/api/agents/${agentId}/deployments/${deploymentId}/stop`,
      { method: "POST" }
    ),

  getLogs: (agentId: string, deploymentId: string) =>
    api<{ logs: string; error: string | null }>(
      `/api/agents/${agentId}/deployments/${deploymentId}/logs`
    ),

  importGithub: (githubUrl: string) =>
    api<{ config: { framework: string; name: string; description: string; sourceUrl: string; detectedFiles: string[] }; repoInfo: { owner: string; repo: string } }>("/api/agents/import-github", {
      method: "POST",
      body: { githubUrl },
    }),
};

// ============================================
// Training Studio API
// ============================================

export interface Dataset {
  id: string;
  name: string;
  description: string | null;
  format: string;
  rowCount: number;
  sizeBytes: number;
  isValidated: boolean;
  createdAt: string;
}

export interface DatasetDetail extends Dataset {
  storageType: string;
  validationErrors: any[] | null;
  sampleRows: Record<string, any>[] | null;
  updatedAt: string;
}

export interface TrainingJob {
  id: string;
  name: string;
  baseModelId: string;
  datasetName: string;
  method: "lora" | "qlora" | "full";
  status: "pending" | "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  gpuTier: string;
  gpuCount: number;
  estimatedCostCents: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TrainingJobDetail extends Omit<TrainingJob, "datasetName"> {
  baseModelHfId: string;
  dataset: {
    id: string;
    name: string;
    rowCount: number;
  };
  config: {
    epochs: number;
    batchSize: number;
    learningRate: number;
    warmupSteps: number;
    gradientAccumulationSteps: number;
    loraR?: number;
    loraAlpha?: number;
    loraDropout?: number;
    targetModules?: string[];
  };
  currentEpoch: number | null;
  totalEpochs: number | null;
  trainingLoss: number | null;
  evalLoss: number | null;
  metrics: any | null;
  outputModelId: string | null;
  outputPath: string | null;
  actualCostCents: number | null;
  lastError: string | null;
}

export interface TrainableModel {
  id: string;
  hfId: string;
  displayName: string;
  parameters: number | null;
  supportedMethods: string[];
  recommendedGpuTier: string;
}

export interface CreateDatasetInput {
  name: string;
  description?: string;
  fileName: string;
  contentType?: string;
  format?: "jsonl" | "csv" | "parquet" | "alpaca" | "sharegpt";
}

export interface CreateTrainingJobInput {
  name: string;
  baseModelId: string;
  datasetId: string;
  method?: "lora" | "qlora" | "full";
  gpuTier?: string;
  gpuCount?: number;
  config?: {
    epochs?: number;
    batchSize?: number;
    learningRate?: number;
    warmupSteps?: number;
    gradientAccumulationSteps?: number;
    loraR?: number;
    loraAlpha?: number;
    loraDropout?: number;
    targetModules?: string[];
    quantizationBits?: "4" | "8";
  };
}

export const trainingApi = {
  // Datasets
  listDatasets: () =>
    api<{ datasets: Dataset[]; total: number }>("/api/training/datasets"),

  getDataset: (id: string) =>
    api<{ dataset: DatasetDetail }>(`/api/training/datasets/${id}`),

  createDataset: (input: CreateDatasetInput) =>
    api<{
      dataset: { id: string; name: string };
      upload: { url: string; expiresAt: string };
      message: string;
    }>("/api/training/datasets", {
      method: "POST",
      body: input,
    }),

  validateDataset: (id: string) =>
    api<{
      validation: {
        isValid: boolean;
        format: string;
        detectedFormat: string;
        rowCount: number;
        sizeBytes: number;
        errors: any[];
        warnings: any[];
      };
      stats: {
        totalTokens: number;
        avgTokensPerRow: number;
        minTokens: number;
        maxTokens: number;
        estimatedTrainingTime: string;
      };
      sampleRows: Record<string, any>[];
    }>(`/api/training/datasets/${id}/validate`, { method: "POST" }),

  deleteDataset: (id: string) =>
    api<{ message: string }>(`/api/training/datasets/${id}`, { method: "DELETE" }),

  // Training Jobs
  listJobs: (status?: string) =>
    api<{ jobs: TrainingJob[]; total: number }>(
      `/api/training/jobs${status ? `?status=${status}` : ""}`
    ),

  getJob: (id: string) =>
    api<{ job: TrainingJobDetail; liveProgress: any | null }>(`/api/training/jobs/${id}`),

  createJob: (input: CreateTrainingJobInput) =>
    api<{
      job: { id: string; name: string; status: string };
      estimate: { gpuHours: number; costCents: number; costUsd: string };
      message: string;
    }>("/api/training/jobs", {
      method: "POST",
      body: input,
    }),

  getJobLogs: (id: string, tail?: number) =>
    api<{ jobId: string; status: string; logs: string; totalLines: number }>(
      `/api/training/jobs/${id}/logs${tail ? `?tail=${tail}` : ""}`
    ),

  cancelJob: (id: string) =>
    api<{ message: string }>(`/api/training/jobs/${id}/cancel`, { method: "POST" }),

  // Estimation
  estimate: (input: {
    baseModelId: string;
    datasetId: string;
    method?: "lora" | "qlora" | "full";
    epochs?: number;
    gpuTier?: string;
  }) =>
    api<{
      estimate: {
        gpuTier: string;
        recommendedGpuTier: string;
        minVramGb: number;
        gpuHours: number;
        costPerHour: number;
        totalCostCents: number;
        totalCostUsd: string;
      };
      dataset: { rowCount: number; format: string };
    }>("/api/training/estimate", { method: "POST", body: input }),

  // Models
  listTrainableModels: () =>
    api<{ models: TrainableModel[] }>("/api/training/models"),
};

// ============================================
// Marketplace API
// ============================================

/** A buyer's monthly subscription to a marketplace listing. */
export interface MarketplaceSubscription {
  id: string;
  listingId: string;
  status: "active" | "past_due" | "cancelled" | "expired";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  hasAccess: boolean;
  graceEndsAt: string | null;
  /**
   * The monthly price this subscription was agreed at, which is what a
   * renewal charges. The listing's current price can differ. Null only
   * when no price was ever agreed (it is confirmed before any renewal).
   */
  priceCents: number | null;
  /** Set when the publisher's side ended it; the buyer must accept the new pricing. */
  endReason: "pricing_changed" | "listing_archived" | null;
}

/**
 * Where an install stands, by the same rule the API bills with:
 * subscribed (inside a paid period), listing_pricing (the listing's
 * current pricing applies), unlisted (no longer sold; keeps running at no
 * charge), subscription_lapsed, pricing_changed (paused until the buyer
 * accepts the listing's new pricing).
 */
export type MarketplaceInstallAccess =
  | "subscribed"
  | "listing_pricing"
  | "unlisted"
  | "subscription_lapsed"
  | "pricing_changed"
  | "uninstalled";

export interface MarketplaceListing {
  id: string;
  agentId: string;
  title: string;
  slug: string;
  shortDescription: string;
  longDescription: string | null;
  category: string;
  iconUrl: string | null;
  screenshots: string[];
  readme: string | null;
  pricingModel: "free" | "per_request" | "monthly" | "tokenized";
  pricePerRequestCents: number | null;
  monthlyPriceCents: number | null;
  publisherId: string;
  publisherName: string;
  status: "draft" | "pending_review" | "published" | "archived";
  isFeatured: boolean;
  totalInstalls: number;
  activeInstalls: number;
  avgRating: number;
  reviewCount: number;
  totalRequests: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agent?: {
    id: string;
    framework: string;
    tags: string[];
    // Present on the detail endpoint only (getListingBySlug select) —
    // used to link to the public /a/:slug transparency page.
    slug?: string;
    isPublic?: boolean;
  };
}

// ============================================
// Public Agent Transparency Feed (/api/a/:slug)
// ============================================

export interface PublicAgentDetail {
  agent: {
    name: string;
    slug: string;
    framework: string;
    createdAt: string;
  };
  treasury: {
    address: string;
    balanceLamports: string;
    balanceSol: number;
    cumulativeComputePaidLamports: string;
  } | null;
  uptime: {
    totalComputeSeconds: string;
    totalComputeHours: number;
    totalRequests: number;
  } | null;
  eligibility: { eligible: boolean } | null;
  deployments: Array<{ gpuTier: string; replicas: number; status: string }>;
  channels: Array<{ platform: string; enabled: boolean }>;
  recentPayments: Array<{
    amountLamports: string;
    status: string;
    txSignature: string | null;
    paidAt: string | null;
  }>;
}

export const publicAgentApi = {
  get: (slug: string) => api<PublicAgentDetail>(`/api/a/${slug}`),
};

export interface MarketplaceCategory {
  id: string;
  label: string;
  icon: string;
  count: number;
}

export interface MarketplaceReview {
  id: string;
  rating: number;
  title: string | null;
  content: string | null;
  isVerified: boolean;
  helpfulCount: number;
  reviewerName: string;
  createdAt: string;
}

export interface PublisherProfile {
  displayName: string;
  slug: string;
  bio: string | null;
  avatarUrl: string | null;
  website: string | null;
  twitter: string | null;
  github: string | null;
  isVerified: boolean;
  totalListings: number;
  totalInstalls: number;
  createdAt: string;
  listings: MarketplaceListing[];
}

export interface PaginatedResponse<T> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface CreateListingInput {
  agentId: string;
  title: string;
  shortDescription: string;
  longDescription?: string;
  category: "customer-support" | "coding" | "research" | "automation" | "creative" | "other";
  iconUrl?: string;
  screenshots?: string[];
  readme?: string;
  pricingModel: "free" | "per_request" | "monthly" | "tokenized";
  pricePerRequestCents?: number;
  monthlyPriceCents?: number;
}

export interface SearchListingsParams {
  query?: string;
  category?: string;
  pricingModel?: string;
  minRating?: number;
  sortBy?: "popular" | "rating" | "newest" | "price_low" | "price_high";
  page?: number;
  limit?: number;
}

export const marketplaceApi = {
  // Public Routes
  searchListings: (params: SearchListingsParams = {}) => {
    const searchParams = new URLSearchParams();
    if (params.query) searchParams.set("query", params.query);
    if (params.category) searchParams.set("category", params.category);
    if (params.pricingModel) searchParams.set("pricingModel", params.pricingModel);
    if (params.minRating) searchParams.set("minRating", params.minRating.toString());
    if (params.sortBy) searchParams.set("sortBy", params.sortBy);
    if (params.page) searchParams.set("page", params.page.toString());
    if (params.limit) searchParams.set("limit", params.limit.toString());

    const queryString = searchParams.toString();
    return api<{ listings: MarketplaceListing[] } & PaginatedResponse<MarketplaceListing>>(
      `/api/marketplace/listings${queryString ? `?${queryString}` : ""}`
    );
  },

  getListing: (slugOrId: string) =>
    api<{ listing: MarketplaceListing }>(`/api/marketplace/listings/${slugOrId}`),

  getListingReviews: (id: string, page = 1, limit = 10) =>
    api<{ reviews: MarketplaceReview[] } & PaginatedResponse<MarketplaceReview>>(
      `/api/marketplace/listings/${id}/reviews?page=${page}&limit=${limit}`
    ),

  getCategories: () =>
    api<{ categories: MarketplaceCategory[] }>("/api/marketplace/categories"),

  getFeatured: (limit = 6) =>
    api<{ listings: MarketplaceListing[] }>(`/api/marketplace/featured?limit=${limit}`),

  getPublisher: (slug: string) =>
    api<{ publisher: PublisherProfile }>(`/api/marketplace/publishers/${slug}`),

  getPricingModels: () =>
    api<{ pricingModels: Array<{ id: string; label: string }> }>("/api/marketplace/pricing-models"),

  // Protected Routes
  createListing: (input: CreateListingInput) =>
    api<{ listing: MarketplaceListing }>("/api/marketplace/listings", {
      method: "POST",
      body: input,
    }),

  updateListing: (id: string, updates: Partial<Omit<CreateListingInput, "agentId">>) =>
    api<{ listing: MarketplaceListing }>(`/api/marketplace/listings/${id}`, {
      method: "PATCH",
      body: updates,
    }),

  publishListing: (id: string) =>
    api<{ listing: MarketplaceListing; message: string }>(`/api/marketplace/listings/${id}/publish`, {
      method: "POST",
    }),

  archiveListing: (id: string) =>
    api<{ listing: MarketplaceListing; message: string }>(`/api/marketplace/listings/${id}/archive`, {
      method: "POST",
    }),

  getMyListings: () =>
    api<{ listings: MarketplaceListing[] }>("/api/marketplace/my-listings"),

  createReview: (listingId: string, data: { rating: number; title?: string; content?: string }) =>
    api<{ review: MarketplaceReview }>(`/api/marketplace/listings/${listingId}/reviews`, {
      method: "POST",
      body: data,
    }),

  // Install Routes. A monthly listing charges the first 30-day period
  // here; the API answers 402 (insufficient_credits) when the buyer
  // cannot pay.
  /**
   * Install, resubscribe, or (with acceptNewPricing) continue an install
   * the publisher repriced. Without the flag a repriced install answers
   * 409 `pricing_changed` carrying the listing's current pricing.
   */
  installAgent: (listingId: string, opts?: { acceptNewPricing?: boolean }) =>
    api<{
      message: string;
      install: { id: string; status: string };
      clonedAgent: {
        id: string;
        name: string;
        slug: string;
        /** Graph nodes installed without the publisher's request details or code. */
        needsConfiguration?: Array<{ nodeId: string; label: string; type: string; fields: string[] }>;
      };
      subscription: { id: string; currentPeriodEnd: string } | null;
    }>(`/api/marketplace/listings/${listingId}/install`, {
      method: "POST",
      ...(opts?.acceptNewPricing ? { body: { acceptNewPricing: true } } : {}),
    }),

  uninstallAgent: (listingId: string) =>
    api<{ message: string }>(`/api/marketplace/listings/${listingId}/uninstall`, {
      method: "POST",
    }),

  checkInstallStatus: (listingId: string) =>
    api<{
      isInstalled: boolean;
      install: {
        id: string;
        status: string;
        clonedAgentId: string;
        installedAt: string;
      } | null;
    }>(`/api/marketplace/listings/${listingId}/install-status`),

  getMyInstalls: () =>
    api<{
      installs: Array<{
        id: string;
        listingId: string;
        clonedAgentId: string;
        status: string;
        totalRequests: number;
        totalSpentCents: number;
        installedAt: string;
        access: MarketplaceInstallAccess;
        listing: MarketplaceListing;
        subscription: MarketplaceSubscription | null;
      }>;
    }>("/api/marketplace/my-installs"),

  // Monthly subscriptions
  getSubscriptions: () =>
    api<{
      subscriptions: Array<
        MarketplaceSubscription & {
          listing: { id: string; title: string; slug: string; iconUrl: string | null; monthlyPriceCents: number };
        }
      >;
    }>("/api/marketplace/subscriptions"),

  cancelSubscription: (listingId: string) =>
    api<{ subscription: MarketplaceSubscription }>(
      `/api/marketplace/subscriptions/${listingId}/cancel`,
      { method: "POST" }
    ),

  resumeSubscription: (listingId: string) =>
    api<{ subscription: MarketplaceSubscription }>(
      `/api/marketplace/subscriptions/${listingId}/resume`,
      { method: "POST" }
    ),

  // Revenue Routes
  getRevenue: () =>
    api<{
      totalRevenueCents: number;
      pendingPayoutCents: number;
      totalListings: number;
      totalInstalls: number;
      revenueByListing: Array<{
        listingId: string;
        listing: { id: string; title: string; slug: string } | undefined;
        totalRevenueCents: number;
        totalRequests: number;
      }>;
      recentTransactions: Array<{
        id: string;
        type: string;
        grossAmountCents: number;
        platformFeeCents: number;
        creatorAmountCents: number;
        requestCount: number;
        status: string;
        createdAt: string;
      }>;
      pendingPayouts: Array<{
        id: string;
        amountCents: number;
        payoutMethod: string;
        status: string;
        requestedAt: string;
      }>;
    }>("/api/marketplace/revenue"),

  requestPayout: (payoutMethod: "credits" | "crypto_usdc" | "crypto_sol", payoutAddress?: string) =>
    api<{
      payout: {
        id: string;
        amountCents: number;
        payoutMethod: string;
        status: string;
        requestedAt: string;
      };
    }>("/api/marketplace/payouts", {
      method: "POST",
      body: { payoutMethod, payoutAddress },
    }),

  getPayoutHistory: () =>
    api<{
      payouts: Array<{
        id: string;
        amountCents: number;
        payoutMethod: string;
        payoutAddress: string | null;
        status: string;
        txSignature: string | null;
        grossRevenueCents: number;
        platformFeeCents: number;
        periodStart: string;
        periodEnd: string;
        requestedAt: string;
        processedAt: string | null;
        failureReason: string | null;
      }>;
    }>("/api/marketplace/payouts"),
};

// ============================================
// Reputation API
// ============================================

export interface ReputationBreakdown {
  score: number;
  tier: string;
  breakdown: {
    avgRating: { value: number; score: number; weight: number };
    installCount: { value: number; score: number; weight: number };
    responseTime: { value: number | null; score: number; weight: number };
    accountAge: { value: number; score: number; weight: number };
    verificationStatus: { value: boolean; score: number; weight: number };
    disputeRatio: { value: number; score: number; weight: number };
    payoutSuccess: { value: number; score: number; weight: number };
  };
  badges: string[];
}

export interface PublisherReputation {
  orgId: string;
  displayName: string;
  slug: string;
  avatarUrl: string | null;
  bio: string | null;
  website: string | null;
  twitter: string | null;
  github: string | null;
  isVerified: boolean;
  reputationScore: number;
  reputationTier: string;
  badges: string[];
  totalListings: number;
  totalInstalls: number;
  avgResponseTimeMs: number | null;
  joinedDaysAgo: number;
  createdAt: string;
}

export interface LeaderboardEntry {
  orgId: string;
  displayName: string;
  slug: string;
  avatarUrl: string | null;
  isVerified: boolean;
  reputationScore: number;
  reputationTier: string;
  badges: string[];
  totalListings: number;
  totalInstalls: number;
}

export interface BadgeInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export interface ReputationStats {
  totalPublishers: number;
  averageScore: number;
  tierDistribution: Record<string, number>;
}

export const reputationApi = {
  // Public Routes
  getLeaderboard: (limit = 10) =>
    api<{ success: boolean; data: LeaderboardEntry[] }>(
      `/api/reputation/leaderboard?limit=${limit}`
    ),

  getPublishersByTier: (tier: string, limit = 20) =>
    api<{ success: boolean; data: LeaderboardEntry[] }>(
      `/api/reputation/tier/${tier}?limit=${limit}`
    ),

  getAllBadges: () =>
    api<{ success: boolean; data: BadgeInfo[] }>("/api/reputation/badges"),

  getBadge: (badge: string) =>
    api<{ success: boolean; data: BadgeInfo }>(`/api/reputation/badges/${badge}`),

  getPublisherReputation: (slug: string) =>
    api<{ success: boolean; data: PublisherReputation }>(
      `/api/reputation/publisher/${slug}`
    ),

  getPublisherBreakdown: (slug: string) =>
    api<{ success: boolean; data: ReputationBreakdown }>(
      `/api/reputation/publisher/${slug}/breakdown`
    ),

  getStats: () =>
    api<{ success: boolean; data: ReputationStats }>("/api/reputation/stats"),

  // Protected Routes
  getMyReputation: () =>
    api<{
      success: boolean;
      data: {
        profile: {
          displayName: string;
          slug: string;
          avatarUrl: string | null;
          isVerified: boolean;
        };
        reputation: ReputationBreakdown;
      };
    }>("/api/reputation/my-reputation"),

  recalculateReputation: () =>
    api<{ success: boolean; data: ReputationBreakdown; message: string }>(
      "/api/reputation/recalculate",
      { method: "POST" }
    ),
};

// ============================================
// Analytics API
// ============================================

export interface UsageMetrics {
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostCents: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface TimeSeriesPoint {
  timestamp: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  errors: number;
}

export interface DeploymentMetrics {
  deploymentId: string;
  deploymentName: string;
  modelId: string;
  status: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface CostBreakdown {
  byModel: Array<{ modelId: string; costCents: number; requests: number }>;
  byGpu: Array<{ gpuTier: string; costCents: number; requests: number }>;
}

export interface CostProjection {
  currentSpend: number;
  projectedSpend: number;
  daysRemaining: number;
  dailyAverage: number;
}

export interface SpendingAlert {
  type: "warning" | "critical";
  message: string;
  percentage: number;
}

export interface AnalyticsDashboard {
  overview: UsageMetrics;
  timeseries: TimeSeriesPoint[];
  deployments: DeploymentMetrics[];
  costBreakdown: CostBreakdown;
  projection: CostProjection;
}

/**
 * Download usage analytics as a file (Pro and above). Resolves once the
 * browser has been handed the file; rejects with an ApiError (403 on
 * Starter) so callers can offer the upgrade.
 */
export async function downloadAnalyticsExport(opts: {
  days: number;
  format: "csv" | "json";
  dataset: "daily" | "deployments";
}): Promise<void> {
  const qs = new URLSearchParams({ days: String(opts.days), format: opts.format, dataset: opts.dataset });
  const res = await fetch(`${API_URL}/api/analytics/export?${qs}`, { credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, res.statusText, data);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `wheelsai-${opts.dataset}.${opts.format}`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const analyticsApi = {
  getOverview: (days = 30) =>
    api<{ success: boolean; data: UsageMetrics; period: { days: number } }>(
      `/api/analytics/overview?days=${days}`
    ),

  getTimeSeries: (days = 30, granularity: "hourly" | "daily" = "daily") =>
    api<{
      success: boolean;
      data: TimeSeriesPoint[];
      period: { days: number; granularity: string };
    }>(`/api/analytics/timeseries?days=${days}&granularity=${granularity}`),

  getDeploymentMetrics: (days = 30) =>
    api<{ success: boolean; data: DeploymentMetrics[]; period: { days: number } }>(
      `/api/analytics/deployments?days=${days}`
    ),

  getCostByModel: (days = 30) =>
    api<{
      success: boolean;
      data: Array<{ modelId: string; costCents: number; requests: number }>;
      period: { days: number };
    }>(`/api/analytics/costs/by-model?days=${days}`),

  getCostByGpu: (days = 30) =>
    api<{
      success: boolean;
      data: Array<{ gpuTier: string; costCents: number; requests: number }>;
      period: { days: number };
    }>(`/api/analytics/costs/by-gpu?days=${days}`),

  getProjection: () =>
    api<{ success: boolean; data: CostProjection }>("/api/analytics/projection"),

  getAlerts: (budgetUsd = 100) =>
    api<{ success: boolean; data: SpendingAlert[] }>(
      `/api/analytics/alerts?budget=${budgetUsd}`
    ),

  getDashboard: (days = 30) =>
    api<{ success: boolean; data: AnalyticsDashboard; period: { days: number } }>(
      `/api/analytics/dashboard?days=${days}`
    ),
};

// ============================================
// Enterprise API
// ============================================

export interface AuditLogEntry {
  id: string;
  orgId: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  details: Record<string, any> | null;
  ipAddress: string | null;
  userAgent: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: string;
}

export interface TeamMember {
  userId: string;
  role: string;
  email: string | null;
  displayName: string | null;
  walletAddress: string | null;
  joinedAt: string;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface SsoConfig {
  provider: string;
  enabled: boolean;
  samlEntityId: string | null;
  samlSsoUrl: string | null;
  oidcClientId: string | null;
  oidcIssuer: string | null;
  oidcScopes: string[];
  allowedDomains: string[];
  autoProvision: boolean;
  defaultRole: string;
  createdAt: string;
  updatedAt: string;
}

export const enterpriseApi = {
  // Audit Logs
  getAuditLogs: (params?: {
    action?: string;
    resource?: string;
    userId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.action) searchParams.set("action", params.action);
    if (params?.resource) searchParams.set("resource", params.resource);
    if (params?.userId) searchParams.set("userId", params.userId);
    if (params?.startDate) searchParams.set("startDate", params.startDate);
    if (params?.endDate) searchParams.set("endDate", params.endDate);
    if (params?.page) searchParams.set("page", params.page.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    const query = searchParams.toString();
    return api<{
      success: boolean;
      data: AuditLogEntry[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
    }>(`/api/enterprise/audit-logs${query ? `?${query}` : ""}`);
  },

  getAuditLogSummary: (days = 30) =>
    api<{ success: boolean; data: Array<{ action: string; count: number }> }>(
      `/api/enterprise/audit-logs/summary?days=${days}`
    ),

  // Team Management
  getTeamMembers: () =>
    api<{ success: boolean; data: TeamMember[] }>("/api/enterprise/team"),

  getPendingInvites: () =>
    api<{ success: boolean; data: TeamInvite[] }>("/api/enterprise/team/invites"),

  createTeamInvite: (email: string, role?: string) =>
    api<{ success: boolean; data: TeamInvite; message: string; inviteUrl: string; emailSent: boolean }>(
      "/api/enterprise/team/invites",
      { method: "POST", body: { email, role } }
    ),

  revokeInvite: (inviteId: string) =>
    api<{ success: boolean; message: string }>(
      `/api/enterprise/team/invites/${inviteId}`,
      { method: "DELETE" }
    ),

  updateMemberRole: (memberId: string, role: string) =>
    api<{ success: boolean; message: string }>(
      `/api/enterprise/team/${memberId}/role`,
      { method: "PATCH", body: { role } }
    ),

  removeMember: (memberId: string) =>
    api<{ success: boolean; message: string }>(
      `/api/enterprise/team/${memberId}`,
      { method: "DELETE" }
    ),

  acceptInvite: (token: string) =>
    api<{ success: boolean; data: { orgId: string; role: string }; message: string }>(
      `/api/enterprise/team/invites/${token}/accept`,
      { method: "POST" }
    ),

  // SSO Configuration
  getSsoConfig: () =>
    api<{ success: boolean; data: SsoConfig | null }>("/api/enterprise/sso"),

  configureSamlSso: (config: {
    entityId: string;
    ssoUrl: string;
    certificate: string;
    allowedDomains?: string[];
    autoProvision?: boolean;
    defaultRole?: string;
  }) =>
    api<{ success: boolean; data: { provider: string; enabled: boolean }; message: string }>(
      "/api/enterprise/sso/saml",
      { method: "POST", body: config }
    ),

  configureOidcSso: (config: {
    clientId: string;
    clientSecret: string;
    issuer: string;
    scopes?: string[];
    allowedDomains?: string[];
    autoProvision?: boolean;
    defaultRole?: string;
  }) =>
    api<{ success: boolean; data: { provider: string; enabled: boolean }; message: string }>(
      "/api/enterprise/sso/oidc",
      { method: "POST", body: config }
    ),

  disableSso: () =>
    api<{ success: boolean; message: string }>("/api/enterprise/sso/disable", {
      method: "POST",
    }),

  deleteSsoConfig: () =>
    api<{ success: boolean; message: string }>("/api/enterprise/sso", {
      method: "DELETE",
    }),
};

// ============================================
// Agent Graph API (Visual Builder)
// ============================================

export type GraphNodeType =
  | "input"
  | "output"
  | "llm"
  | "tool"
  | "condition"
  | "loop"
  | "memory"
  | "transform"
  | "api"
  | "code"
  | "delay"
  | "parallel"
  | "merge";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  position: { x: number; y: number };
  data: {
    label: string;
    config: Record<string, any>;
    inputs?: string[];
    outputs?: string[];
  };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
  animated?: boolean;
}

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface AgentGraph {
  agentId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport?: GraphViewport;
  version: number;
}

export interface GraphTemplate {
  id: string;
  name: string;
  nodeCount: number;
  description: string;
}

export interface GraphValidation {
  valid: boolean;
  issues: Array<{ type: "error" | "warning"; message: string }>;
}

export interface CompiledGraph {
  agentId: string;
  entryPoints: string[];
  exitPoints: string[];
  executionOrder: string[];
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
}

/** One node's record from a graph run (W2 linear interpreter). */
export interface GraphTraceEntry {
  nodeId: string;
  nodeType: string;
  label: string;
  /** `refused` = the interpreter deliberately will not run this node. */
  status: "success" | "failed" | "refused";
  input: string | null;
  output: string | null;
  error: string | null;
  durationMs: number;
  /** 0-based iteration when the node ran inside a loop body. */
  iteration?: number;
  /** The loop node whose body this entry belongs to. */
  loopId?: string;
}

export interface GraphRunResult {
  executionId: string;
  status: "completed" | "failed";
  output: string | null;
  error: string | null;
  trace: GraphTraceEntry[];
  durationMs: number;
}

export interface GraphExecutionRow {
  id: string;
  status: string;
  input: string | null;
  output: string | null;
  error: string | null;
  startedAt: string;
  durationMs: number | null;
}

export const agentGraphApi = {
  // Get agent graph
  getGraph: (agentId: string) =>
    api<{ success: boolean; data: AgentGraph }>(`/api/agents/${agentId}/graph`),

  // Save agent graph
  saveGraph: (
    agentId: string,
    data: { nodes: GraphNode[]; edges: GraphEdge[]; viewport?: GraphViewport }
  ) =>
    api<{ success: boolean; data: AgentGraph; message: string }>(
      `/api/agents/${agentId}/graph`,
      { method: "PUT", body: data }
    ),

  // Delete agent graph
  deleteGraph: (agentId: string) =>
    api<{ success: boolean; message: string }>(
      `/api/agents/${agentId}/graph`,
      { method: "DELETE" }
    ),

  // Get available templates
  getTemplates: () =>
    api<{ success: boolean; data: GraphTemplate[] }>("/api/graph-templates"),

  // Apply template to agent
  applyTemplate: (agentId: string, templateId: string) =>
    api<{ success: boolean; data: AgentGraph; message: string }>(
      `/api/agents/${agentId}/graph/template`,
      { method: "POST", body: { templateId } }
    ),

  // Validate graph
  validateGraph: (
    agentId: string,
    data: { nodes: GraphNode[]; edges: GraphEdge[] }
  ) =>
    api<{ success: boolean; data: GraphValidation }>(
      `/api/agents/${agentId}/graph/validate`,
      { method: "POST", body: data }
    ),

  // Run the graph through the linear interpreter (W2). Compiling only
  // produces an execution ORDER; this actually walks it.
  runGraph: (agentId: string, input: string) =>
    api<{ success: boolean; data: GraphRunResult }>(
      `/api/agents/${agentId}/graph/run`,
      { method: "POST", body: { input } }
    ),

  // Past runs, newest first.
  getGraphExecutions: (agentId: string, limit = 20) =>
    api<{ success: boolean; data: GraphExecutionRow[] }>(
      `/api/agents/${agentId}/graph/executions?limit=${limit}`
    ),

  // Compile graph for execution
  compileGraph: (agentId: string) =>
    api<{ success: boolean; data: CompiledGraph; message: string }>(
      `/api/agents/${agentId}/graph/compile`,
      { method: "POST" }
    ),
};

// ============================================
// Monitoring & Alerting API
// ============================================

export type ChannelType = "slack" | "discord" | "email" | "webhook" | "pagerduty";
export type Severity = "info" | "warning" | "critical";
export type AlertStatus = "active" | "acknowledged" | "resolved";

export interface AlertChannel {
  id: string;
  orgId: string;
  name: string;
  type: ChannelType;
  config: Record<string, any>;
  isEnabled: boolean;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlertRule {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  ruleType: string;
  resourceType: string;
  resourceId: string | null;
  metric: string;
  operator: string;
  threshold: number;
  windowMinutes: number;
  severity: Severity;
  cooldownMinutes: number;
  isEnabled: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  channels?: Array<{ channel: AlertChannel }>;
  _count?: { alerts: number };
}

export interface Alert {
  id: string;
  orgId: string;
  ruleId: string;
  status: AlertStatus;
  severity: Severity;
  title: string;
  message: string;
  resourceType: string;
  resourceId: string | null;
  metricValue: number;
  threshold: number;
  triggeredAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  rule?: { name: string; resourceType: string };
}

export interface UptimeMonitor {
  id: string;
  orgId: string;
  name: string;
  targetType: string;
  targetId: string | null;
  targetUrl: string | null;
  checkIntervalSeconds: number;
  timeoutSeconds: number;
  httpMethod: string;
  expectedStatus: number;
  expectedBody: string | null;
  headers: Record<string, string> | null;
  isEnabled: boolean;
  currentStatus: string;
  lastCheckAt: string | null;
  lastUpAt: string | null;
  lastDownAt: string | null;
  uptimePercent24h: number | null;
  uptimePercent7d: number | null;
  uptimePercent30d: number | null;
  avgLatencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface UptimeEvent {
  id: string;
  monitorId: string;
  status: string;
  statusCode: number | null;
  latencyMs: number | null;
  errorMessage: string | null;
  checkRegion: string | null;
  checkedAt: string;
}

export interface AlertStats {
  byStatus: Array<{ status: string; count: number }>;
  bySeverity: Array<{ severity: string; count: number }>;
  topRules: Array<{ ruleId: string; count: number }>;
  totalRecent: number;
}

export interface UptimeSummary {
  totalMonitors: number;
  totalUp: number;
  totalDown: number;
  avgUptime24h: number | null;
  monitors: Array<{
    id: string;
    name: string;
    targetType: string;
    currentStatus: string;
    uptimePercent24h: number | null;
    avgLatencyMs: number | null;
    lastCheckAt: string | null;
  }>;
}

export interface CreateAlertChannelInput {
  name: string;
  type: ChannelType;
  config: Record<string, any>;
}

export interface CreateAlertRuleInput {
  name: string;
  description?: string;
  ruleType: "threshold" | "anomaly" | "uptime" | "budget";
  resourceType: "deployment" | "agent" | "organization";
  resourceId?: string;
  metric: string;
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
  threshold: number;
  windowMinutes?: number;
  severity?: Severity;
  cooldownMinutes?: number;
  channelIds: string[];
}

export interface CreateUptimeMonitorInput {
  name: string;
  targetType: "deployment" | "agent" | "custom_url";
  targetId?: string;
  targetUrl?: string;
  checkIntervalSeconds?: number;
  timeoutSeconds?: number;
  httpMethod?: string;
  expectedStatus?: number;
  expectedBody?: string;
  headers?: Record<string, string>;
}

export const monitoringApi = {
  // Alert Channels
  getChannels: () =>
    api<{ success: boolean; data: AlertChannel[] }>("/api/monitoring/channels"),

  createChannel: (input: CreateAlertChannelInput) =>
    api<{ success: boolean; data: AlertChannel; message: string }>(
      "/api/monitoring/channels",
      { method: "POST", body: input }
    ),

  updateChannel: (
    channelId: string,
    updates: Partial<CreateAlertChannelInput> & { isEnabled?: boolean }
  ) =>
    api<{ success: boolean; data: AlertChannel; message: string }>(
      `/api/monitoring/channels/${channelId}`,
      { method: "PATCH", body: updates }
    ),

  deleteChannel: (channelId: string) =>
    api<{ success: boolean; message: string }>(
      `/api/monitoring/channels/${channelId}`,
      { method: "DELETE" }
    ),

  testChannel: (channelId: string) =>
    api<{ success: boolean; message: string }>(
      `/api/monitoring/channels/${channelId}/test`,
      { method: "POST" }
    ),

  // Alert Rules
  getRules: () =>
    api<{ success: boolean; data: AlertRule[] }>("/api/monitoring/rules"),

  getRule: (ruleId: string) =>
    api<{ success: boolean; data: AlertRule }>(`/api/monitoring/rules/${ruleId}`),

  createRule: (input: CreateAlertRuleInput) =>
    api<{ success: boolean; data: AlertRule; message: string }>(
      "/api/monitoring/rules",
      { method: "POST", body: input }
    ),

  updateRule: (ruleId: string, updates: Partial<CreateAlertRuleInput>) =>
    api<{ success: boolean; data: AlertRule; message: string }>(
      `/api/monitoring/rules/${ruleId}`,
      { method: "PATCH", body: updates }
    ),

  deleteRule: (ruleId: string) =>
    api<{ success: boolean; message: string }>(
      `/api/monitoring/rules/${ruleId}`,
      { method: "DELETE" }
    ),

  toggleRule: (ruleId: string, isEnabled: boolean) =>
    api<{ success: boolean; data: AlertRule; message: string }>(
      `/api/monitoring/rules/${ruleId}/toggle`,
      { method: "POST", body: { isEnabled } }
    ),

  // Alerts
  getAlerts: (params?: {
    status?: string;
    severity?: string;
    ruleId?: string;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set("status", params.status);
    if (params?.severity) searchParams.set("severity", params.severity);
    if (params?.ruleId) searchParams.set("ruleId", params.ruleId);
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    const query = searchParams.toString();
    return api<{
      success: boolean;
      data: Alert[];
      pagination: { total: number; limit: number; offset: number };
    }>(`/api/monitoring/alerts${query ? `?${query}` : ""}`);
  },

  acknowledgeAlert: (alertId: string) =>
    api<{ success: boolean; data: Alert; message: string }>(
      `/api/monitoring/alerts/${alertId}/acknowledge`,
      { method: "POST" }
    ),

  resolveAlert: (alertId: string) =>
    api<{ success: boolean; data: Alert; message: string }>(
      `/api/monitoring/alerts/${alertId}/resolve`,
      { method: "POST" }
    ),

  getAlertStats: (days = 7) =>
    api<{ success: boolean; data: AlertStats }>(
      `/api/monitoring/alerts/stats?days=${days}`
    ),

  // Uptime Monitoring
  getUptimeSummary: () =>
    api<{ success: boolean; data: UptimeSummary }>("/api/monitoring/uptime/summary"),

  getUptimeMonitors: () =>
    api<{ success: boolean; data: UptimeMonitor[] }>("/api/monitoring/uptime"),

  getUptimeMonitor: (monitorId: string) =>
    api<{ success: boolean; data: UptimeMonitor & { events: UptimeEvent[] } }>(
      `/api/monitoring/uptime/${monitorId}`
    ),

  createUptimeMonitor: (input: CreateUptimeMonitorInput) =>
    api<{ success: boolean; data: UptimeMonitor; message: string }>(
      "/api/monitoring/uptime",
      { method: "POST", body: input }
    ),

  updateUptimeMonitor: (
    monitorId: string,
    updates: Partial<CreateUptimeMonitorInput> & { isEnabled?: boolean }
  ) =>
    api<{ success: boolean; data: UptimeMonitor; message: string }>(
      `/api/monitoring/uptime/${monitorId}`,
      { method: "PATCH", body: updates }
    ),

  deleteUptimeMonitor: (monitorId: string) =>
    api<{ success: boolean; message: string }>(
      `/api/monitoring/uptime/${monitorId}`,
      { method: "DELETE" }
    ),
};

// ============================================
// Agent Versioning API
// ============================================

export type ChangeType = "major" | "minor" | "patch";

export interface AgentVersion {
  id: string;
  agentId: string;
  version: string;
  versionNumber: number;
  name: string;
  description: string | null;
  framework: string;
  systemPrompt: string | null;
  tools: any[];
  modelConfig: Record<string, any>;
  sourceType: string;
  sourceUrl: string | null;
  sourceCode: string | null;
  env: Record<string, any>;
  graphNodes: any[] | null;
  graphEdges: any[] | null;
  /** How the agent answered at this version; null when it was not recorded. */
  entrypoint?: "chat" | "graph" | null;
  changeLog: string | null;
  changeType: string;
  tags: string[];
  // Null when an API key created the version (createdByApiKeyId is set).
  createdById: string | null;
  createdByApiKeyId: string | null;
  createdByName: string;
  isLatest: boolean;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
}

export interface AgentVersionSummary {
  id: string;
  version: string;
  versionNumber: number;
  changeLog: string | null;
  changeType: string;
  tags: string[];
  // Null when an API key created the version (createdByApiKeyId is set).
  createdById: string | null;
  createdByApiKeyId: string | null;
  createdByName: string;
  isLatest: boolean;
  isPublished: boolean;
  createdAt: string;
}

export interface AgentVersionDiff {
  id: string;
  agentId: string;
  fromVersion: string;
  toVersion: string;
  changes: Record<string, { from: any; to: any }>;
  addedFields: string[];
  removedFields: string[];
  modifiedFields: string[];
  linesAdded: number;
  linesRemoved: number;
  createdAt: string;
}

export interface VersionHistoryEntry extends AgentVersionSummary {
  diff: {
    addedFields: string[];
    removedFields: string[];
    modifiedFields: string[];
    linesAdded: number;
    linesRemoved: number;
  } | null;
}

export interface CreateVersionInput {
  changeLog?: string;
  changeType?: ChangeType;
  tags?: string[];
}

export const versioningApi = {
  // Get all versions of an agent
  getVersions: (agentId: string, params?: { limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    const query = searchParams.toString();
    return api<{ versions: AgentVersionSummary[]; total: number }>(
      `/api/versioning/agents/${agentId}/versions${query ? `?${query}` : ""}`
    );
  },

  // Get version history with diffs
  getHistory: (agentId: string, limit = 10) =>
    api<VersionHistoryEntry[]>(
      `/api/versioning/agents/${agentId}/history?limit=${limit}`
    ),

  // Get a specific version
  getVersion: (agentId: string, version: string) =>
    api<AgentVersion>(`/api/versioning/agents/${agentId}/versions/${version}`),

  // Get the latest version
  getLatestVersion: (agentId: string) =>
    api<AgentVersion>(`/api/versioning/agents/${agentId}/versions/latest`),

  // Create a new version
  createVersion: (agentId: string, input: CreateVersionInput = {}) =>
    api<AgentVersion>(`/api/versioning/agents/${agentId}/versions`, {
      method: "POST",
      body: input,
    }),

  // Compare two versions
  compareVersions: (agentId: string, fromVersion: string, toVersion: string) =>
    api<AgentVersionDiff>(
      `/api/versioning/agents/${agentId}/compare?from=${fromVersion}&to=${toVersion}`
    ),

  // Rollback to a specific version
  rollbackToVersion: (agentId: string, version: string) =>
    api<AgentVersion>(
      `/api/versioning/agents/${agentId}/versions/${version}/rollback`,
      { method: "POST" }
    ),

  // Tag a version
  tagVersion: (agentId: string, version: string, tags: string[]) =>
    api<AgentVersion>(
      `/api/versioning/agents/${agentId}/versions/${version}/tag`,
      { method: "POST", body: { tags } }
    ),

  // Publish a version
  publishVersion: (agentId: string, version: string) =>
    api<AgentVersion>(
      `/api/versioning/agents/${agentId}/versions/${version}/publish`,
      { method: "POST" }
    ),

  // Delete a version
  deleteVersion: (agentId: string, version: string) =>
    api<void>(`/api/versioning/agents/${agentId}/versions/${version}`, {
      method: "DELETE",
    }),
};

// ============================================
// Webhooks & Integrations API
// ============================================

export type WebhookEventType =
  | "agent.created"
  | "agent.updated"
  | "agent.deleted"
  | "agent.deployed"
  | "agent.version.created"
  | "deployment.started"
  | "deployment.running"
  | "deployment.stopped"
  | "deployment.failed"
  | "training.started"
  | "training.completed"
  | "training.failed"
  | "alert.triggered"
  | "alert.resolved"
  | "billing.low_balance"
  | "billing.payment_received";

export type IntegrationType = "slack" | "discord" | "github" | "zapier" | "make" | "n8n";

export interface Webhook {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  url: string;
  secret?: string;
  events: string[];
  resourceType: string | null;
  resourceId: string | null;
  isEnabled: boolean;
  retryCount: number;
  timeoutSeconds: number;
  headers: Record<string, string> | null;
  lastDeliveredAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventType: string;
  eventId: string;
  payload: any;
  attempt: number;
  status: "pending" | "success" | "failed" | "retrying";
  statusCode: number | null;
  responseBody: string | null;
  responseTimeMs: number | null;
  errorMessage: string | null;
  scheduledAt: string;
  deliveredAt: string | null;
  nextRetryAt: string | null;
}

export interface Integration {
  id: string;
  orgId: string;
  type: IntegrationType;
  name: string;
  config: Record<string, any>;
  scopes: string[];
  isEnabled: boolean;
  isConnected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  externalId: string | null;
  externalName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationEvent {
  id: string;
  integrationId: string;
  eventType: string;
  action: string;
  inputPayload: any;
  outputPayload: any;
  status: "pending" | "success" | "failed";
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AvailableIntegration {
  type: string;
  name: string;
  description: string;
  icon: string;
  features: string[];
  requiresOAuth: boolean;
}

export interface CreateWebhookInput {
  name: string;
  description?: string;
  url: string;
  events: string[];
  resourceType?: string;
  resourceId?: string;
  headers?: Record<string, string>;
  retryCount?: number;
  timeoutSeconds?: number;
}

export interface CreateIntegrationInput {
  type: IntegrationType;
  name: string;
  config?: Record<string, any>;
  scopes?: string[];
}

export const webhooksApi = {
  // Webhook Events
  getEvents: () =>
    api<{
      events: WebhookEventType[];
      categories: Record<string, WebhookEventType[]>;
    }>("/api/webhooks/events"),

  // Webhooks
  getWebhooks: (params?: { limit?: number; offset?: number; isEnabled?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    if (params?.isEnabled !== undefined) searchParams.set("isEnabled", params.isEnabled.toString());
    const query = searchParams.toString();
    return api<{ webhooks: Webhook[]; total: number }>(
      `/api/webhooks${query ? `?${query}` : ""}`
    );
  },

  getWebhook: (webhookId: string) =>
    api<Webhook & { deliveries: WebhookDelivery[] }>(`/api/webhooks/${webhookId}`),

  createWebhook: (input: CreateWebhookInput) =>
    api<Webhook>("/api/webhooks", {
      method: "POST",
      body: input,
    }),

  updateWebhook: (
    webhookId: string,
    updates: Partial<CreateWebhookInput> & { isEnabled?: boolean }
  ) =>
    api<Webhook>(`/api/webhooks/${webhookId}`, {
      method: "PATCH",
      body: updates,
    }),

  deleteWebhook: (webhookId: string) =>
    api<void>(`/api/webhooks/${webhookId}`, { method: "DELETE" }),

  regenerateSecret: (webhookId: string) =>
    api<{ id: string; secret: string }>(
      `/api/webhooks/${webhookId}/regenerate-secret`,
      { method: "POST" }
    ),

  testWebhook: (webhookId: string) =>
    api<{
      success: boolean;
      statusCode?: number;
      responseTimeMs: number;
      error?: string;
      deliveryId: string;
    }>(`/api/webhooks/${webhookId}/test`, { method: "POST" }),

  // Webhook Deliveries
  getDeliveries: (
    webhookId: string,
    params?: { limit?: number; offset?: number; status?: string }
  ) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    if (params?.status) searchParams.set("status", params.status);
    const query = searchParams.toString();
    return api<{ deliveries: WebhookDelivery[]; total: number }>(
      `/api/webhooks/${webhookId}/deliveries${query ? `?${query}` : ""}`
    );
  },

  retryDelivery: (webhookId: string, deliveryId: string) =>
    api<{ message: string }>(
      `/api/webhooks/${webhookId}/deliveries/${deliveryId}/retry`,
      { method: "POST" }
    ),
};

export const integrationsApi = {
  // Available Integrations
  getAvailable: () =>
    api<{ integrations: AvailableIntegration[]; types: IntegrationType[] }>(
      "/api/integrations/available"
    ),

  // Integrations
  getIntegrations: (params?: {
    type?: IntegrationType;
    isEnabled?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set("type", params.type);
    if (params?.isEnabled !== undefined) searchParams.set("isEnabled", params.isEnabled.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    const query = searchParams.toString();
    return api<{ integrations: Integration[]; total: number }>(
      `/api/integrations${query ? `?${query}` : ""}`
    );
  },

  getIntegration: (integrationId: string) =>
    api<Integration>(`/api/integrations/${integrationId}`),

  createIntegration: (input: CreateIntegrationInput) =>
    api<Integration>("/api/integrations", {
      method: "POST",
      body: input,
    }),

  updateIntegration: (
    integrationId: string,
    updates: Partial<Omit<CreateIntegrationInput, "type">> & { isEnabled?: boolean }
  ) =>
    api<Integration>(`/api/integrations/${integrationId}`, {
      method: "PATCH",
      body: updates,
    }),

  deleteIntegration: (integrationId: string) =>
    api<void>(`/api/integrations/${integrationId}`, { method: "DELETE" }),

  disconnectIntegration: (integrationId: string) =>
    api<Integration>(`/api/integrations/${integrationId}/disconnect`, {
      method: "POST",
    }),

  // Integration Events
  getEvents: (
    integrationId: string,
    params?: { limit?: number; offset?: number; status?: string; action?: string }
  ) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    if (params?.status) searchParams.set("status", params.status);
    if (params?.action) searchParams.set("action", params.action);
    const query = searchParams.toString();
    return api<{ events: IntegrationEvent[]; total: number }>(
      `/api/integrations/${integrationId}/events${query ? `?${query}` : ""}`
    );
  },

  testIntegration: (integrationId: string, action: string, payload?: Record<string, any>) =>
    api<{ success: boolean; result: any }>(
      `/api/integrations/${integrationId}/test`,
      { method: "POST", body: { action, payload } }
    ),
};

// ============================================
// Testing Framework API
// ============================================

export type AssertionType =
  | "exact"
  | "contains"
  | "regex"
  | "semantic"
  | "json_schema"
  | "function";

export type TestRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TestResultStatus = "passed" | "failed" | "skipped" | "error";

export interface TestSuite {
  id: string;
  orgId: string;
  agentId: string;
  name: string;
  description: string | null;
  timeout: number;
  retries: number;
  parallel: boolean;
  tags: string[];
  isEnabled: boolean;
  totalTests: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  passRate: number | null;
  createdAt: string;
  updatedAt: string;
  _count?: { testCases: number; testRuns: number };
}

export interface TestCase {
  id: string;
  suiteId: string;
  name: string;
  description: string | null;
  inputType: "message" | "conversation" | "api";
  input: any;
  assertionType: AssertionType;
  expected: any;
  tolerance: number | null;
  priority: number;
  tags: string[];
  isEnabled: boolean;
  customScript: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TestRun {
  id: string;
  suiteId: string;
  agentVersion: string | null;
  deploymentId: string | null;
  status: TestRunStatus;
  progress: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  passRate: number | null;
  totalDurationMs: number | null;
  triggeredBy: string | null;
  triggeredById: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface TestResult {
  id: string;
  runId: string;
  testCaseId: string;
  status: TestResultStatus;
  durationMs: number | null;
  actualOutput: any;
  error: string | null;
  assertionResult: {
    passed: boolean;
    details: string;
    score?: number;
  } | null;
  attempt: number;
  createdAt: string;
  testCase?: { name: string; description: string | null };
}

export interface TestStats {
  totalSuites: number;
  totalTests: number;
  avgPassRate: number;
  recentRuns: Array<TestRun & { suite: { name: string } }>;
}

export interface CreateTestSuiteInput {
  agentId: string;
  name: string;
  description?: string;
  timeout?: number;
  retries?: number;
  parallel?: boolean;
  tags?: string[];
}

export interface CreateTestCaseInput {
  name: string;
  description?: string;
  inputType: "message" | "conversation" | "api";
  input: any;
  assertionType: AssertionType;
  expected: any;
  tolerance?: number;
  priority?: number;
  tags?: string[];
  customScript?: string;
}

export const testingApi = {
  // Test Suites
  getSuites: (params?: { agentId?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.agentId) searchParams.set("agentId", params.agentId);
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    const query = searchParams.toString();
    return api<{ success: boolean; data: { suites: TestSuite[]; total: number } }>(
      `/api/testing/suites${query ? `?${query}` : ""}`
    );
  },

  getSuite: (suiteId: string) =>
    api<{
      success: boolean;
      data: TestSuite & { testCases: TestCase[]; testRuns: TestRun[] };
    }>(`/api/testing/suites/${suiteId}`),

  createSuite: (input: CreateTestSuiteInput) =>
    api<{ success: boolean; data: TestSuite }>("/api/testing/suites", {
      method: "POST",
      body: input,
    }),

  updateSuite: (suiteId: string, updates: Partial<CreateTestSuiteInput>) =>
    api<{ success: boolean; data: TestSuite }>(`/api/testing/suites/${suiteId}`, {
      method: "PATCH",
      body: updates,
    }),

  deleteSuite: (suiteId: string) =>
    api<void>(`/api/testing/suites/${suiteId}`, { method: "DELETE" }),

  // Test Cases
  getCases: (suiteId: string) =>
    api<{ success: boolean; data: TestCase[] }>(
      `/api/testing/suites/${suiteId}/cases`
    ),

  createCase: (suiteId: string, input: CreateTestCaseInput) =>
    api<{ success: boolean; data: TestCase }>(
      `/api/testing/suites/${suiteId}/cases`,
      { method: "POST", body: input }
    ),

  updateCase: (suiteId: string, caseId: string, updates: Partial<CreateTestCaseInput>) =>
    api<{ success: boolean; data: TestCase }>(
      `/api/testing/suites/${suiteId}/cases/${caseId}`,
      { method: "PATCH", body: updates }
    ),

  deleteCase: (suiteId: string, caseId: string) =>
    api<void>(`/api/testing/suites/${suiteId}/cases/${caseId}`, { method: "DELETE" }),

  toggleCase: (suiteId: string, caseId: string, isEnabled: boolean) =>
    api<{ success: boolean; data: TestCase }>(
      `/api/testing/suites/${suiteId}/cases/${caseId}/toggle`,
      { method: "POST", body: { isEnabled } }
    ),

  // Test Runs
  runSuite: (suiteId: string, deploymentId?: string) =>
    api<{ success: boolean; data: TestRun; message: string }>(
      `/api/testing/suites/${suiteId}/run`,
      { method: "POST", body: { deploymentId } }
    ),

  getRuns: (
    suiteId: string,
    params?: { limit?: number; offset?: number; status?: string }
  ) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    if (params?.status) searchParams.set("status", params.status);
    const query = searchParams.toString();
    return api<{ success: boolean; data: { runs: TestRun[]; total: number } }>(
      `/api/testing/suites/${suiteId}/runs${query ? `?${query}` : ""}`
    );
  },

  getRun: (suiteId: string, runId: string) =>
    api<{ success: boolean; data: TestRun & { results: TestResult[] } }>(
      `/api/testing/suites/${suiteId}/runs/${runId}`
    ),

  cancelRun: (suiteId: string, runId: string) =>
    api<{ success: boolean; data: TestRun; message: string }>(
      `/api/testing/suites/${suiteId}/runs/${runId}/cancel`,
      { method: "POST" }
    ),

  // Stats
  getStats: (agentId?: string) => {
    const query = agentId ? `?agentId=${agentId}` : "";
    return api<{ success: boolean; data: TestStats }>(
      `/api/testing/stats${query}`
    );
  },
};

// ============================================
// Conversation Memory API
// ============================================

export type MessageRole = "user" | "assistant" | "system" | "function";
export type ContextType = "fact" | "preference" | "summary" | "entity" | "custom";

export interface Conversation {
  id: string;
  userId: string;
  agentId: string;
  deploymentId: string | null;
  externalId: string | null;
  title: string | null;
  summary: string | null;
  isActive: boolean;
  messageCount: number;
  totalTokens: number;
  metadata: Record<string, any> | null;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
  agent?: { id: string; name: string };
  deployment?: { id: string; name: string };
  _count?: { messages: number; memoryContexts: number };
}

export interface ConversationDetail extends Conversation {
  agent?: { id: string; name: string; systemPrompt: string | null };
  messages: Message[];
  memoryContexts: MemoryContext[];
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  functionName: string | null;
  functionArgs: Record<string, any> | null;
  metadata: Record<string, any> | null;
  tokens: number | null;
  createdAt: string;
}

export interface MemoryContext {
  id: string;
  conversationId: string;
  key: string;
  value: string;
  contextType: ContextType;
  importance: number;
  accessCount: number;
  expiresAt: string | null;
  metadata: Record<string, any> | null;
  lastAccessedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationStats {
  totalConversations: number;
  activeConversations: number;
  totalMessages: number;
  totalTokens: number;
  avgMessagesPerConversation: number;
  totalMemoryContexts: number;
}

export interface RelevantMemory {
  systemPrompt: string | null;
  summary: string | null;
  recentMessages: Message[];
  memoryContexts: MemoryContext[];
}

export interface CreateConversationInput {
  agentId: string;
  deploymentId?: string;
  externalId?: string;
  metadata?: Record<string, any>;
}

export interface AddMessageInput {
  role: MessageRole;
  content: string;
  functionName?: string;
  functionArgs?: Record<string, any>;
  metadata?: Record<string, any>;
  tokens?: number;
}

export interface CreateMemoryContextInput {
  key: string;
  value: string;
  contextType: ContextType;
  importance?: number;
  expiresAt?: string;
  metadata?: Record<string, any>;
}

export const memoryApi = {
  // Stats
  getStats: (agentId?: string) => {
    const query = agentId ? `?agentId=${agentId}` : "";
    return api<ConversationStats>(`/api/memory/stats${query}`);
  },

  // Conversations
  getConversations: (params?: {
    agentId?: string;
    deploymentId?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.agentId) searchParams.set("agentId", params.agentId);
    if (params?.deploymentId) searchParams.set("deploymentId", params.deploymentId);
    if (params?.isActive !== undefined) searchParams.set("isActive", params.isActive.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    const query = searchParams.toString();
    return api<{ conversations: Conversation[]; total: number; limit: number; offset: number }>(
      `/api/memory/conversations${query ? `?${query}` : ""}`
    );
  },

  createConversation: (input: CreateConversationInput) =>
    api<Conversation>("/api/memory/conversations", {
      method: "POST",
      body: input,
    }),

  getConversation: (conversationId: string) =>
    api<ConversationDetail>(`/api/memory/conversations/${conversationId}`),

  getConversationByExternalId: (externalId: string) =>
    api<Conversation>(`/api/memory/conversations/external/${externalId}`),

  updateConversation: (
    conversationId: string,
    updates: {
      title?: string;
      summary?: string;
      isActive?: boolean;
      metadata?: Record<string, any>;
    }
  ) =>
    api<Conversation>(`/api/memory/conversations/${conversationId}`, {
      method: "PATCH",
      body: updates,
    }),

  deleteConversation: (conversationId: string) =>
    api<{ success: boolean }>(`/api/memory/conversations/${conversationId}`, {
      method: "DELETE",
    }),

  // Messages
  getMessages: (
    conversationId: string,
    params?: { limit?: number; before?: string; after?: string }
  ) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.before) searchParams.set("before", params.before);
    if (params?.after) searchParams.set("after", params.after);
    const query = searchParams.toString();
    return api<Message[]>(
      `/api/memory/conversations/${conversationId}/messages${query ? `?${query}` : ""}`
    );
  },

  addMessage: (conversationId: string, input: AddMessageInput) =>
    api<Message>(`/api/memory/conversations/${conversationId}/messages`, {
      method: "POST",
      body: input,
    }),

  deleteMessage: (conversationId: string, messageId: string) =>
    api<{ success: boolean }>(
      `/api/memory/conversations/${conversationId}/messages/${messageId}`,
      { method: "DELETE" }
    ),

  // Memory Contexts
  getMemoryContexts: (
    conversationId: string,
    params?: { contextTypes?: string; minImportance?: number; limit?: number }
  ) => {
    const searchParams = new URLSearchParams();
    if (params?.contextTypes) searchParams.set("contextTypes", params.contextTypes);
    if (params?.minImportance !== undefined)
      searchParams.set("minImportance", params.minImportance.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    const query = searchParams.toString();
    return api<MemoryContext[]>(
      `/api/memory/conversations/${conversationId}/memory${query ? `?${query}` : ""}`
    );
  },

  addMemoryContext: (conversationId: string, input: CreateMemoryContextInput) =>
    api<MemoryContext>(`/api/memory/conversations/${conversationId}/memory`, {
      method: "POST",
      body: input,
    }),

  updateMemoryContext: (
    conversationId: string,
    contextId: string,
    updates: {
      value?: string;
      importance?: number;
      expiresAt?: string | null;
      metadata?: Record<string, any>;
    }
  ) =>
    api<MemoryContext>(
      `/api/memory/conversations/${conversationId}/memory/${contextId}`,
      { method: "PATCH", body: updates }
    ),

  deleteMemoryContext: (conversationId: string, contextId: string) =>
    api<{ success: boolean }>(
      `/api/memory/conversations/${conversationId}/memory/${contextId}`,
      { method: "DELETE" }
    ),

  // Context retrieval for inference
  getRelevantMemory: (
    conversationId: string,
    params?: { contextTypes?: string; minImportance?: number; limit?: number }
  ) => {
    const searchParams = new URLSearchParams();
    if (params?.contextTypes) searchParams.set("contextTypes", params.contextTypes);
    if (params?.minImportance !== undefined)
      searchParams.set("minImportance", params.minImportance.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    const query = searchParams.toString();
    return api<RelevantMemory>(
      `/api/memory/conversations/${conversationId}/context${query ? `?${query}` : ""}`
    );
  },

  // Summarization
  summarizeConversation: (conversationId: string, summary: string) =>
    api<Conversation>(`/api/memory/conversations/${conversationId}/summarize`, {
      method: "POST",
      body: { summary },
    }),

  // Fact extraction
  extractFacts: (
    conversationId: string,
    facts: Array<{
      key: string;
      value: string;
      contextType: "fact" | "preference" | "entity";
      importance?: number;
    }>
  ) =>
    api<MemoryContext[]>(`/api/memory/conversations/${conversationId}/extract`, {
      method: "POST",
      body: { facts },
    }),
};

// ============================================
// Custom Domains API
// ============================================

export type VerificationStatus = "pending" | "verified" | "failed" | "expired";
export type SslStatus = "pending" | "provisioning" | "active" | "failed" | "expired";

export interface CustomDomain {
  id: string;
  orgId: string;
  domain: string;
  subdomain: string | null;
  rootDomain: string;
  targetType: "agent" | "deployment";
  targetId: string;
  verificationStatus: VerificationStatus;
  verificationToken: string;
  verificationMethod: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  verificationError: string | null;
  sslStatus: SslStatus;
  sslProvider: string | null;
  sslExpiresAt: string | null;
  sslError: string | null;
  routingMode: string;
  forceHttps: boolean;
  headers: Record<string, string> | null;
  isActive: boolean;
  isPrimary: boolean;
  totalRequests: number;
  lastRequestAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DnsRecords {
  txtRecord: {
    name: string;
    type: string;
    value: string;
  };
  cnameRecord: {
    name: string;
    type: string;
    value: string;
  };
}

export interface CustomDomainWithDns extends CustomDomain {
  dnsRecords: DnsRecords;
}

export interface DomainEvent {
  id: string;
  domainId: string;
  eventType: string;
  message: string | null;
  details: Record<string, any> | null;
  previousStatus: string | null;
  newStatus: string | null;
  createdAt: string;
}

export interface DomainStats {
  total: number;
  verified: number;
  active: number;
  pending: number;
  sslExpiringSoon: number;
}

export interface SslStatusInfo {
  sslStatus: SslStatus;
  sslProvider: string | null;
  sslExpiresAt: string | null;
  sslError: string | null;
  needsRenewal: boolean;
}

export interface CreateDomainInput {
  domain: string;
  targetType: "agent" | "deployment";
  targetId: string;
  forceHttps?: boolean;
  headers?: Record<string, string>;
}

export const domainsApi = {
  // Stats
  getStats: () =>
    api<{ success: boolean; data: DomainStats }>("/api/domains/stats"),

  // List domains
  getDomains: (params?: {
    targetType?: string;
    targetId?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.targetType) searchParams.set("targetType", params.targetType);
    if (params?.targetId) searchParams.set("targetId", params.targetId);
    if (params?.isActive !== undefined) searchParams.set("isActive", params.isActive.toString());
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    const query = searchParams.toString();
    return api<{
      success: boolean;
      data: { domains: CustomDomain[]; total: number; limit: number; offset: number };
    }>(`/api/domains${query ? `?${query}` : ""}`);
  },

  // Create domain
  createDomain: (input: CreateDomainInput) =>
    api<{ success: boolean; data: CustomDomainWithDns; message: string }>("/api/domains", {
      method: "POST",
      body: input,
    }),

  // Get domain
  getDomain: (domainId: string) =>
    api<{ success: boolean; data: CustomDomainWithDns }>(`/api/domains/${domainId}`),

  // Update domain
  updateDomain: (
    domainId: string,
    updates: {
      forceHttps?: boolean;
      headers?: Record<string, string>;
      isPrimary?: boolean;
    }
  ) =>
    api<{ success: boolean; data: CustomDomain; message: string }>(`/api/domains/${domainId}`, {
      method: "PATCH",
      body: updates,
    }),

  // Delete domain
  deleteDomain: (domainId: string) =>
    api<{ success: boolean; message: string }>(`/api/domains/${domainId}`, {
      method: "DELETE",
    }),

  // Verify domain
  verifyDomain: (domainId: string) =>
    api<{
      success: boolean;
      data: {
        verified: boolean;
        domain?: CustomDomain;
        message?: string;
        error?: string;
        dnsRecords?: DnsRecords;
      };
    }>(`/api/domains/${domainId}/verify`, { method: "POST" }),

  // Re-verify domain (get new token)
  reverifyDomain: (domainId: string) =>
    api<{
      success: boolean;
      data: { domain: CustomDomain; dnsRecords: DnsRecords };
      message: string;
    }>(`/api/domains/${domainId}/reverify`, { method: "POST" }),

  // Toggle domain active status
  toggleDomain: (domainId: string, isActive: boolean) =>
    api<{ success: boolean; data: CustomDomain; message: string }>(
      `/api/domains/${domainId}/toggle`,
      { method: "POST", body: { isActive } }
    ),

  // Get SSL status
  getSslStatus: (domainId: string) =>
    api<{ success: boolean; data: SslStatusInfo }>(`/api/domains/${domainId}/ssl`),

  // Renew SSL
  renewSsl: (domainId: string) =>
    api<{ success: boolean; data: { message: string } }>(`/api/domains/${domainId}/ssl/renew`, {
      method: "POST",
    }),

  // Get domain events
  getDomainEvents: (domainId: string, params?: { limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set("limit", params.limit.toString());
    if (params?.offset) searchParams.set("offset", params.offset.toString());
    const query = searchParams.toString();
    return api<{
      success: boolean;
      data: { events: DomainEvent[]; total: number; limit: number; offset: number };
    }>(`/api/domains/${domainId}/events${query ? `?${query}` : ""}`);
  },
};

// ============================================
// Scheduled Tasks API (Phase 5)
// ============================================

/**
 * The status and body of a failed API call, or null for any other error.
 * For callers that map a contract error (`error`, `field`, `step`,
 * `details.fieldErrors`) onto a form instead of only showing its message.
 */
export function getApiErrorBody(
  err: unknown
): { status: number; body: Record<string, unknown> } | null {
  if (!(err instanceof ApiError)) return null;
  const body =
    typeof err.data === "object" && err.data !== null
      ? (err.data as Record<string, unknown>)
      : {};
  return { status: err.status, body };
}

export type ScheduleType = "cron" | "interval" | "once";

export interface ScheduledTask {
  id: string;
  orgId: string;
  /** Null for task types that need no agent (webhook, workflow_run, ...). */
  agentId: string | null;
  /** The workflow a workflow_run task starts. */
  orchestrationId: string | null;
  name: string;
  description?: string | null;
  scheduleType: ScheduleType | string;
  cronExpression?: string | null;
  intervalSeconds?: number | null;
  scheduledAt?: string | null;
  timezone: string;
  taskType: string;
  payload: Record<string, unknown>;
  timeout: number;
  maxRetries: number;
  isEnabled: boolean;
  status: string;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  lastRunDurationMs?: number | null;
  lastError?: string | null;
  nextRunAt?: string | null;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  createdAt: string;
}

export interface TaskExecution {
  id: string;
  taskId: string;
  /** 'running' | 'success' | 'failed' | 'timeout' | 'cancelled' */
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  attempt: number;
  triggeredBy: string;
  /** Set on a workflow_run execution: the workflow run that finishes it. */
  orchestrationExecutionId?: string | null;
  createdAt: string;
}

export interface SchedulerStats {
  /** False when no worker fires schedules on this server. */
  schedulerEnabled: boolean;
  intervalMs: number;
  totalTasks: number;
  activeTasks: number;
  pausedTasks: number;
  totalRunsToday: number;
  successRateToday: number;
  failedRunsToday: number;
  runningExecutions: number;
  upcomingRuns: Array<{ taskId: string; taskName: string; nextRunAt: string }>;
}

export type TaskFieldKind =
  | "text"
  | "textarea"
  | "url"
  | "number"
  | "boolean"
  | "select"
  | "json"
  | "headers"
  | "sources"
  | "knowledge_base"
  | "deployment"
  | "monitor"
  | "alert_channel";

export interface TaskTypeFieldOption {
  value: string;
  label: string;
  available: boolean;
  reason?: string;
}

/** One input of a task type's form; `key` is a (dotted) path in the payload. */
export interface TaskTypeField {
  key: string;
  label: string;
  kind: TaskFieldKind;
  required: boolean;
  min?: number;
  max?: number;
  help?: string;
  options?: TaskTypeFieldOption[];
  showWhen?: { key: string; in: string[] };
}

export interface TaskTypeEntry {
  type: string;
  label: string;
  description: string;
  agent: "required" | "optional" | "none";
  /** The task runs a workflow and needs orchestrationId. */
  orchestration: boolean;
  /** Another worker finishes the execution; trigger answers 202. */
  deferred: boolean;
  retryable: boolean;
  aliasOf?: string;
  available: boolean;
  reason?: string;
  fields: TaskTypeField[];
}

export interface TaskTypeCatalogue {
  schedulerEnabled: boolean;
  intervalMs: number;
  taskTypes: TaskTypeEntry[];
}

export interface ScheduledTaskInput {
  name: string;
  description?: string;
  taskType: string;
  agentId?: string | null;
  orchestrationId?: string | null;
  scheduleType: ScheduleType;
  cronExpression?: string;
  intervalSeconds?: number;
  /** An ISO instant, or a local date-time read in `timezone`. */
  scheduledAt?: string;
  timezone?: string;
  payload?: Record<string, unknown>;
  timeout?: number;
  maxRetries?: number;
}

export const schedulerApi = {
  getStats: () => api<SchedulerStats>("/api/scheduler/stats"),
  taskTypes: () => api<TaskTypeCatalogue>("/api/scheduler/task-types"),
  list: (params?: { agentId?: string; orchestrationId?: string; taskType?: string; status?: string; isEnabled?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.agentId) sp.set("agentId", params.agentId);
    if (params?.orchestrationId) sp.set("orchestrationId", params.orchestrationId);
    if (params?.taskType) sp.set("taskType", params.taskType);
    if (params?.status) sp.set("status", params.status);
    if (params?.isEnabled) sp.set("isEnabled", params.isEnabled);
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ tasks: ScheduledTask[]; total: number }>(`/api/scheduler${q ? `?${q}` : ""}`);
  },
  get: (id: string) => api<ScheduledTask & { executions: TaskExecution[] }>(`/api/scheduler/${id}`),
  create: (data: ScheduledTaskInput) => api<ScheduledTask>("/api/scheduler", { method: "POST", body: data }),
  update: (id: string, data: Partial<ScheduledTaskInput> & { isEnabled?: boolean }) =>
    api<ScheduledTask>(`/api/scheduler/${id}`, { method: "PATCH", body: data }),
  delete: (id: string) => api<void>(`/api/scheduler/${id}`, { method: "DELETE" }),
  toggle: (id: string, isEnabled: boolean) => api<ScheduledTask>(`/api/scheduler/${id}/toggle`, { method: "POST", body: { isEnabled } }),
  /**
   * Fires the task now. A synchronous type answers 201 with the finished
   * execution; a workflow_run answers 202 with one still `running`, which
   * the workflow run finishes.
   */
  trigger: (id: string) => api<TaskExecution>(`/api/scheduler/${id}/trigger`, { method: "POST" }),
  getExecutions: (taskId: string, params?: { status?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.status) sp.set("status", params.status);
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ executions: TaskExecution[]; total: number }>(`/api/scheduler/${taskId}/executions${q ? `?${q}` : ""}`);
  },
  cancelExecution: (taskId: string, executionId: string) =>
    api<TaskExecution>(`/api/scheduler/${taskId}/executions/${executionId}/cancel`, { method: "POST" }),
};

// ============================================
// Knowledge Base / RAG API (Phase 5)
// ============================================

export interface KnowledgeBase {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  status: string;
  totalDocuments: number;
  totalChunks: number;
  totalSizeBytes: number;
  agentIds: string[];
  createdAt: string;
}

export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  fileName?: string;
  mimeType?: string;
  sourceUrl?: string;
  sourceType: string;
  sizeBytes: number;
  status: string;
  chunkCount: number;
  tags: string[];
  createdAt: string;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
  chunkIndex: number;
}

export const knowledgeApi = {
  getStats: () => api<{ totalBases: number; totalDocuments: number; totalChunks: number }>("/api/knowledge/stats"),
  list: (params?: { status?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.status) sp.set("status", params.status);
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ knowledgeBases: KnowledgeBase[]; total: number }>(`/api/knowledge${q ? `?${q}` : ""}`);
  },
  get: (id: string) => api<KnowledgeBase & { documents: KnowledgeDocument[] }>(`/api/knowledge/${id}`),
  create: (data: Partial<KnowledgeBase>) => api<KnowledgeBase>("/api/knowledge", { method: "POST", body: data }),
  update: (id: string, data: Partial<KnowledgeBase>) => api<KnowledgeBase>(`/api/knowledge/${id}`, { method: "PATCH", body: data }),
  delete: (id: string) => api<void>(`/api/knowledge/${id}`, { method: "DELETE" }),
  search: (id: string, query: string, limit?: number) => api<{ results: SearchResult[]; query: string; totalChunksSearched: number }>(`/api/knowledge/${id}/search`, { method: "POST", body: { query, limit } }),
  addDocument: (kbId: string, data: { title: string; content: string; sourceType: string; tags?: string[] }) => api<KnowledgeDocument>(`/api/knowledge/${kbId}/documents`, { method: "POST", body: data }),
  getDocuments: (kbId: string, params?: { limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ documents: KnowledgeDocument[]; total: number }>(`/api/knowledge/${kbId}/documents${q ? `?${q}` : ""}`);
  },
  deleteDocument: (kbId: string, docId: string) => api<void>(`/api/knowledge/${kbId}/documents/${docId}`, { method: "DELETE" }),
};

// ============================================
// Orchestration API (Phase 5): workflows
// ============================================

export type WorkflowExecutionMode = "sequential" | "parallel" | "conditional" | "pipeline";
export type WorkflowStepType = "agent" | "model" | "retrieval";
export type WorkflowConditionOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "exists"
  | "not_exists"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

/** `left` and `right` are literals, or references such as `$.steps.a.output.field`. */
export interface WorkflowCondition {
  left: unknown;
  op: WorkflowConditionOp;
  right?: unknown;
}

export type WorkflowLoop =
  | { forEach: string; maxItems?: number }
  | { until: WorkflowCondition; maxIterations: number; onExhausted?: "fail" | "continue" };

export interface WorkflowLayout {
  /** Canvas position of each step, keyed by step name. */
  positions?: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
}

/** One step as the API accepts it (create, replace, plan). */
export interface WorkflowStepInput {
  name: string;
  stepType?: WorkflowStepType;
  agentId?: string | null;
  deploymentId?: string | null;
  modelId?: string | null;
  knowledgeBaseId?: string | null;
  promptTemplate?: string | null;
  inputMapping?: Record<string, unknown>;
  outputMapping?: Record<string, unknown>;
  outputFormat?: "text" | "json";
  condition?: WorkflowCondition | null;
  loop?: WorkflowLoop | null;
  onError?: "fail" | "continue" | "fallback";
  fallbackAgentId?: string | null;
  maxRetries?: number;
  timeoutMs?: number | null;
  dependsOn?: string[];
}

/** The body of create, replace and plan. Unknown keys are refused. */
export interface WorkflowDefinitionInput {
  name: string;
  description?: string | null;
  executionMode: WorkflowExecutionMode;
  maxConcurrency?: number;
  timeout?: number;
  retryPolicy?: { maxRetries?: number; backoffMs?: number };
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  layout?: WorkflowLayout | null;
  steps: WorkflowStepInput[];
}

export interface WorkflowPlan {
  /** Steps that may run together, level by level. */
  levels: string[][];
  order: string[];
  concurrency: number;
  warnings: string[];
}

export interface OrchestrationStep {
  id: string;
  orchestrationId: string;
  name: string;
  stepOrder: number;
  stepType: WorkflowStepType;
  agentId: string | null;
  deploymentId: string | null;
  modelId: string | null;
  knowledgeBaseId: string | null;
  promptTemplate: string | null;
  inputMapping: Record<string, unknown> | null;
  outputMapping: Record<string, unknown> | null;
  outputFormat: "text" | "json";
  condition: WorkflowCondition | null;
  loop: WorkflowLoop | null;
  onError: "fail" | "continue" | "fallback";
  fallbackAgentId: string | null;
  maxRetries: number;
  timeoutMs: number | null;
  dependsOn: string[];
}

export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface OrchestrationExecution {
  id: string;
  orchestrationId: string;
  status: WorkflowRunStatus;
  progress: number;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  /** 'manual' | 'api' | 'schedule' | 'job' */
  triggeredBy: string;
  triggeredById?: string | null;
  cancelRequestedAt?: string | null;
  scheduledTaskId?: string | null;
  taskExecutionId?: string | null;
  error?: string | null;
  failedStepId?: string | null;
  createdAt: string;
}

export interface OrchestrationStepResult {
  id: string;
  stepId: string | null;
  stepName: string;
  stepType: WorkflowStepType | string;
  agentId: string | null;
  /** The deployment or knowledge base a non-agent step used. */
  resourceId: string | null;
  status: "success" | "failed" | "skipped";
  /** Loop pass: the item index (for-each) or the pass number (until). */
  iteration: number | null;
  input: ({ prompt?: string; missingRefs?: string[] } & Record<string, unknown>) | null;
  output: { content?: string; value?: unknown; truncated?: boolean } | null;
  error: string | null;
  attempt: number;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OrchestrationExecutionDetail extends OrchestrationExecution {
  input?: unknown;
  output?: unknown;
  context?: unknown;
  stepResults: OrchestrationStepResult[];
}

export interface WorkflowScheduleSummary {
  id: string;
  name: string;
  scheduleType: string;
  cronExpression: string | null;
  intervalSeconds: number | null;
  scheduledAt: string | null;
  timezone: string;
  isEnabled: boolean;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

export interface Orchestration {
  id: string;
  orgId: string;
  name: string;
  /** The workflow's address under /v1. Set on create; a rename does not change it. */
  slug: string;
  /** `<api>/v1/workflows/<slug>/chat/completions`; null when the API has no public address set. */
  apiEndpoint: string | null;
  /** `<api>/v1/workflows/<slug>`: an OpenAI client's base URL for this workflow. */
  openaiBaseUrl: string | null;
  /** `workflow/<slug>`: the `model` that selects this workflow on the unified /v1 base. */
  openaiModel: string;
  description?: string | null;
  executionMode: WorkflowExecutionMode;
  maxConcurrency: number;
  timeout: number;
  retryPolicy?: { maxRetries?: number; backoffMs?: number } | null;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  layout?: WorkflowLayout | null;
  isEnabled: boolean;
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
  avgDurationMs?: number | null;
  lastRunAt?: string | null;
  createdAt: string;
  /** The editor's lock token: sent back as expectedUpdatedAt on replace. */
  updatedAt: string;
  steps?: OrchestrationStep[];
  /** List rows only. */
  _count?: { steps: number; executions: number };
  scheduleCount?: number;
  lastExecution?: { id: string; status: WorkflowRunStatus; completedAt: string | null } | null;
}

export interface OrchestrationDetail extends Orchestration {
  steps: OrchestrationStep[];
  executions: OrchestrationExecution[];
  schedules: WorkflowScheduleSummary[];
}

export interface OrchestrationStats {
  totalOrchestrations: number;
  activeOrchestrations: number;
  totalExecutions: number;
  runningExecutions: number;
}

export const orchestrationApi = {
  getStats: () => api<OrchestrationStats>("/api/orchestrations/stats"),
  list: (params?: { isEnabled?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.isEnabled) sp.set("isEnabled", params.isEnabled);
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ orchestrations: Orchestration[]; total: number }>(`/api/orchestrations${q ? `?${q}` : ""}`);
  },
  get: (id: string) => api<OrchestrationDetail>(`/api/orchestrations/${id}`),
  /** Dry run: validates and plans a definition, saves nothing. */
  plan: (definition: WorkflowDefinitionInput) =>
    api<WorkflowPlan>("/api/orchestrations/plan", { method: "POST", body: definition }),
  create: (definition: WorkflowDefinitionInput) =>
    api<Orchestration & { steps: OrchestrationStep[] }>("/api/orchestrations", { method: "POST", body: definition }),
  /** Replaces settings and steps together; 409 stale_definition when it changed since it was loaded. */
  replace: (id: string, definition: WorkflowDefinitionInput, expectedUpdatedAt?: string) =>
    api<Orchestration & { steps: OrchestrationStep[] }>(`/api/orchestrations/${id}`, {
      method: "PUT",
      body: expectedUpdatedAt ? { ...definition, expectedUpdatedAt } : definition,
    }),
  /** Metadata only; steps and settings change through replace. */
  update: (id: string, data: { name?: string; description?: string | null; isEnabled?: boolean }) =>
    api<Orchestration>(`/api/orchestrations/${id}`, { method: "PATCH", body: data }),
  delete: (id: string) => api<void>(`/api/orchestrations/${id}`, { method: "DELETE" }),
  /** Queues a run (202). Poll getExecution until it leaves queued/running. */
  execute: (id: string, body: { prompt?: string; input?: Record<string, unknown> } = {}) =>
    api<{ execution: Pick<OrchestrationExecution, "id" | "status" | "triggeredBy" | "triggeredById" | "createdAt"> }>(
      `/api/orchestrations/${id}/execute`,
      { method: "POST", body }
    ),
  getExecutions: (orchId: string, params?: { status?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.status) sp.set("status", params.status);
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ executions: OrchestrationExecution[]; total: number }>(`/api/orchestrations/${orchId}/executions${q ? `?${q}` : ""}`);
  },
  getExecution: (orchId: string, execId: string) =>
    api<OrchestrationExecutionDetail>(`/api/orchestrations/${orchId}/executions/${execId}`),
  /** A queued run is cancelled at once; a running one is asked to stop and ends shortly. */
  cancelExecution: (orchId: string, execId: string) =>
    api<{ execution: OrchestrationExecution }>(`/api/orchestrations/${orchId}/executions/${execId}/cancel`, { method: "POST" }),
};

// ============================================
// Templates API (Phase 5)
// ============================================

export interface AgentTemplate {
  id: string;
  name: string;
  slug: string;
  title: string;
  description: string;
  longDescription?: string;
  category: string;
  difficulty: string;
  tags: string[];
  framework: string;
  iconUrl?: string;
  screenshots: string[];
  usageCount: number;
  avgRating: number;
  isPublished: boolean;
  isFeatured: boolean;
  authorName: string;
  authorUrl?: string;
  createdAt: string;
}

export const templateApi = {
  list: (params?: { category?: string; framework?: string; difficulty?: string; search?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.category) sp.set("category", params.category);
    if (params?.framework) sp.set("framework", params.framework);
    if (params?.difficulty) sp.set("difficulty", params.difficulty);
    if (params?.search) sp.set("search", params.search);
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ templates: AgentTemplate[]; total: number }>(`/api/templates${q ? `?${q}` : ""}`);
  },
  get: (idOrSlug: string) => api<AgentTemplate>(`/api/templates/${idOrSlug}`),
  getCategories: () => api<{ categories: string[] }>("/api/templates/categories"),
  getStats: () => api<{ total: number; published: number; featured: number; totalUsage: number }>("/api/templates/stats"),
  use: (templateId: string, data: { name: string; slug: string; description?: string }) =>
    // The route returns the created Agent row (201) — the caller redirects
    // to it instead of stranding the user on the gallery (INT-B2).
    api<{ id: string; name: string; slug: string }>(`/api/templates/${templateId}/use`, { method: "POST", body: data }),
};

// ============================================
// Two-Factor Auth API (Phase 5)
// ============================================

export interface TwoFactorStatus {
  isEnabled: boolean;
  isVerified: boolean;
  lastUsedAt?: string;
  lastMethod?: string;
  backupCodesRemaining?: number;
  recoveryEmail?: string;
}

export interface TwoFactorSetup {
  id: string;
  secret: string;
  otpauthUrl: string;
  qrCodeUrl: string;
  backupCodes: string[];
}

export const twoFactorApi = {
  getStatus: () => api<TwoFactorStatus>("/api/2fa/status"),
  setup: () => api<TwoFactorSetup>("/api/2fa/setup", { method: "POST" }),
  verifySetup: (token: string) => api<{ success: boolean; message: string }>("/api/2fa/verify-setup", { method: "POST", body: { token } }),
  disable: (token: string) => api<{ success: boolean; message: string }>("/api/2fa/disable", { method: "POST", body: { token } }),
  regenerateBackupCodes: (token: string) => api<{ backupCodes: string[] }>("/api/2fa/backup-codes/regenerate", { method: "POST", body: { token } }),
  setRecoveryEmail: (email: string) => api<{ success: boolean }>("/api/2fa/recovery-email", { method: "POST", body: { email } }),
  // The public challenge endpoints were removed in B5 (user-enumeration
  // oracle); the login flow mints and redeems challenges itself via
  // authApi.login + authApi.completeTwoFactorLogin.
};

// ============================================
// OpenClaw API (Phase 6)
// ============================================

export interface OpenClawDeployment {
  id: string;
  agentId: string;
  agentName: string;
  slug: string;
  description?: string;
  status: string;
  healthStatus?: string | null;
  publicUrl?: string | null;
  channelCount: number;
  channels: OpenClawChannel[];
  modelConfig?: { model?: string; temperature?: number; maxTokens?: number };
  gpuTier?: string;
  systemPrompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpenClawChannel {
  id: string;
  platform: string;
  enabled: boolean;
  createdAt: string;
}

export const openclawApi = {
  listDeployments: () =>
    api<{ deployments: OpenClawDeployment[] }>("/api/openclaw/deployments"),

  getDeployment: (id: string) =>
    api<{ deployment: OpenClawDeployment }>(`/api/openclaw/deployments/${id}`),

  deploy: (data: {
    name: string;
    slug: string;
    description?: string;
    systemPrompt?: string;
    modelConfig?: { model?: string; temperature?: number; maxTokens?: number };
    gpuTier?: string;
    channels?: { platform: string; config: Record<string, string> }[];
    env?: Record<string, string>;
  }) =>
    api<{ deployment: OpenClawDeployment; message: string }>("/api/openclaw/deploy", {
      method: "POST",
      body: data,
    }),

  updateDeployment: (id: string, data: Partial<{
    description: string;
    systemPrompt: string;
    modelConfig: { model?: string; temperature?: number; maxTokens?: number };
    env: Record<string, string>;
  }>) =>
    api<{ deployment: OpenClawDeployment }>(`/api/openclaw/deployments/${id}`, {
      method: "PUT",
      body: data,
    }),

  startDeployment: (id: string) =>
    api<{ message: string }>(`/api/openclaw/deployments/${id}/start`, { method: "POST" }),

  stopDeployment: (id: string) =>
    api<{ message: string }>(`/api/openclaw/deployments/${id}/stop`, { method: "POST" }),

  restartDeployment: (id: string) =>
    api<{ message: string }>(`/api/openclaw/deployments/${id}/restart`, { method: "POST" }),

  deleteDeployment: (id: string) =>
    api<{ message: string }>(`/api/openclaw/deployments/${id}`, { method: "DELETE" }),

  getHealth: (id: string) =>
    api<{ status: string; healthStatus: string }>(`/api/openclaw/deployments/${id}/health`),

  getLogs: (id: string) =>
    api<{ logs: string }>(`/api/openclaw/deployments/${id}/logs`),

  addChannel: (deploymentId: string, data: { platform: string; config: Record<string, string> }) =>
    api<{ channel: OpenClawChannel }>(`/api/openclaw/deployments/${deploymentId}/channels`, {
      method: "POST",
      body: data,
    }),

  updateChannel: (channelId: string, data: { enabled?: boolean; config?: Record<string, string> }) =>
    api<{ channel: OpenClawChannel }>(`/api/openclaw/channels/${channelId}`, {
      method: "PATCH",
      body: data,
    }),

  deleteChannel: (channelId: string) =>
    api<{ message: string }>(`/api/openclaw/channels/${channelId}`, { method: "DELETE" }),
};

// ============================================
// Token Marketplace API (Phase 6)
// ============================================

export interface AgentToken {
  id: string;
  agentListingId: string;
  mintAddress: string;
  pumpfunUrl?: string | null;
  bondingCurveAddress?: string | null;
  creatorAddress: string;
  name: string;
  symbol: string;
  imageUri?: string | null;
  totalSupply: number;
  curveSupply: number;
  reservedSupply: number;
  status: "BONDING" | "GRADUATED" | "FAILED";
  graduatedAt?: string | null;
  raydiumPoolId?: string | null;
  marketCapUsd: number;
  priceUsd: number;
  volume24h: number;
  holders: number;
  creatorLockupEnd?: string | null;
  createdAt: string;
  updatedAt: string;
  agentListing?: {
    id: string;
    title: string;
    slug: string;
    avgRating: number;
    totalInstalls: number;
    totalRequests: number;
    category: string;
  };
}

export interface AgentTokenTrade {
  id: string;
  tokenId: string;
  txSignature: string;
  traderAddress: string;
  side: "buy" | "sell";
  solAmount: number;
  tokenAmount: number;
  priceUsd: number;
  timestamp: string;
}

export interface AgentTokenHolder {
  id: string;
  walletAddress: string;
  balance: number;
  percentage: number;
}

export interface TokenSnapshot {
  id: string;
  priceUsd: number;
  marketCapUsd: number;
  volume24h: number;
  holders: number;
  timestamp: string;
}

export const tokenApi = {
  // NOTE: the custodial POST /api/tokens/create client was removed — the
  // endpoint is retired (410). Launching goes through prepareLaunch +
  // submitLaunch below (browser partial-sign flow).

  list: (params?: {
    sortBy?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) => {
    const sp = new URLSearchParams();
    if (params?.sortBy) sp.set("sortBy", params.sortBy);
    if (params?.status) sp.set("status", params.status);
    if (params?.search) sp.set("search", params.search);
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ tokens: AgentToken[]; total: number }>(`/api/tokens${q ? `?${q}` : ""}`);
  },

  trending: () => api<{ tokens: AgentToken[] }>("/api/tokens/trending"),

  get: (id: string) =>
    api<{ token: AgentToken }>(`/api/tokens/${id}`),

  getTrades: (id: string, params?: { limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.offset) sp.set("offset", params.offset.toString());
    const q = sp.toString();
    return api<{ trades: AgentTokenTrade[]; total: number }>(`/api/tokens/${id}/trades${q ? `?${q}` : ""}`);
  },

  getHolders: (id: string) =>
    api<{ holders: AgentTokenHolder[] }>(`/api/tokens/${id}/holders`),

  getChart: (id: string) =>
    api<{ snapshots: TokenSnapshot[] }>(`/api/tokens/${id}/chart`),

  leaderboard: () =>
    api<{ tokens: AgentToken[] }>("/api/tokens/leaderboard"),

  checkEligibility: (agentListingId: string) =>
    api<{
      eligible: boolean;
      reasons: string[];
      requirements: {
        minReputation: number;
        minDeploymentAgeDays: number;
        creatorLockupDays: number;
      };
    }>(`/api/tokens/eligibility/${agentListingId}`),

  // ============================================
  // Browser-partial-sign launch (Phase 1.5)
  // ============================================
  //
  // Two-step flow that keeps the on-chain creator equal to the user's
  // connected wallet — server never holds the creator privkey.
  //
  //   1. prepareLaunch  → returns a base64 partial-signed pumpfun
  //                       create tx + an HMAC-signed prepareToken.
  //   2. Caller signs the tx with `wallet.signTransaction(...)`.
  //   3. submitLaunch   → returns the persisted token + on-chain
  //                       mint + tx signature.
  //
  // Both endpoints require a connected wallet (request.auth.walletAddress).
  prepareLaunch: (data: {
    agentId: string;
    name: string;
    symbol: string;
    description: string;
    imageUri?: string;
    twitter?: string;
    telegram?: string;
    website?: string;
    initialBuySol?: number;
  }) =>
    api<{
      partialSignedTxBase64: string;
      mintAddress: string;
      creatorPubkey: string;
      prepareToken: string;
    }>("/api/tokens/launch/prepare", {
      method: "POST",
      body: data,
    }),

  submitLaunch: (data: { prepareToken: string; signedTxBase64: string }) =>
    api<{
      tokenId: string;
      mintAddress: string;
      txSignature: string;
      treasuryPdaAddress: string;
      creatorLockupEnd: string;
    }>("/api/tokens/launch/submit", {
      method: "POST",
      body: data,
    }),

  // Recovery: the mint already broadcast on-chain but /submit's DB persist
  // failed. Retries persistence idempotently from the same prepare token.
  reconcileLaunch: (data: {
    prepareToken: string;
    mintAddress: string;
    txSignature: string;
  }) =>
    api<{
      tokenId: string;
      mintAddress: string;
      txSignature: string;
      treasuryPdaAddress: string;
      creatorLockupEnd: string;
      alreadyExisted: boolean;
    }>("/api/tokens/launch/reconcile", {
      method: "POST",
      body: data,
    }),
};

// ============================================
// Streaming Helper
// ============================================

/**
 * Stream playground chat responses as an async generator of content deltas
 */
export async function* streamPlaygroundChat(
  agentId: string,
  body: { messages: Array<{ role: string; content: string }>; model?: string },
  options?: { onToolCalls?: (calls: PlaygroundToolCall[]) => void }
): AsyncGenerator<string, void, unknown> {
  const res = await fetch(
    `${API_URL}/api/agents/${agentId}/playground/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      credentials: "include",
    }
  );

  if (!res.ok) {
    // readBody tolerates empty / non-JSON error bodies (proxy 502 pages),
    // so the real status survives as an ApiError.
    const data = await readBody(res);
    throw new ApiError(res.status, res.statusText, data);
  }

  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Skip unparseable SSE chunks
          continue;
        }

        // A provider (or the server) can report a failure INSIDE a 200
        // stream. Surface it — never render a half answer as if it were
        // whole.
        if (parsed?.error) {
          const message =
            typeof parsed.error === "string"
              ? parsed.error
              : parsed.error.message ?? "The model stream failed";
          throw new Error(message);
        }
        if (parsed?.wheelsai?.toolCalls && options?.onToolCalls) {
          options.onToolCalls(parsed.wheelsai.toolCalls as PlaygroundToolCall[]);
        }
        const content = parsed?.choices?.[0]?.delta?.content;
        if (content) yield content;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================
// Treasury API — runway card + payments history
// (drives apps/api/src/routes/runway.ts + payments.ts)
// ============================================

// Mirrors deriveRunwayAlertLevel in apps/api/src/services/treasury.ts.
export type RunwayAlertLevel = "healthy" | "warning" | "critical" | "expired";

export interface AgentRunwayResponse {
  agent: { id: string; name: string; slug: string };
  treasuryAddress: string | null;
  // BigInt as string — JSON-safe
  treasuryBalanceLamports: string;
  solPriceUsd: number;
  runway: {
    totalCostCents: number;
    lookbackSeconds: number;
    burnRateLamportsPerSecond: string;
    burnLamportsPerDay: string;
    // "infinity" means burn rate is zero (idle agent)
    runwaySeconds: number | "infinity";
    alertLevel: RunwayAlertLevel;
    desiredReplicas: number;
  };
}

export type ComputePaymentStatus =
  | "PENDING"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED";

export interface AgentPaymentRow {
  id: string;
  // BigInt as string
  amountLamports: string;
  computeSeconds: string;
  status: ComputePaymentStatus;
  txSignature: string | null;
  // ISO 8601 — null when unset (PENDING rows have no paidAt)
  paidAt: string | null;
  scheduledFor: string;
  errorMessage: string | null;
  createdAt: string;
}

export interface AgentPaymentsResponse {
  payments: AgentPaymentRow[];
  totalCount: number;
  limit: number;
  offset: number;
  status: ComputePaymentStatus | null;
  from: string | null;
  to: string | null;
}

export const treasuryApi = {
  runway: (slug: string, lookbackSeconds?: number) => {
    const q = lookbackSeconds
      ? `?lookbackSeconds=${lookbackSeconds}`
      : "";
    return api<AgentRunwayResponse>(`/api/agents/${slug}/runway${q}`);
  },

  payments: (
    slug: string,
    params: {
      limit?: number;
      offset?: number;
      status?: ComputePaymentStatus;
      from?: string;
      to?: string;
    } = {},
  ) => {
    const sp = new URLSearchParams();
    if (params.limit !== undefined) sp.set("limit", String(params.limit));
    if (params.offset !== undefined) sp.set("offset", String(params.offset));
    if (params.status) sp.set("status", params.status);
    if (params.from) sp.set("from", params.from);
    if (params.to) sp.set("to", params.to);
    const q = sp.toString();
    return api<AgentPaymentsResponse>(
      `/api/agents/${slug}/payments${q ? `?${q}` : ""}`,
    );
  },
};

// ============================================
// Collaboration API (agent contributors and revenue shares)
// ============================================

export interface AgentContributorRow {
  id: string;
  role: string;
  revenueShare: number;
  revenueShareBps: number;
  status: "pending" | "accepted";
  /** The address the invitation was sent to; null when invited by user id. */
  invitedEmail: string | null;
  acceptedAt: string | null;
  createdAt: string;
  earnedCents: number;
  /** Null until the invitation is accepted: a pending row never names an account. */
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
  } | null;
}

export interface MyContribution {
  id: string;
  agentId: string;
  agentName: string;
  role: string;
  revenueShareBps: number;
  acceptedAt: string | null;
  createdAt: string;
  earnedCents: number;
}

export const collaborationApi = {
  listContributors: (agentId: string) =>
    api<{ contributors: AgentContributorRow[] }>(`/api/agents/${agentId}/contributors`),

  /**
   * Invite by account email; revenueShare is a fraction (0.25 = 25%).
   * Owners and admins only. The answer, and the pending row the list then
   * shows, are the same whether or not the email has an account, so
   * inviting cannot be used to look accounts up.
   */
  invite: (agentId: string, data: { email: string; role: string; revenueShare: number }) =>
    api<{ message: string }>(`/api/agents/${agentId}/contributors`, {
      method: "POST",
      body: data,
    }),

  remove: (agentId: string, contributorId: string) =>
    api<{ message: string }>(`/api/agents/${agentId}/contributors/${contributorId}`, {
      method: "DELETE",
    }),

  myContributions: () => api<{ contributions: MyContribution[] }>("/api/agents/contributions"),

  accept: (agentId: string, contributorId: string) =>
    api<{ message: string }>(`/api/agents/${agentId}/contributors/${contributorId}/accept`, {
      method: "POST",
    }),

  decline: (agentId: string, contributorId: string) =>
    api<{ success: boolean }>(`/api/agents/${agentId}/contributors/${contributorId}/decline`, {
      method: "POST",
    }),
};

export { ApiError };

// ============================================
// Contact sales
// ============================================

export const contactApi = {
  submit: (body: {
    name: string;
    email: string;
    company?: string;
    topic?: "enterprise" | "support" | "other";
    message: string;
  }) => api<{ received: boolean; id: string; emailed: boolean }>("/api/contact", { method: "POST", body }),
};
