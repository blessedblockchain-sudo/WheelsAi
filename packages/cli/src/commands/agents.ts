import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { WheelsAI } from "@wheelsai/sdk";
import { getConfig } from "../config.js";

function getClient(): WheelsAI {
  const config = getConfig();
  const client = new WheelsAI({ baseUrl: config.apiUrl, token: config.token, apiKey: config.apiKey });
  return client;
}

export const agentsCommand = new Command("agents")
  .description("Manage agents");

agentsCommand
  .command("list")
  .description("List all agents")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const spinner = ora("Fetching agents...").start();
    try {
      const client = getClient();
      const { agents } = await client.agents.list();
      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(agents, null, 2));
        return;
      }

      if (agents.length === 0) {
        console.log(chalk.yellow("No agents found. Create one with: wheelsai agents create"));
        return;
      }

      console.log(chalk.bold(`\n  Agents (${agents.length})\n`));
      for (const agent of agents) {
        const status = agent.status === "running"
          ? chalk.green(agent.status)
          : chalk.gray(agent.status);
        console.log(`  ${chalk.cyan(agent.name)}  ${status}  ${chalk.gray(agent.id)}`);
        console.log(`    Framework: ${agent.framework}  Version: ${agent.version}`);
      }
      console.log();
    } catch (err: any) {
      spinner.fail(chalk.red(err.message || "Failed to fetch agents"));
      process.exit(1);
    }
  });

agentsCommand
  .command("get <id>")
  .description("Get agent details")
  .option("--json", "Output as JSON")
  .action(async (id, opts) => {
    const spinner = ora("Fetching agent...").start();
    try {
      const client = getClient();
      const { agent } = await client.agents.get(id);
      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(agent, null, 2));
        return;
      }

      console.log(chalk.bold(`\n  ${agent.name}\n`));
      console.log(`  ID:          ${agent.id}`);
      console.log(`  Framework:   ${agent.framework}`);
      console.log(`  Version:     ${agent.version}`);
      console.log(`  Status:      ${agent.status}`);
      console.log(`  Public:      ${agent.isPublic}`);
      console.log(`  Tags:        ${agent.tags.join(", ") || "none"}`);
      console.log(`  Tools:       ${agent.tools.map((t) => t.name).join(", ") || "none"}`);
      console.log(`  Model:       ${agent.modelConfig.externalModel || "default"}`);

      if (agent.deployments.length > 0) {
        console.log(chalk.bold(`\n  Deployments (${agent.deployments.length}):`));
        for (const d of agent.deployments) {
          const status = d.status === "running" ? chalk.green(d.status) : chalk.yellow(d.status);
          console.log(`    ${status}  GPU: ${d.gpuTier}  Endpoint: ${d.endpoint || "n/a"}`);
        }
      }
      console.log();
    } catch (err: any) {
      spinner.fail(chalk.red(err.message || "Failed to fetch agent"));
      process.exit(1);
    }
  });
