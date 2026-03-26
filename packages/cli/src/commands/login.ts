import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { WheelsAI } from "@wheelsai/sdk";
import { getConfig, setConfig } from "../config.js";

export const loginCommand = new Command("login")
  .description("Authenticate with WheelsAI")
  .option("--api-key <key>", "Authenticate with an API key")
  .option("--email <email>", "Email for login")
  .option("--password <password>", "Password for login")
  .option("--url <url>", "API base URL")
  .action(async (opts) => {
    if (opts.url) {
      setConfig("apiUrl", opts.url);
    }

    const config = getConfig();
    const client = new WheelsAI({ baseUrl: config.apiUrl });

    if (opts.apiKey) {
      setConfig("apiKey", opts.apiKey);
      console.log(chalk.green("API key saved successfully."));
      return;
    }

    if (opts.email && opts.password) {
      const spinner = ora("Logging in...").start();
      try {
        const result = await client.auth.login(opts.email, opts.password);
        setConfig("token", result.token);
        spinner.succeed(
          chalk.green(`Logged in as ${result.user.email} (org: ${result.organization.name})`)
        );
      } catch (err: any) {
        spinner.fail(chalk.red(err.message || "Login failed"));
        process.exit(1);
      }
      return;
    }

    console.log(chalk.yellow("Usage:"));
    console.log("  wheelsai login --api-key <key>");
    console.log("  wheelsai login --email <email> --password <password>");
    console.log("  wheelsai login --url <api-url> --api-key <key>");
  });
