import { Command } from "commander";
import chalk from "chalk";

import { createSession } from "../client.js";
import { clean } from "../lib/terminal.js";
import { Reporter, field, printJson } from "../ui.js";

export const whoamiCommand = new Command("whoami")
  .description("Show who the saved credentials belong to (calls the API)")
  .option("--json", "output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { wheels, config } = createSession();
    const reporter = new Reporter(opts.json);
    reporter.start(`Asking ${config.apiUrl}`);
    const me = await wheels.auth.me();
    reporter.stop();

    if (opts.json) {
      printJson({ apiUrl: config.apiUrl, authType: me.authType, user: me.user, organization: me.organization });
      return;
    }

    const who = clean(me.user.email ?? me.user.walletAddress ?? null);
    console.log(chalk.bold("\n  WheelsAI\n"));
    console.log(field("API", config.apiUrl));
    console.log(field("Auth", me.authType === "api_key" ? "API key" : "session token"));
    console.log(field("User", who ?? (me.authType === "api_key" ? chalk.dim("none (API keys act for the organization)") : null)));
    console.log(field("Organization", clean(me.organization.id)));
    if (me.authType === "jwt") console.log(field("Verified", me.user.emailVerified ? "email verified" : "email not verified"));
    console.log();
  });
