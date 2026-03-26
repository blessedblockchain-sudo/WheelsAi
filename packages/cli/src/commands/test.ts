import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { WheelsAI } from "@wheelsai/sdk";
import { getConfig } from "../config.js";

export const testCommand = new Command("test")
  .description("Send a test message to an agent via playground")
  .argument("<agent-id>", "Agent ID to test")
  .option("-m, --message <msg>", "Message to send", "Hello! Can you tell me about yourself?")
  .option("--model <model>", "Model to use (e.g., free/groq/llama-3.3-70b)")
  .option("--json", "Output as JSON")
  .action(async (agentId, opts) => {
    const spinner = ora("Sending message...").start();
    try {
      const config = getConfig();
      const client = new WheelsAI({ baseUrl: config.apiUrl, token: config.token, apiKey: config.apiKey });

      const result = await client.agents.playgroundChat(agentId, {
        messages: [{ role: "user", content: opts.message }],
        model: opts.model,
      });

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold("\n  Agent Response:\n"));
      console.log(`  ${result.content}`);
      console.log();
      console.log(chalk.gray(`  Model: ${result.model}`));
      console.log(chalk.gray(`  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`));
      console.log();
    } catch (err: any) {
      spinner.fail(chalk.red(err.message || "Test failed"));
      process.exit(1);
    }
  });
