import chalk from "chalk";
import { WheelsAIError, type Agent, type AgentDeployment, type WheelsAI } from "@wheelsai/sdk";

import { CliError, describeError } from "../errors.js";
import type { Reporter } from "../ui.js";
import { shortId } from "../ui.js";
import { resolveAgent } from "./agents.js";
import { findChannels, type ChannelReport } from "./channels.js";
import { checkAgentGraph } from "./graph.js";
import { chooseTier, describeTier, loadTiers } from "./gpu.js";
import {
  describePublishOutcome,
  preflightListing,
  publishAgent,
  publishCommandLine,
  type PublishOptions,
  type PublishResult,
} from "./listing.js";
import { waitForDeployment, type PollOutcome, type PollResult } from "./poll.js";
import { clean } from "./terminal.js";

export interface DeployRequest {
  /** Agent slug or id. */
  agent: string;
  gpuTier?: string;
  replicas: number;
  timeoutMs: number;
  /** The steady time between status checks; the first few come sooner. */
  intervalMs: number;
  modelDeployment?: string;
  externalModelUrl?: string;
  /** Check the agent's graph with the API's validator first. */
  validate: boolean;
  /** When set, create and publish a marketplace listing once the deployment is running. */
  publish?: PublishOptions;
  /**
   * The id of a deployment that already exists: wait for that one instead of creating
   * another. Nothing is requested from the GPU network and no credits are reserved.
   */
  resume?: string;
}

export interface DeployContext {
  wheels: WheelsAI;
  webUrl: string;
  /** Which credential requests carry; decides how a graph that cannot be read is treated. */
  credential: "token" | "apiKey" | "none";
  reporter: Reporter;
  /** Test seams for the polling clock. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeployResult {
  agent: Agent;
  /** The deployment as the API last reported it (status `running`). */
  deployment: AgentDeployment;
  channels: ChannelReport;
  listing?: PublishResult;
}

/** What is known about a deployment at the moment something went wrong. */
export type KnownDeployment = Pick<AgentDeployment, "id" | "status"> & Partial<AgentDeployment>;

/**
 * Any failure after the deployment exists. The deployment is on the server and its credits
 * are reserved whatever happened to this command, so the error always carries its id: losing
 * it is how a retry turns into a second paid deployment.
 */
export class DeployFailure extends CliError {
  readonly agent: Pick<Agent, "id" | "slug" | "name">;
  readonly deployment: KnownDeployment;
  /** The HTTP status and API error code of the request that failed, when one did. */
  readonly status?: number;
  readonly code?: string;

  constructor(
    cause: unknown,
    agent: Pick<Agent, "id" | "slug" | "name">,
    deployment: KnownDeployment,
    /** What to do about this deployment. Left out when the cause already says (a failed or timed-out wait). */
    next?: string,
  ) {
    const described = describeError(cause);
    super(described.message, {
      detail: described.detail,
      hint: [next, described.hint].filter(Boolean).join("\n") || undefined,
    });
    this.name = "DeployFailure";
    this.agent = { id: agent.id, slug: agent.slug, name: agent.name };
    this.deployment = deployment;
    if (cause instanceof WheelsAIError) {
      this.status = cause.status;
      this.code = cause.code;
    }
  }

  /** The failure as one JSON document, for `--json`. */
  toJSON(): { agent: DeployFailure["agent"]; deployment: KnownDeployment; error: { message: string; status?: number; code?: string } } {
    return {
      agent: this.agent,
      deployment: this.deployment,
      error: { message: this.message, ...(this.status !== undefined && { status: this.status }), ...(this.code && { code: this.code }) },
    };
  }
}

const FINAL_STATUSES = new Set(["running", "failed", "stopped"]);

/** The first status check comes after this long; the wait then doubles up to `intervalMs`. */
const FIRST_POLL_MS = 5_000;

/**
 * Deploy an agent end to end against the API: resolve, validate, pick a GPU tier,
 * deploy, wait until it runs, then (optionally) list it. Every value in the result
 * is something the API returned; failures throw with the API's own message, and once
 * the deployment exists every failure is a `DeployFailure` naming it.
 */
export async function runDeploy(ctx: DeployContext, request: DeployRequest): Promise<DeployResult> {
  const { wheels, reporter } = ctx;

  // 1. Resolve the agent in the caller's organization.
  reporter.start(`Looking up agent ${request.agent}`);
  const agent = await resolveAgent(wheels, request.agent);
  reporter.succeed(`Agent ${chalk.cyan(clean(agent.name))} ${chalk.dim(`${clean(agent.slug)}  ${agent.id}`)}`);

  // 2. A listing that cannot be created is found out now, not after the GPU is paid for.
  if (request.publish) {
    reporter.start("Checking the marketplace listing");
    await preflightListing(wheels, agent, request.publish);
    reporter.stop();
  }

  const known = request.resume ? await existingDeployment(ctx, agent, request.resume) : await createDeployment(ctx, agent, request);

  // From here on the deployment exists: nothing may be thrown without its id.
  let latest: KnownDeployment = known;
  try {
    // Wait for it to run, showing each status the API reports.
    const final = await followDeployment(ctx, agent, known.id, known.status, request, (deployment) => {
      latest = deployment;
    });
    if (final.outcome !== "running" || !final.deployment) {
      throw failureFor(final.outcome, final.deployment, known.id, request.timeoutMs, agent.slug, final.lastError);
    }
    const deployment = final.deployment;

    // What the API says about channels (the endpoint is already on the deployment).
    const channels = await findChannels(wheels, agent.id, deployment);

    // Optionally list on the marketplace.
    let listing: PublishResult | undefined;
    if (request.publish) {
      try {
        reporter.start("Publishing to marketplace");
        listing = await publishAgent(wheels, agent, ctx.webUrl, request.publish, (step) => reporter.update(step));
        reporter.succeed(describePublishOutcome(listing));
      } catch (error) {
        throw new DeployFailure(
          error,
          agent,
          deployment,
          `The agent is running (deployment ${deployment.id}); only the listing failed. Do not deploy again.\n` +
            `Retry the listing with: ${publishCommandLine(agent.slug, request.publish)}`,
        );
      }
    }

    return { agent, deployment, channels, listing };
  } catch (error) {
    reporter.stop();
    if (error instanceof DeployFailure) throw error;
    // A failed, stopped or timed-out wait already says what to do; anything else gets the standing advice.
    const settled = error instanceof CliError;
    throw new DeployFailure(
      error,
      agent,
      latest,
      settled
        ? undefined
        : `Deployment ${known.id} exists and carries on (its credits stay reserved); this command only lost track of it.\n` +
          `Check it with: wheelsai logs ${known.id} --agent ${agent.slug}\n` +
          `Keep waiting for it with: wheelsai deploy --agent ${agent.slug} --resume ${known.id}\n` +
          "Running deploy without --resume would start a second, separately billed deployment.",
    );
  }
}

/** Steps for a new deployment: validate the graph, choose a tier, submit. */
async function createDeployment(ctx: DeployContext, agent: Agent, request: DeployRequest): Promise<KnownDeployment> {
  const { wheels, reporter } = ctx;

  // Validate: the graph if it has one; otherwise the lookup was the check.
  if (request.validate) {
    reporter.start("Checking the agent graph");
    const check = await checkAgentGraph(wheels, agent.id, ctx.credential);
    switch (check.kind) {
      case "none":
        reporter.succeed("Agent found; it has no graph to validate");
        break;
      case "valid":
        reporter.succeed(`Graph valid: ${check.nodes} nodes, ${check.edges} edges`);
        for (const issue of check.issues) reporter.warn(clean(issue.message));
        break;
      case "invalid": {
        const errors = check.issues.filter((issue) => issue.type === "error");
        throw new CliError(
          `Agent graph is not valid:\n${errors.map((issue) => `  - ${issue.message}`).join("\n")}`,
          { hint: "Fix it in the builder, or deploy anyway with --no-validate." },
        );
      }
      case "skipped":
        reporter.warn(`Graph not checked: ${check.reason}`);
        break;
    }
  }

  // Pick a GPU tier from the API's own list of deployable tiers.
  reporter.start("Choosing a GPU tier");
  const choice = chooseTier(await loadTiers(wheels), request.gpuTier);
  if (choice.unverified) {
    reporter.warn(`The API lists no deployable GPU tiers; sending "${choice.id}" unchecked`);
  } else {
    const detail = choice.tier ? ` ${chalk.dim(`(${clean(describeTier(choice.tier))})`)}` : "";
    const why = choice.reason === "cheapest" ? chalk.dim("  cheapest available") : "";
    reporter.succeed(`GPU tier ${chalk.cyan(clean(choice.id))}${detail}${why}`);
  }

  reporter.start("Submitting deployment");
  let created: KnownDeployment;
  try {
    ({ deployment: created } = await wheels.agents.deploy(agent.id, {
      gpuTier: choice.id,
      replicas: request.replicas,
      modelDeploymentId: request.modelDeployment,
      externalModelUrl: request.externalModelUrl,
    }));
  } catch (error) {
    // No answer is not a "no": the request may have arrived and created the deployment.
    if (error instanceof WheelsAIError && error.status === 0) {
      throw new CliError(`${clean(error.message)}. The deploy request got no answer, so the deployment may or may not have been created.`, {
        hint:
          `Before deploying again, look for a new deployment with: wheelsai agents get ${agent.slug}\n` +
          "If there is one, wait for it with --resume <deployment-id> instead of starting another.",
      });
    }
    throw error;
  }
  reporter.succeed(`Deployment ${chalk.cyan(created.id)} created ${chalk.dim(`(${clean(created.status)})`)}`);
  return created;
}

/** `--resume`: confirm the deployment is this agent's and pick up from its current status. */
async function existingDeployment(ctx: DeployContext, agent: Agent, deploymentId: string): Promise<KnownDeployment> {
  const { wheels, reporter } = ctx;
  reporter.start(`Finding deployment ${deploymentId}`);
  let deployment: AgentDeployment;
  try {
    ({ deployment } = await wheels.agents.getDeployment(agent.id, deploymentId));
  } catch (error) {
    if (error instanceof WheelsAIError && error.status === 404) {
      throw new CliError(`No deployment ${deploymentId} on agent "${agent.slug}".`, {
        hint: `List the agent's deployments with: wheelsai agents get ${agent.slug}`,
      });
    }
    throw error;
  }
  reporter.succeed(`Deployment ${chalk.cyan(deployment.id)} found ${chalk.dim(`(${clean(deployment.status)})`)}; nothing new was started`);
  return deployment;
}

/** Poll to a final state, turning each status the API reports into a line of progress. */
async function followDeployment(
  ctx: DeployContext,
  agent: Agent,
  deploymentId: string,
  knownStatus: string,
  request: Pick<DeployRequest, "timeoutMs" | "intervalMs">,
  onSeen: (deployment: AgentDeployment) => void,
): Promise<PollResult> {
  const { wheels, reporter } = ctx;
  const label = (status: string, elapsedMs: number) =>
    `Deployment ${shortId(deploymentId)}: ${chalk.yellow(clean(status))} ${chalk.dim(`${Math.round(elapsedMs / 1000)}s`)}`;

  let stateStartedMs = 0;
  reporter.start(label(knownStatus, 0));

  // Ctrl-C stops watching; the deployment itself carries on server-side.
  const onInterrupt = () => {
    reporter.stop();
    console.error(`\nStopped watching. Deployment ${deploymentId} is still in progress on the API.`);
    console.error(chalk.dim(`  Check it with: wheelsai logs ${deploymentId} --agent ${agent.slug}`));
    console.error(chalk.dim(`  Keep waiting for it with: wheelsai deploy --agent ${agent.slug} --resume ${deploymentId}`));
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);

  try {
    return await waitForDeployment({
      fetchDeployment: async () => (await wheels.agents.getDeployment(agent.id, deploymentId)).deployment,
      knownStatus,
      timeoutMs: request.timeoutMs,
      intervalMs: request.intervalMs,
      initialIntervalMs: Math.min(FIRST_POLL_MS, request.intervalMs),
      now: ctx.now,
      sleep: ctx.sleep,
      onTransition: ({ status, previous, elapsedMs }) => {
        if (previous !== null) {
          reporter.succeed(`${clean(previous)} ${chalk.dim(`${Math.round((elapsedMs - stateStartedMs) / 1000)}s`)}`);
        }
        stateStartedMs = elapsedMs;
        if (!FINAL_STATUSES.has(status)) reporter.start(label(status, elapsedMs));
      },
      onPoll: ({ status, elapsedMs, deployment }) => {
        onSeen(deployment);
        reporter.update(label(status, elapsedMs));
      },
      onRetry: (error, attempt) => reporter.update(`Status check failed (${clean(error.message)}); retrying (${attempt})`),
    });
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

/** The error for a deployment that did not reach `running`. */
export function failureFor(
  outcome: PollOutcome,
  deployment: AgentDeployment | null,
  deploymentId: string,
  timeoutMs: number,
  /** With the agent's slug, a timeout can say how to keep waiting for the same deployment. */
  agentSlug?: string,
  /** On a timeout: why the last status check failed, if it did. */
  lastError?: Error,
): CliError {
  const hint = `Details: wheelsai logs ${deploymentId}`;
  switch (outcome) {
    case "failed":
      return new CliError(`Deployment failed: ${deployment?.lastError ?? "the API gave no error message"}`, { hint });
    case "stopped":
      return new CliError("Deployment was stopped before it started running.", { hint });
    case "timeout": {
      const seconds = Math.round(timeoutMs / 1000);
      const state = lastError
        ? `Could not read the deployment's status at the end of ${seconds}s (${clean(lastError.message)}); it was last seen ${deployment?.status ?? "not at all"}.`
        : `Still ${deployment?.status ?? "unknown"} after ${seconds}s.`;
      // Never suggest running deploy again: that starts a second deployment and a second reservation.
      const resume = agentSlug
        ? `\nKeep waiting for this same deployment with: wheelsai deploy --agent ${agentSlug} --resume ${deploymentId}`
        : "";
      return new CliError(`${state} The deployment may yet complete; it was not cancelled.`, {
        hint: `${hint}${resume}\nRunning deploy without --resume would start a second, separately billed deployment.`,
      });
    }
    default:
      return new CliError("Deployment did not reach a running state.", { hint });
  }
}
