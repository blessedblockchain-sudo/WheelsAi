import { Command } from "commander";
import chalk from "chalk";
import type { PlaygroundChatResponse } from "@wheelsai/sdk";

import { createSession } from "../client.js";
import { resolveAgent } from "../lib/agents.js";
import { parseWholeNumber } from "../lib/numbers.js";
import { clean } from "../lib/terminal.js";
import { Reporter, printJson } from "../ui.js";

/**
 * The marketplace charge for one playground message, as the API reported it, or null when
 * the call was not billed. A charge the user only finds on a statement is a hidden charge.
 */
export function describeCharge(billing: PlaygroundChatResponse["billing"]): string | null {
  if (!billing) return null;
  return `$${(billing.chargedCents / 100).toFixed(2)} for this request (marketplace listing "${clean(billing.listingTitle)}")`;
}

export const testCommand = new Command("test")
  .description(
    "Send one message to an agent through the playground (no GPU deployment needed). " +
      "An installed marketplace agent priced per request charges for it; the charge is shown.",
  )
  .argument("<agent>", "agent slug or id")
  .option("-m, --message <msg>", "message to send", "Hello! Can you tell me about yourself?")
  .option("--model <model>", "model to use (e.g. free/groq/llama-3.3-70b)")
  .option("--timeout <seconds>", "how long to wait for the reply (agents with tools can take a while)", "120")
  .option("--json", "output as JSON")
  .action(async (reference: string, opts: { message: string; model?: string; timeout: string; json?: boolean }) => {
    const timeoutMs = parseWholeNumber("--timeout", opts.timeout) * 1000;
    const { wheels } = createSession();
    const reporter = new Reporter(opts.json);
    reporter.start("Sending message");
    const agent = await resolveAgent(wheels, reference);
    const result = await wheels.agents.playgroundChat(
      agent.id,
      { messages: [{ role: "user", content: opts.message }], model: opts.model },
      { timeoutMs },
    );
    reporter.stop();

    if (opts.json) return printJson(result);

    console.log(chalk.bold("\n  Agent response\n"));
    console.log(`  ${clean(result.content)}`);
    console.log();
    console.log(chalk.gray(`  Model:   ${clean(result.model)}`));
    console.log(chalk.gray(`  Tokens:  ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`));
    const charge = describeCharge(result.billing);
    if (charge) console.log(chalk.yellow(`  Charged: ${charge}`));
    console.log();
  });
