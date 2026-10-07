import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import "./unitEnv.js";
import { startFakeNosanaApi, FAKE_MARKETS } from "./fakeNosanaApi.js";
import { refusalFor, runNosanaAccessCheck } from "../services/nosanaAccessCheck.js";

// The read-only access check (scripts/nosana-access-check.ts), run against the
// fake Nosana REST API on loopback. What matters most: it only ever sends GET,
// it never prints a credential, and it never sends the key anywhere it need not.

const fake = await startFakeNosanaApi();
after(() => fake.close());

const API_KEY = fake.apiKey;
// Not a real key: a recognisable stand-in, to prove the value is never echoed.
const WALLET_VALUE = "WALLET-KEY-VALUE-THAT-MUST-NEVER-BE-PRINTED";

function reset() {
  fake.rotateApiKey(API_KEY);
  fake.setBalance({ assignedCredits: 25, reservedCredits: 1.5, settledCredits: 0.25 });
  fake.setMarkets(FAKE_MARKETS);
  fake.setOwner("11111111111111111111111111111111");
  fake.deployments.clear();
  fake.requests.length = 0;
}

function seed(name: string, status: "RUNNING" | "STOPPED" = "RUNNING", owner = "11111111111111111111111111111111") {
  const id = `seed${fake.deployments.size + 1}`;
  const at = "2026-10-07T10:00:00.000Z";
  fake.deployments.set(id, {
    id,
    name,
    vault: owner,
    market: "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq",
    owner,
    status,
    replicas: 1,
    timeout: 7200,
    strategy: "SIMPLE-EXTEND",
    confidential: true,
    active_revision: 1,
    jobs: [],
    events: [],
    endpoints: [],
    created_at: at,
    updated_at: at,
  });
  return id;
}

async function run(env: Record<string, string | undefined>) {
  const lines: string[] = [];
  const result = await runNosanaAccessCheck({
    env: { NODE_ENV: "development", NOSANA_API_URL: fake.url, ...env },
    fetch: (url, init) => fetch(url, init),
    print: (line) => lines.push(line),
    now: () => new Date("2026-10-07T12:00:00.000Z"),
    timeoutMs: 2_000,
  });
  return { result, text: lines.join("\n") };
}

test("any argument other than help is refused before anything is requested", () => {
  assert.equal(refusalFor([]), null);
  assert.equal(refusalFor(["--help"]), null);
  for (const args of [["--stop", "abc"], ["create"], ["--fix"], ["--help", "--start"]]) {
    assert.match(refusalFor(args)!, /only reads/);
  }
});

test("the module can only send GET: one request helper, no other method, no Nosana SDK", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../services/nosanaAccessCheck.ts", import.meta.url)),
    "utf8",
  );
  const script = readFileSync(
    fileURLToPath(new URL("../../scripts/nosana-access-check.ts", import.meta.url)),
    "utf8",
  );
  assert.equal([...source.matchAll(/deps\.fetch\(/g)].length, 1, "one way out");
  assert.deepEqual([...new Set([...source.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]))], ["GET"]);
  for (const text of [source, script]) {
    assert.doesNotMatch(text, /["'`](POST|PUT|PATCH|DELETE)["'`]/);
    assert.doesNotMatch(text, /from\s+["']@nosana\/sdk["']/);
    assert.doesNotMatch(text, /services\/nosana\.js/, "the client that can create and stop is not loaded");
  }
  assert.doesNotMatch(script, /fetch\([^)]*method/);
});

test("with an API key: mode, key suffix, balance, deployments, raw owner and vault, and tier costs", async () => {
  reset();
  seed("wheelsai-model-3f0c2f0e-6a57-4b53-9f43-0d1b2c3d4e5f-r0");
  seed("someone-elses-deployment", "STOPPED");
  const { result, text } = await run({ NOSANA_API_KEY: API_KEY });

  assert.equal(result.exitCode, 0);
  assert.equal(result.mode, "api_key");
  assert.match(text, /mode \(pays for new deployments\): api_key/);
  assert.match(text, /network: mainnet/);
  assert.match(text, new RegExp(`API key: set, ends in \\.\\.\\.${API_KEY.slice(-4)}`));
  assert.ok(!text.includes(API_KEY), "the key itself is never printed");

  assert.match(text, /assigned: {2}\$25\.0000/);
  assert.match(text, /reserved: {2}\$1\.5000/);
  assert.match(text, /available: \$23\.2500/);
  assert.match(text, /above the warning threshold/);

  assert.match(text, /total: 2/);
  assert.match(text, /by status: RUNNING 1, STOPPED 1/);
  assert.match(text, /named wheelsai-\*: 1/);
  assert.match(text, /wheelsai-model-3f0c2f0e-6a57-4b53-9f43-0d1b2c3d4e5f-r0 {2}RUNNING {2}id seed1/);
  assert.match(text, /owner: {2}"11111111111111111111111111111111"/);
  assert.match(text, /vault: {2}"11111111111111111111111111111111"/);
  assert.match(text, /owner parses as a Solana public key: yes/);
  assert.match(text, /vault equals owner: yes/);

  // 3060: 0.0436 x 1.1 rounded up to 14 micro-USD/s = $0.0504/h against $0.36 retail.
  assert.match(text, /3060\s+7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq\s+0\.0436\s+10\s+0\.0504\s+0\.3600\s+86\.0%/);
  assert.match(text, /a100\s+\S+\s+cost unknown/);
  assert.doesNotMatch(text, /BELOW COST/);

  assert.deepEqual(
    fake.requests.map((r) => `${r.method} ${r.path}`),
    ["GET /api/credits/balance", "GET /api/deployments", "GET /api/markets/"],
  );
  assert.equal(fake.requests[2]!.authorization, undefined, "the public market list is asked without the key");
  assert.ok(result.requests.every((r) => r.method === "GET"));
  assert.equal(fake.deployments.get("seed1")!.status, "RUNNING", "nothing was changed");
});

test("an owner that is not a public key is called out, since the SDK would throw on it", async () => {
  reset();
  fake.setOwner("user_2fakeDashboardUserId");
  seed("wheelsai-agent-1", "RUNNING", "user_2fakeDashboardUserId");
  const { result, text } = await run({ NOSANA_API_KEY: API_KEY });
  assert.equal(result.exitCode, 0);
  assert.match(text, /owner: {2}"user_2fakeDashboardUserId"/);
  assert.match(text, /owner parses as a Solana public key: NO/);
});

test("an account with no deployment says the raw fields cannot be read yet", async () => {
  reset();
  const { text } = await run({ NOSANA_API_KEY: API_KEY });
  assert.match(text, /total: 0/);
  assert.match(text, /none: the account has no deployment yet/);
});

test("a balance below the floor and a tier priced below cost are both stated", async () => {
  reset();
  fake.setBalance({ assignedCredits: 4, reservedCredits: 0, settledCredits: 0 });
  fake.setMarkets([{ ...(FAKE_MARKETS[0] as object), usd_reward_per_hour: 0.5 }]);
  const { text } = await run({ NOSANA_API_KEY: API_KEY });
  assert.match(text, /BELOW THE FLOOR/);
  assert.match(text, /3060.*BELOW COST/);
});

test("a rejected key: exit 1, said plainly, and the public costs are still printed", async () => {
  reset();
  fake.rotateApiKey("nos_fake_key_rotated_away_0009");
  const { result, text } = await run({ NOSANA_API_KEY: API_KEY });
  assert.equal(result.exitCode, 1);
  assert.match(text, /credits[^\n]*\n\s+REJECTED: HTTP 401/);
  assert.match(text, /deployments[^\n]*\n\s+REJECTED: HTTP 401/);
  assert.match(text, /3060\s+7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq\s+0\.0436/);
  assert.ok(!text.includes(API_KEY));
});

test("no credential at all: only the public market list is requested, with no Authorization", async () => {
  reset();
  const { result, text } = await run({ NOSANA_NETWORK: "mainnet" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.mode, "none");
  assert.match(text, /No Nosana credential is configured/);
  assert.match(text, /3060\s+7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq\s+0\.0436/);
  assert.deepEqual(fake.requests.map((r) => [r.method, r.path, r.authorization]), [
    ["GET", "/api/markets/", undefined],
  ]);
});

test("wallet access: the wallet key is neither printed nor used, and no account read is attempted", async () => {
  reset();
  const { result, text } = await run({
    NOSANA_WALLET_PRIVATE_KEY: WALLET_VALUE,
    SOLANA_NETWORK: "mainnet-beta",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.mode, "wallet");
  assert.match(text, /wallet key: set \(not read or used by this script\)/);
  assert.match(text, /Wallet access is not exercised by this script/);
  assert.ok(!text.includes(WALLET_VALUE));
  assert.deepEqual(fake.requests.map((r) => [r.method, r.path, r.authorization]), [
    ["GET", "/api/markets/", undefined],
  ]);
});

test("a configuration the API would refuse at boot is reported and nothing is requested", async () => {
  reset();
  const { result, text } = await run({
    NOSANA_API_KEY: API_KEY,
    NOSANA_WALLET_PRIVATE_KEY: WALLET_VALUE,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.mode, null);
  assert.match(text, /configuration refused: .*both NOSANA_API_KEY and NOSANA_WALLET_PRIVATE_KEY are set/);
  assert.equal(fake.requests.length, 0);
  assert.ok(!text.includes(API_KEY) && !text.includes(WALLET_VALUE));
});

test("an unreachable backend is an honest failure, not a guess", async () => {
  const lines: string[] = [];
  const result = await runNosanaAccessCheck({
    env: { NODE_ENV: "development", NOSANA_NETWORK: "mainnet" },
    fetch: async () => {
      throw new Error("network is down");
    },
    print: (line) => lines.push(line),
  });
  assert.equal(result.exitCode, 1);
  assert.match(lines.join("\n"), /unreadable: network is down/);
});
