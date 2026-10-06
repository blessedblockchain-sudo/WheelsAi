import { Command } from "commander";
import chalk from "chalk";
import type { Agent, AgentDeployment, AgentListing } from "@wheelsai/sdk";

import { createSession } from "../client.js";
import { CliError } from "../errors.js";
import { agentReference } from "../lib/agents.js";
import { channelLabel, type ChannelReport } from "../lib/channels.js";
import { DeployFailure, runDeploy } from "../lib/deploy.js";
import { checkListingText } from "../lib/listing.js";
import { parseWholeNumber } from "../lib/numbers.js";
import { describePricing, parseCategory, parsePricing, pricingNote } from "../lib/pricing.js";
import { clean } from "../lib/terminal.js";
import { Reporter, field, printJson } from "../ui.js";

interface DeployOptions {
  agent?: string;
  gpuTier?: string;
  replicas: string;
  timeout: string;
  interval: string;
  modelDeployment?: string;
  externalModelUrl?: string;
  validate: boolean;
  resume?: string;
  publish?: boolean;
  pricePerRequest?: string;
  monthly?: string;
  free?: boolean;
  tokenized?: boolean;
  title?: string;
  description?: string;
  category?: string;
  json?: boolean;
}

export const deployCommand = new Command("deploy")
  .description("Deploy an agent to GPU, wait until it runs, and optionally list it on the marketplace")
  .argument("[agent]", "agent slug or id (same as --agent)")
  .option("--agent <slug-or-id>", "agent to deploy")
  .option("--gpu-tier <tier>", "GPU tier id from `GET /api/models` (default: the cheapest the API offers)")
  .option("--replicas <n>", "number of replicas", "1")
  .option("--timeout <seconds>", "give up waiting for the deployment to run after this long", "600")
  .option(
    "--interval <seconds>",
    "seconds between status checks once the first few are done (the API refreshes a deployment's status about every 30 seconds)",
    "30",
  )
  .option("--resume <deployment-id>", "wait for a deployment that already exists instead of starting (and paying for) another")
  .option("--model-deployment <id>", "run against one of your running model deployments")
  .option("--external-model-url <url>", "run against an external model endpoint")
  .option("--no-validate", "skip the agent graph check")
  .option("--publish", "after the deployment is running, create and publish a marketplace listing")
  .option("--price-per-request <cents>", "with --publish: charge this many cents per request")
  .option("--monthly <cents>", "with --publish: charge this many cents per month")
  .option("--free", "with --publish: list for free (the default)")
  .option("--tokenized", "with --publish: token-gated once a token is launched for the listing; free to install until then")
  .option("--title <title>", "with --publish: listing title (default: the agent's name)")
  .option("--description <text>", "with --publish: listing description (default: the agent's description)")
  .option("--category <category>", "with --publish: marketplace category (default: from the agent's tags, else other)")
  .option("--json", "print the result as JSON")
  .action(async (positional: string | undefined, opts: DeployOptions) => {
    // Everything that can be checked offline is checked BEFORE any GPU is requested: the flags
    // here, and (in runDeploy) the listing the agent would get, against the API's own limits.
    const agent = agentReference(positional, opts.agent);
    const replicas = parseWholeNumber("--replicas", opts.replicas);
    const timeoutMs = parseWholeNumber("--timeout", opts.timeout) * 1000;
    const intervalMs = parseWholeNumber("--interval", opts.interval) * 1000;
    const pricing = parsePricing(opts);
    parseCategory(opts.category);
    checkListingText(opts);
    if (!opts.publish && (pricing || opts.title !== undefined || opts.description !== undefined || opts.category !== undefined)) {
      throw new CliError("Pricing, --title, --description and --category only apply with --publish.");
    }
    if (opts.resume !== undefined && !UUID.test(opts.resume)) {
      throw new CliError(`--resume takes a deployment id (a UUID), got "${opts.resume}".`);
    }
    if (opts.resume !== undefined && (opts.gpuTier || opts.modelDeployment || opts.externalModelUrl || opts.replicas !== "1")) {
      throw new CliError("--resume waits for an existing deployment: --gpu-tier, --replicas and the model options do not apply.");
    }

    const { wheels, config } = createSession();
    let result;
    try {
      result = await runDeploy(
        { wheels, webUrl: config.webUrl, credential: config.credential, reporter: new Reporter(opts.json) },
        {
          agent,
          gpuTier: opts.gpuTier,
          replicas,
          timeoutMs,
          intervalMs,
          modelDeployment: opts.modelDeployment,
          externalModelUrl: opts.externalModelUrl,
          validate: opts.validate,
          resume: opts.resume,
          publish: opts.publish
            ? { pricing, title: opts.title, description: opts.description, category: opts.category }
            : undefined,
        },
      );
    } catch (error) {
      // The deployment exists: a script reading stdout must still get its id, not an empty document.
      if (opts.json && error instanceof DeployFailure) printJson(error);
      throw error;
    }

    if (opts.json) {
      return printJson({
        agent: { id: result.agent.id, slug: result.agent.slug, name: result.agent.name },
        deployment: result.deployment,
        endpoint: result.deployment.endpoint,
        openaiBaseUrl: result.agent.openaiBaseUrl ?? null,
        openaiModel: result.agent.openaiModel ?? null,
        channels: result.channels,
        listing: result.listing ? { ...result.listing.listing, url: result.listing.url } : undefined,
      });
    }

    printLive(result.agent, result.deployment, result.channels);
    if (result.listing) printListing(result.listing.listing, result.listing.url);
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Only reached with a deployment the API reports as `running`. The endpoint is the agent's
 * OpenAI-compatible URL on the API, printed exactly as returned, with what an OpenAI client
 * needs to use it: the base URL and the model id.
 */
function printLive(agent: Agent, deployment: AgentDeployment, channels: ChannelReport): void {
  console.log(chalk.bold("\n  Agent live!"));
  console.log(field("Deployment", deployment.id));
  console.log(field("GPU", `${clean(deployment.gpuTier)} x${deployment.replicas}`));
  console.log(field("Endpoint", clean(deployment.endpoint) ?? chalk.dim("none returned by the API")));
  if (agent.openaiBaseUrl) {
    console.log(field("OpenAI base", clean(agent.openaiBaseUrl)));
    console.log(field("Model", clean(agent.openaiModel)));
  }
  console.log(
    field(
      "Channels",
      channels.kind === "reported" && channels.channels.length > 0
        ? `${clean(channels.channels.map(channelLabel).join(", "))}${channels.source === "openclaw" ? chalk.dim("  (the agent's OpenClaw deployment)") : ""}`
        : chalk.dim("none reported by the API"),
    ),
  );
  console.log();
}

function printListing(listing: AgentListing, url: string): void {
  console.log(chalk.bold("  Listed on the marketplace"));
  console.log(field("URL", clean(url)));
  console.log(field("Status", clean(listing.status)));
  console.log(field("Pricing", clean(describePricing(listing))));
  const note = pricingNote(listing.pricingModel);
  if (note) console.log(chalk.yellow(`  ${note}`));
  console.log();
}
