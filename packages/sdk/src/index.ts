import { WheelsAIClient, type ClientConfig } from "./client.js";
import {
  authResource,
  agentsResource,
  destinationsResource,
  deploymentsResource,
  modelsResource,
  billingResource,
  marketplaceResource,
  inferenceResource,
  workflowsResource,
  offeringsResource,
  jobsResource,
  versioningResource,
  openclawResource,
  platformResource,
  skillsResource,
} from "./resources/index.js";

export class WheelsAI {
  readonly auth;
  readonly agents;
  readonly destinations;
  readonly deployments;
  readonly models;
  readonly billing;
  readonly marketplace;
  readonly inference;
  readonly workflows;
  readonly offerings;
  readonly jobs;
  readonly versioning;
  readonly openclaw;
  readonly platform;
  readonly skills;

  private client: WheelsAIClient;

  constructor(config: ClientConfig) {
    this.client = new WheelsAIClient(config);
    this.auth = authResource(this.client);
    this.agents = agentsResource(this.client);
    this.destinations = destinationsResource(this.client);
    this.deployments = deploymentsResource(this.client);
    this.models = modelsResource(this.client);
    this.billing = billingResource(this.client);
    this.marketplace = marketplaceResource(this.client);
    this.inference = inferenceResource(this.client);
    this.workflows = workflowsResource(this.client);
    this.offerings = offeringsResource(this.client);
    this.jobs = jobsResource(this.client);
    this.versioning = versioningResource(this.client);
    this.openclaw = openclawResource(this.client);
    this.platform = platformResource(this.client);
    this.skills = skillsResource(this.client);
  }

  /**
   * Set the session token for subsequent requests.
   * Call this after `auth.login` / `auth.register`.
   */
  setToken(token: string | undefined): void {
    this.client.setToken(token);
  }

  /**
   * Set the API key (`wheels_live_...`) for subsequent requests. It is sent as
   * `Authorization: Bearer <key>`, like a session token.
   */
  setApiKey(apiKey: string | undefined): void {
    this.client.setApiKey(apiKey);
  }
}

export type { ClientConfig, Query, QueryValue, RequestOptions } from "./client.js";
export { WheelsAIClient, seg } from "./client.js";
export { WheelsAIError, extractErrorInfo } from "./error.js";
export * from "./resources/index.js";
