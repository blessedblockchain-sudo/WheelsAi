// API Client for WheelsAI backend

import type { AgentKind, KindConfig, TaskField, TaskFieldType, TaskInputSchema } from "@wheelsai/shared/agent-kind";

import type { PayoutLimits, PayoutMethod } from "./earnings";
import { readSseChat, type SseChatEvent } from "./sse";

export type { AgentKind, KindConfig, TaskField, TaskFieldType, TaskInputSchema };

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
/**
 * The body of a 400 `validation_failed`. `message` is the first problem as one
 * plain sentence; `fields` has one sentence per field, keyed by its path
 * ("name", "tools[1].type", "kindConfig.task.fields[0].label"; "body" for the
 * request as a whole). Show those two to people. `details` is the older
 * shape, kept for forms that read it: the validator's own wording, filed
 * under the top-level field.
 */
export interface ValidationErrorBody {
  error: "validation_failed";
  message: string;
  fields: Record<string, string>;
  details?: { formErrors: string[]; fieldErrors: Record<string, string[] | undefined> };
}

/**
 * The validation problems of a failed API call, or null when the error is
 * anything else. For a form that shows each sentence beside its field.
 */
export function getValidationError(err: unknown): ValidationErrorBody | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const data = err.data;
  if (typeof data !== "object" || data === null) return null;
  const body = data as Record<string, unknown>;
  if (body.error !== "validation_failed") return null;
  const fields: Record<string, string> = {};
  if (typeof body.fields === "object" && body.fields !== null && !Array.isArray(body.fields)) {
    for (const [field, sentence] of Object.entries(body.fields)) {
      if (typeof sentence === "string") fields[field] = sentence;
    }
  }
  const message =
    typeof body.message === "string" && body.message.trim()
      ? body.message
      : Object.values(fields)[0] ?? "Some of what was sent could not be accepted. Check it and try again.";
  return {
    error: "validation_failed",
    message,
    fields,
    ...(typeof body.details === "object" && body.details !== null
      ? { details: body.details as ValidationErrorBody["details"] }
      : {}),
  };
}

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
  /** Why it left service ("user_stopped", "insufficient_credits", ...); null while healthy. */
  statusReason?: string | null;
  endpoint: string | null;
  /** The fine-tuned model this deployment serves; null or absent for a catalog model. */
  fineTunedModel?: { id: string; name: string; slug: string } | null;
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
  /** A catalog model id. Optional when fineTunedModelId is given: the base model comes from it. */
  modelId?: string;
  /** Serve one of the organization's fine-tuned models (vLLM only). */
  fineTunedModelId?: string;
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
    api<{
      message: string;
      /** false while the GPUs are still winding down; confirmed in the background. */
      fundsReleased?: boolean;
    }>(`/api/deployments/${id}`, { method: "DELETE" }),

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
        /** End-to-end time of answered requests; null when none was measured. */
        avgLatencyMs: number | null;
        p50LatencyMs: number | null;
        p95LatencyMs: number | null;
        latencySampleCount: number;
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
  /** Spend caps of a key granted jobs:hire; null on any other key. */
  maxJobPriceCents?: number | null;
  /** The most one use of a paid agent may cost; set on a key granted agents:use, null on any other. */
  maxUsePriceCents?: number | null;
  /** The most the key may spend in a UTC day; shared by hiring and paid use. */
  dailySpendCapCents?: number | null;
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export const apiKeysApi = {
  list: () => api<{ apiKeys: ApiKey[] }>("/api/auth/keys"),

  create: (
    name: string,
    scopes?: string[],
    caps?: { maxJobPriceCents?: number; maxUsePriceCents?: number; dailySpendCapCents: number },
  ) =>
    api<{ apiKey: ApiKey; key: string }>("/api/auth/keys", {
      method: "POST",
      body: { name, scopes, ...caps },
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

/** What a wallet top-up can be paid in. */
export type TopupAsset = "USDC" | "SOL";

/** Where a top-up stands. "In flight" means submitting or submitted. */
export type TopupStatus =
  | "prepared"
  | "submitting"
  | "submitted"
  | "credited"
  | "failed"
  | "expired";

export interface TopupPrepareResponse {
  topupId: string;
  /** Full unsigned transaction for wallet.signTransaction. */
  unsignedTxBase64: string;
  depositAddress: string;
  /** The wallet that signs and pays: the one sent, else the one on the session. */
  payerAddress: string;
  asset: TopupAsset;
  amountUsd: number;
  bonusUsd: number;
  /** What the wallet sends, in base units (lamports, or USDC times 1,000,000). */
  amountRaw: string;
  /** SOL only. */
  quotedSolPriceUsd?: number;
  /** SOL only: the price this top-up was worked out from and how long it holds. */
  quote: { solPriceUsd: number; validUntil: string } | null;
  /** True when this first USDC payment also opens the organization's USDC account. */
  opensUsdcAccount: boolean;
  expiresAt: string;
  /** The sentence to show. */
  message: string;
}

/** The answer of submit and of reconcile. `message` is the sentence to show. */
export interface TopupSettleResponse {
  status: TopupStatus;
  message: string;
  txSignature?: string;
  grantedUsd?: number;
  balanceUsd?: number;
  alreadyCredited?: boolean;
  pendingConfirmation?: boolean;
  /** True while the top-up is prepared and no signed transfer has reached the API. */
  pendingSignature?: boolean;
}

/** One top-up as GET /api/billing/topups and GET /api/billing/topups/:id give it. */
export interface TopupRecord {
  id: string;
  status: TopupStatus;
  message: string;
  asset: TopupAsset;
  amountUsd: number;
  bonusUsd: number;
  txSignature?: string;
  depositAddress: string;
  payerAddress: string;
  createdAt: string;
  expiresAt: string;
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

  // Wallet top-up: prepare, the wallet signs the transfer the server built,
  // submit. Credits are granted only once the chain confirms the transfer;
  // a top-up still being confirmed is followed with reconcile.
  prepareTopup: (body: { amountUsd: number; asset: TopupAsset; payerAddress?: string }) =>
    api<TopupPrepareResponse>("/api/billing/topups/prepare", {
      method: "POST",
      body,
    }),

  submitTopup: (topupId: string, signedTxBase64: string) =>
    api<TopupSettleResponse>(`/api/billing/topups/${encodeURIComponent(topupId)}/submit`, {
      method: "POST",
      body: { signedTxBase64 },
    }),

  reconcileTopup: (topupId: string) =>
    api<TopupSettleResponse>(`/api/billing/topups/${encodeURIComponent(topupId)}/reconcile`, {
      method: "POST",
      body: {},
    }),

  getTopup: (topupId: string) =>
    api<TopupRecord>(`/api/billing/topups/${encodeURIComponent(topupId)}`),

  /** The organization's last 20 top-ups, newest first. */
  listTopups: () => api<{ topups: TopupRecord[] }>("/api/billing/topups"),

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

  /** A one-time text for the wallet to sign, to prove it is the caller's. */
  linkWalletNonce: (walletAddress: string) =>
    api<{ nonce: string; walletAddress: string }>("/api/settings/link-wallet/nonce", {
      method: "POST",
      body: { walletAddress },
    }),

  /** `signature` is the wallet's signature over the nonce text, base58. */
  linkWallet: (walletAddress: string, signature: string, nonce: string) =>
    api<{ walletAddress: string; message: string }>("/api/settings/link-wallet", {
      method: "POST",
      body: { walletAddress, signature, nonce },
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
   * The name in the agent's public address, `/a/<handle>`; unique across the
   * platform. null until the agent has been public.
   */
  publicHandle: string | null;
  /**
   * How people use the agent: they talk to it (`conversation`), they give it
   * a task through a short form (`task`), or it runs on its own on a
   * schedule (`scheduled`).
   */
  agentKind: AgentKind;
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
  /** Measured per request over answered chats; null when none was measured. */
  avgLatencyMs: number | null;
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
  /**
   * The settings of each kind, one key per kind, so changing the kind and
   * changing back loses nothing. null when there are none.
   */
  kindConfig: KindConfig | null;
  /** A self-running agent's latest results show on its public page only when this is on. */
  publicResults: boolean;
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

/** What a create and an update accept for `kindConfig`: a key that is sent replaces that key. */
export type KindConfigInput = {
  /** The form of a task agent. A question sent without a `key` gets one from its label; without a `type` it is short text. */
  task?: { fields: Array<Omit<TaskField, "key" | "type" | "required"> & { key?: string; type?: TaskFieldType; required?: boolean }> } | null;
  /** A suggested schedule and what the agent is told at each run. */
  scheduled?: { schedule?: { cronExpression: string; timezone?: string }; prompt?: string } | null;
};

/** Only `name` is needed. The rest has defaults: a `custom`, `inline` agent that people talk to. */
export interface CreateAgentInput {
  /** 3 to 100 characters. */
  name: string;
  description?: string;
  framework?: Agent["framework"];
  systemPrompt?: string;
  tools?: Array<{
    name: string;
    type: "function" | "api" | "mcp";
    description?: string;
    config?: Record<string, any>;
  }>;
  modelConfig?: {
    modelId?: string;
    externalModel?: string;
    temperature?: number;
    maxTokens?: number;
  };
  sourceType?: "inline" | "github" | "ipfs";
  /** Needed when `sourceType` is `github` or `ipfs`. */
  sourceUrl?: string;
  sourceCode?: string;
  env?: Record<string, string>;
  tags?: string[];
  isPublic?: boolean;
  knowledgeBaseId?: string | null;
  /** Defaults to `conversation`, or to the template's kind. */
  agentKind?: AgentKind;
  /** null clears the settings; a task agent then gets the default form. */
  kindConfig?: KindConfigInput | null;
  /** A published template to start from. What is sent here replaces the template's value, field by field. */
  templateId?: string;
  /** Left out, it is made from the name. Either way it is made unique. */
  slug?: string;
  /**
   * The agent's own schedule, made with the agent. Only with `agentKind: "scheduled"`
   * (or a template of that kind). Left out, the agent has no schedule yet.
   */
  schedule?: CreateAgentSchedule;
}

/** The schedule a create may carry. Time limit and tries keep their defaults; change them with `agentsApi.putSchedule`. */
export interface CreateAgentSchedule {
  /** Five-field cron, for example `0 9 * * 1-5`. */
  cronExpression: string;
  /** An IANA time zone such as `Europe/Berlin`. Default `UTC`. */
  timezone?: string;
  /** What the agent is told at each run. Left out, it gets the default line. */
  prompt?: string | null;
  /** Where results go: one of `destinationsApi.list`. null or left out, results are only saved on the agent's page. */
  deliver?: { channelId: string } | null;
  /** Default `true`. */
  enabled?: boolean;
}

/** What `PATCH /api/agents/:id` accepts: any part of a create but the template and the slug. */
export type UpdateAgentInput = Partial<Omit<CreateAgentInput, "templateId" | "slug">> & {
  entrypoint?: AgentEntrypoint;
};

/** The agent in the answer to a create, from `POST /api/agents` or from a template. */
export interface CreatedAgent {
  id: string;
  name: string;
  slug: string;
  framework: string;
  agentKind: AgentKind;
  apiEndpoint: string | null;
  openaiBaseUrl: string | null;
  openaiModel: string;
}

/** The agent's own schedule as a create answers it. Never what it is told or where results go. */
export interface CreatedAgentSchedule {
  /** The scheduled task's id. */
  id: string;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string;
  nextRunAt: string | null;
}

/** The 201 of `POST /api/agents` and of `POST /api/templates/:id/use`. */
export interface CreateAgentResult {
  agent: CreatedAgent;
  /** Always present: null when the agent was created without a schedule. */
  schedule: CreatedAgentSchedule | null;
  message: string;
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

/**
 * Where an agent's public page stands. `off`: the agent is not public and its
 * page does not exist. `view_only`: the page shows and nobody can use the
 * agent from it yet. `on`: anyone with the link can use it. `paused`: the page
 * shows and use is stopped for now.
 */
export type PublicLinkState = "off" | "view_only" | "on" | "paused";

/** What an owner can set the link to; `view_only` is read, never asked for. */
export type PublicLinkSwitch = "on" | "paused" | "off";

/** `GET` and `PUT /api/agents/:id/public-link`. */
export interface PublicLink {
  state: PublicLinkState;
  /** The agent's address, kept while the link is off. null until it has one. */
  handle: string | null;
  /** `<web>/a/<handle>`; null without a handle, or when the server does not know its web address. */
  url: string | null;
  /** Uses a day the page allows (1 to 100,000). */
  dailyCap: number;
  /** Uses counted today (UTC); null when the count could not be read. */
  usedToday: number | null;
  /** Whether a self-running agent's latest results show on its page. */
  showResults: boolean;
  /** The agent has a tool that visitors do not get. */
  toolsOffForVisitors: boolean;
  /** Present while a published listing sells use of this agent; `paid` is whether a price is set. */
  sale?: { paid: boolean; listingSlug: string };
}

/** What `PUT /api/agents/:id/public-link` accepts. */
export interface PublicLinkInput {
  state: PublicLinkSwitch;
  /** 1 to 100,000 uses a day. */
  dailyCap?: number;
  /** 3 to 40 lower-case letters, digits and hyphens. Left out, the agent keeps its address or gets one made from its name. */
  handle?: string;
  showResults?: boolean;
}

/** One answer of a task form that needs another look (a 422 `input_invalid`). */
export interface TaskInputIssue {
  /** Where in the input, as a JSON pointer: `/topic`, `/keywords/3`; "" is the input as a whole. */
  path: string;
  /** The key of the question it is about, or null for the input as a whole. */
  field: string | null;
  /** That question's label, or null when the form has no such question. */
  label: string | null;
  message: string;
}

/** The body of a 422 from a run: every answer that needs another look, in the order of the form. */
export interface InputInvalidBody {
  error: "input_invalid";
  message: string;
  details: TaskInputIssue[];
}

/** `POST /api/agents/:id/run` with `stream: false`. */
export interface AgentRunResult {
  output: { format: "text"; text: string };
  /** Every tool the model called in this run, and how each call ended. */
  toolCalls: PlaygroundToolCall[];
  durationMs: number;
  /** What the run cost a buyer's copy and who it went to; null when nothing was charged. */
  billing: { listingTitle: string; chargedCents: number; creatorCents: number } | null;
}

/** A place results can go to. Never its link or its address. */
export interface Destination {
  channelId: string;
  /** "" when the place was removed after it was chosen. */
  name: string;
  /** `slack`, `discord`, `email` or `webhook`; `unknown` when the place was removed after it was chosen. */
  type: string;
  /** true only for an email place that goes to the signed-in person's own address; always false for an API key and for the other types. */
  mine: boolean;
}

/** The body of `destinationsApi.create`. Email takes no address: it is the signed-in person's own verified address. */
export interface CreateDestinationInput {
  type: "slack" | "discord" | "email";
  /** The pasted Slack or Discord link. Not for `email`. */
  link?: string;
  /** Left out, it is named after the service ("Slack", "Slack 2"; an email place is "Email to <display name>", or "Email to a teammate"). */
  name?: string;
}

/** An agent's own schedule, as the agent page reads and changes it. */
export interface ScheduleView {
  id: string;
  enabled: boolean;
  /** null only for an older task that runs on an interval or once. */
  cronExpression: string | null;
  timezone: string;
  /** What the agent is told at each run. */
  prompt: string;
  /** Whether the date and time are told to the agent at each run. */
  stampTime: boolean;
  deliver: Omit<Destination, "mine"> | null;
  /** A run is stopped after this many seconds (5 to 3,600). */
  timeoutSeconds: number;
  /** Tries after a failed run (0 to 5). */
  maxRetries: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
}

/** `GET` and `PUT /api/agents/:id/schedule`. */
export interface ScheduleAnswer {
  /** null until the agent has one. */
  schedule: ScheduleView | null;
  /** The times and the line a template or the creator suggested. */
  suggested: { schedule?: { cronExpression: string; timezone?: string }; prompt?: string } | null;
  /** The agent's other scheduled tasks; they are on the Scheduler page. */
  otherTasks: number;
  /** false while no worker here fires schedules; runs can still be started by hand. */
  schedulerRunning: boolean;
}

/** What `PUT /api/agents/:id/schedule` accepts. It creates the schedule, or changes it. */
export interface ScheduleInput {
  enabled: boolean;
  cronExpression: string;
  timezone?: string;
  prompt?: string;
  stampTime?: boolean;
  /** A place from `destinationsApi.list`; null clears it; left out, it is kept as it is. */
  deliver?: { channelId: string } | null;
  /** 5 to 3,600. */
  timeoutSeconds?: number;
  /** 0 to 5. */
  maxRetries?: number;
}

/** `running`: not done yet. `finished`: it has a result. `did_not_finish`: see `failure`. `stopped`: someone stopped it. */
export type RunStatus = "running" | "finished" | "did_not_finish" | "stopped";

/** How sending one result to one place went. */
export interface RunDelivery {
  channelId: string;
  name: string;
  type: string;
  status: "sent" | "failed" | "skipped";
  /** Present unless `status` is `sent`. */
  reason?: string;
  /** When it was tried (ISO). */
  at: string;
}

/** One run of an agent's own schedule. */
export interface RunView {
  id: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  startedBy: "schedule" | "person";
  /** The answer of a finished run; null otherwise. */
  text: string | null;
  /** One plain sentence when the run did not finish; null otherwise. */
  failure: string | null;
  /** Every try to send the result, oldest first. A failed delivery never changes `status`. */
  delivery: RunDelivery[];
}

/** `GET /api/agents/:id/runs`, newest first. */
export interface RunsPage {
  runs: RunView[];
  hasMore: boolean;
}

export const agentsApi = {
  list: () => api<{ agents: Agent[]; total: number }>("/api/agents"),

  get: (id: string) => api<{ agent: AgentDetail }>(`/api/agents/${id}`),

  create: (input: CreateAgentInput) =>
    api<CreateAgentResult>(
      "/api/agents",
      { method: "POST", body: input }
    ),

  /** `schedulePaused` is `true` only when this change turned the agent's own schedule off by moving its kind away from `scheduled`. */
  update: (id: string, updates: UpdateAgentInput) =>
    api<{ agent: AgentDetail; schedulePaused?: true }>(`/api/agents/${id}`, {
      method: "PATCH",
      body: updates,
    }),

  getSchedule: (id: string) => api<ScheduleAnswer>(`/api/agents/${id}/schedule`),

  /** Creates the schedule, or changes it. 409 `schedule_changed`: it was changed somewhere else; reload it. */
  putSchedule: (id: string, body: ScheduleInput) =>
    api<ScheduleAnswer>(`/api/agents/${id}/schedule`, { method: "PUT", body }),

  /** One run now, billed and delivered as a timed run is. 409 `already_running`; 404 `schedule_not_found`. */
  runScheduleNow: (id: string) =>
    api<{ run: RunView }>(`/api/agents/${id}/schedule/run`, { method: "POST" }),

  /** Newest first. `before` is the id of the last run already shown. */
  listRuns: (id: string, params?: { limit?: number; before?: string }) => {
    const sp = new URLSearchParams();
    if (params?.limit) sp.set("limit", params.limit.toString());
    if (params?.before) sp.set("before", params.before);
    const q = sp.toString();
    return api<RunsPage>(`/api/agents/${id}/runs${q ? `?${q}` : ""}`);
  },

  /**
   * "Send again": posts the saved result of a finished run to the place the
   * schedule names now. Runs nothing. A place that does not take it answers
   * 502 `delivery_failed` with the run.
   */
  resendRun: (id: string, runId: string) =>
    api<{ run: RunView }>(`/api/agents/${id}/runs/${runId}/deliver`, { method: "POST" }),

  /**
   * Run a task agent on one filled-in form and wait for the result (the JSON
   * answer; the route streams when `stream` is left out). A form that does
   * not fit answers 422 with an `InputInvalidBody`.
   */
  run: (id: string, body: { input: Record<string, unknown> }) =>
    api<AgentRunResult>(`/api/agents/${id}/run`, {
      method: "POST",
      body: { input: body.input, stream: false },
    }),

  getPublicLink: (id: string) => api<PublicLink>(`/api/agents/${id}/public-link`),

  setPublicLink: (id: string, body: PublicLinkInput) =>
    api<PublicLink>(`/api/agents/${id}/public-link`, { method: "PUT", body }),

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

export const destinationsApi = {
  /** The places results can go to, by id, name and type. No answer carries a link or an address. */
  list: () => api<Destination[]>("/api/destinations"),

  /** Slack or Discord by pasted link, or `email` for the signed-in person's own verified address (not with an API key). Answers 200 when that email place already exists. */
  create: (input: CreateDestinationInput) =>
    api<Destination>("/api/destinations", { method: "POST", body: input }),

  /** Sends a short test message. */
  test: (channelId: string) =>
    api<{ sent: true }>(`/api/destinations/${channelId}/test`, { method: "POST" }),
};

// ============================================
// Training Studio API
// ============================================

export type DatasetFileType = "jsonl" | "csv" | "parquet";

export interface Dataset {
  id: string;
  name: string;
  description: string | null;
  /** What the uploader declared. */
  format: string;
  /** How the file is encoded. */
  fileType: DatasetFileType;
  /** Row format found by validation (alpaca, sharegpt, completion, text). */
  schemaFormat: string | null;
  /** null when the rows could not be counted (Parquet). */
  rowCount: number | null;
  sizeBytes: number;
  avgTokensPerRow: number | null;
  totalTokens: number | null;
  /** sha256 of the validated file; a training job is pinned to it. */
  contentSha256?: string | null;
  isValidated: boolean;
  createdAt: string;
}

/** Whether this server can take a dataset upload, and how large one may be. */
export interface DatasetStorageState {
  configured: boolean;
  maxDatasetBytes: number;
  maxDatasetRows: number;
}

/** "1,234 rows", or the honest answer when the rows were not counted. */
export function formatDatasetRows(rowCount: number | null | undefined): string {
  return typeof rowCount === "number"
    ? `${rowCount.toLocaleString()} rows`
    : "Row count unknown";
}

/** One problem validation found. `row` is 1-based; absent for a whole-file problem. */
export interface DatasetIssue {
  row?: number;
  field?: string;
  message: string;
  severity?: "error" | "warning";
}

export interface DatasetDetail extends Dataset {
  storageType: string;
  /** At most 50 are stored. */
  validationErrors: DatasetIssue[] | null;
  sampleRows: Record<string, unknown>[] | null;
  updatedAt: string;
}

export interface DatasetValidationResult {
  validation: {
    isValid: boolean;
    format: string;
    fileType: DatasetFileType;
    schemaFormat: string;
    detectedFormat: string;
    rowCount: number | null;
    sizeBytes: number;
    /** At most 50; errorCount is the true total. */
    errors: DatasetIssue[];
    errorCount: number;
    warnings: DatasetIssue[];
  };
  stats: {
    totalTokens: number;
    avgTokensPerRow: number;
    minTokens: number;
    maxTokens: number;
  } | null;
  sampleRows: Record<string, unknown>[];
}

export interface CreateDatasetInput {
  name: string;
  description?: string;
  fileName: string;
  /** Exact size of the file; the upload link is good for this size only. */
  sizeBytes: number;
  /** Rows counted before uploading, when known. */
  rowCount?: number;
  /** Defaults to the file name's extension. */
  fileType?: DatasetFileType;
  contentType?: string;
  format?: "jsonl" | "csv" | "parquet" | "alpaca" | "sharegpt" | "completion" | "text";
}

export type TrainingMethod = "lora" | "qlora";

/** The nine states of a training job (GET /api/training/jobs?status=). */
export type TrainingJobStatus =
  | "pending"
  | "submitting"
  | "queued"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

/** Why a job cannot start on this server, in the API's own sentence. */
export interface TrainingBlocker {
  code: string;
  message: string;
}

export interface TrainingHyperparamBound {
  min: number;
  max: number;
  integer: boolean;
}

/** The trainer's hyperparameters. Only the keys sent are stored; the rest are the trainer's defaults. */
export interface TrainingHyperparams {
  epochs?: number;
  batchSize?: number;
  gradientAccumulationSteps?: number;
  learningRate?: number;
  warmupRatio?: number;
  loraR?: number;
  loraAlpha?: number;
  loraDropout?: number;
  targetModules?: "all-linear" | string[];
  maxSeqLength?: number;
  maxSteps?: number | null;
  evalSplit?: number | null;
  seed?: number;
}

/** GET /api/training/capabilities: the one read that decides what the pages offer. */
export interface TrainingCapabilities {
  canStart: boolean;
  blockers: TrainingBlocker[];
  storage: {
    configured: boolean;
    driver: "s3" | "local" | null;
    maxDatasetBytes: number;
    maxDatasetRows: number;
  };
  image: { configured: boolean };
  nosana: {
    configured: boolean;
    mock: boolean;
    tiers: Array<{
      tier: string;
      name: string;
      vramGb: number;
      pricePerSecondUsd: number;
      deployable: boolean;
    }>;
  };
  callbacks: { configured: boolean };
  poller: { enabled: boolean };
  gatedModels: { available: boolean };
  runLimit: {
    minSeconds: number;
    maxSeconds: number;
    setupAllowanceSeconds: number;
    queueTimeoutSeconds: number;
  };
  limits: { maxActiveJobs: number; freeFailuresPerDay: number; adapterMaxBytes: number };
  methods: TrainingMethod[];
  hyperparameters: {
    bounds: Record<string, TrainingHyperparamBound>;
    defaults: Record<string, unknown>;
    loraRanks: number[];
  };
}

export interface TrainableModelTier {
  tier: string;
  vramGb: number;
  pricePerSecondUsd: number;
}

export interface TrainableModelMethod {
  method: TrainingMethod;
  /** A planning figure, not a measurement. */
  requiredVramGb: number;
  /** The tiers of this server the method fits on, cheapest first. Empty = none. */
  tiers: TrainableModelTier[];
  recommendedTier: string | null;
}

export interface TrainableModel {
  id: string;
  hfId: string;
  displayName: string;
  parameters: number | null;
  /** Needs a Hugging Face token on the server. */
  gated: boolean;
  available: boolean;
  unavailableReason: "hf_token_required" | "no_tier_available" | "model_not_in_catalog" | null;
  unavailableMessage: string | null;
  methods: TrainableModelMethod[];
  supportedMethods: TrainingMethod[];
  recommendedGpuTier: string | null;
  figuresBasis: "planning";
}

/** POST /api/training/estimate. Planning figures with a low and a high bound. */
export interface TrainingEstimate {
  basis: "planning";
  trainTokens: number;
  steps: number;
  seconds: {
    imagePull: number;
    setup: number;
    train: number;
    wrapUp: number;
    trainer: number;
    total: number;
  };
  estimate: { seconds: number; cents: number };
  low: { seconds: number; cents: number };
  high: { seconds: number; cents: number };
  pricePerSecondUsd: number;
  runLimit: {
    minSeconds: number;
    maxSeconds: number;
    suggestedSeconds: number;
    appliedSeconds: number;
  };
  /** The most the job can cost: what is held when it is created. */
  maximumCents: number;
  fitsRunLimit: boolean;
  suggestionCapped: boolean;
}

export interface TrainingEstimateResponse {
  /**
   * null when the dataset has no measured tokens per row (a Parquet file) and
   * a run limit was given: the job can still be created, held for that limit.
   */
  estimate: (TrainingEstimate & { gpuTier: string; recommendedGpuTier: string | null }) | null;
  /** What creating the job would hold: the price per second times the run limit. */
  hold: { cents: number; maxRuntimeSeconds: number; pricePerSecondUsd: number; gpuTier: string };
  dataset: { id: string; rowCount: number; avgTokensPerRow: number | null };
}

export interface TrainingJobFailure {
  code: string;
  /** A plain sentence. */
  message: string;
  charged: boolean;
}

/** One job as GET /api/training/jobs lists it. Money is in cents. */
export interface TrainingJob {
  id: string;
  name: string;
  baseModelId: string;
  baseModelHfId: string;
  datasetId: string;
  /** null when the dataset row is gone. */
  datasetName: string | null;
  /** Rows created before LoRA-only training may still say "full". */
  method: string;
  gpuTier: string;
  gpuCount: number;
  status: TrainingJobStatus;
  progress: number;
  currentEpoch: number | null;
  totalEpochs: number | null;
  currentStep: number | null;
  totalSteps: number | null;
  trainingLoss: number | null;
  evalLoss: number | null;
  failureCode: string | null;
  lastError: string | null;
  failure: TrainingJobFailure | null;
  maxRuntimeSeconds: number | null;
  estimatedCostCents: number | null;
  /** The hold: the most the job can cost. null on a job that held nothing. */
  reservationCents: number | null;
  /** While running, finalizing or cancelling; null otherwise. */
  costSoFarCents: number | null;
  /** The charge. null until the job is settled. */
  actualCostCents: number | null;
  billedSeconds: number | null;
  charged: boolean | null;
  pricePerSecondUsd: number | null;
  /** The fine-tuned model's id, once there is one. */
  outputModelId: string | null;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  cancelRequestedAt: string | null;
  gpuStoppedAt: string | null;
  completedAt: string | null;
  settledAt: string | null;
}

export interface TrainingLedgerEntry {
  id: string;
  type: "training_reservation" | "training_reservation_release" | "training_usage" | string;
  amountCents: number;
  balanceAfterCents: number;
  description: string | null;
  createdAt: string;
}

export interface TrainingJobMetrics {
  started?: { gpu: string | null; vramGb: number | null; device: string; trainerVersion: string };
  phase?: string;
  step?: { epoch: number; lr: number; tokensPerSecond: number | null; etaSeconds: number };
  /** [step, loss] pairs. */
  trainLoss?: Array<[number, number]>;
  evalLoss?: Array<[number, number]>;
  uploaded?: { adapterBytes: number; adapterSha256: string };
  logSource?: "callbacks" | "nosana_result";
  /** A summary of the run's metrics file, once the job is finalised. */
  result?: Record<string, unknown>;
}

export interface TrainingJobDetail extends Omit<TrainingJob, "datasetName"> {
  hyperparams: TrainingHyperparams | null;
  config: unknown;
  datasetSha256: string | null;
  dataset: { id: string; name: string; rowCount: number | null; deleted: boolean } | null;
  metrics: TrainingJobMetrics;
  /** true when the trainer stopped at the run limit and kept a partial adapter. */
  partial: boolean | null;
  fineTunedModel: { id: string; slug: string; name: string } | null;
  ledger: TrainingLedgerEntry[];
}

export interface CreateTrainingJobInput {
  name: string;
  baseModelId: string;
  datasetId: string;
  method: TrainingMethod;
  /** A tier key from the capabilities, such as "4090". */
  gpuTier: string;
  /** The run limit. Omitted = the estimate's suggestion. */
  maxRuntimeSeconds?: number;
  hyperparams?: TrainingHyperparams;
}

export interface CreateTrainingJobResponse {
  job: { id: string; name: string; status: TrainingJobStatus };
  /** What was held: the most this job can cost. */
  reservation: { cents: number; maxRuntimeSeconds: number; pricePerSecondUsd: number };
  estimate: TrainingEstimate | null;
  message: string;
  retryOf?: string;
}

export interface EstimateTrainingInput {
  baseModelId: string;
  datasetId: string;
  method: TrainingMethod;
  /** Omitted = the cheapest tier the model and method fit on. */
  gpuTier?: string;
  maxRuntimeSeconds?: number;
  hyperparams?: TrainingHyperparams;
}

export interface TrainingJobLogs {
  jobId: string;
  status: TrainingJobStatus;
  logs: string;
  totalLines: number;
  source: "callbacks" | "nosana_result" | "none";
}

export const trainingApi = {
  // What this server can do
  getCapabilities: () => api<TrainingCapabilities>("/api/training/capabilities"),

  // Datasets
  listDatasets: () =>
    api<{ datasets: Dataset[]; total: number; storage: DatasetStorageState }>(
      "/api/training/datasets"
    ),

  getDataset: (id: string) =>
    api<{ dataset: DatasetDetail }>(`/api/training/datasets/${id}`),

  createDataset: (input: CreateDatasetInput) =>
    api<{
      dataset: { id: string; name: string; fileType: DatasetFileType };
      upload: {
        url: string;
        method: "PUT";
        /** Send these with the upload exactly: the link is signed for them. */
        headers: Record<string, string>;
        expiresAt: string;
        maxBytes: number | null;
      };
      message: string;
    }>("/api/training/datasets", {
      method: "POST",
      body: input,
    }),

  validateDataset: (id: string) =>
    api<DatasetValidationResult>(`/api/training/datasets/${id}/validate`, { method: "POST" }),

  deleteDataset: (id: string) =>
    api<{ deleted: boolean; message: string }>(`/api/training/datasets/${id}`, {
      method: "DELETE",
    }),

  // Training Jobs
  listJobs: (status?: TrainingJobStatus) =>
    api<{ jobs: TrainingJob[]; total: number }>(
      `/api/training/jobs${status ? `?status=${status}` : ""}`
    ),

  getJob: (id: string) => api<{ job: TrainingJobDetail }>(`/api/training/jobs/${id}`),

  createJob: (input: CreateTrainingJobInput) =>
    api<CreateTrainingJobResponse>("/api/training/jobs", {
      method: "POST",
      body: input,
    }),

  /** A new job with the configuration of one that is over. It takes its own hold. */
  retryJob: (id: string) =>
    api<CreateTrainingJobResponse>(`/api/training/jobs/${id}/retry`, { method: "POST" }),

  getJobLogs: (id: string, tail?: number) =>
    api<TrainingJobLogs>(`/api/training/jobs/${id}/logs${tail ? `?tail=${tail}` : ""}`),

  /** 200 "cancelled" when it is over already; 202 "cancelling" while the stop is confirmed. */
  cancelJob: (id: string) =>
    api<{ status: "cancelled" | "cancelling"; message: string }>(
      `/api/training/jobs/${id}/cancel`,
      { method: "POST" }
    ),

  // Estimation
  estimate: (input: EstimateTrainingInput) =>
    api<TrainingEstimateResponse>("/api/training/estimate", { method: "POST", body: input }),

  // Models
  listTrainableModels: () =>
    api<{ models: TrainableModel[] }>("/api/training/models"),
};

// ============================================
// Fine-tuned models
// ============================================

/** The result of a completed training job: a LoRA adapter the organization owns. */
export interface FineTunedModel {
  id: string;
  name: string;
  slug: string;
  baseModelId: string;
  baseModelHfId: string;
  baseModelName: string;
  method: string;
  loraR: number;
  adapterBytes: number;
  adapterSha256: string;
  /** A summary of the run's metrics file. */
  metrics: Record<string, unknown> | null;
  trainingJobId: string;
  trainingJob: { id: string; name: string; status: string; completedAt: string | null } | null;
  /** Every deployment that names this model, running or not. */
  deployments: Array<{ id: string; name: string; slug: string; status: string }>;
  activeDeployments: number;
  createdAt: string;
}

export const fineTunedModelsApi = {
  list: () =>
    api<{ fineTunedModels: FineTunedModel[]; total: number }>(
      "/api/training/fine-tuned-models"
    ),

  get: (id: string) =>
    api<{ fineTunedModel: FineTunedModel }>(`/api/training/fine-tuned-models/${id}`),

  /** 409 model_in_use while an active deployment serves it. */
  delete: (id: string) =>
    api<{ deleted: boolean }>(`/api/training/fine-tuned-models/${id}`, { method: "DELETE" }),
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
  endReason: "pricing_changed" | "listing_archived" | "use_ended" | null;
}

/**
 * Where an install stands, by the same rule the API bills with:
 * subscribed (inside a paid period), listing_pricing (the listing's
 * current pricing applies: it is what the buyer accepted, or cheaper),
 * unlisted (no longer sold; keeps running at no charge),
 * subscription_lapsed, pricing_changed (paused until the buyer accepts the
 * listing's new pricing: a subscription's listing left monthly pricing, or
 * a per-request price went above the one the install accepted, or the
 * pricing model changed).
 */
export type MarketplaceInstallAccess =
  | "subscribed"
  | "listing_pricing"
  | "unlisted"
  | "subscription_lapsed"
  | "pricing_changed"
  | "uninstalled"
  // Use of the creator's agent (kind "use"): no licence yet, or the listing no longer offers it.
  | "none"
  | "not_offered";

/** What a listing sells: use of the creator's own agent, or a copy the buyer owns. */
export type MarketplaceSells = "use" | "copies";

/** The agent a licence is for, as its buyer may know it. Never its instructions. */
export interface MarketplaceLicenceAgent {
  /** The name in `/a/<handle>`; null when the agent has no page. */
  handle: string | null;
  name: string;
  agentKind: AgentKind;
}

/** The buyer's licence: their own copy, or the right to use the creator's agent. */
export type MarketplaceInstallKind = "copy" | "use";

/** The pricing a buyer agreed to when they installed or last accepted a change. */
export interface MarketplaceAcceptedPricing {
  pricingModel: MarketplaceListing["pricingModel"] | null;
  pricePerRequestCents: number | null;
  acceptedAt: string | null;
}

/** A listing's pricing as the buyer was shown it; sent back when confirming. */
export interface MarketplacePricingTerms {
  pricingModel: MarketplaceListing["pricingModel"];
  pricePerRequestCents: number | null;
  monthlyPriceCents: number | null;
}

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
  /** Whether the listing has a token. Said by the marketplace, its featured row and the listing page. */
  hasToken?: boolean;
  /** What the listing sells. */
  sells: MarketplaceSells;
  /** What one payment buys; null for a free listing, a copy or a token listing. */
  unit: "message" | "run" | "month" | null;
  /** Owner's views only (create, update, my-listings): the tools the agent may use for people who pay. */
  allowedTools?: string[];
  /** `getMyListings` only: how many people have a copy, use it, or are subscribed. */
  buyers?: { copies: number; using: number; subscribed: number };
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
  /** Whether the listing has a Try it tab (every published listing does). */
  trial?: { enabled: boolean };
  agent?: {
    id: string;
    framework: string;
    /** How people use the listed agent. */
    agentKind: AgentKind;
    tags: string[];
    // Present on the detail endpoint only (getListingBySlug select) —
    // used to link to the public /a/:slug transparency page.
    slug?: string;
    isPublic?: boolean;
    /** The name in the agent's page address, `/a/<handle>`; null when it has no page. */
    handle?: string | null;
  };
}

// ============================================
// Public Agent Page (/api/a/:handle)
// ============================================

export interface PublicAgentDetail {
  agent: {
    name: string;
    slug: string;
    framework: string;
    createdAt: string;
    /** What the owner wrote for the public; never the instructions. */
    description: string | null;
    /** The name in the page's address, `/a/<handle>`. */
    handle: string;
    agentKind: AgentKind;
  };
  /** How the page can be used right now, and what the panel of the agent's kind needs. */
  use: PublicAgentUse;
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
  channels: Array<{ platform: string; enabled: boolean; /** false = configured, but nothing serves it yet. */ live?: boolean }>;
  recentPayments: Array<{
    amountLamports: string;
    status: string;
    txSignature: string | null;
    paidAt: string | null;
  }>;
}

/** What every page says about its use, whatever the agent's kind. */
interface PublicAgentUseBase {
  /**
   * `view_only`: shown, not yet usable. `on`: usable. `paused`: use is stopped
   * for now. `paid`: people sign in and pay to use it; `paid` carries the terms.
   */
  state: "view_only" | "on" | "paused" | "paid";
  /** The page's publishable key; set only while `state` is `on`, null while `paid`. */
  key: string | null;
  /** Whether the agent's owner keeps a copy of what visitors send and receive. */
  transcriptsStored: boolean;
  /** The terms of paid use; null unless `state` is `paid`. */
  paid: PublicAgentPaidTerms | null;
}

/** What a person sees before paying to use an agent. */
export interface PublicAgentPaidTerms {
  listingId: string;
  listingSlug: string;
  pricingModel: "per_request" | "monthly";
  priceCents: number;
  unit: "message" | "run" | "month";
  /** The most one buyer may use it in a minute, and in a day. */
  perMinute: number;
  perDay: number;
  /** Whether the owner keeps a copy of what buyers send and receive. */
  transcriptsStored: boolean;
  /** Whether the agent may send requests to other websites as part of its answers. */
  sendsRequests: boolean;
}

/** Exactly one of `chat`, `task` and `scheduled` is present, the one of the agent's kind. */
export type PublicAgentUse = PublicAgentUseBase &
  (
    | {
        chat: { maxMessages: number; maxMessageChars: number; maxTotalChars: number };
        task?: never;
        scheduled?: never;
      }
    | {
        task: { inputSchema: TaskInputSchema; maxInputChars: number };
        chat?: never;
        scheduled?: never;
      }
    | {
        /**
         * `latest`: at most 3 results of at most 8,000 characters, newest first, only while `resultsPublic`; otherwise empty.
         * While the page is `paid` the results are the buyers': `latest` has dates only (no `text`), `lastResultAt` is when
         * the latest arrived and `schedule` when it runs (both present only then).
         */
        scheduled: {
          resultsPublic: boolean;
          latest: Array<{ finishedAt: string; text?: string }>;
          lastResultAt?: string | null;
          schedule?: { cronExpression: string; timezone: string } | null;
        };
        chat?: never;
        task?: never;
      }
  );

// ============================================
// The public run (POST /api/widget/:publicKey/run)
// ============================================
// Called from the agent's page by a browser: no sign-in, no cookies, and an
// Origin header the key allows. Code calls POST /api/agents/:id/run instead.

/** The body of a public run. It streams unless `stream` is false. */
export interface PublicRunRequest {
  input: Record<string, unknown>;
  stream?: boolean;
}

/** The JSON answer of a public run (`stream: false`). */
export interface PublicRunResult {
  output: { format: "text"; text: string };
  toolCalls: Array<{ name: string; status: "ok" | "unavailable" | "error" }>;
}

/** What a visitor is told when a public run is refused, with the status it comes with. */
export interface PublicRunRefusal {
  error: string;
  message: string;
  reason?: string;
  scope?: "ip" | "key" | "session" | "org" | "global" | "agent";
  retryAfterSeconds?: number;
  /** 422 `input_invalid`: each answer that needs another look. */
  details?: TaskInputIssue[];
}

/**
 * The one fetch a visitor's browser makes: no sign-in and never a cookie.
 * The public-key routes forbid cookies (the API's CORS policy for them never
 * allows credentials) and a public page is read the same way, so nothing a
 * stranger's page sends goes through the shared helper, which always sends
 * them: `credentials` is "omit", here and only here.
 */
function publicFetch(path: string, init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
  const hasBody = init.body !== undefined;
  return fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: hasBody ? { "Content-Type": "application/json" } : { Accept: "application/json" },
    ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    credentials: "omit",
    signal: init.signal,
  });
}

export const publicAgentApi = {
  /** By the agent's public handle, the name in `/a/<handle>`. No cookie goes with it. A refusal throws an ApiError. */
  get: async (handle: string): Promise<PublicAgentDetail> => {
    const res = await publicFetch(`/api/a/${handle}`);
    const data = await readBody(res);
    if (!res.ok) throw new ApiError(res.status, res.statusText, data);
    return data as PublicAgentDetail;
  },
};

/** One turn of a visitor's chat on an agent's page. */
export interface PublicChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * One streamed request to a public-key route, through `publicFetch`. A
 * refusal throws an ApiError whose `data` is a PublicRunRefusal before
 * anything is yielded; a failure inside the stream arrives as an `error`
 * event.
 */
async function* streamPublicUse(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<SseChatEvent, void, unknown> {
  const res = await publicFetch(path, { method: "POST", body: { ...body, stream: true }, signal });
  if (!res.ok) throw new ApiError(res.status, res.statusText, await readBody(res));
  if (!res.body) return;
  yield* readSseChat(res.body);
}

/** Free use of an agent from its public page: no sign-in and no cookies. */
export const publicUseApi = {
  /** One chat message with the conversation so far; the answer is streamed. */
  chat: (publicKey: string, body: { messages: PublicChatTurn[]; sessionId?: string }, signal?: AbortSignal) =>
    streamPublicUse(`/api/widget/${encodeURIComponent(publicKey)}/chat`, body, signal),
  /** One task run from the form's answers; the result is streamed. */
  run: (publicKey: string, body: { input: Record<string, unknown> }, signal?: AbortSignal) =>
    streamPublicUse(`/api/widget/${encodeURIComponent(publicKey)}/run`, body, signal),
};

/** `POST /api/marketplace/listings/:id/use`: where the buyer stands after starting. */
export interface MarketplaceUseState {
  access: MarketplaceInstallAccess;
  acceptedPricing: MarketplaceAcceptedPricing | null;
  subscription: MarketplaceSubscription | null;
  agent: MarketplaceLicenceAgent;
}

// ============================================
// Paid use of an agent (/api/a/:handle/...)
// ============================================
// The signed-in buyer uses a creator's own agent and pays from their credits.
// These go through the app's `api()` helper, which sends the session cookie.
// Chat and run send `stream: false`: the answer arrives whole as JSON.

/** Where a buyer stands with an agent. */
export type PaidUseAccess = MarketplaceInstallAccess | "own_agent";

/** What the listing asks for one use, as the buyer is shown it. */
export interface PaidUseTerms {
  pricingModel: "per_request" | "monthly" | (string & {});
  pricePerRequestCents: number | null;
  monthlyPriceCents: number | null;
  /** What one payment buys. */
  unit: "message" | "run" | "month";
  /** Whether the agent's owner keeps a copy of what is sent and answered. */
  keepsCopy: boolean;
}

/** `GET /api/a/:handle/access`. */
export interface PaidUseAccessState {
  access: PaidUseAccess;
  listingId: string;
  /** What the listing asks now; null when use of it is not on sale. */
  terms: PaidUseTerms | null;
  /** What the caller agreed to; null when they have not started. */
  accepted: { pricingModel: string | null; pricePerRequestCents: number | null; monthlyPriceCents: number | null } | null;
  /**
   * `graceEndsAt` is set while a renewal that failed is still being retried: the day access ends
   * unless credits are added before it (an ISO date).
   */
  subscription: {
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    graceEndsAt: string | null;
  } | null;
  /** The caller's credits, in cents. */
  balanceCents: number;
  /** Whether the caller may agree to a price: an owner or admin of their organization. */
  canAccept: boolean;
  /**
   * Set while the caller holds a copy of this agent with a month paid for: starting to use it waits
   * until `until` (an ISO date), and `canAccept` is false. Null otherwise.
   */
  startBlocked: { code: "copy_subscription_active"; message: string; until: string } | null;
}

/** What a use cost. */
export interface PaidUseBilling {
  /** 0 inside a paid month. */
  chargedCents: number;
  /** The buyer's credits after it; null when they could not be read just now. */
  balanceCents: number | null;
  access: "subscribed" | "listing_pricing";
}

export interface PaidUseToolCall {
  name: string;
  status: "ok" | "unavailable" | "error";
}

/** `POST /api/a/:handle/chat` with `stream: false`. */
export interface PaidChatResult {
  message: { role: "assistant"; content: string };
  toolCalls: PaidUseToolCall[];
  billing: PaidUseBilling;
}

/** `POST /api/a/:handle/run` with `stream: false`. */
export interface PaidRunResult {
  output: { format: "text"; text: string };
  toolCalls: PaidUseToolCall[];
  billing: PaidUseBilling;
}

/** `GET /api/a/:handle/results`: a subscriber's read of a self-running agent's results, newest first. */
export interface PaidResults {
  results: Array<{ finishedAt: string; text: string }>;
  hasMore: boolean;
}

/**
 * The body of a refused paid use. Show `message` as it comes. The other
 * fields are present only for the refusals they belong to.
 */
export interface PaidUseRefusal {
  /**
   * The refusal's code. Two to know: `not_a_member` (403), the caller is no longer a member of the
   * paying organization; `copy_subscription_active` (409, on starting to use), the caller holds a
   * copy with a month paid for.
   */
  error: "copy_subscription_active" | "not_a_member" | (string & {});
  message: string;
  /** copy_subscription_active: when the copy's paid month ends (an ISO date). */
  until?: string;
  /** rate_limited: `org` is the buyer's own limit, `agent` the agent's. */
  scope?: "org" | "agent";
  retryAfterSeconds?: number;
  /** 422 input_invalid: each answer that needs another look. */
  details?: TaskInputIssue[];
  /** The buyer's access, where the licence decided. */
  access?: PaidUseAccess;
  /** use_not_started and pricing_changed: what the listing asks now. */
  terms?: PaidUseTerms;
  /** insufficient_credits: the price of this use and the buyer's credits. */
  priceCents?: number;
  balanceCents?: number;
  /** model_error and answer_withheld: what was charged and given back. */
  refundedCents?: number;
  /** pricing_changed on starting to use: what the listing asks now. */
  pricing?: MarketplacePricingTerms;
  /** insufficient_credits on subscribing: what the first month costs. */
  requiredCents?: number;
}

/** The refusal body of an error thrown by `paidUseApi`, or null when it is not one. */
export function paidUseRefusalOf(error: unknown): PaidUseRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const data = error.data as Partial<PaidUseRefusal> | null;
  if (!data || typeof data !== "object" || typeof data.error !== "string" || typeof data.message !== "string") {
    return null;
  }
  return data as PaidUseRefusal;
}

/** Use of an agent you pay for. A refusal throws an ApiError whose `data` is a PaidUseRefusal. */
export const paidUseApi = {
  access: (handle: string) =>
    api<PaidUseAccessState>(`/api/a/${encodeURIComponent(handle)}/access`),

  /** One chat message with the conversation so far; charged when sent, refunded if no answer is delivered. */
  chat: (handle: string, body: { messages: PublicChatTurn[]; sessionId?: string }) =>
    api<PaidChatResult>(`/api/a/${encodeURIComponent(handle)}/chat`, {
      method: "POST",
      body: { ...body, stream: false },
    }),

  /** One task run from the form's answers. */
  run: (handle: string, body: { input: Record<string, unknown> }) =>
    api<PaidRunResult>(`/api/a/${encodeURIComponent(handle)}/run`, {
      method: "POST",
      body: { ...body, stream: false },
    }),

  /** A self-running agent's latest results, for a subscriber. */
  results: (handle: string) =>
    api<PaidResults>(`/api/a/${encodeURIComponent(handle)}/results`),
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
  /** What the listing sells. Left out, a new listing sells use of the agent. */
  sells?: "use" | "copies";
  /** Skill keys (such as `http_request`) the agent may use for people who pay; at most 50. */
  allowedTools?: string[];
  /** Publish in the same request. */
  publish?: boolean;
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
   * expectedPricing is the pricing the buyer was shown: if the listing has
   * moved since, the API answers the same 409 and charges nothing.
   */
  installAgent: (
    listingId: string,
    opts?: { acceptNewPricing?: boolean; expectedPricing?: MarketplacePricingTerms },
  ) =>
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
      ...(opts?.acceptNewPricing || opts?.expectedPricing
        ? {
            body: {
              ...(opts.acceptNewPricing ? { acceptNewPricing: true } : {}),
              ...(opts.expectedPricing ? { expectedPricing: opts.expectedPricing } : {}),
            },
          }
        : {}),
    }),

  /**
   * Start using the creator's agent (a listing that sells use), or accept
   * its new pricing. `expected` is the pricing the buyer was shown: it is
   * their consent, and a listing that has moved answers 409 `pricing_changed`
   * with nothing charged. A monthly price charges the first 30 days now.
   */
  startUsing: (
    listingId: string,
    body: { expected: MarketplacePricingTerms; acceptNewPricing?: boolean },
  ) =>
    api<MarketplaceUseState>(`/api/marketplace/listings/${listingId}/use`, {
      method: "POST",
      body,
    }),

  /** Stop using an agent, or remove a copy. A subscription ends now and is not refunded. */
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
        kind: MarketplaceInstallKind;
        /** null for a licence to use the creator's agent: there is no copy. */
        clonedAgentId: string | null;
        agent: MarketplaceLicenceAgent;
        access: MarketplaceInstallAccess;
        installedAt: string;
      } | null;
    }>(`/api/marketplace/listings/${listingId}/install-status`),

  getMyInstalls: () =>
    api<{
      installs: Array<{
        id: string;
        listingId: string;
        kind: MarketplaceInstallKind;
        /** null when `kind` is "use": the buyer uses the creator's agent and has no copy. */
        clonedAgentId: string | null;
        agent: MarketplaceLicenceAgent;
        status: string;
        totalRequests: number;
        totalSpentCents: number;
        installedAt: string;
        access: MarketplaceInstallAccess;
        acceptedPricing: MarketplaceAcceptedPricing;
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
      /** Settled job revenue on offerings with no agent listing (workflows, models, unlisted agents). */
      unlistedJobRevenue?: { totalRevenueCents: number; jobs: number };
      recentTransactions: Array<{
        id: string;
        type: string;
        grossAmountCents: number;
        platformFeeCents: number;
        creatorAmountCents: number;
        requestCount: number;
        status: string;
        /** Set on a job's row. Only a released row is an earning. */
        jobId?: string | null;
        escrow?: EscrowState | null;
        modelCostCents?: number;
        /** What the row's licence is for: use of your agent, or a buyer's copy. Null when no licence is behind it. */
        licenceKind?: "use" | "copy" | null;
        createdAt: string;
      }>;
      /** Job payments buyers have paid that are not yours yet. */
      heldInEscrow?: { creatorAmountCents: number; jobs: number };
      pendingPayouts: Array<{
        id: string;
        amountCents: number;
        payoutMethod: string;
        status: string;
        requestedAt: string;
      }>;
      /**
       * What a payout can be requested for right now: the minimum, the limits for a wallet, what
       * today has used, the largest amount each way and the methods offered. Read it through
       * readPayoutLimits (lib/earnings), which answers null when it is absent or not whole.
       */
      payoutLimits?: PayoutLimits;
    }>("/api/marketplace/revenue"),

  /**
   * Requests a payout. Without `amountCents` the API takes the largest amount allowed right now for
   * the method. A refusal is `{ error, message }`: the code, and the sentence to show.
   */
  requestPayout: (request: { payoutMethod: PayoutMethod; payoutAddress?: string; amountCents?: number }) =>
    api<{
      payout: {
        id: string;
        amountCents: number;
        payoutMethod: string;
        status: string;
        requestedAt: string;
        message?: string | null;
      };
      /** What stays in the earnings after this payout was reserved. */
      remainingCents?: number;
      /** The sentence to show the creator: what was requested and when it is sent. */
      message?: string;
    }>("/api/marketplace/payouts", {
      method: "POST",
      body: request,
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
        /** Why a payout did not go through, as a plain sentence for the creator. */
        failureReason: string | null;
        /** True while the payout can still be cancelled: requested and not yet being sent. */
        cancellable?: boolean;
        /** A sentence for the creator: a pending payout that is waiting, or why one failed. Else null. */
        message?: string | null;
      }>;
    }>("/api/marketplace/payouts"),

  /**
   * Cancels a payout that has not started to be sent: the amount goes back to the earnings it was
   * taken from. 409 `payout_not_cancellable` once it is being sent or is finished.
   */
  cancelPayout: (payoutId: string) =>
    api<{ payout: { id: string; amountCents: number; payoutMethod: string; status: string; requestedAt: string } }>(
      `/api/marketplace/payouts/${payoutId}/cancel`,
      { method: "POST" },
    ),
};

// ============================================
// Offerings and Jobs API
// ============================================

export type OfferingProductKind = "agent" | "workflow" | "model";
export type OfferingStatus = "draft" | "active" | "paused" | "archived";
export type OfferingOutputFormat = "text" | "json";

/** A check a deliverable must pass before the buyer sees it. */
export type DeliverableCheck =
  | { type: "contains" | "not_contains"; value: string; caseSensitive?: boolean; label?: string }
  | { type: "exact"; value: string; label?: string }
  | { type: "regex"; pattern: string; flags?: string; label?: string }
  | { type: "json_schema"; schema: Record<string, unknown>; label?: string }
  | { type: "min_length" | "max_length"; value: number; label?: string };

/** What anyone may read. It has no field for the publisher's private instructions. */
export interface PublicOffering {
  id: string;
  slug: string;
  title: string;
  description: string;
  productKind: OfferingProductKind;
  priceCents: number;
  slaSeconds: number;
  /** Changes with anything a buyer agrees to; a hire sends it back as `expected`. */
  termsVersion: string;
  reviewWindowHours: number;
  inputSchema: Record<string, unknown> | null;
  sampleInputs: Array<Record<string, unknown>>;
  deliverableChecks: DeliverableCheck[];
  outputFormat: OfferingOutputFormat;
  product: { name: string };
  publisher: { name: string; slug: string | null; isVerified: boolean; reputationTier: string | null };
  listing: { slug: string; title: string } | null;
  createdAt: string;
}

/** The terms a hire is held to: PublicOffering has all three. */
export interface OfferingTerms {
  priceCents: number;
  slaSeconds: number;
  termsVersion: string;
}

export interface OfferingTrackRecord {
  completed: number;
  rejected: number;
  failed: number;
  expired: number;
  cancelled: number;
  successRate: number | null;
  avgRating: number | null;
  ratingCount: number;
  medianTurnaroundSeconds: number | null;
}

export interface PublisherOffering extends PublicOffering {
  status: OfferingStatus;
  instructions: string | null;
  agentId: string | null;
  orchestrationId: string | null;
  deploymentId: string | null;
  listingId: string | null;
  allowedTools: string[];
  maxAttempts: number;
  maxConcurrentJobs: number;
  activeJobs: number;
  productAvailable: boolean;
  publishedAt: string | null;
  updatedAt: string;
  stats: { jobs: Record<string, number> };
  /**
   * For an offering whose form was taken from its agent's own task form: whether buyers still see
   * the form the agent has now. False after the agent's form was edited; saving with
   * `fromAgentForm: true` shows buyers the new one. Null for an offering with a form of its own.
   */
  formInSync?: boolean | null;
}

export interface OfferingContentInput {
  title: string;
  description: string;
  priceCents: number;
  slaSeconds: number;
  inputSchema?: Record<string, unknown> | null;
  /**
   * Take the form buyers fill in from the agent's own task form, in its order. Sent in place of
   * `inputSchema` (sending both is refused), and only for a task agent (409 `not_a_task_agent`).
   */
  fromAgentForm?: boolean;
  sampleInputs?: Array<Record<string, unknown>>;
  instructions?: string | null;
  deliverableChecks?: DeliverableCheck[];
  outputFormat?: OfferingOutputFormat;
  allowedTools?: string[];
  maxAttempts?: number;
  maxConcurrentJobs?: number;
}

export interface CreateOfferingInput extends OfferingContentInput {
  productKind: OfferingProductKind;
  agentId?: string;
  orchestrationId?: string;
  deploymentId?: string;
}

/** One problem in a schema, a sample, a check or a buyer's input, by JSON pointer. */
export interface SchemaIssue {
  path: string;
  message: string;
}

export interface OfferingTestRun {
  passed: boolean;
  output: JobDeliverable | null;
  checkResults: Array<{ label: string; type: string; passed: boolean; details: string }>;
  durationMs: number;
}

export interface SearchOfferingsParams {
  productKind?: OfferingProductKind;
  query?: string;
  agentId?: string;
  listingId?: string;
  publisher?: string;
  sort?: "newest" | "price_low" | "price_high" | "rating";
  page?: number;
  limit?: number;
}

export type JobStatus =
  | "funded"
  | "running"
  | "submitted"
  | "completed"
  | "rejected"
  | "failed"
  | "expired"
  | "cancelled";

/** Where a job's price is: held in escrow, released to the publisher, or back with the buyer. */
export type EscrowState = "held" | "released" | "refunded";

export interface JobDeliverable {
  format: OfferingOutputFormat;
  text: string;
  value?: unknown;
}

interface JobBase {
  id: string;
  status: JobStatus;
  offering: { id: string; slug: string; title: string; productKind: OfferingProductKind };
  priceCents: number;
  escrow: { status: EscrowState; amountCents: number } | null;
  input: Record<string, unknown>;
  output: JobDeliverable | null;
  deadlineAt: string | null;
  reviewDeadlineAt: string | null;
  fundedAt: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  rejectionReason: string | null;
  rating: number | null;
  review: string | null;
  createdAt: string;
}

export interface BuyerJob extends JobBase {
  role: "buyer";
  checks: Array<{ label: string; type: string; passed: boolean }>;
}

export interface PublisherJob extends JobBase {
  role: "publisher";
  buyer: { orgId: string; name: string };
  checkResults: Array<{ label: string; type: string; passed: boolean; details: string }>;
  attempts: number;
  orchestrationExecutionId: string | null;
  platformFeeCents: number | null;
  creatorAmountCents: number | null;
  modelCostCents: number;
}

export type Job = BuyerJob | PublisherJob;

export interface JobSummary {
  awaitingReview: number;
  inProgress: number;
  toDeliver: number;
}

/** The field problems a refused hire or save carries, wherever the API put them. */
export function schemaIssuesOf(err: unknown): SchemaIssue[] {
  if (!(err instanceof ApiError) || typeof err.data !== "object" || err.data === null) return [];
  const data = err.data as { errors?: unknown; details?: unknown };
  const list = Array.isArray(data.errors) ? data.errors : Array.isArray(data.details) ? data.details : [];
  return list.filter(
    (issue): issue is SchemaIssue =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as SchemaIssue).path === "string" &&
      typeof (issue as SchemaIssue).message === "string",
  );
}

/** The API's machine-readable error code, when the failure carried one. */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError) || typeof err.data !== "object" || err.data === null) return null;
  const code = (err.data as { error?: unknown }).error;
  return typeof code === "string" ? code : null;
}

function queryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const offeringsApi = {
  // Public
  search: (params: SearchOfferingsParams = {}) =>
    api<{ offerings: PublicOffering[] } & PaginatedResponse<PublicOffering>>(
      `/api/offerings${queryString(params)}`,
    ),

  get: (slug: string) =>
    api<{ offering: PublicOffering & { trackRecord: OfferingTrackRecord } }>(
      `/api/offerings/${encodeURIComponent(slug)}`,
    ),

  // Publisher
  listMine: (status?: OfferingStatus) =>
    api<{ offerings: PublisherOffering[] }>(`/api/offerings/mine${queryString({ status })}`),

  getMine: (id: string) => api<{ offering: PublisherOffering }>(`/api/offerings/mine/${id}`),

  create: (input: CreateOfferingInput) =>
    api<{ offering: PublisherOffering }>("/api/offerings", { method: "POST", body: input }),

  update: (id: string, updates: Partial<OfferingContentInput>) =>
    api<{ offering: PublisherOffering }>(`/api/offerings/${id}`, { method: "PATCH", body: updates }),

  setStatus: (id: string, action: "activate" | "pause" | "archive") =>
    api<{ offering: PublisherOffering }>(`/api/offerings/${id}/${action}`, { method: "POST" }),

  /** The checks a save runs, saving nothing. Throws with the problems (see schemaIssuesOf). */
  validate: (content: Pick<OfferingContentInput, "inputSchema" | "sampleInputs" | "deliverableChecks">) =>
    api<{ ok: true }>("/api/offerings/validate", { method: "POST", body: content }),

  /** One real run of the product as a paid job would run it; no job, no money. */
  testRun: (id: string, input: Record<string, unknown>) =>
    api<OfferingTestRun>(`/api/offerings/${id}/test-run`, { method: "POST", body: { input } }),

  // Buyer
  /**
   * Pays the price into escrow and queues the job. The Idempotency-Key makes
   * a retried click or a repeated request the same job, charged once.
   *
   * `expected` is the offering as the buyer was shown it. It is not
   * optional here: a publisher can edit an active offering, and the server
   * refuses the hire (409 offering_terms_changed, nothing charged) when the
   * price, the delivery time or anything else agreed to has moved since.
   */
  hire: (
    id: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
    expected: OfferingTerms,
  ) =>
    api<{ job: BuyerJob }>(`/api/offerings/${id}/hire`, {
      method: "POST",
      body: { input, expected },
      headers: { "Idempotency-Key": idempotencyKey },
    }),
};

export const jobsApi = {
  list: (params: { role?: "buyer" | "publisher"; status?: JobStatus; offeringId?: string; page?: number; limit?: number } = {}) =>
    api<{ jobs: Job[] } & PaginatedResponse<Job>>(`/api/jobs${queryString(params)}`),

  summary: () => api<JobSummary>("/api/jobs/summary"),

  get: (id: string) => api<{ job: Job }>(`/api/jobs/${id}`),

  accept: (id: string, body: { rating?: number; review?: string } = {}) =>
    api<{ job: BuyerJob }>(`/api/jobs/${id}/accept`, { method: "POST", body }),

  reject: (id: string, reason: string) =>
    api<{ job: BuyerJob; refundedCents: number }>(`/api/jobs/${id}/reject`, {
      method: "POST",
      body: { reason },
    }),

  cancel: (id: string, reason?: string) =>
    api<{ job: BuyerJob; refundedCents: number }>(`/api/jobs/${id}/cancel`, {
      method: "POST",
      body: reason ? { reason } : {},
    }),

  rate: (id: string, rating: number, review?: string) =>
    api<{ job: BuyerJob }>(`/api/jobs/${id}/rate`, {
      method: "POST",
      body: review ? { rating, review } : { rating },
    }),
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
  /** End-to-end time of answered requests; null when none was measured. */
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  latencySampleCount: number;
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
  /** null when no answered request of this deployment was measured. */
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
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
  /**
   * How people used the agent at this version, and that kind's settings.
   * `agentKind` is null on versions taken before kinds were recorded.
   */
  agentKind?: AgentKind | null;
  kindConfig?: KindConfig | null;
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
  // `schedulePaused` is `true` only when the rollback turned the agent's own schedule off (its kind moved away from `scheduled`).
  rollbackToVersion: (agentId: string, version: string) =>
    api<AgentVersion & { schedulePaused?: true }>(
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
  | "training.cancelled"
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

export type VerificationStatus = "pending" | "verified" | "expired";
export type DomainRoutingStatus = "pending" | "ok" | "misrouted" | "unresolvable";
export type SslStatus = "pending" | "provisioning" | "active" | "failed" | "expired";
/** Why a domain that could serve is not serving. Null when it serves or is still being set up. */
export type DomainPausedReason =
  | "disabled"
  | "plan_inactive"
  | "target_missing"
  | "verification_lost"
  | "dns_not_routed"
  | "certificate_invalid";

export interface DnsRecordInstruction {
  name: string;
  type: "TXT" | "CNAME" | "A" | "AAAA";
  value: string;
}

/**
 * The records to publish. The routing records are null/empty while custom
 * domains are not configured on the server: there is nothing true to point at.
 */
export interface DnsRecords {
  txtRecord: DnsRecordInstruction;
  cnameRecord: DnsRecordInstruction | null;
  aRecords: DnsRecordInstruction[];
  aaaaRecords: DnsRecordInstruction[];
  recommended: "cname" | "a" | null;
}

/** DNS routing as the checker last observed it. */
export interface DomainRoutingView {
  status: DomainRoutingStatus;
  checkedAt: string | null;
  error: string | null;
  observedAddresses: string[];
}

/** The certificate as last read from a TLS handshake. Null fields were never observed. */
export interface DomainCertificateView {
  status: SslStatus;
  provider: string | null;
  issuer: string | null;
  validFrom: string | null;
  expiresAt: string | null;
  fingerprint256: string | null;
  checkedAt: string | null;
  error: string | null;
}

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
  /** When the current verification attempt started; an unverified domain expires 14 days later. */
  verificationStartedAt: string | null;
  /** Set when a verified domain's TXT record stopped being found; serving stops 72 hours later. */
  verificationLostAt: string | null;
  routingStatus: DomainRoutingStatus;
  routingCheckedAt: string | null;
  routingError: string | null;
  observedAddresses: string[];
  isApex: boolean | null;
  sslStatus: SslStatus;
  sslProvider: string | null;
  sslIssuer: string | null;
  sslValidFrom: string | null;
  sslExpiresAt: string | null;
  sslFingerprint256: string | null;
  sslCheckedAt: string | null;
  sslError: string | null;
  routingMode: string;
  forceHttps: boolean;
  headers: Record<string, string> | null;
  /** The owner's switch. */
  enabled: boolean;
  /** Derived by the server: the domain is serving requests right now. */
  isActive: boolean;
  pausedReason: DomainPausedReason | null;
  isPrimary: boolean;
  nextCheckAt: string | null;
  totalRequests: number | string;
  lastRequestAt: string | null;
  createdAt: string;
  updatedAt: string;
  dnsRecords: DnsRecords;
  routing: DomainRoutingView;
  certificate: DomainCertificateView;
}

/** Every domain view carries its DNS records; the name is kept for callers. */
export type CustomDomainWithDns = CustomDomain;

/** GET /api/domains/config: whether custom domains work on this server and plan. */
export interface DomainsConfig {
  configured: boolean;
  unavailableReason: string | null;
  edge: { hostname: string; ipv4: string[]; ipv6: string[] } | null;
  verification: { recordPrefix: string; type: "TXT" };
  plan: { plan: PlanId; entitled: boolean; upgradeUrl: string; includedIn: PlanId[] };
  /** A platform safety limit, the same on every plan; every domain counts, in any state. */
  limits: { maxDomainsPerOrganization: number };
  policy: { httpsEnforced: boolean; verificationGraceHours: number; pendingExpiryDays: number };
}

export interface DomainVerifyResult {
  verified: boolean;
  verificationStatus: VerificationStatus;
  routingStatus: DomainRoutingStatus;
  sslStatus: SslStatus;
  isActive: boolean;
  pausedReason: DomainPausedReason | null;
  message: string;
  dnsRecords: DnsRecords;
  /** What DNS answered during this check. */
  observed: { txtFound: boolean; addresses: string[]; addressesChecked: boolean };
  domain: CustomDomain;
}

export interface DomainCertificateCheckResult {
  message: string;
  /** False when no handshake was made (the domain does not qualify for one). */
  probed: boolean;
  sslStatus: SslStatus;
  sslIssuer: string | null;
  sslExpiresAt: string | null;
  sslCheckedAt: string | null;
  sslError: string | null;
  isActive: boolean;
  pausedReason: DomainPausedReason | null;
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
  /** Serving requests right now. */
  active: number;
  pending: number;
  paused: number;
  sslExpiringSoon: number;
}

export interface SslStatusInfo {
  sslStatus: SslStatus;
  sslProvider: string | null;
  sslIssuer: string | null;
  sslValidFrom: string | null;
  sslExpiresAt: string | null;
  sslFingerprint256: string | null;
  sslCheckedAt: string | null;
  sslError: string | null;
  needsRenewal: boolean;
}

export interface CreateDomainInput {
  domain: string;
  targetType: "agent" | "deployment";
  targetId: string;
  headers?: Record<string, string>;
}

export const domainsApi = {
  // Whether custom domains are configured on this server and included in the plan
  getConfig: () => api<{ success: boolean; data: DomainsConfig }>("/api/domains/config"),

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
    api<{ success: boolean; data: CustomDomain; message: string }>("/api/domains", {
      method: "POST",
      body: input,
    }),

  // Get domain
  getDomain: (domainId: string) =>
    api<{ success: boolean; data: CustomDomain }>(`/api/domains/${domainId}`),

  // Update domain. HTTPS is always enforced, so there is no switch for it.
  updateDomain: (
    domainId: string,
    updates: {
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

  // "Check now": ownership record and addresses, as DNS answers right now
  verifyDomain: (domainId: string) =>
    api<{ success: boolean; data: DomainVerifyResult }>(`/api/domains/${domainId}/verify`, {
      method: "POST",
    }),

  // New verification token; the previous proof stops counting and serving stops
  reverifyDomain: (domainId: string) =>
    api<{
      success: boolean;
      data: { domain: CustomDomain; dnsRecords: DnsRecords };
      message: string;
    }>(`/api/domains/${domainId}/reverify`, { method: "POST" }),

  // The owner's switch. The field is named isActive on the wire; it sets `enabled`.
  toggleDomain: (domainId: string, enabled: boolean) =>
    api<{ success: boolean; data: CustomDomain; message: string }>(
      `/api/domains/${domainId}/toggle`,
      { method: "POST", body: { isActive: enabled } }
    ),

  // The certificate as last observed
  getSslStatus: (domainId: string) =>
    api<{ success: boolean; data: SslStatusInfo }>(`/api/domains/${domainId}/ssl`),

  // "Re-check the certificate now": one TLS handshake with the edge
  renewSsl: (domainId: string) =>
    api<{ success: boolean; data: DomainCertificateCheckResult }>(`/api/domains/${domainId}/ssl/renew`, {
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
  /** How an agent made from this template is used, and that kind's settings. */
  agentKind: AgentKind;
  kindConfig: KindConfig | null;
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
  list: (params?: { category?: string; framework?: string; difficulty?: string; agentKind?: AgentKind; search?: string; limit?: number; offset?: number }) => {
    const sp = new URLSearchParams();
    if (params?.category) sp.set("category", params.category);
    if (params?.agentKind) sp.set("agentKind", params.agentKind);
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
  use: (templateId: string, data: Omit<CreateAgentInput, "templateId">) =>
    // Only a name is needed; the slug is optional and made unique. The route
    // answers what POST /api/agents answers (201) — the caller redirects to
    // the new agent instead of stranding the user on the gallery (INT-B2).
    api<CreateAgentResult>(`/api/templates/${templateId}/use`, { method: "POST", body: data }),
};

// ============================================
// Capabilities API
// ============================================

/** What works on this server right now, so a screen offers only that. */
export interface Capabilities {
  chat: {
    /** The models an agent can answer on now, in the order the platform tries them. */
    models: Array<{ id: string; label: string }>;
    /** The model an agent with none of its own answers on; null when there is none. */
    defaultModel: string | null;
  };
  /** Earnings can be paid out. */
  payouts: { available: boolean };
  /** Results can be sent by email. */
  emailDelivery: { available: boolean };
  /** An agent can be put on a dedicated GPU. */
  agentGpu: { available: boolean };
  /** A paid task can be run. */
  paidTasks: { available: boolean };
  /** What a Sell screen and a buyer's page say of paid use of an agent. */
  paidUse: {
    /** How often one buyer may use an agent. */
    perBuyerPerMinute: number;
    perBuyerPerDay: number;
    /** The smallest price of one use, in cents. */
    minPricePerUseCents: number;
    /** Answers a day on the platform's models for the caller's organization; null when it cannot be read. */
    freeModelDailyAllowance: number | null;
  };
}

export const capabilitiesApi = {
  get: () => api<Capabilities>("/api/capabilities"),
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
  options?: { onToolCalls?: (calls: PlaygroundToolCall[]) => void; signal?: AbortSignal }
): AsyncGenerator<string, void, unknown> {
  const res = await fetch(
    `${API_URL}/api/agents/${agentId}/playground/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      credentials: "include",
      signal: options?.signal,
    }
  );

  if (!res.ok) {
    // readBody tolerates empty / non-JSON error bodies (proxy 502 pages),
    // so the real status survives as an ApiError.
    const data = await readBody(res);
    throw new ApiError(res.status, res.statusText, data);
  }

  if (!res.body) return;

  for await (const event of readSseChat(res.body)) {
    if (event.type === "done") return;
    // A provider (or the server) can report a failure INSIDE a 200 stream.
    // Surface it — never render a half answer as if it were whole.
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "toolCalls") options?.onToolCalls?.(event.toolCalls as PlaygroundToolCall[]);
    else yield event.content;
  }
}

// ============================================
// Web chat channel (/api/channels/web) and Try it
// (/api/marketplace/listings/:slug/try)
// ============================================

export type WidgetPosition = "bottom-right" | "bottom-left";

/** One publishable web chat key, as its owner sees it. */
export interface WidgetKey {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  /** Public by design: it is printed in the snippet. */
  publicKey: string;
  allowedOrigins: string[];
  /** null = the platform default (`defaults.dailyMessageCap` of the list). */
  dailyMessageCap: number | null;
  perIpPerMinute: number | null;
  appearance: {
    title: string | null;
    greeting: string | null;
    primaryColor: string | null;
    position: WidgetPosition;
  };
  storeTranscripts: boolean;
  hideBranding: boolean;
  enabled: boolean;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /**
   * Set on the one key that serves an agent's public page, to that agent's
   * id; null on a key made for a website. Pausing it pauses public use.
   */
  pageOfAgentId: string | null;
  createdAt: string;
  /** Messages counted today (UTC); null when the count could not be read. */
  usageToday: number | null;
  /** null when the server does not know its public addresses; the reason says which. */
  snippet: string | null;
  snippetUnavailableReason: string | null;
}

export interface WidgetKeyList {
  keys: WidgetKey[];
  defaults: { dailyMessageCap: number };
  /** Whether this organization's plan may hide "Powered by WheelsAI". */
  whiteLabel: boolean;
}

export interface WidgetKeyInput {
  name?: string;
  allowedOrigins?: string[];
  dailyMessageCap?: number | null;
  perIpPerMinute?: number | null;
  appearance?: {
    title?: string | null;
    greeting?: string | null;
    primaryColor?: string | null;
    position?: WidgetPosition;
  };
  storeTranscripts?: boolean;
  hideBranding?: boolean;
  enabled?: boolean;
}

export const webChannelApi = {
  listKeys: (options: { agentId?: string; includeRevoked?: boolean } = {}) => {
    const query = new URLSearchParams();
    if (options.agentId) query.set("agentId", options.agentId);
    if (options.includeRevoked) query.set("includeRevoked", "true");
    const suffix = query.toString();
    return api<WidgetKeyList>(`/api/channels/web/keys${suffix ? `?${suffix}` : ""}`);
  },
  createKey: (input: Omit<WidgetKeyInput, "enabled"> & { agentId: string; name: string }) =>
    api<{ key: WidgetKey }>("/api/channels/web/keys", { method: "POST", body: input }),
  updateKey: (id: string, input: WidgetKeyInput) =>
    api<{ key: WidgetKey }>(`/api/channels/web/keys/${id}`, { method: "PATCH", body: input }),
  /** A new public value; every snippet carrying the old one stops working. */
  rotateKey: (id: string) => api<{ key: WidgetKey }>(`/api/channels/web/keys/${id}/rotate`, { method: "POST" }),
  /** Permanent. */
  revokeKey: (id: string) => api<null>(`/api/channels/web/keys/${id}`, { method: "DELETE" }),
};

/** Who may start a Try it chat right now: `signin` means there is no anonymous door. */
export type TryItGate = "session" | "turnstile" | "signin";

export interface TryItAvailability {
  enabled: boolean;
  /** How people use the listed agent. */
  agentKind: AgentKind;
  /** A task agent's form; null for any other kind. */
  inputSchema: TaskInputSchema | null;
  disabledReason: "graph_agent_preview" | "no_model_available" | null;
  gate: TryItGate;
  turnstileSiteKey: string | null;
  model: { id: string; label: string; substituted: boolean; note: string | null } | null;
  limits: { messagesPerSession: number; maxMessageChars: number; maxMessages: number; maxTotalChars: number };
  /** The agent's tools a preview withholds. */
  disabledTools: string[];
}

export interface TryItSession {
  sessionToken: string;
  expiresAt: string;
  messagesRemaining: number;
}

/** The publisher's view of one listing's Try it. */
export interface ListingTrialSettings {
  trial: { enabled: boolean; fundedDailyCap: number };
  pricing: { baseDailyMessages: number; fundedMessageCents: number | null };
  today: { day: string; baseCount: number | null; fundedCount: number; fundedSpentCents: number };
}

export const tryItApi = {
  availability: (slug: string) =>
    api<TryItAvailability>(`/api/marketplace/listings/${encodeURIComponent(slug)}/try`),
  startSession: (slug: string, turnstileToken?: string) =>
    api<TryItSession>(`/api/marketplace/listings/${encodeURIComponent(slug)}/try/session`, {
      method: "POST",
      body: turnstileToken ? { turnstileToken } : {},
    }),
  /**
   * One message, streamed. A refusal (a limit, an expired session) throws an
   * ApiError before anything is yielded; a failure inside the stream arrives
   * as an `error` event.
   */
  streamChat: async function* (
    slug: string,
    body: { sessionToken: string; messages: Array<{ role: "user" | "assistant"; content: string }> },
    signal?: AbortSignal,
  ): AsyncGenerator<SseChatEvent, void, unknown> {
    const res = await fetch(`${API_URL}/api/marketplace/listings/${encodeURIComponent(slug)}/try/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      credentials: "include",
      signal,
    });
    if (!res.ok) throw new ApiError(res.status, res.statusText, await readBody(res));
    if (!res.body) return;
    yield* readSseChat(res.body);
  },
  getSettings: (listingId: string) => api<ListingTrialSettings>(`/api/marketplace/listings/${listingId}/trial`),
  /** 501 `trial_funding_not_configured` while a funded message has no price. */
  updateSettings: (listingId: string, input: { fundedDailyCap: number }) =>
    api<ListingTrialSettings>(`/api/marketplace/listings/${listingId}/trial`, { method: "PATCH", body: input }),
};

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
