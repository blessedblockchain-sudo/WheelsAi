import { Command } from "commander";
import { WheelsAI } from "@wheelsai/sdk";

import { clearCredentials, resolveConfig, savedCredential } from "../config.js";
import { describeError } from "../errors.js";
import { Reporter } from "../ui.js";

export const logoutCommand = new Command("logout")
  .description("Forget the saved credentials")
  .action(async () => {
    const reporter = new Reporter();
    const saved = savedCredential();

    // A session token can be revoked server-side, on the server that issued it (not whichever
    // URL is in effect now). An API key is revoked from the dashboard.
    let notRevoked: string | undefined;
    if (saved.token && saved.apiUrl) {
      try {
        await new WheelsAI({ baseUrl: saved.apiUrl, token: saved.token }).auth.logout();
      } catch (error) {
        notRevoked = describeError(error).message;
      }
    }
    clearCredentials();
    reporter.succeed(saved.token || saved.apiKey ? "Signed out. Saved credentials removed." : "No saved credentials to remove.");
    if (notRevoked) {
      // The local logout still happens, but the token itself is still good: do not hide that.
      reporter.warn(`Could not revoke the session on ${saved.apiUrl} (${notRevoked}). It stays valid until it expires.`);
    }
    if (saved.apiKey) {
      reporter.info("  The API key itself is still valid. Revoke it in the dashboard if it should stop working.");
    }
    if (resolveConfig().credentialSource === "env") {
      reporter.warn("WHEELSAI_API_KEY / WHEELSAI_TOKEN in your environment still apply.");
    }
  });
