import { Command } from "commander";
import chalk from "chalk";

import { createSession } from "../client.js";
import { agentReference, resolveAgent } from "../lib/agents.js";
import { checkListingText, describePublishOutcome, publishAgent } from "../lib/listing.js";
import { describePlans, describePricing, describeSells, parseCategory, parsePricing, pricingNote } from "../lib/pricing.js";
import { clean } from "../lib/terminal.js";
import { Reporter, field, printJson } from "../ui.js";

interface PublishCommandOptions {
  agent?: string;
  pricePerRequest?: string;
  monthly?: string;
  free?: boolean;
  tokenized?: boolean;
  copies?: boolean;
  title?: string;
  description?: string;
  category?: string;
  json?: boolean;
}

export const publishCommand = new Command("publish")
  .description("Create and publish a marketplace listing for an agent (safe to run again)")
  .argument("[agent]", "agent slug or id (same as --agent)")
  .option("--agent <slug-or-id>", "agent to list")
  .option("--price-per-request <cents>", "charge this many cents per request")
  .option("--monthly <cents>", "charge this many cents per month")
  .option("--free", "list for free (the default for a new listing)")
  .option("--copies", "sell copies of the agent instead of use of it: buyers get their own copy, including its instructions, and you cannot take a copy back")
  .option("--tokenized", "token-gated once a token is launched for the listing; free to install until then (needs --copies)")
  .option("--title <title>", "listing title (default: the agent's name)")
  .option("--description <text>", "listing description (default: the agent's description)")
  .option("--category <category>", "marketplace category (default: from the agent's tags, else other)")
  .option("--json", "print the result as JSON")
  .action(async (positional: string | undefined, opts: PublishCommandOptions) => {
    const reference = agentReference(positional, opts.agent);
    const pricing = parsePricing(opts);
    parseCategory(opts.category);
    checkListingText(opts);

    const { wheels, config } = createSession();
    const reporter = new Reporter(opts.json);

    reporter.start(`Looking up agent ${reference}`);
    const agent = await resolveAgent(wheels, reference);
    reporter.succeed(`Agent ${chalk.cyan(clean(agent.name))} ${chalk.dim(`${clean(agent.slug)}  ${agent.id}`)}`);

    reporter.start("Publishing to marketplace");
    const result = await publishAgent(
      wheels,
      agent,
      config.webUrl,
      { pricing, title: opts.title, description: opts.description, category: opts.category, copies: opts.copies },
      (step) => reporter.update(step),
    );
    reporter.succeed(describePublishOutcome(result));

    if (opts.json) return printJson({ ...result.listing, url: result.url });

    console.log(chalk.bold("\n  Marketplace listing\n"));
    console.log(field("URL", clean(result.url)));
    console.log(field("Title", clean(result.listing.title)));
    console.log(field("Status", clean(result.listing.status)));
    console.log(field("Category", clean(result.listing.category)));
    console.log(field("Sells", clean(describeSells(result.listing))));
    console.log(field("Pricing", clean(describePricing(result.listing))));
    // One line for each plan the listing offers, the first beside the label.
    describePlans(result.listing).forEach((plan, index) => console.log(field(index === 0 ? "Plans" : "", clean(plan))));
    const note = pricingNote(result.listing.pricingModel);
    if (note) console.log(chalk.yellow(`\n  ${note}`));
    if (result.created && !pricing) {
      console.log(chalk.dim("\n  Listed free by default. Charge with --price-per-request <cents> (at least 5 for use) or --monthly <cents>."));
    }
    console.log();
  });
