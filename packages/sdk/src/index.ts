import { WheelsAIClient, type ClientConfig } from "./client.js";
import {
  authResource,
  agentsResource,
  deploymentsResource,
  modelsResource,
  billingResource,
  marketplaceResource,
  inferenceResource,
  versioningResource,
} from "./resources/index.js";

export class WheelsAI {
  readonly auth;
  readonly agents;
  readonly deployments;
  readonly models;
  readonly billing;
  readonly marketplace;
  readonly inference;
  readonly versioning;

  private client: WheelsAIClient;

  constructor(config: ClientConfig) {
    this.client = new WheelsAIClient(config);
    this.auth = authResource(this.client);
    this.agents = agentsResource(this.client);
    this.deployments = deploymentsResource(this.client);
    this.models = modelsResource(this.client);
    this.billing = billingResource(this.client);
    this.marketplace = marketplaceResource(this.client);
    this.inference = inferenceResource(this.client);
    this.versioning = versioningResource(this.client);
  }

  /**
   * Set the auth token for subsequent requests.
   * Call this after login/register to authenticate.
   */
  setToken(token: string): void {
    this.client.setToken(token);
  }

  /**
   * Set the API key for subsequent requests.
   * Alternative to token-based auth.
   */
  setApiKey(apiKey: string): void {
    this.client.setApiKey(apiKey);
  }
}

// Re-export types
export type { ClientConfig } from "./client.js";
export { WheelsAIClient } from "./client.js";
export { WheelsAIError } from "./error.js";
export type {
  AuthResponse,
  Agent,
  AgentDetail,
  CreateAgentInput,
  PlaygroundChatResponse,
  Deployment,
  DeploymentDetail,
  CreateDeploymentInput,
  DeploymentMetrics,
  Model,
  GpuTier,
  CreditBalance,
  CreditTransaction,
  UsageRecord,
  AgentListing,
  AgentReview,
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  AgentVersion,
  VersionDiff,
} from "./resources/index.js";
