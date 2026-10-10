import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Payments pass, batch 1: one place decides which node the API talks to.
// Before, three services each built a connection of their own and ignored
// SOLANA_RPC_URL on devnet. These tests read the source so a fourth
// cannot appear quietly.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");

// Directories that are not the app: the tests, and the build pass's notes.
const NOT_APP = new Set(["tests", ".scratch", "node_modules"]);

function sourceFiles(dir: string, skip: Set<string>): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === SRC && skip.has(entry.name)) continue;
      if (entry.name === "node_modules") continue;
      found.push(...sourceFiles(full, skip));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function relative(file: string): string {
  return path.relative(SRC, file).split(path.sep).join("/");
}

// Drops block comments, whole-line comments and trailing line comments.
// A "//" that follows a colon is kept: that is a URL, the very thing the
// endpoint test looks for.
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
}

// Any way of building a web3 Connection: with a space before the bracket,
// through a namespace (new web3.Connection(...)) or with a type argument.
const BUILDS_CONNECTION = /\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)*Connection\s*[(<]/g;

function connectionsBuilt(code: string): number {
  return (code.match(BUILDS_CONNECTION) ?? []).length;
}

const APP_FILES = sourceFiles(SRC, NOT_APP);

test("the scan sees the app", () => {
  const names = APP_FILES.map(relative);
  assert.ok(names.length > 100, `only ${names.length} files found`);
  for (const expected of ["lib/solana.ts", "services/nosana.ts", "services/x402.ts", "config/env.ts"]) {
    assert.ok(names.includes(expected), expected);
  }
  assert.ok(!names.some((name) => name.startsWith("tests/")));
});

test("the comment stripper keeps URLs and drops comments", () => {
  const sample = [
    'const a = "https://api.devnet.solana.com"; // the public node',
    "// new Connection(endpoint)",
    "/* new Connection(",
    "   other) */",
    " * new Connection(x)",
    "const b = new Connection(url);",
  ].join("\n");
  const stripped = withoutComments(sample);
  assert.ok(stripped.includes('"https://api.devnet.solana.com"'));
  assert.ok(!stripped.includes("the public node"));
  assert.equal(stripped.split("new Connection(").length - 1, 2);
  assert.equal(connectionsBuilt(stripped), 2);
});

test("the scan sees a connection however it is spelled", () => {
  for (const spelling of [
    "new Connection(url)",
    "new Connection (url)",
    "new  Connection(\n  url,\n)",
    "new web3.Connection(url)",
    "new solana.web3.Connection(url)",
    "new Connection<Foo>(url)",
  ]) {
    assert.equal(connectionsBuilt(spelling), 1, spelling);
  }
  for (const other of [
    "getSolanaConnection()",
    "new RedisConnection(url)",
    "function renewConnection(url) {}",
    "const c: Connection = getSolanaConnection();",
  ]) {
    assert.equal(connectionsBuilt(other), 0, other);
  }
});

test("a connection is built only in lib/solana.ts and services/nosana.ts", () => {
  const builders = APP_FILES.filter(
    (file) => connectionsBuilt(withoutComments(readFileSync(file, "utf8"))) > 0,
  ).map(relative);
  assert.deepEqual(builders.sort(), ["lib/solana.ts", "services/nosana.ts"]);
});

test("lib/solana.ts builds its connection from SOLANA_RPC_URL at confirmed", () => {
  const code = withoutComments(readFileSync(path.join(SRC, "lib/solana.ts"), "utf8"));
  assert.equal(connectionsBuilt(code), 1);
  assert.match(code, /new Connection\(env\.SOLANA_RPC_URL, "confirmed"\)/);
});

test("the x402 services take the shared connection", () => {
  for (const file of ["services/x402.ts", "services/x402Settlement.ts"]) {
    const code = withoutComments(readFileSync(path.join(SRC, file), "utf8"));
    assert.match(code, /getSolanaConnection\(\)/, file);
    assert.match(code, /from "\.\.\/lib\/solana\.js"/, file);
  }
});

test("no cluster endpoint is written into the code outside config/env.ts", () => {
  const endpoints = ["api.devnet.solana.com", "api.mainnet-beta.solana.com", "api.testnet.solana.com"];
  const offenders: string[] = [];
  for (const file of APP_FILES) {
    if (relative(file) === "config/env.ts") continue;
    const code = withoutComments(readFileSync(file, "utf8"));
    for (const endpoint of endpoints) {
      if (code.includes(endpoint)) offenders.push(`${relative(file)}: ${endpoint}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the mints have one home", () => {
  const assets = readFileSync(path.join(SRC, "lib/solanaAssets.ts"), "utf8");
  const usdcMainnet = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const usdcDevnet = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  assert.ok(assets.includes(usdcMainnet));
  assert.ok(assets.includes(usdcDevnet));
  // An env-free leaf: pure services import it.
  assert.ok(!/config\/env/.test(withoutComments(assets)));

  const x402 = withoutComments(readFileSync(path.join(SRC, "services/x402.ts"), "utf8"));
  assert.ok(!x402.includes(usdcMainnet) && !x402.includes(usdcDevnet));
  assert.match(x402, /from "\.\.\/lib\/solanaAssets\.js"/);
  assert.match(x402, /export \{ USDC_MINT \}/);

  for (const file of ["routes/walletTopupBindings.ts", "queues/payout-executor.queue.ts"]) {
    const code = readFileSync(path.join(SRC, file), "utf8");
    assert.match(code, /import \{ USDC_MINT \} from "\.\.\/lib\/solanaAssets\.js"/, file);
  }
});

test("services/wallet.ts is gone and nothing imports it", () => {
  assert.equal(existsSync(path.join(SRC, "services/wallet.ts")), false);
  const importers: string[] = [];
  for (const file of sourceFiles(SRC, new Set([".scratch"]))) {
    if (/services\/wallet(\.js)?["']|["']\.\/wallet(\.js)?["']/.test(readFileSync(file, "utf8"))) {
      importers.push(relative(file));
    }
  }
  assert.deepEqual(importers, []);
});

test("its fallback key string appears nowhere in src, tests included", () => {
  // Assembled here so this file does not itself carry the string.
  const fallbackKey = ["development", "master", "key", "do", "not", "use", "in", "production"].join("-");
  const carriers = sourceFiles(SRC, new Set([".scratch"]))
    .filter((file) => readFileSync(file, "utf8").includes(fallbackKey))
    .map(relative);
  assert.deepEqual(carriers, []);
});
