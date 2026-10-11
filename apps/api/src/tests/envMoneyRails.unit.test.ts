import assert from "node:assert/strict";
import test from "node:test";

import "./unitEnv.js";

// Payments pass, batch 1: the start rules for the money rails. A rail that
// moves money must not run in production off mainnet, a static SOL price
// must never price real SOL, and the Pyth settings are checked for shape
// before anything reads them.

const { validateEnv, EnvValidationError } = await import("../config/env.js");

const DEPLOYED: Record<string, string> = {
  DATABASE_URL: "postgresql://u:p@db:5432/app",
  JWT_SECRET: "a".repeat(32),
  ENCRYPTION_KEY: "b".repeat(32),
  CORS_ORIGIN: "https://app.example.app",
};
const PRODUCTION = { ...DEPLOYED, NODE_ENV: "production" };
const STAGING = { ...DEPLOYED, NODE_ENV: "staging" };
const DEVELOPMENT = { ...DEPLOYED, NODE_ENV: "development" };
const MAINNET = {
  SOLANA_NETWORK: "mainnet-beta",
  SOLANA_RPC_URL: "https://rpc.example.app",
};

// A structurally valid public key for the settings that need one.
const REAL_KEY = "2BFEMhwhA1hakQ4J7P4tNeMQZW4k3J6tziumWncVobkH";

// Each switch with everything else it needs, so the only thing left to
// refuse is the network.
const SWITCHES: Record<string, Record<string, string>> = {
  WALLET_TOPUPS_ENABLED: {
    WALLET_TOPUPS_ENABLED: "true",
    WALLET_MASTER_KEY: "c".repeat(48),
  },
  PAYOUTS_ENABLED: { PAYOUTS_ENABLED: "true" },
  X402_ENABLED: {
    X402_ENABLED: "true",
    X402_SUBMIT_TRANSACTIONS: "true",
    X402_SETTLEMENT_WORKER_ENABLED: "true",
    TREASURY_WALLET_ADDRESS: REAL_KEY,
  },
};

function refusal(raw: Record<string, string>): string {
  try {
    validateEnv(raw);
  } catch (error) {
    assert.ok(error instanceof EnvValidationError, String(error));
    return error.message;
  }
  assert.fail("expected validateEnv to refuse");
}

test("the baselines pass", () => {
  assert.doesNotThrow(() => validateEnv({ ...PRODUCTION }));
  assert.doesNotThrow(() => validateEnv({ ...PRODUCTION, ...MAINNET }));
  assert.doesNotThrow(() => validateEnv({ ...STAGING }));
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT }));
});

for (const [name, settings] of Object.entries(SWITCHES)) {
  test(`production on devnet refuses ${name}, naming it`, () => {
    const message = refusal({ ...PRODUCTION, ...settings });
    assert.match(message, new RegExp(`^${name} requires SOLANA_NETWORK=mainnet-beta in production`));
    // Stated outright as well as left to the default.
    assert.match(
      refusal({ ...PRODUCTION, SOLANA_NETWORK: "devnet", ...settings }),
      new RegExp(`^${name} `),
    );
  });

  test(`staging and development keep ${name} on devnet`, () => {
    assert.doesNotThrow(() => validateEnv({ ...STAGING, ...settings }));
    assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, ...settings }));
  });

  test(`production on mainnet allows ${name}`, () => {
    const data = validateEnv({ ...PRODUCTION, ...MAINNET, ...settings });
    assert.equal(data[name as "X402_ENABLED"], true);
    assert.equal(data.SOLANA_NETWORK, "mainnet-beta");
  });
}

test("production on mainnet allows all three rails at once", () => {
  assert.doesNotThrow(() =>
    validateEnv({
      ...PRODUCTION,
      ...MAINNET,
      ...SWITCHES.WALLET_TOPUPS_ENABLED,
      ...SWITCHES.PAYOUTS_ENABLED,
      ...SWITCHES.X402_ENABLED,
    }),
  );
});

test("production on devnet with every rail off still starts", () => {
  const data = validateEnv({ ...PRODUCTION, SOLANA_NETWORK: "devnet" });
  assert.equal(data.SOLANA_NETWORK, "devnet");
});

// ---- the static price ---------------------------------------------------

test("a static price needs its number", () => {
  assert.match(
    refusal({ ...DEVELOPMENT, SOL_PRICE_SOURCE: "static" }),
    /SOL_PRICE_SOURCE=static requires SOL_PRICE_STATIC_USD/,
  );
  const data = validateEnv({
    ...DEVELOPMENT,
    SOL_PRICE_SOURCE: "static",
    SOL_PRICE_STATIC_USD: "110.5",
  });
  assert.equal(data.SOL_PRICE_SOURCE, "static");
  assert.equal(data.SOL_PRICE_STATIC_USD, 110.5);
});

test("a static price is allowed on staging devnet", () => {
  assert.doesNotThrow(() =>
    validateEnv({ ...STAGING, SOL_PRICE_SOURCE: "static", SOL_PRICE_STATIC_USD: "110" }),
  );
});

test("a static price is refused in production, on either network", () => {
  const settings = { SOL_PRICE_SOURCE: "static", SOL_PRICE_STATIC_USD: "110" };
  assert.match(refusal({ ...PRODUCTION, ...settings }), /SOL_PRICE_SOURCE=static/);
  assert.match(refusal({ ...PRODUCTION, ...MAINNET, ...settings }), /SOL_PRICE_SOURCE=static/);
});

test("a static price is refused on mainnet in every environment", () => {
  const settings = { ...MAINNET, SOL_PRICE_SOURCE: "static", SOL_PRICE_STATIC_USD: "110" };
  for (const base of [DEVELOPMENT, STAGING]) {
    assert.match(refusal({ ...base, ...settings }), /SOL_PRICE_SOURCE=static.*mainnet-beta/);
  }
});

test("credits without a payment are refused on mainnet in every environment, development included", () => {
  assert.match(
    refusal({ ...DEVELOPMENT, ...MAINNET, ALLOW_MOCK_CHECKOUT: "true" }),
    /ALLOW_MOCK_CHECKOUT must not be used with SOLANA_NETWORK=mainnet-beta/,
  );
  // On devnet a local demo may still grant them, and off they change nothing.
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, ALLOW_MOCK_CHECKOUT: "true" }));
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, ...MAINNET, ALLOW_MOCK_CHECKOUT: "false" }));
});

test("the static number alone, with the source off, changes nothing", () => {
  const data = validateEnv({ ...PRODUCTION, ...MAINNET, SOL_PRICE_STATIC_USD: "110" });
  assert.equal(data.SOL_PRICE_SOURCE, "off");
});

// ---- the price band -----------------------------------------------------

test("the band must have its low end below its high end", () => {
  for (const [min, max] of [
    ["200", "100"],
    ["100", "100"],
  ] as const) {
    assert.match(
      refusal({ ...DEVELOPMENT, SOL_PRICE_MIN_USD: min, SOL_PRICE_MAX_USD: max }),
      /SOL_PRICE_MIN_USD must be below SOL_PRICE_MAX_USD/,
    );
  }
  assert.doesNotThrow(() =>
    validateEnv({ ...DEVELOPMENT, SOL_PRICE_MIN_USD: "10", SOL_PRICE_MAX_USD: "1000" }),
  );
  // One end alone is a one-sided band.
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, SOL_PRICE_MIN_USD: "10" }));
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, SOL_PRICE_MAX_USD: "1000" }));
});

// ---- the Pyth values ----------------------------------------------------

const PYTH = { SOL_PRICE_SOURCE: "pyth" };

test("pyth with the default values passes, in production on mainnet too", () => {
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, ...PYTH }));
  assert.doesNotThrow(() => validateEnv({ ...PRODUCTION, ...MAINNET, ...PYTH }));
});

// 32 base58 characters that decode to fewer than 32 bytes, and 44 that
// decode to more: the right length and alphabet, the wrong size.
const TOO_SHORT_KEY = "2".repeat(32);
const TOO_LONG_KEY = "z".repeat(44);

for (const [label, value] of [
  ["empty", ""],
  ["not base58 (0, O, I, l)", "0OIl".repeat(11)],
  ["too few bytes", TOO_SHORT_KEY],
  ["too many bytes", TOO_LONG_KEY],
  ["a hex string", "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"],
] as const) {
  test(`pyth refuses a price account that is ${label}`, () => {
    assert.match(
      refusal({ ...DEVELOPMENT, ...PYTH, PYTH_SOL_USD_ACCOUNT: value }),
      /PYTH_SOL_USD_ACCOUNT must be a base58 Solana public key/,
    );
  });

  test(`pyth refuses a program id that is ${label}`, () => {
    assert.match(
      refusal({ ...DEVELOPMENT, ...PYTH, PYTH_PROGRAM_IDS: value }),
      /PYTH_PROGRAM_IDS must be a comma-separated list of base58 Solana public keys/,
    );
  });
}

test("pyth accepts well-formed keys, the all-ones address included", () => {
  assert.doesNotThrow(() =>
    validateEnv({ ...DEVELOPMENT, ...PYTH, PYTH_SOL_USD_ACCOUNT: REAL_KEY }),
  );
  // 32 zero bytes: every character is a leading zero.
  assert.doesNotThrow(() =>
    validateEnv({ ...DEVELOPMENT, ...PYTH, PYTH_SOL_USD_ACCOUNT: "1".repeat(32) }),
  );
  assert.doesNotThrow(() =>
    validateEnv({
      ...DEVELOPMENT,
      ...PYTH,
      PYTH_PROGRAM_IDS: `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ, ${REAL_KEY}`,
    }),
  );
});

test("pyth checks every entry of the program list", () => {
  for (const list of [
    `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ,not-a-key`,
    `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ,`,
    `,rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`,
  ]) {
    assert.match(refusal({ ...DEVELOPMENT, ...PYTH, PYTH_PROGRAM_IDS: list }), /PYTH_PROGRAM_IDS/);
  }
});

test("pyth refuses a feed id that is not 64 hex characters", () => {
  for (const feedId of [
    "",
    "ef0d8b6f",
    "0x" + "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b5",
    "g".repeat(64),
    "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d00",
  ]) {
    assert.match(
      refusal({ ...DEVELOPMENT, ...PYTH, PYTH_SOL_USD_FEED_ID: feedId }),
      /PYTH_SOL_USD_FEED_ID must be 64 hex characters/,
    );
  }
});

test("the Pyth values are checked only when the source is pyth", () => {
  const junk = {
    PYTH_SOL_USD_ACCOUNT: "not-a-key",
    PYTH_SOL_USD_FEED_ID: "not-hex",
    PYTH_PROGRAM_IDS: "not-a-key",
  };
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, ...junk }));
  assert.doesNotThrow(() =>
    validateEnv({
      ...DEVELOPMENT,
      ...junk,
      SOL_PRICE_SOURCE: "static",
      SOL_PRICE_STATIC_USD: "110",
    }),
  );
  assert.throws(() => validateEnv({ ...DEVELOPMENT, ...junk, ...PYTH }), EnvValidationError);
});

// SOLANA_RPC_URL is used on every network now, so the pairing the older
// rule did not need to think about (a devnet setting with a mainnet
// address) is refused too.
test("devnet with a mainnet RPC address is refused in every environment", () => {
  for (const base of [PRODUCTION, STAGING, DEVELOPMENT]) {
    for (const url of ["https://api.mainnet-beta.solana.com", "https://MAINNET.rpc.example.app/?api-key=k"]) {
      const message = refusal({ ...base, SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: url });
      assert.match(message, /SOLANA_NETWORK=devnet must not be used with a mainnet SOLANA_RPC_URL/);
      assert.doesNotMatch(message, /api-key/, "the address itself is not repeated in the message");
    }
  }
});

test("devnet with a devnet or a local RPC address passes", () => {
  for (const url of ["https://api.devnet.solana.com", "http://127.0.0.1:18899", "https://devnet.rpc.example.app"]) {
    assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: url }));
    assert.doesNotThrow(() => validateEnv({ ...STAGING, SOLANA_NETWORK: "devnet", SOLANA_RPC_URL: url }));
  }
});

// Payments pass, batch 4: the limits on payouts to a wallet.
test("the payout limits have defaults, and a day limit below the per-payout limit is refused", () => {
  const data = validateEnv({ ...DEVELOPMENT });
  assert.equal(data.PAYOUT_MAX_PER_PAYOUT_USD, 500);
  assert.equal(data.PAYOUT_MAX_PER_DAY_USD, 1000);
  assert.equal(data.PAYOUT_PLATFORM_MAX_PER_DAY_USD, 5000);
  assert.equal(data.PAYOUT_MAX_ATTEMPTS, 3);
  assert.match(
    refusal({ ...DEVELOPMENT, PAYOUT_MAX_PER_PAYOUT_USD: "800", PAYOUT_MAX_PER_DAY_USD: "500" }),
    /PAYOUT_MAX_PER_DAY_USD must not be below PAYOUT_MAX_PER_PAYOUT_USD/,
  );
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, PAYOUT_MAX_PER_PAYOUT_USD: "800", PAYOUT_MAX_PER_DAY_USD: "800" }));
});

test("the old SOL payout price is a retired setting: ignored, and said to be", async () => {
  const { retiredSettingsIn } = await import("../config/env.js");
  const data = validateEnv({ ...DEVELOPMENT, PAYOUT_SOL_PRICE_USD: "150" }) as Record<string, unknown>;
  assert.equal("PAYOUT_SOL_PRICE_USD" in data, false);
  const lines = retiredSettingsIn({ PAYOUT_SOL_PRICE_USD: "150" });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^PAYOUT_SOL_PRICE_USD is no longer a setting and is ignored: .*SOL_PRICE_SOURCE/);
  assert.doesNotMatch(lines[0]!, /150/);
});

// Payments pass, batch 5: deposit addresses.
test("deposits need the wallet rail, and outside development the scan that credits them", () => {
  const rail = { WALLET_TOPUPS_ENABLED: "true", WALLET_MASTER_KEY: "c".repeat(48) };
  assert.equal(validateEnv({ ...DEVELOPMENT }).DEPOSITS_ENABLED, false);
  assert.equal(validateEnv({ ...DEVELOPMENT }).DEPOSIT_SCAN_INTERVAL_MS, 60_000);
  assert.match(refusal({ ...DEVELOPMENT, DEPOSITS_ENABLED: "true" }), /DEPOSITS_ENABLED requires WALLET_TOPUPS_ENABLED/);
  assert.doesNotThrow(() => validateEnv({ ...STAGING, ...rail, DEPOSITS_ENABLED: "true" }));
  assert.match(
    refusal({ ...STAGING, ...rail, DEPOSITS_ENABLED: "true", DEPOSIT_SCAN_INTERVAL_MS: "0" }),
    /DEPOSITS_ENABLED requires DEPOSIT_SCAN_INTERVAL_MS above 0/,
  );
  // Development may run the scan by hand.
  assert.doesNotThrow(() => validateEnv({ ...DEVELOPMENT, ...rail, DEPOSITS_ENABLED: "true", DEPOSIT_SCAN_INTERVAL_MS: "0" }));
  // In production the address is watched on mainnet only, like the rail it belongs to.
  assert.match(refusal({ ...PRODUCTION, ...rail, DEPOSITS_ENABLED: "true" }), /requires SOLANA_NETWORK=mainnet-beta in production/);
});

// Payments pass, batch 6: sweeps.
test("sweeps are off by default, need deposits, and carry their floats and threshold", () => {
  const rail = { WALLET_TOPUPS_ENABLED: "true", WALLET_MASTER_KEY: "c".repeat(48) };
  const settings = validateEnv({ ...DEVELOPMENT });
  assert.equal(settings.SWEEPS_ENABLED, false);
  assert.equal(settings.SWEEP_INTERVAL_MS, 300_000);
  assert.equal(settings.SWEEP_MIN_USD, 25);
  assert.equal(settings.SWEEP_MAX_PER_RUN, 20);
  assert.equal(settings.HOT_WALLET_FLOAT_USDC, 200);
  assert.equal(settings.HOT_WALLET_FLOAT_SOL_USD, 100);
  assert.match(refusal({ ...DEVELOPMENT, ...rail, SWEEPS_ENABLED: "true" }), /SWEEPS_ENABLED requires DEPOSITS_ENABLED/);
  assert.doesNotThrow(() => validateEnv({ ...STAGING, ...rail, DEPOSITS_ENABLED: "true", SWEEPS_ENABLED: "true" }));
  // The worker's interval may be 0: sweeps then simply do not run.
  assert.doesNotThrow(() =>
    validateEnv({ ...STAGING, ...rail, DEPOSITS_ENABLED: "true", SWEEPS_ENABLED: "true", SWEEP_INTERVAL_MS: "0" }),
  );
  assert.match(refusal({ ...DEVELOPMENT, SWEEP_MIN_USD: "0" }), /SWEEP_MIN_USD/);
});
