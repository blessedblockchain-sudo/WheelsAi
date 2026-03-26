import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { WheelsAI } from "@wheelsai/sdk";
import { getConfig } from "../config.js";

export const deployCommand = new Command("deploy")
  .description("Deploy an agent to GPU")
  .argument("<agent-id>", "Agent ID to deploy")
  .option("--gpu-tier <tier>", "GPU tier (e.g., rtx-4090)", "rtx-4090")
  .option("--replicas <n>", "Number of replicas", "1")
  .action(async (agentId, opts) => {
    const spinner = ora("Deploying agent...").start();
    try {
      const config = getConfig();
      const client = new WheelsAI({ baseUrl: config.apiUrl, token: config.token, apiKey: config.apiKey });

      const { deployment } = await client.agents.deploy(agentId, {
        gpuTier: opts.gpuTier,
        replicas: parseInt(opts.replicas, 10),
      });

      spinner.succeed(
        chalk.green(`Deployment created: ${deployment.id} (status: ${deployment.status})`)
      );
      console.log(chalk.gray(`  Monitor with: wheelsai logs ${deployment.id}`));
    } catch (err: any) {
      spinner.fail(chalk.red(err.message || "Deployment failed"));
      process.exit(1);
    }
  });
