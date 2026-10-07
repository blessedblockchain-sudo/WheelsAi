import chalk from "chalk";
import { WheelsAI } from "@wheelsai/sdk";

import { CliError } from "./errors.js";
import { resolveConfig, type ResolvedConfig } from "./config.js";
import { plainHttpWarning } from "./lib/urls.js";

export interface Session {
  wheels: WheelsAI;
  config: ResolvedConfig;
}

/** Why there is no credential to send, in words that say how to get one. */
export function missingCredential(config: Pick<ResolvedConfig, "apiUrl" | "withheld">): CliError {
  if (config.withheld?.savedFor) {
    return new CliError(
      `Your saved credentials are for ${config.withheld.savedFor}, so they were not sent to ${config.apiUrl}.`,
      {
        hint:
          `Sign in to this API with \`wheelsai login --url ${config.apiUrl}\`, ` +
          `or go back with \`wheelsai config set apiUrl ${config.withheld.savedFor}\`.`,
      },
    );
  }
  if (config.withheld) {
    return new CliError("Your saved credentials do not record which API they belong to, so they were not sent.", {
      hint: `Sign in again: \`wheelsai login --url ${config.apiUrl}\`.`,
    });
  }
  return new CliError("Not logged in.", {
    hint: "Run `wheelsai login --url <api-url>` (it asks for your API key), or `wheelsai login --email <email> --url <api-url>`.",
  });
}

/** An SDK client using the stored (or environment) API URL and credentials. */
export function createSession(options: { requireAuth?: boolean; timeoutMs?: number } = {}): Session {
  const config = resolveConfig();
  if (options.requireAuth !== false && config.credential === "none") {
    throw missingCredential(config);
  }
  const insecure = config.credential === "none" ? null : plainHttpWarning(config.apiUrl);
  if (insecure) console.error(`${chalk.yellow("⚠")} ${insecure}`);
  const wheels = new WheelsAI({
    baseUrl: config.apiUrl,
    token: config.token || undefined,
    apiKey: config.apiKey || undefined,
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
  });
  return { wheels, config };
}
