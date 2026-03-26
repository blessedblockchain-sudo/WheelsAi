#!/usr/bin/env node

import { Command } from "commander";
import { loginCommand } from "./commands/login.js";
import { agentsCommand } from "./commands/agents.js";
import { deployCommand } from "./commands/deploy.js";
import { logsCommand } from "./commands/logs.js";
import { testCommand } from "./commands/test.js";

const program = new Command()
  .name("wheelsai")
  .description("WheelsAI CLI — Deploy and manage AI agents on decentralized GPUs")
  .version("0.1.0");

program.addCommand(loginCommand);
program.addCommand(agentsCommand);
program.addCommand(deployCommand);
program.addCommand(logsCommand);
program.addCommand(testCommand);

program.parse();
