import { Command } from "commander";
import chalk from "chalk";

import { CONFIG_KEYS, resolveConfig, setSetting, type ConfigKey } from "../config.js";
import { CliError } from "../errors.js";
import { plainHttpWarning } from "../lib/urls.js";
import { field, printJson } from "../ui.js";

export const configCommand = new Command("config").description("Show or change CLI settings");

configCommand
  .command("show", { isDefault: true })
  .description("Show the effective settings (credentials are not printed)")
  .option("--json", "output as JSON")
  .action((opts: { json?: boolean }) => {
    const config = resolveConfig();
    const summary = {
      apiUrl: config.apiUrl,
      apiUrlSource: config.apiUrlSource,
      webUrl: config.webUrl,
      webUrlSource: config.webUrlSource,
      credential: config.credential === "none" ? "none" : config.credential === "apiKey" ? "API key" : "session token",
      credentialSource: config.credentialSource,
      // A saved credential that is not in use, and the API URL it belongs to.
      credentialWithheld: config.withheld ? { savedFor: config.withheld.savedFor } : undefined,
      configFile: config.configPath,
    };
    if (opts.json) return printJson(summary);
    console.log(chalk.bold("\n  Settings\n"));
    console.log(field("API URL", `${summary.apiUrl} ${chalk.dim(`(${summary.apiUrlSource})`)}`));
    console.log(field("Web URL", `${summary.webUrl} ${chalk.dim(`(${summary.webUrlSource})`)}`));
    console.log(field("Credentials", summary.credential === "none" ? "none" : `${summary.credential} ${chalk.dim(`(${summary.credentialSource})`)}`));
    if (config.withheld) {
      console.log(field("", chalk.yellow(`saved credentials are for ${config.withheld.savedFor ?? "an unrecorded API URL"} and are not sent to this one`)));
    }
    console.log(field("Config file", summary.configFile));
    console.log(chalk.dim("\n  Environment overrides: WHEELSAI_API_URL, WHEELSAI_WEB_URL, WHEELSAI_API_KEY, WHEELSAI_TOKEN\n"));
  });

configCommand
  .command("set <key> <value>")
  .description(`Change a setting (${CONFIG_KEYS.join(" or ")}). An empty webUrl goes back to the derived default.`)
  .action((key: string, value: string) => {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new CliError(`Unknown setting "${key}".`, { hint: `Settings: ${CONFIG_KEYS.join(", ")}.` });
    }
    const saved = setSetting(key as ConfigKey, value);
    console.log(`${chalk.green("✔")} ${key} saved`);
    const insecure = key === "apiUrl" ? plainHttpWarning(saved) : null;
    if (insecure) console.error(`${chalk.yellow("⚠")} ${insecure}`);
    const config = resolveConfig();
    if (key === "apiUrl" && config.withheld?.savedFor) {
      console.error(
        `${chalk.yellow("⚠")} Your saved credentials are for ${config.withheld.savedFor} and will not be sent to ${config.apiUrl}. Sign in with \`wheelsai login\`.`,
      );
    }
  });
