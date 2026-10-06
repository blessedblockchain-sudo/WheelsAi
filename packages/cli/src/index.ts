#!/usr/bin/env node

import { Command } from "commander";

import { agentsCommand } from "./commands/agents.js";
import { configCommand } from "./commands/config.js";
import { deployCommand } from "./commands/deploy.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { logsCommand } from "./commands/logs.js";
import { publishCommand } from "./commands/publish.js";
import { testCommand } from "./commands/test.js";
import { whoamiCommand } from "./commands/whoami.js";
import { resolveConfig } from "./config.js";
import type { ErrorContext } from "./errors.js";
import { reportFatal } from "./ui.js";

const program = new Command()
  .name("wheelsai")
  .description("WheelsAI CLI: build, deploy and monetize AI agents")
  .version("0.1.0");

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(configCommand);
program.addCommand(agentsCommand);
program.addCommand(testCommand);
program.addCommand(deployCommand);
program.addCommand(publishCommand);
program.addCommand(logsCommand);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  let context: ErrorContext = {};
  try {
    const config = resolveConfig();
    context = { webUrl: config.webUrl, credentialSource: config.credentialSource };
  } catch {
    // The config file itself may be the problem; the error still gets printed.
  }
  process.exitCode = reportFatal(error, context);
}
