import { Command } from "commander";
import chalk from "chalk";
import { WheelsAI, WheelsAIError, isTwoFactorChallenge, type AuthResponse } from "@wheelsai/sdk";

import { resolveConfig, saveApiKey, saveToken, setSetting, type ResolvedConfig } from "../config.js";
import { CliError } from "../errors.js";
import { promptLine, readSecret } from "../lib/prompt.js";
import { clean } from "../lib/terminal.js";
import { parseBaseUrl, plainHttpWarning, sameOrigin } from "../lib/urls.js";
import { Reporter } from "../ui.js";

interface LoginOptions {
  apiKey?: string;
  apiKeyStdin?: boolean;
  email?: string;
  password?: string;
  passwordStdin?: boolean;
  code?: string;
  url?: string;
  webUrl?: string;
}

const ON_COMMAND_LINE = "is visible in your shell history and to other users in the process list";

export const loginCommand = new Command("login")
  .description("Sign in with an API key (asked for, or read from stdin) or with email and password")
  .option("--api-key-stdin", "read the API key from stdin, e.g. `wheelsai login --api-key-stdin < key.txt`")
  .option("--api-key <key>", "API key on the command line (discouraged: prefer the prompt or --api-key-stdin)")
  .option("--email <email>", "sign in with email and password; the password is asked for")
  .option("--password-stdin", "with --email: read the password from stdin")
  .option("--password <password>", "with --email: password on the command line (discouraged)")
  .option("--code <code>", "two-factor code, if the account has two-factor authentication on")
  .option("--url <url>", "API base URL to sign in to; it is saved with the credential")
  .option("--web-url <url>", "web app URL to use and save (for marketplace links)")
  .action(async (opts: LoginOptions) => {
    const reporter = new Reporter();
    const config = resolveConfig();
    const apiUrl = opts.url !== undefined ? parseBaseUrl(opts.url, "--url") : config.apiUrl;
    const webUrl = opts.webUrl !== undefined && opts.webUrl.trim() !== "" ? parseBaseUrl(opts.webUrl, "--web-url") : opts.webUrl;

    const withKey = opts.apiKey !== undefined || Boolean(opts.apiKeyStdin);
    const withEmail = opts.email !== undefined;
    if (withKey && (withEmail || opts.password !== undefined || opts.passwordStdin)) {
      throw new CliError("Use either an API key or --email with a password, not both.");
    }
    if (opts.apiKey !== undefined && opts.apiKeyStdin) {
      throw new CliError("Use either --api-key or --api-key-stdin, not both.");
    }
    if (opts.password !== undefined && opts.passwordStdin) {
      throw new CliError("Use either --password or --password-stdin, not both.");
    }
    if (!withEmail && (opts.password !== undefined || opts.passwordStdin)) {
      throw new CliError("A password needs --email <email>.");
    }

    if (!withKey && !withEmail) {
      // With a terminal, `login --url <api-url>` goes on to ask for the key. Without one
      // (or with only --web-url) there is nobody to ask, so the URLs are all that is saved.
      const onlyUrls = opts.url === undefined || !process.stdin.isTTY;
      if ((opts.url !== undefined || opts.webUrl !== undefined) && onlyUrls) {
        saveUrls(opts, apiUrl, webUrl);
        reporter.succeed(`Saved ${[opts.url !== undefined && `API URL ${apiUrl}`, opts.webUrl !== undefined && `web URL ${webUrl || "(derived)"}`].filter(Boolean).join(" and ")}`);
        warnPlainHttp(reporter, apiUrl);
        const now = resolveConfig();
        if (now.withheld?.savedFor) {
          reporter.warn(`Your saved credentials are for ${now.withheld.savedFor} and will not be sent to ${now.apiUrl}.`);
        }
        if (now.credential === "none") console.error(chalk.dim("  Now sign in: wheelsai login --api-key-stdin < key.txt, or wheelsai login in a terminal"));
        return;
      }
      if (!process.stdin.isTTY) {
        console.log(chalk.bold("Usage"));
        console.log("  wheelsai login --url <api-url>                           (asks for your API key)");
        console.log("  wheelsai login --url <api-url> --api-key-stdin < key.txt");
        console.log("  wheelsai login --url <api-url> --email <email>           (asks for your password)");
        console.log("  wheelsai login --url <api-url> --email <email> --password-stdin [--code <2fa>]");
        console.log("  wheelsai config set apiUrl <api-url>                     (just set the URL)");
        process.exitCode = 1;
        return;
      }
    }

    // A credential is only ever sent to a server somebody named: never to the built-in local default.
    if (opts.url === undefined && config.apiUrlSource === "default") {
      throw new CliError("No API URL is set, so there is nowhere to check a credential against.", {
        hint: `Pass --url <api-url>. For a local development server: --url ${config.apiUrl}`,
      });
    }
    warnPlainHttp(reporter, apiUrl);

    if (withEmail) {
      const password = await readPassword(opts);
      const wheels = new WheelsAI({ baseUrl: apiUrl });
      reporter.start(`Signing in to ${apiUrl}`);
      let session: AuthResponse;
      const first = await rejectedAs(wheels.auth.login(opts.email!, password), "Check the email and password.");
      if (isTwoFactorChallenge(first)) {
        reporter.stop();
        const code =
          opts.code ??
          (await promptLine("Two-factor code: ", "This account uses two-factor authentication: pass --code <6-digit code>."));
        reporter.start("Verifying the code");
        session = await rejectedAs(
          wheels.auth.login2fa(first.challengeToken, code),
          "Check the code, or run `wheelsai login` again for a fresh one.",
        );
      } else {
        session = first;
      }
      saveToken(session.token, apiUrl);
      saveUrls({ webUrl: opts.webUrl }, apiUrl, webUrl);
      reporter.succeed(
        `Signed in to ${apiUrl} as ${chalk.cyan(clean(session.user.email ?? session.user.id))} (organization ${clean(session.organization.name)})`,
      );
      warnOverrides(reporter, apiUrl);
      return;
    }

    const apiKey = await readApiKey(opts);
    // Verify before saving, so a mistyped key never replaces a working login.
    reporter.start(`Checking the key against ${apiUrl}`);
    const me = await rejectedAs(
      new WheelsAI({ baseUrl: apiUrl, apiKey }).auth.me(),
      `Check the key, and that ${apiUrl} is the API it belongs to.`,
    );
    saveApiKey(apiKey, apiUrl);
    saveUrls({ webUrl: opts.webUrl }, apiUrl, webUrl);
    reporter.succeed(`API key saved for ${apiUrl}, organization ${chalk.cyan(clean(me.organization.id))}`);
    warnOverrides(reporter, apiUrl);
  });

/** The API key from stdin, the (discouraged) flag, or a prompt that does not echo. Never printed back. */
async function readApiKey(opts: LoginOptions): Promise<string> {
  let key: string;
  if (opts.apiKey !== undefined) {
    console.error(`${chalk.yellow("⚠")} A key passed with --api-key ${ON_COMMAND_LINE}. Prefer \`wheelsai login\` or --api-key-stdin.`);
    key = opts.apiKey;
  } else if (opts.apiKeyStdin && !process.stdin.isTTY) {
    key = await readSecret("--api-key-stdin");
  } else {
    key = await promptLine("API key: ", "Pipe the key in with --api-key-stdin.", { hidden: true });
  }
  key = key.trim();
  if (!/^wheels_[A-Za-z0-9_-]+$/.test(key)) {
    throw new CliError("That is not a WheelsAI API key: keys start with wheels_ and contain only letters, digits, _ and -.");
  }
  return key;
}

async function readPassword(opts: LoginOptions): Promise<string> {
  if (opts.password !== undefined) {
    console.error(`${chalk.yellow("⚠")} A password passed with --password ${ON_COMMAND_LINE}. Leave it out to be asked, or use --password-stdin.`);
    return opts.password;
  }
  if (opts.passwordStdin && !process.stdin.isTTY) return readSecret("--password-stdin");
  if (process.env.WHEELSAI_PASSWORD) return process.env.WHEELSAI_PASSWORD;
  return promptLine("Password: ", "A password is needed with --email: pipe it in with --password-stdin, or set WHEELSAI_PASSWORD.", {
    hidden: true,
  });
}

function saveUrls(opts: { url?: string; webUrl?: string }, apiUrl: string, webUrl: string | undefined): void {
  if (opts.url !== undefined) setSetting("apiUrl", apiUrl);
  if (opts.webUrl !== undefined) setSetting("webUrl", webUrl ?? "");
}

function warnPlainHttp(reporter: Reporter, apiUrl: string): void {
  const warning = plainHttpWarning(apiUrl);
  if (warning) reporter.warn(warning);
}

/** What was just saved is not what the next command uses when the environment overrides it: say so. */
function warnOverrides(reporter: Reporter, savedApiUrl: string): void {
  const next: ResolvedConfig = resolveConfig();
  if (next.credentialSource === "env") {
    reporter.warn("WHEELSAI_API_KEY / WHEELSAI_TOKEN in your environment override this saved login in every command.");
  }
  if (next.apiUrlSource === "env" && !sameOrigin(next.apiUrl, savedApiUrl)) {
    reporter.warn(`WHEELSAI_API_URL (${next.apiUrl}) overrides the saved API URL, and this login is not sent there.`);
  }
}

/**
 * A 401 here means the credentials just typed were refused, so "run wheelsai login"
 * (the generic hint for a stale session) would be a loop. Say what to check instead.
 */
async function rejectedAs<T>(request: Promise<T>, hint: string): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof WheelsAIError && error.status === 401) {
      throw new CliError(`${clean(error.message)} (HTTP 401)`, { hint });
    }
    throw error;
  }
}
