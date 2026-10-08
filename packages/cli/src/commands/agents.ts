import { Command } from "commander";
import chalk from "chalk";
import { WheelsAIError } from "@wheelsai/sdk";
import type { TaskInputIssue } from "@wheelsai/sdk";

import { createSession } from "../client.js";
import { CliError } from "../errors.js";
import { agentKindLabel, resolveAgent } from "../lib/agents.js";
import { parseWholeNumber } from "../lib/numbers.js";
import { clean } from "../lib/terminal.js";
import { Reporter, colorStatus, field, printJson, shortId } from "../ui.js";
import { describeCharge } from "./test.js";

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
      console.log(chalk.dim(`    ${agent.id}  ${agentKindLabel(agent.agentKind)}  ${clean(agent.framework)}  v${clean(agent.version)}`));
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
    // How people use it: they talk to it, give it a task, or it runs on its own.
    console.log(field("Kind", agentKindLabel(agent.agentKind)));
    if (agent.agentKind === "task") {
      // The questions of its form, in order; with none of its own it asks one: "Your request".
      const questions = agent.kindConfig?.task?.fields ?? [];
      console.log(field("Form", questions.length > 0 ? clean(questions.map((question) => question.label).join(", ")) : "Your request"));
    }
    if (agent.agentKind === "scheduled") {
      const suggested = agent.kindConfig?.scheduled?.schedule;
      if (suggested) {
        console.log(field("Suggested", clean(`${suggested.cronExpression}${suggested.timezone ? ` (${suggested.timezone})` : ""}`)));
      }
    }
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
    console.log(field("API", clean(agent.apiEndpoint) ?? chalk.dim("none returned by the API")));
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

/** All of stdin: the answers piped in with --input-stdin. */
async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/** The answers to a task agent's form, from `--input` or stdin: one JSON object, one entry per question. */
export function parseRunInput(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(`${source} is not valid JSON.`, {
      hint: `Send one object with an entry per question, for example ${source === "--input" ? "--input '{\"topic\": \"Refunds\"}'" : '{"topic": "Refunds"}'}.`,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${source} must be a JSON object with an entry for each question.`, {
      hint: "Run `wheelsai agents get <agent>` to see the agent's questions.",
    });
  }
  return parsed as Record<string, unknown>;
}

/** Each answer that needs another look, one a line, as "<question>: <what to do>". */
export function describeInputIssues(issues: TaskInputIssue[]): string[] {
  return issues.map((issue) => {
    const label = clean(issue.label ?? issue.field);
    return label ? `${label}: ${clean(issue.message)}` : clean(issue.message);
  });
}

agentsCommand
  .command("run <agent>")
  .description(
    "Run a task agent on one filled-in form and print its result (by slug or id). " +
      "An installed marketplace agent priced per request charges for it; the charge is shown.",
  )
  .option("--input <json>", "the answers, as one JSON object with an entry for each question")
  .option("--input-stdin", "read the answers from stdin, e.g. `wheelsai agents run my-agent --input-stdin < answers.json`")
  .option("--timeout <seconds>", "how long to wait for the result (a run may take up to two minutes)", "150")
  .option("--json", "output as JSON")
  .action(async (reference: string, opts: { input?: string; inputStdin?: boolean; timeout: string; json?: boolean }) => {
    if (opts.input !== undefined && opts.inputStdin) throw new CliError("Use either --input or --input-stdin, not both.");
    if (opts.input === undefined && !opts.inputStdin) {
      throw new CliError("What should the agent work on? Pass the answers with --input '<json>' or --input-stdin.", {
        hint: "Run `wheelsai agents get <agent>` to see the agent's questions.",
      });
    }
    const timeoutMs = parseWholeNumber("--timeout", opts.timeout) * 1000;
    const input = opts.inputStdin ? parseRunInput(await readStdin(), "The input from stdin") : parseRunInput(opts.input!, "--input");

    const { wheels } = createSession();
    const reporter = new Reporter(opts.json);
    reporter.start("Running");
    const agent = await resolveAgent(wheels, reference);
    let result;
    try {
      result = await wheels.agents.run(agent.id, input, { timeoutMs });
    } catch (err) {
      // The form did not fit: say which answers to look at, in the form's own words.
      if (err instanceof WheelsAIError && err.status === 422 && err.code === "input_invalid") {
        const details = (err.data as { details?: TaskInputIssue[] } | null)?.details;
        if (Array.isArray(details) && details.length > 0) {
          throw new CliError([clean(err.message), ...describeInputIssues(details).map((line) => `  ${line}`)].join("\n"), {
            detail: "HTTP 422 input_invalid",
          });
        }
      }
      throw err;
    }
    reporter.stop();

    if (opts.json) return printJson(result);

    console.log(chalk.bold("\n  Result\n"));
    console.log(`  ${clean(result.output.text).split("\n").join("\n  ")}`);
    console.log();
    console.log(chalk.gray(`  Took:    ${(result.durationMs / 1000).toFixed(1)}s`));
    const charge = describeCharge(result.billing);
    if (charge) console.log(chalk.yellow(`  Charged: ${charge}`));
    console.log();
  });
