import { Command } from "commander";
import chalk from "chalk";
import { WheelsAIError, type Agent, type AgentDeployment, type DeploymentDetail, type DeploymentLogs } from "@wheelsai/sdk";

import { createSession } from "../client.js";
import { CliError } from "../errors.js";
import { findAgentDeployment } from "../lib/logs.js";
import { parseWholeNumber } from "../lib/numbers.js";
import { clean } from "../lib/terminal.js";
import { Reporter, colorStatus, field, printJson } from "../ui.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LogsOptions {
  agent?: string;
  model?: boolean;
  lines?: string;
  json?: boolean;
}

export const logsCommand = new Command("logs")
  .description("Show a deployment's status and logs (agent deployments, or model deployments with --model)")
  .argument("<deployment-id>", "deployment id")
  .option("--agent <slug-or-id>", "the agent the deployment belongs to (skips searching your agents)")
  .option("--model", "the id is a model deployment (from `GET /api/deployments`), not an agent deployment")
  .option("--lines <n>", "model deployments: how many log events to show (10 to 1000)")
  .option("--json", "output as JSON")
  .action(async (deploymentId: string, opts: LogsOptions) => {
    if (!UUID.test(deploymentId)) {
      throw new CliError(`"${deploymentId}" is not a deployment id (they are UUIDs).`, {
        hint: "`wheelsai deploy` prints the id; `wheelsai agents get <agent>` lists an agent's deployments.",
      });
    }
    if (opts.model && opts.agent) throw new CliError("--model and --agent cannot be used together.");
    const lines = opts.lines ? parseWholeNumber("--lines", opts.lines, 10) : undefined;

    const { wheels } = createSession();
    const reporter = new Reporter(opts.json);
    reporter.start("Finding deployment");

    // Agent deployments are what `wheelsai deploy` creates, so they are tried first
    // unless --model says otherwise.
    const found = opts.model ? null : await findAgentDeployment(wheels, deploymentId, opts.agent);
    if (found) {
      const { logs, error } = await wheels.agents.deploymentLogs(found.agent.id, deploymentId);
      reporter.stop();
      if (opts.json) return printJson({ kind: "agent", agent: found.agent, deployment: found.deployment, logs, error });
      printAgentDeployment(found.agent, found.deployment, logs, error);
      return;
    }
    if (opts.agent) {
      throw new CliError(`No deployment ${deploymentId} on agent "${opts.agent}".`);
    }

    let deployment: DeploymentDetail;
    try {
      ({ deployment } = await wheels.deployments.get(deploymentId));
    } catch (error) {
      if (error instanceof WheelsAIError && error.status === 404) {
        throw new CliError(
          opts.model
            ? `No model deployment ${deploymentId} in your organization.`
            : `No agent or model deployment ${deploymentId} in your organization.`,
          { hint: "Check the id, or pass --agent <slug-or-id> / --model to be specific." },
        );
      }
      throw error;
    }

    // The deployment is shown even when its events cannot be read (a development mock
    // deployment has none; Nosana may be unreachable): the failure is reported, not hidden.
    let events: DeploymentLogs | undefined;
    let eventsError: WheelsAIError | undefined;
    try {
      events = await wheels.deployments.logs(deploymentId, lines ? { lines } : undefined);
    } catch (error) {
      if (!(error instanceof WheelsAIError)) throw error;
      eventsError = error;
      process.exitCode = 1;
    }
    reporter.stop();

    if (opts.json) {
      return printJson({
        kind: "model",
        deployment,
        logs: events?.logs ?? null,
        note: events?.note,
        logsError: eventsError ? { status: eventsError.status, code: eventsError.code, message: eventsError.message } : undefined,
      });
    }
    printModelDeployment(deployment, events, eventsError);
  });

function printModelDeployment(deployment: DeploymentDetail, events: DeploymentLogs | undefined, eventsError: WheelsAIError | undefined): void {
  const healthy = deployment.nodes.filter((node) => node.healthStatus === "healthy").length;
  console.log(chalk.bold(`\n  Model deployment ${chalk.cyan(clean(deployment.name))}\n`));
  console.log(field("ID", deployment.id));
  console.log(field("Status", colorStatus(deployment.status)));
  console.log(field("Reason", clean(deployment.statusReason)));
  console.log(field("Model", clean(deployment.model.displayName)));
  console.log(field("Engine", clean(deployment.engine)));
  console.log(field("GPU", `${clean(deployment.gpuTier)} x${deployment.replicas}`));
  console.log(field("Endpoint", clean(deployment.endpoint) ?? chalk.dim("none (not running)")));
  console.log(field("Nodes", `${healthy}/${deployment.nodes.length} healthy`));
  console.log(chalk.bold("\n  Events"));
  if (eventsError) {
    console.log(chalk.red(`  Unavailable: ${clean(eventsError.message)}`));
    console.log(chalk.dim(`  HTTP ${eventsError.status}${eventsError.code ? ` ${clean(eventsError.code)}` : ""}`));
  } else if (events) {
    console.log(chalk.dim(`  ${clean(events.note)}`));
    if (events.logs.length === 0) console.log(chalk.dim("  none reported"));
    for (const entry of events.logs) {
      const level = entry.level === "error" ? chalk.red("error") : chalk.dim("info ");
      console.log(`  ${chalk.dim(clean(entry.timestamp) ?? "")} ${level} ${clean(entry.type)}  ${clean(entry.message)}`);
    }
  }
  console.log();
}

/**
 * The endpoint exactly as the API returned it, and only as a live address while the
 * deployment is running: before or after that, nothing answers there.
 */
export function agentEndpointLabel(deployment: Pick<AgentDeployment, "status" | "endpoint">): string {
  if (!deployment.endpoint) return chalk.dim("none returned by the API");
  const endpoint = clean(deployment.endpoint);
  return deployment.status === "running" ? endpoint : chalk.dim(`${endpoint} (not live: the deployment is ${clean(deployment.status)})`);
}

function printAgentDeployment(agent: Agent, deployment: AgentDeployment, logs: string, error: string | null): void {
  console.log(chalk.bold(`\n  Agent deployment ${chalk.cyan(clean(agent.slug))}\n`));
  console.log(field("ID", deployment.id));
  console.log(field("Status", colorStatus(deployment.status)));
  console.log(field("GPU", `${clean(deployment.gpuTier)} x${deployment.replicas}`));
  console.log(field("Endpoint", agentEndpointLabel(deployment)));
  console.log(field("Created", clean(deployment.createdAt)));
  console.log(field("Updated", clean(deployment.updatedAt)));
  if (deployment.stoppedAt) console.log(field("Stopped", clean(deployment.stoppedAt)));
  if (error) console.log(field("Last error", chalk.red(clean(error))));
  console.log(chalk.bold("\n  Logs"));
  console.log(clean(logs).split("\n").map((line) => `  ${line}`).join("\n"));
  console.log();
}
