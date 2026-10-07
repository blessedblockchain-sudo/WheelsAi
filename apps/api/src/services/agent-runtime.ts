/**
 * Agent Runtime Service
 *
 * Generates Nosana job definitions for agent deployments.
 * Supports multiple frameworks: Mastra, LangChain, AutoGen, and custom.
 */

import { createLogger } from "../utils/logger.js";
import type { NosanaJobDefinition } from "./nosana.js";
import {
  DEFAULT_FREE_MODEL_ID,
  freeModelProviderAndName,
} from "../config/free-models.js";

const logger = createLogger("agent-runtime");

// ============================================
// Types
// ============================================

export interface AgentConfig {
  agent: {
    id: string;
    name: string;
    slug: string;
    framework: "mastra" | "langchain" | "autogen" | "custom";
    systemPrompt?: string;
    tools: any[];
    modelConfig: {
      modelId?: string;
      externalModel?: string;
      temperature: number;
      maxTokens: number;
    };
    sourceType: "inline" | "github" | "ipfs";
    sourceUrl?: string;
    sourceCode?: string;
    env: Record<string, string>;
    version: string;
  };
  modelDeploymentId?: string;
  /**
   * Where the container reaches the model of `modelDeploymentId`: an absolute
   * OpenAI-compatible base URL on the public internet - this API's /v1 route
   * for the deployment (modelDeploymentOpenAiBaseUrl), or the deployment's
   * own Nosana endpoint. Required with `modelDeploymentId`: a Nosana node
   * resolves no internal hostname, every service is reachable only through
   * its public URL.
   */
  modelEndpointUrl?: string;
  externalModelUrl?: string;
}

/** An absolute http(s) URL with no credentials in it. */
function isPublicBaseUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

// ============================================
// Job Definition Generators
// ============================================

/**
 * Generate Nosana job definition for an agent deployment
 */
export function generateAgentJobDefinition(config: AgentConfig): NosanaJobDefinition {
  const { agent, modelDeploymentId, modelEndpointUrl, externalModelUrl } = config;

  // Determine model endpoint
  let modelEndpoint: string;
  if (modelDeploymentId) {
    // A WheelsAI model deployment, at the public URL the caller resolved.
    // Never a made-up internal hostname: fail here, before anything is
    // created, rather than start an agent that cannot reach its model.
    if (!isPublicBaseUrl(modelEndpointUrl)) {
      throw new Error("The model deployment has no public endpoint for the agent to call");
    }
    modelEndpoint = modelEndpointUrl.replace(/\/+$/, "");
  } else if (externalModelUrl) {
    modelEndpoint = externalModelUrl;
  } else if (agent.modelConfig.externalModel) {
    // External provider like OpenAI
    modelEndpoint = getExternalProviderUrl(agent.modelConfig.externalModel);
  } else {
    throw new Error("No model endpoint configured");
  }

  // Select runtime image based on framework
  const runtimeImage = getRuntimeImage(agent.framework);

  // Build environment variables
  const envVars: Record<string, string> = {
    AGENT_ID: agent.id,
    AGENT_NAME: agent.name,
    AGENT_VERSION: agent.version,
    AGENT_FRAMEWORK: agent.framework,
    MODEL_ENDPOINT: modelEndpoint,
    MODEL_TEMPERATURE: agent.modelConfig.temperature.toString(),
    MODEL_MAX_TOKENS: agent.modelConfig.maxTokens.toString(),
    SYSTEM_PROMPT: agent.systemPrompt || "",
    TOOLS_CONFIG: JSON.stringify(agent.tools),
    ...agent.env,
  };

  // Add source configuration
  if (agent.sourceType === "inline") {
    envVars.AGENT_SOURCE_TYPE = "inline";
    envVars.AGENT_SOURCE_CODE = agent.sourceCode || "";
  } else if (agent.sourceType === "github") {
    envVars.AGENT_SOURCE_TYPE = "github";
    envVars.AGENT_SOURCE_URL = agent.sourceUrl || "";
  } else if (agent.sourceType === "ipfs") {
    envVars.AGENT_SOURCE_TYPE = "ipfs";
    envVars.AGENT_SOURCE_HASH = agent.sourceUrl?.replace("ipfs://", "") || "";
  }

  // Build the job definition
  const jobDefinition: NosanaJobDefinition = {
    version: "0.1",
    type: "container",
    meta: {
      trigger: "cli",
    },
    ops: [
      {
        type: "container/run",
        id: `agent-${agent.slug}`,
        args: {
          image: runtimeImage,
          env: envVars,
          gpu: shouldUseGpu(agent),
          // Agent HTTP server + health endpoint. No CPU or memory limits:
          // Nosana's schema has none (`resources` there is a list of model
          // sources), and its strict validator refuses the create otherwise.
          expose: [3000, 8080],
        },
      },
    ],
  };

  logger.info(
    { agentId: agent.id, framework: agent.framework },
    "Generated agent job definition"
  );

  return jobDefinition;
}

/**
 * Get the runtime image for a specific framework
 */
function getRuntimeImage(framework: string): string {
  const images: Record<string, string> = {
    mastra: "wheelsai/agent-runtime-mastra:latest",
    langchain: "wheelsai/agent-runtime-langchain:latest",
    autogen: "wheelsai/agent-runtime-autogen:latest",
    elizaos: "wheelsai/agent-runtime-elizaos:latest",
    crewai: "wheelsai/agent-runtime-crewai:latest",
    custom: "wheelsai/agent-runtime-base:latest",
  };

  return images[framework] ?? images.custom ?? "wheelsai/agent-runtime-base:latest";
}

/**
 * Get external provider URL for a model identifier
 */
function getExternalProviderUrl(modelId: string): string {
  // free/<provider>/<id> → <provider>
  let provider: string;
  if (modelId.startsWith("free/")) {
    const parts = modelId.split("/");
    provider = parts[1] ?? "openai";
  } else {
    provider = modelId.split("/")[0] ?? "openai";
  }

  const providerUrls: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    together: "https://api.together.xyz/v1",
    groq: "https://api.groq.com/openai/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  };

  return providerUrls[provider] ?? providerUrls.openai ?? "https://api.openai.com/v1";
}

/**
 * Determine if an agent needs GPU resources
 */
function shouldUseGpu(agent: AgentConfig["agent"]): boolean {
  // Check if using local model (needs GPU)
  if (agent.modelConfig.modelId) {
    return true;
  }

  // Check if any tools require GPU (e.g., image generation, audio processing)
  const gpuRequiringTools = ["image_generation", "audio_transcription", "video_processing"];
  const hasGpuTools = agent.tools.some((tool) =>
    gpuRequiringTools.includes(tool.type || tool.name)
  );

  return hasGpuTools;
}

// ============================================
// Framework-specific Configurations
// ============================================

/**
 * Split an agent's model id into provider + upstream model name.
 * `free/...` ids resolve through the free-model catalog so a retired
 * upstream model is fixed in one place; unknown free ids fall back to the
 * default free model. Other ids are `provider/model`.
 */
export function resolveProviderModel(
  externalModel: string | undefined,
  fallback = "openai/gpt-4",
): { provider: string; modelName: string } {
  const id = externalModel || fallback;
  if (id.startsWith("free/")) {
    return (
      freeModelProviderAndName(id) ??
      freeModelProviderAndName(DEFAULT_FREE_MODEL_ID) ?? {
        provider: "groq",
        modelName: "openai/gpt-oss-120b",
      }
    );
  }
  const [provider, ...rest] = id.split("/");
  return { provider: provider || "openai", modelName: rest.join("/") || "gpt-4" };
}


/**
 * Generate Mastra-specific agent configuration
 */
export function generateMastraConfig(agent: AgentConfig["agent"]): Record<string, any> {
  const { provider, modelName } = resolveProviderModel(agent.modelConfig.externalModel);

  return {
    agent: {
      name: agent.name,
      instructions: agent.systemPrompt,
      model: {
        provider,
        name: modelName,
        temperature: agent.modelConfig.temperature,
        maxTokens: agent.modelConfig.maxTokens,
      },
      tools: agent.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.config?.parameters || {},
      })),
    },
  };
}

/**
 * Generate LangChain-specific agent configuration
 */
export function generateLangChainConfig(agent: AgentConfig["agent"]): Record<string, any> {
  return {
    agent_type: "react", // ReAct agent by default
    llm: {
      model: agent.modelConfig.externalModel || "gpt-4",
      temperature: agent.modelConfig.temperature,
      max_tokens: agent.modelConfig.maxTokens,
    },
    system_message: agent.systemPrompt,
    tools: agent.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      type: tool.type,
      config: tool.config,
    })),
    memory: {
      type: "buffer",
      max_messages: 50,
    },
  };
}

/**
 * Generate AutoGen-specific agent configuration
 */
export function generateAutoGenConfig(agent: AgentConfig["agent"]): Record<string, any> {
  return {
    name: agent.name,
    system_message: agent.systemPrompt,
    llm_config: {
      model: agent.modelConfig.externalModel || "gpt-4",
      temperature: agent.modelConfig.temperature,
      max_tokens: agent.modelConfig.maxTokens,
    },
    human_input_mode: "NEVER",
    max_consecutive_auto_reply: 10,
    code_execution_config: false,
    functions: agent.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.config?.parameters || { type: "object", properties: {} },
    })),
  };
}

/**
 * Generate ElizaOS-specific agent configuration
 */
export function generateElizaOSConfig(agent: AgentConfig["agent"]): Record<string, any> {
  const { provider, modelName } = resolveProviderModel(
    agent.modelConfig.externalModel,
    DEFAULT_FREE_MODEL_ID,
  );
  return {
    name: agent.name,
    bio: agent.systemPrompt ? [agent.systemPrompt] : [],
    lore: [],
    messageExamples: [],
    postExamples: [],
    topics: [],
    style: {
      all: [],
      chat: [],
      post: [],
    },
    adjectives: [],
    modelProvider: provider,
    model: modelName,
    settings: {
      model: `${provider}/${modelName}`,
      temperature: agent.modelConfig.temperature,
      maxOutputTokens: agent.modelConfig.maxTokens,
    },
    plugins: agent.tools.map((tool) => tool.name),
  };
}

/**
 * Generate CrewAI-specific agent configuration
 */
export function generateCrewAIConfig(agent: AgentConfig["agent"]): Record<string, any> {
  return {
    crew: {
      agents: [
        {
          role: agent.name,
          goal: agent.systemPrompt || "Complete assigned tasks effectively",
          backstory: agent.systemPrompt || `You are ${agent.name}, an AI agent.`,
          llm: {
            model: agent.modelConfig.externalModel || "gpt-4",
            temperature: agent.modelConfig.temperature,
            max_tokens: agent.modelConfig.maxTokens,
          },
          tools: agent.tools.map((tool) => tool.name),
          verbose: false,
          allow_delegation: false,
        },
      ],
      tasks: [],
      process: "sequential",
    },
  };
}

// ============================================
// Tool Definitions
// ============================================

export interface ToolDefinition {
  name: string;
  type: "function" | "api" | "mcp";
  description: string;
  inputSchema?: Record<string, any>;
  config?: Record<string, any>;
}

// The built-in tool catalogue lives in services/skills/registry.ts. A second
// list of tool schemas used to sit here; nothing executed it, it named a
// different search provider than the one the runtime actually calls, and it
// advertised `code_interpreter` as sandboxed while nothing ran code. There is
// one list now, and it only contains tools that run (or say why they cannot).

/**
 * Validate tool configuration
 */
export function validateToolConfig(tool: ToolDefinition): string[] {
  const errors: string[] = [];

  if (!tool.name || tool.name.length < 1) {
    errors.push("Tool name is required");
  }

  if (!["function", "api", "mcp"].includes(tool.type)) {
    errors.push(`Invalid tool type: ${tool.type}`);
  }

  if (tool.type === "api" && !tool.config?.provider && !tool.config?.url) {
    errors.push("API tools require either a provider or url in config");
  }

  if (tool.type === "mcp" && !tool.config?.server) {
    errors.push("MCP tools require a server in config");
  }

  return errors;
}
