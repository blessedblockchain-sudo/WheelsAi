import { Command } from "commander";
import chalk from "chalk";

import { createSession } from "../client.js";
import { resolveAgent } from "../lib/agents.js";
import { clean } from "../lib/terminal.js";
import { Reporter, colorStatus, field, printJson, shortId } from "../ui.js";

export const agentsCommand = new Command("agents").description("List and inspect your agents");

agentsCommand
  .command("list")
  .description("List the agents in your organization")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { wheels } = createSession();
    const reporter = new Reporter(opts.json);
    reporter.start("Fetching agents");
    const { agents } = await wheels.agents.list();
    reporter.stop();

    if (opts.json) return printJson(agents);

    if (agents.length === 0) {
      console.log(chalk.yellow("No agents yet. Create one in the dashboard, then run `wheelsai deploy --agent <slug>`."));
      return;
    }

    console.log(chalk.bold(`\n  Agents (${agents.length})\n`));
    for (const agent of agents) {
      const latest = agent.latestDeployment;
      const deployed = latest ? `${colorStatus(latest.status)} ${chalk.dim(`deployment ${shortId(latest.id)}`)}` : chalk.dim("not deployed");
      console.log(`  ${chalk.cyan(clean(agent.slug))}  ${clean(agent.name)}  ${deployed}`);
      console.log(chalk.dim(`    ${agent.id}  ${clean(agent.framework)}  v${clean(agent.version)}`));
    }
    console.log();
  });

agentsCommand
  .command("get <agent>")
  .description("Show an agent and its deployments (by slug or id)")
  .option("--json", "output as JSON")
  .action(async (reference: string, opts: { json?: boolean }) => {
    const { wheels } = createSession();
    const reporter = new Reporter(opts.json);
    reporter.start("Fetching agent");
    const summary = await resolveAgent(wheels, reference);
    const { agent } = await wheels.agents.get(summary.id);
    reporter.stop();

    if (opts.json) return printJson(agent);

    console.log(chalk.bold(`\n  ${clean(agent.name)}\n`));
    console.log(field("Slug", clean(agent.slug)));
    console.log(field("ID", agent.id));
    console.log(field("Framework", clean(agent.framework)));
    console.log(field("Version", clean(agent.version)));
    console.log(field("Public", String(agent.isPublic)));
    console.log(field("Tags", clean(agent.tags.join(", "))));
    console.log(field("Tools", clean(agent.tools.map((tool) => tool.name).join(", "))));
    console.log(field("Model", clean(agent.modelConfig?.externalModel ?? agent.modelConfig?.modelId)));
    console.log(field("Secrets", agent.env.keys.length > 0 ? clean(agent.env.keys.join(", ")) : null));
    // What answers a chat, in the playground and on /v1.
    console.log(field("Answers with", agent.entrypoint === "graph" ? "its graph" : "prompt, model and tools"));
    // The agent's OpenAI-compatible API is served by the platform, deployed or not.
    console.log(field("API", clean(agent.apiEndpoint) ?? chalk.dim("not configured on the API (PUBLIC_API_URL is not set)")));
    if (agent.openaiBaseUrl) {
      console.log(field("OpenAI base", clean(agent.openaiBaseUrl)));
      console.log(field("Model id", clean(agent.openaiModel)));
    }

    if (agent.deployments.length > 0) {
      console.log(chalk.bold(`\n  Deployments (${agent.deployments.length})`));
      for (const deployment of agent.deployments) {
        console.log(`    ${colorStatus(deployment.status)}  ${deployment.id}`);
        // An endpoint is only an address that answers while the deployment is running.
        const endpoint = deployment.status === "running" ? clean(deployment.endpoint) ?? "none" : "none (not running)";
        console.log(chalk.dim(`      GPU ${clean(deployment.gpuTier)} x${deployment.replicas}  endpoint ${endpoint}  created ${clean(deployment.createdAt)}`));
        if (deployment.lastError) console.log(chalk.red(`      ${clean(deployment.lastError)}`));
      }
    }
    console.log();
  });
