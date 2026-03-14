/**
 * Agent Runtime Service
 *
 * Generates Nosana job definitions for agent deployments.
 * Supports multiple frameworks: Mastra, LangChain, AutoGen, and custom.
 */

import { createLogger } from "../utils/logger.js";
import type { NosanaJobDefinition } from "./nosana.js";

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
  externalModelUrl?: string;
}

// ============================================
// Job Definition Generators
// ============================================

/**
 * Generate Nosana job definition for an agent deployment
 */
export function generateAgentJobDefinition(config: AgentConfig): NosanaJobDefinition {
  const { agent, modelDeploymentId, externalModelUrl } = config;

  // Determine model endpoint
  let modelEndpoint: string;
  if (modelDeploymentId) {
    // Use internal WheelsAI model deployment
    modelEndpoint = `http://internal-model-${modelDeploymentId}:8000/v1`;
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
          expose: [3000, 8080], // Agent HTTP server + health endpoint
          resources: {
            memory: "4Gi",
            cpu: "2",
          },
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
    custom: "wheelsai/agent-runtime-base:latest",
  };

  return images[framework] ?? images.custom ?? "wheelsai/agent-runtime-base:latest";
}

/**
 * Get external provider URL for a model identifier
 */
function getExternalProviderUrl(modelId: string): string {
  const provider = modelId.split("/")[0] ?? "openai";

  const providerUrls: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    together: "https://api.together.xyz/v1",
    groq: "https://api.groq.com/openai/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
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
 * Generate Mastra-specific agent configuration
 */
export function generateMastraConfig(agent: AgentConfig["agent"]): Record<string, any> {
  return {
    agent: {
      name: agent.name,
      instructions: agent.systemPrompt,
      model: {
        provider: agent.modelConfig.externalModel?.split("/")[0] || "openai",
        name: agent.modelConfig.externalModel?.split("/")[1] || "gpt-4",
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

/**
 * Built-in tool templates
 */
export const builtInTools: Record<string, ToolDefinition> = {
  web_search: {
    name: "web_search",
    type: "api",
    description: "Search the web for information",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        num_results: { type: "number", description: "Number of results", default: 5 },
      },
      required: ["query"],
    },
    config: {
      provider: "serper", // or "tavily", "bing"
    },
  },
  calculator: {
    name: "calculator",
    type: "function",
    description: "Perform mathematical calculations",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Mathematical expression to evaluate" },
      },
      required: ["expression"],
    },
  },
  code_interpreter: {
    name: "code_interpreter",
    type: "function",
    description: "Execute Python code in a sandboxed environment",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to execute" },
      },
      required: ["code"],
    },
    config: {
      timeout: 30000,
      max_output: 10000,
    },
  },
  http_request: {
    name: "http_request",
    type: "api",
    description: "Make HTTP requests to external APIs",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to request" },
        method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], default: "GET" },
        headers: { type: "object", description: "Request headers" },
        body: { type: "string", description: "Request body" },
      },
      required: ["url"],
    },
  },
  file_read: {
    name: "file_read",
    type: "function",
    description: "Read contents of a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
      },
      required: ["path"],
    },
  },
  file_write: {
    name: "file_write",
    type: "function",
    description: "Write contents to a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
};

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
