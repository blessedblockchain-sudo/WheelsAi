// What a creator is owed changes in one place only. This test reads the
// source: any other file that adds to or takes from
// publisher_profiles.pending_payout_cents, or adds to the lifetime revenue
// beside it, fails it. A change made anywhere else would move the balance
// with no row in earnings_transactions behind it.
import "./unitEnv.js";

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "services/earningsLedger.ts";

function sourceFiles(dir: string, skip: Set<string>): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full, skip));
    else if (name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Block comments and whole-line or trailing `//` comments, cut out. */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

const relative = (file: string) => path.relative(SRC, file).split(path.sep).join("/");

// A write that moves either counter: `pendingPayoutCents: { increment: ... }`,
// `{ decrement: ... }`, `{ set: ... }`, and the same for totalRevenueCents.
// A profile created with `pendingPayoutCents: 0` is not a move and is allowed.
const MOVES = /\b(pendingPayoutCents|totalRevenueCents)\s*:\s*\{\s*(increment|decrement|set|multiply|divide)\b/;
// Raw SQL would get round the client entirely.
const RAW = /\b(pending_payout_cents|total_revenue_cents)\s*=\s*/;

test("only the earnings ledger moves what a creator is owed", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC, new Set(["tests", ".scratch"]))) {
    const name = relative(file);
    if (name === LEDGER) continue;
    const code = withoutComments(readFileSync(file, "utf8"));
    for (const [index, line] of code.split("\n").entries()) {
      if (MOVES.test(line) || RAW.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], "these lines change a creator's balance outside services/earningsLedger.ts");
});

test("the ledger is where the move is, so the scan above is looking for the right thing", () => {
  const code = withoutComments(readFileSync(path.join(SRC, LEDGER), "utf8"));
  assert.match(code, /pendingPayoutCents\s*:\s*\{\s*increment\b/);
  assert.match(code, /pendingPayoutCents\s*:\s*\{\s*decrement\b/);
  assert.match(code, /totalRevenueCents\s*:\s*\{\s*increment\b/);
  assert.match(code, /earningsTransaction\.create\(/);
});

test("every place that used to move the balance now goes through the ledger", () => {
  for (const file of [
    "services/marketplaceMetering.ts",
    "services/marketplaceSubscriptions.ts",
    "services/jobEscrow.ts",
    "services/contributorSplits.ts",
  ]) {
    const code = withoutComments(readFileSync(path.join(SRC, file), "utf8"));
    assert.match(code, /\bmoveEarnings\(/, `${file} calls moveEarnings`);
    assert.match(code, /from "\.\/earningsLedger\.js"/, `${file} imports the ledger`);
  }
  // The payout side moves between files in a later batch; wherever it lives,
  // a reservation and both restores are written somewhere in src.
  const all = sourceFiles(SRC, new Set(["tests", ".scratch"]))
    .map((file) => withoutComments(readFileSync(file, "utf8")))
    .join("\n");
  assert.match(all, /type:\s*"payout_reserved"/);
  assert.ok((all.match(/type:\s*"payout_restored"/g) ?? []).length >= 2, "the cancel and the failed payout both restore");
});
