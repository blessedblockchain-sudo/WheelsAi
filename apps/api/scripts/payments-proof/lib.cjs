/*
 * What every script in this folder needs in the same form: where the
 * repository is, where the local chain keeps its throwaway keys, how to load
 * the API's own packages, and how to ask the local database a question.
 *
 * Settings (all optional):
 *   WHEELSAI_LOCAL_CHAIN_DIR   the chain's folder, default $HOME/.wheelsai/local-chain
 *                              (keys in <folder>/keys, the ledger in <folder>/ledger)
 *   WHEELSAI_PG_CONTAINER      the Postgres container's name, default wheelsai-postgres
 *   WHEELSAI_CHROME            a Chrome or Chromium to drive in the browser tests;
 *                              when unset, playwright-core finds its own
 */
const path = require("path");
const os = require("os");
const { createRequire } = require("module");
const { execFileSync } = require("child_process");

/** The repository's root, found from this file's own place (apps/api/scripts/payments-proof). */
const REPO = path.resolve(__dirname, "../../../..");
const CHAIN_DIR = process.env.WHEELSAI_LOCAL_CHAIN_DIR || path.join(process.env.HOME || os.homedir(), ".wheelsai", "local-chain");
/** master.key, mint-authority.json and treasury.json: made by local-chain.sh, used only on the local chain. */
const KEYS_DIR = path.join(CHAIN_DIR, "keys");
const PG_CONTAINER = process.env.WHEELSAI_PG_CONTAINER || "wheelsai-postgres";

/** `require` as the API sees it, so the scripts use the versions the API uses. */
const req = createRequire(path.join(REPO, "apps/api/package.json"));

/** One statement against the local database, through the repository's own Postgres container. */
function sql(statement, db = "wheelsai") {
  const user = execFileSync("docker", ["exec", PG_CONTAINER, "printenv", "POSTGRES_USER"], { encoding: "utf8" }).trim();
  return execFileSync("docker", ["exec", PG_CONTAINER, "psql", "-U", user, "-d", db, "-At", "-F", "|", "-c", statement], { encoding: "utf8" }).trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The browser for the browser tests: $WHEELSAI_CHROME when set, else the one playwright-core finds. */
function launchBrowser() {
  const { chromium } = require(path.join(REPO, "node_modules/playwright-core"));
  return chromium.launch(process.env.WHEELSAI_CHROME ? { executablePath: process.env.WHEELSAI_CHROME } : {});
}

module.exports = { REPO, CHAIN_DIR, KEYS_DIR, PG_CONTAINER, req, sql, sleep, launchBrowser };
