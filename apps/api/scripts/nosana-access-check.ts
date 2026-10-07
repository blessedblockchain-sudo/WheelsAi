/**
 * Read-only check of the platform's Nosana access. Spends nothing.
 *
 *   cd apps/api && npx tsx scripts/nosana-access-check.ts
 *
 * Reads the same environment the API reads (apps/api/.env through dotenv, or
 * the process environment) and prints:
 *   - which credential would pay for new deployments, the network and backend,
 *     and the last four characters of the API key (never the key);
 *   - with an API key: the prepaid credit balance against the floor, how many
 *     deployments the account holds (the list is paginated: every page of 100
 *     is read and pagination.total_items printed) and any named wheelsai-*,
 *     and the raw `owner` and `vault` fields of the newest deployment (the SDK
 *     parses `owner` as a Solana public key on every create, so know what an
 *     API-key account returns before the first one);
 *   - in every case, what each GPU tier costs from Nosana's public market list.
 *
 * It sends GET requests only (src/services/nosanaAccessCheck.ts has a single
 * request helper whose method is the literal "GET"), does not load the Nosana
 * SDK, and does not read the wallet key's value. It takes no arguments and
 * refuses to run when given any: there is no flag that makes it do more.
 *
 * With no key configured it still prints the public market costs. The network
 * is the one the API would use; with nothing configured that is derived from
 * SOLANA_NETWORK, so set NOSANA_NETWORK=mainnet to read the mainnet markets.
 *
 * Exit code: 0 everything read, 1 something could not be read (or the
 * configuration would be refused at boot), 2 refused arguments.
 */

import "dotenv/config";

import {
  ALLOWED_ARGS,
  refusalFor,
  runNosanaAccessCheck,
} from "../src/services/nosanaAccessCheck.js";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const refusal = refusalFor(args);
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  if (args.some((a) => ALLOWED_ARGS.has(a))) {
    process.stdout.write("Usage: npx tsx scripts/nosana-access-check.ts   (no arguments; read-only)\n");
    return 0;
  }
  const result = await runNosanaAccessCheck({
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    print: (line) => process.stdout.write(`${line}\n`),
  });
  return result.exitCode;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    // The message of an unexpected error; never the environment.
    console.error(`nosana-access-check failed: ${(err as Error).message}`);
    process.exitCode = 1;
  },
);
