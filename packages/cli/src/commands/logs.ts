import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { WheelsAI } from "@wheelsai/sdk";
import { getConfig } from "../config.js";

export const logsCommand = new Command("logs")
  .description("View deployment logs and metrics")
  .argument("<deployment-id>", "Deployment ID")
  .option("--json", "Output as JSON")
  .action(async (deploymentId, opts) => {
    const spinner = ora("Fetching deployment...").start();
    try {
      const config = getConfig();
      const client = new WheelsAI({ baseUrl: config.apiUrl, token: config.token, apiKey: config.apiKey });

      const { deployment } = await client.deployments.get(deploymentId);
      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(deployment, null, 2));
        return;
      }

      console.log(chalk.bold(`\n  Deployment: ${deployment.name}\n`));
      console.log(`  Status:     ${deployment.status}`);
      console.log(`  Model:      ${deployment.model}`);
      console.log(`  Engine:     ${deployment.engine}`);
      console.log(`  GPU:        ${deployment.gpuTier}`);
      console.log(`  Replicas:   ${deployment.replicas}`);
      console.log(`  Endpoint:   ${deployment.endpoint || "n/a"}`);
      console.log(`  Nodes:      ${deployment.healthyNodes}/${deployment.totalNodes} healthy`);

      if (deployment.nodes.length > 0) {
        console.log(chalk.bold(`\n  Nodes:`));
        for (const node of deployment.nodes) {
          const health = node.healthStatus === "healthy" ? chalk.green("healthy") : chalk.red(node.healthStatus);
          const latency = node.latencyMs != null ? `${node.latencyMs}ms` : "n/a";
          console.log(`    ${node.id}  ${health}  latency: ${latency}`);
        }
      }
      console.log();
    } catch (err: any) {
      spinner.fail(chalk.red(err.message || "Failed to fetch deployment"));
      process.exit(1);
    }
  });
