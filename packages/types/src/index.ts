// WheelsAI Type Definitions

import { z } from "zod";

// ============================================
// Model Types
// ============================================

export const modelSchema = z.object({
  id: z.string(),
  hfId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  parameters: z.number(),
  minGpuTier: z.string(),
  supportedEngines: z.array(z.enum(["vllm", "ollama"])),
  defaultEngine: z.enum(["vllm", "ollama"]),
  contextLength: z.number(),
  license: z.string().optional(),
  tags: z.array(z.string()),
  pricingTier: z.enum(["small", "medium", "large"]),
  pricing: z.object({
    inputPer1k: z.number(),
    outputPer1k: z.number(),
  }).optional(),
});

export type Model = z.infer<typeof modelSchema>;

// ============================================
// GPU Tier Types
// ============================================

export const gpuTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  vram: z.number(),
  available: z.number(),
  pricePerHour: z.number(),
});

export type GpuTier = z.infer<typeof gpuTierSchema>;

// ============================================
// Deployment Types
// ============================================

export const deploymentStatusSchema = z.enum([
  "pending",
  "provisioning",
  "running",
  "degraded",
  "stopped",
  "failed",
]);

export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>;

export const deploymentConfigSchema = z.object({
  maxTokens: z.number().int().min(256).max(32768).default(4096),
  gpuMemoryUtilization: z.number().min(0.5).max(0.95).default(0.9),
});

export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

export const deploymentNodeSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  healthStatus: z.enum(["healthy", "degraded", "unhealthy", "unknown"]),
  latencyMs: z.number().optional(),
});

export type DeploymentNode = z.infer<typeof deploymentNodeSchema>;

export const deploymentSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
  modelId: z.string(),
  engine: z.enum(["vllm", "ollama"]),
  gpuTier: z.string(),
  replicas: z.number(),
  config: deploymentConfigSchema,
  status: deploymentStatusSchema,
  endpoint: z.string().url().optional(),
  nodes: z.array(deploymentNodeSchema),
  nosanaJobIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stoppedAt: z.string().datetime().optional(),
});

export type Deployment = z.infer<typeof deploymentSchema>;

export const createDeploymentSchema = z.object({
  name: z.string().min(3).max(50),
  modelId: z.string(),
  gpuTier: z.string(),
  engine: z.enum(["vllm", "ollama"]).default("vllm"),
  replicas: z.number().int().min(1).max(10).default(1),
  config: deploymentConfigSchema.optional(),
});

export type CreateDeployment = z.infer<typeof createDeploymentSchema>;

// ============================================
// Auth Types
// ============================================

export const userSchema = z.object({
  id: z.string(),
  email: z.string().email().optional(),
  walletAddress: z.string().optional(),
  createdAt: z.string().datetime(),
});

export type User = z.infer<typeof userSchema>;

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  createdAt: z.string().datetime(),
});

export type Organization = z.infer<typeof organizationSchema>;

export const apiKeySchema = z.object({
  id: z.string(),
  keyPrefix: z.string(),
  name: z.string().optional(),
  scopes: z.array(z.string()),
  lastUsedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
});

export type ApiKey = z.infer<typeof apiKeySchema>;

// ============================================
// Billing Types
// ============================================

export const creditBalanceSchema = z.object({
  balanceCents: z.number(),
  updatedAt: z.string().datetime(),
});

export type CreditBalance = z.infer<typeof creditBalanceSchema>;

export const creditTransactionTypeSchema = z.enum([
  "purchase",
  "usage",
  "refund",
  "adjustment",
  "bonus",
]);

export type CreditTransactionType = z.infer<typeof creditTransactionTypeSchema>;

export const creditTransactionSchema = z.object({
  id: z.string(),
  amountCents: z.number(),
  type: creditTransactionTypeSchema,
  description: z.string().optional(),
  referenceId: z.string().optional(),
  balanceAfter: z.number(),
  createdAt: z.string().datetime(),
});

export type CreditTransaction = z.infer<typeof creditTransactionSchema>;

// ============================================
// Usage Types
// ============================================

export const usageRecordSchema = z.object({
  id: z.string(),
  deploymentId: z.string(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  requestCount: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalLatencyMs: z.number(),
  errorCount: z.number(),
  costCents: z.number(),
});

export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const usageSummarySchema = z.object({
  period: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  avgLatencyMs: z.number(),
  errorRate: z.number(),
  costCents: z.number(),
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

// ============================================
// OpenAI-Compatible API Types
// ============================================

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(chatMessageSchema),
  max_tokens: z.number().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

export const chatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: chatMessageSchema,
      finish_reason: z.enum(["stop", "length", "content_filter"]),
    })
  ),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }),
});

export type ChatCompletionResponse = z.infer<typeof chatCompletionResponseSchema>;

// ============================================
// Agent Wallet Types (Phase 2)
// ============================================

export const agentWalletSchema = z.object({
  id: z.string(),
  deploymentId: z.string(),
  walletAddress: z.string(),
  dailyLimitCents: z.number().optional(),
  perTxLimitCents: z.number().optional(),
  allowedDomains: z.array(z.string()),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
});

export type AgentWallet = z.infer<typeof agentWalletSchema>;

// ============================================
// Branding / White-label Types
// ============================================

export const brandingSchema = z.object({
  logo: z.string().url().optional(),
  favicon: z.string().url().optional(),
  primaryColor: z.string().optional(),
  accentColor: z.string().optional(),
  appName: z.string().optional(),
  supportEmail: z.string().email().optional(),
});

export type Branding = z.infer<typeof brandingSchema>;

// ============================================
// Error Types
// ============================================

export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.any().optional(),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
