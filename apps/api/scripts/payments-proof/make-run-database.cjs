#!/usr/bin/env node
/*
 * Makes the database a devnet or mainnet run of docs/PAYMENTS-RUN.md keeps
 * its records in: a database of its own in the repository's Postgres
 * container, with every migration applied.
 *
 *   node apps/api/scripts/payments-proof/make-run-database.cjs wheelsai_devnet
 *   node apps/api/scripts/payments-proof/make-run-database.cjs wheelsai_mainnet
 *
 * A run's database is never the local one: that holds test credits and test
 * earnings, and with payouts on they could be paid out in real money.
 *
 * It never drops anything. A database of that name that is already there is
 * kept as it is, migrations that are new since are applied, and what it holds
 * is printed, so a database that is not empty is seen before a run starts on
 * it. `start-api.sh --run <network>` is pointed at it with RUN_DATABASE=<name>.
 * Nothing about how the database is reached is printed.
 */
const { spawnSync } = require("child_process");
const lib = require("./lib.cjs");

const name = process.argv[2] || "";
// The local database and the two that other tools drop and remake are not a run's.
const reserved = ["wheelsai", "wheelsai_scratch", "wheelsai_runbook"];
if (!/^wheelsai_[a-z0-9_]{1,40}$/.test(name) || reserved.includes(name)) {
  console.error("usage: node make-run-database.cjs <name>\n  a name of the run's own, such as wheelsai_devnet or wheelsai_mainnet (lower case letters, digits and _ after wheelsai_)");
  process.exit(2);
}

const there = lib.sql(`select count(*) from pg_database where datname='${name}'`, "postgres") === "1";
if (!there) lib.sql(`create database ${name}`, "postgres");

const run = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: `${lib.REPO}/packages/db`,
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: lib.databaseUrl(name) },
});
if (run.status !== 0) {
  console.error(`${run.stdout || ""}${run.stderr || ""}`.replace(/:\/\/[^@\s]*@/g, "://...@"));
  process.exit(1);
}

const count = (table) => Number(lib.sql(`select count(*) from ${table}`, name));
const holds = { organizations: count("organizations"), receipts: count("onchain_receipts"), payouts: count("creator_payouts") };
console.log(`database ${name}: ${there ? "was already there" : "made"}, with every migration applied (${count("_prisma_migrations")} of them)`);
console.log(
  holds.organizations === 0
    ? "it is empty: no organization, no receipt, no payout"
    : `IT IS NOT EMPTY: ${holds.organizations} organizations, ${holds.receipts} receipts, ${holds.payouts} payouts. A run starts on an empty database, or goes on in the one it began in.`,
);
