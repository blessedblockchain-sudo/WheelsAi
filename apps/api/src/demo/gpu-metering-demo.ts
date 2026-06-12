#!/usr/bin/env tsx
/**
 * WheelsAI GPU Metering Demo
 *
 * Runs a single agent task on hybrid compute (decentralized GPU via Nosana
 * with safe fallback to free-tier cloud inference) and logs runtime, success,
 * and usage totals.
 *
 * Usage:
 *   npx tsx apps/api/src/demo/gpu-metering-demo.ts
 *
 * Requirements:
 *   - GROQ_API_KEY in apps/api/.env (free tier fallback)
 *   - Optional: NOSANA_WALLET_PRIVATE_KEY for actual GPU submission
 */

import "dotenv/config";
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { runChat, type ChatMessage } from "../services/mastra-runtime.js";
import { getAvailableFreeModels, resolveFreeModelConfig } from "../config/free-models.js";
import { getNosanaClient } from "../services/nosana.js";
import { generateAgentJobDefinition, type AgentConfig } from "../services/agent-runtime.js";

const logger = createLogger("gpu-metering-demo");

// ============================================
// Demo Configuration
// ============================================

const DEMO_AGENT: AgentConfig = {
  agent: {
    id: "demo-agent-001",
    name: "WheelsAI Demo Agent",
    slug: "demo-agent",
    framework: "mastra",
    systemPrompt: "You are a helpful AI assistant built on WheelsAI. Answer concisely in 2-3 sentences.",
    tools: [],
    modelConfig: {
      externalModel: "free/groq/llama-3.3-70b",
      temperature: 0.7,
      maxTokens: 512,
    },
    sourceType: "inline",
    sourceCode: "// Demo agent",
    env: {},
    version: "1.0.0",
  },
};

const DEMO_MESSAGES: ChatMessage[] = [
  { role: "user", content: "What is an AI agent and why are they important for developers in 2026? Answer in 2-3 sentences." },
];

// ============================================
// Metering State
// ============================================

interface MeteringLog {
  timestamp: string;
  event: string;
  details: Record<string, unknown>;
}

interface UsageTotals {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatencyMs: number;
  totalErrors: number;
  computeMode: "gpu" | "fallback";
  model: string;
}

const logs: MeteringLog[] = [];
const usage: UsageTotals = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalLatencyMs: 0,
  totalErrors: 0,
  computeMode: "fallback",
  model: "unknown",
};

function logEvent(event: string, details: Record<string, unknown> = {}) {
  const entry: MeteringLog = {
    timestamp: new Date().toISOString(),
    event,
    details,
  };
  logs.push(entry);
  logger.info(details, event);
}

// ============================================
// Step 1: Try GPU (Nosana) Submission
// ============================================

async function tryGpuSubmission(): Promise<boolean> {
  logEvent("gpu.attempt", { message: "Attempting Nosana GPU job submission..." });

  if (!env.NOSANA_WALLET_PRIVATE_KEY) {
    logEvent("gpu.skip", { reason: "NOSANA_WALLET_PRIVATE_KEY not configured — using fallback" });
    return false;
  }

  try {
    const jobDefinition = generateAgentJobDefinition(DEMO_AGENT);
    logEvent("gpu.job_created", {
      framework: DEMO_AGENT.agent.framework,
      image: jobDefinition.ops[0]?.args?.image,
      gpu: jobDefinition.ops[0]?.args?.gpu,
    });

    const nosana = await getNosanaClient();
    const job = await nosana.submitJob(jobDefinition, "3060");

    logEvent("gpu.submitted", {
      jobId: job.id,
      market: job.market,
      status: job.status,
    });

    // Check if it's a mock job (Nosana SDK fallback)
    if (job.id.startsWith("mock_job_")) {
      logEvent("gpu.mock_detected", { reason: "Nosana SDK returned mock job — GPU unavailable" });
      return false;
    }

    usage.computeMode = "gpu";
    logEvent("gpu.success", { jobId: job.id });
    return true;
  } catch (err) {
    logEvent("gpu.failed", {
      error: err instanceof Error ? err.message : "Unknown GPU error",
      fallback: "Switching to free-tier cloud inference",
    });
    return false;
  }
}

// ============================================
// Step 2: Fallback — Free Tier Cloud Inference
// ============================================

async function runFallbackInference(): Promise<void> {
  logEvent("fallback.start", { message: "Running agent task via free-tier cloud inference" });

  const availableModels = getAvailableFreeModels();
  if (availableModels.length === 0) {
    logEvent("fallback.no_models", {
      error: "No free models available — set GROQ_API_KEY, GOOGLE_GEMINI_API_KEY, or TOGETHER_API_KEY",
    });
    usage.totalErrors++;
    return;
  }

  const model = availableModels[0]!;
  usage.model = model.id;

  logEvent("fallback.model_selected", {
    model: model.id,
    provider: model.provider,
    displayName: model.displayName,
  });

  const resolved = resolveFreeModelConfig(model.id);
  if (!resolved) {
    logEvent("fallback.resolve_failed", { model: model.id });
    usage.totalErrors++;
    return;
  }

  const agentConfig = {
    name: DEMO_AGENT.agent.name,
    systemPrompt: DEMO_AGENT.agent.systemPrompt,
    tools: DEMO_AGENT.agent.tools,
    modelConfig: {
      externalModel: model.id,
      temperature: DEMO_AGENT.agent.modelConfig.temperature,
      maxTokens: DEMO_AGENT.agent.modelConfig.maxTokens,
    },
  };

  // Run the chat
  const startTime = Date.now();
  try {
    const result = await runChat(resolved, agentConfig, DEMO_MESSAGES, false);
    const latencyMs = Date.now() - startTime;

    usage.totalRequests++;
    usage.totalInputTokens += result.usage.inputTokens;
    usage.totalOutputTokens += result.usage.outputTokens;
    usage.totalLatencyMs += latencyMs;

    logEvent("fallback.success", {
      model: model.id,
      latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      responseLength: result.content.length,
      responsePreview: result.content.slice(0, 200),
    });
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    usage.totalErrors++;
    usage.totalLatencyMs += latencyMs;

    logEvent("fallback.error", {
      model: model.id,
      latencyMs,
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}

// ============================================
// Step 3: Run a Second Request (for totals)
// ============================================

async function runSecondRequest(): Promise<void> {
  logEvent("second_request.start", { message: "Running second request to verify metering accumulation" });

  const resolved = resolveFreeModelConfig(usage.model);
  if (!resolved) return;

  const followUpMessages: ChatMessage[] = [
    { role: "user", content: "Give me 3 reasons why AI agents will transform software in 2026." },
  ];

  const agentConfig = {
    name: DEMO_AGENT.agent.name,
    systemPrompt: DEMO_AGENT.agent.systemPrompt,
    tools: DEMO_AGENT.agent.tools,
    modelConfig: {
      externalModel: usage.model,
      temperature: DEMO_AGENT.agent.modelConfig.temperature,
      maxTokens: DEMO_AGENT.agent.modelConfig.maxTokens,
    },
  };

  const startTime = Date.now();
  try {
    const result = await runChat(resolved, agentConfig, followUpMessages, false);
    const latencyMs = Date.now() - startTime;

    usage.totalRequests++;
    usage.totalInputTokens += result.usage.inputTokens;
    usage.totalOutputTokens += result.usage.outputTokens;
    usage.totalLatencyMs += latencyMs;

    logEvent("second_request.success", {
      latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  } catch (err) {
    usage.totalErrors++;
    logEvent("second_request.error", { error: err instanceof Error ? err.message : "Unknown" });
  }
}

// ============================================
// Step 4: Verify & Report
// ============================================

function verifyAndReport(): void {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║          WheelsAI GPU Metering Demo — Results              ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Compute Mode:    ${pad(usage.computeMode === "gpu" ? "Nosana GPU (Decentralized)" : "Free-Tier Cloud (Fallback)")}`);
  console.log(`║  Model:           ${pad(usage.model)}`);
  console.log(`║  Total Requests:  ${pad(String(usage.totalRequests))}`);
  console.log(`║  Input Tokens:    ${pad(String(usage.totalInputTokens))}`);
  console.log(`║  Output Tokens:   ${pad(String(usage.totalOutputTokens))}`);
  console.log(`║  Total Latency:   ${pad(usage.totalLatencyMs + "ms")}`);
  console.log(`║  Avg Latency:     ${pad(usage.totalRequests > 0 ? Math.round(usage.totalLatencyMs / usage.totalRequests) + "ms" : "N/A")}`);
  console.log(`║  Errors:          ${pad(String(usage.totalErrors))}`);
  console.log(`║  Success Rate:    ${pad(usage.totalRequests > 0 ? ((usage.totalRequests / (usage.totalRequests + usage.totalErrors)) * 100).toFixed(1) + "%" : "N/A")}`);
  console.log("╠══════════════════════════════════════════════════════════════╣");

  // Verify metering matches logs
  const loggedInputTokens = logs
    .filter((l) => l.event.includes("success") && l.details.inputTokens)
    .reduce((sum, l) => sum + (l.details.inputTokens as number), 0);
  const loggedOutputTokens = logs
    .filter((l) => l.event.includes("success") && l.details.outputTokens)
    .reduce((sum, l) => sum + (l.details.outputTokens as number), 0);

  const inputMatch = loggedInputTokens === usage.totalInputTokens;
  const outputMatch = loggedOutputTokens === usage.totalOutputTokens;

  console.log("║  METERING VERIFICATION                                     ║");
  console.log(`║  Input tokens match:  ${pad(inputMatch ? "✓ PASS" : `✗ FAIL (logs: ${loggedInputTokens}, totals: ${usage.totalInputTokens})`)}`);
  console.log(`║  Output tokens match: ${pad(outputMatch ? "✓ PASS" : `✗ FAIL (logs: ${loggedOutputTokens}, totals: ${usage.totalOutputTokens})`)}`);
  console.log(`║  Overall:             ${pad(inputMatch && outputMatch && usage.totalErrors === 0 ? "✓ ALL CHECKS PASSED" : "⚠ CHECK RESULTS ABOVE")}`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  console.log("\n── Event Log ──────────────────────────────────────────────────");
  for (const log of logs) {
    const time = log.timestamp.split("T")[1]?.slice(0, 12) ?? "";
    console.log(`  [${time}] ${log.event}`);
    for (const [key, value] of Object.entries(log.details)) {
      const val = typeof value === "string" && value.length > 80 ? value.slice(0, 80) + "..." : value;
      console.log(`             ${key}: ${val}`);
    }
  }
  console.log("────────────────────────────────────────────────────────────────\n");
}

function pad(s: string): string {
  return s.padEnd(40) + "║";
}

// ============================================
// Main
// ============================================

async function main() {
  console.log("\n🚀 WheelsAI GPU Metering Demo\n");

  logEvent("demo.start", {
    agent: DEMO_AGENT.agent.name,
    framework: DEMO_AGENT.agent.framework,
    defaultModel: DEMO_AGENT.agent.modelConfig.externalModel,
  });

  // Step 1: Try GPU
  const gpuAvailable = await tryGpuSubmission();

  // Step 2: If no GPU, use fallback
  if (!gpuAvailable) {
    await runFallbackInference();
  }

  // Step 3: Run a second request to test accumulation
  if (usage.totalRequests > 0) {
    await runSecondRequest();
  }

  // Step 4: Report
  verifyAndReport();

  logEvent("demo.complete", {
    totalRequests: usage.totalRequests,
    computeMode: usage.computeMode,
    success: usage.totalErrors === 0,
  });

  process.exit(0);
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
