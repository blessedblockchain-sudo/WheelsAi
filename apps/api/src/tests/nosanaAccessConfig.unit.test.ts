import assert from "node:assert/strict";
import test from "node:test";
import {
  loadNosanaAccessConfig,
  NosanaAccessConfigError,
  NOSANA_BACKEND_URLS,
  rowAccessMode,
  secondsToSdkTimeout,
  usdTextToMicroUsd,
} from "../config/nosanaAccess.js";

// config/nosanaAccess.ts: which credential pays Nosana. Every combination of
// the two credentials and NOSANA_ACCESS_MODE, the network default, the URL
// rule and the money parsing. Pure: the source object is passed in.

// Shaped like a key, and nothing more: it opens nothing.
const KEY = "nos_unit_test_key_0000000000_wxyz";
const WALLET = "[1,2,3]";

test("an API key alone is api_key access on mainnet, with the SDK's own backend", () => {
  const cfg = loadNosanaAccessConfig({ NOSANA_API_KEY: KEY });
  assert.equal(cfg.primary, "api_key");
  assert.equal(cfg.hasApiKey, true);
  assert.equal(cfg.hasWallet, false);
  assert.equal(cfg.network, "mainnet");
  assert.equal(cfg.networkDerived, false);
  assert.equal(cfg.backendUrl, NOSANA_BACKEND_URLS.mainnet);
  assert.equal(cfg.apiKey, KEY);
  assert.equal(cfg.apiKeySuffix, "wxyz");
});

test("an API key on mainnet does not depend on SOLANA_NETWORK", () => {
  const cfg = loadNosanaAccessConfig({ NOSANA_API_KEY: KEY, SOLANA_NETWORK: "devnet" });
  assert.equal(cfg.network, "mainnet");
});

test("a wallet alone is wallet access, network derived from SOLANA_NETWORK as before", () => {
  const devnet = loadNosanaAccessConfig({ NOSANA_WALLET_PRIVATE_KEY: WALLET });
  assert.equal(devnet.primary, "wallet");
  assert.equal(devnet.network, "devnet");
  assert.equal(devnet.networkDerived, true);
  assert.equal(devnet.apiKey, undefined);
  assert.equal(devnet.apiKeySuffix, undefined);

  const mainnet = loadNosanaAccessConfig({
    NOSANA_WALLET_PRIVATE_KEY: WALLET,
    SOLANA_NETWORK: "mainnet-beta",
  });
  assert.equal(mainnet.network, "mainnet");
});

test("neither credential boots as mode none (deploys answer 501)", () => {
  const cfg = loadNosanaAccessConfig({});
  assert.equal(cfg.primary, "none");
  assert.equal(cfg.hasWallet, false);
  assert.equal(cfg.hasApiKey, false);
  assert.deepEqual(cfg.warnings, []);
});

test("both credentials with no NOSANA_ACCESS_MODE is refused in every environment", () => {
  for (const NODE_ENV of ["development", "staging", "production"]) {
    assert.throws(
      () => loadNosanaAccessConfig({ NOSANA_API_KEY: KEY, NOSANA_WALLET_PRIVATE_KEY: WALLET, NODE_ENV }),
      (err: unknown) =>
        err instanceof NosanaAccessConfigError &&
        /NOSANA_ACCESS_MODE/.test(err.message) &&
        !err.message.includes(KEY) &&
        !err.message.includes(WALLET),
    );
  }
});

test("both credentials with a mode: that mode is primary and the other stays available", () => {
  const api = loadNosanaAccessConfig({
    NOSANA_API_KEY: KEY,
    NOSANA_WALLET_PRIVATE_KEY: WALLET,
    NOSANA_ACCESS_MODE: "api_key",
  });
  assert.equal(api.primary, "api_key");
  assert.equal(api.hasWallet, true);
  assert.equal(api.network, "mainnet");

  const wallet = loadNosanaAccessConfig({
    NOSANA_API_KEY: KEY,
    NOSANA_WALLET_PRIVATE_KEY: WALLET,
    NOSANA_ACCESS_MODE: "wallet",
  });
  assert.equal(wallet.primary, "wallet");
  assert.equal(wallet.hasApiKey, true);
  assert.equal(wallet.network, "devnet");
  assert.equal(wallet.apiNetwork, "mainnet", "the key is not dragged onto the wallet's network");
  assert.ok(
    wallet.warnings.some((w) => /wallet is used on devnet .* API key on mainnet/.test(w)),
    "two credentials on two networks are flagged",
  );
});

test("each credential keeps its own network, whichever is primary; NOSANA_NETWORK moves both", () => {
  const both = { NOSANA_API_KEY: KEY, NOSANA_WALLET_PRIVATE_KEY: WALLET, SOLANA_NETWORK: "devnet" };

  // Making the API key primary must not move wallet-created deployments off
  // the network they were created on (SOLANA_NETWORK stays devnet).
  const keyPrimary = loadNosanaAccessConfig({ ...both, NOSANA_ACCESS_MODE: "api_key" });
  assert.equal(keyPrimary.network, "mainnet", "new deployments: the key's network");
  assert.equal(keyPrimary.walletNetwork, "devnet");
  assert.equal(keyPrimary.apiNetwork, "mainnet");
  assert.equal(keyPrimary.networkExplicit, false);
  assert.ok(keyPrimary.warnings.some((w) => /wallet is used on devnet/.test(w)));

  // ...and the reverse: making the wallet primary leaves the key on mainnet.
  const walletPrimary = loadNosanaAccessConfig({ ...both, NOSANA_ACCESS_MODE: "wallet" });
  assert.equal(walletPrimary.network, "devnet");
  assert.equal(walletPrimary.walletNetwork, "devnet");
  assert.equal(walletPrimary.apiNetwork, "mainnet");

  for (const mode of ["api_key", "wallet"]) {
    const explicit = loadNosanaAccessConfig({ ...both, NOSANA_ACCESS_MODE: mode, NOSANA_NETWORK: "devnet" });
    assert.equal(explicit.walletNetwork, "devnet");
    assert.equal(explicit.apiNetwork, "devnet");
    assert.equal(explicit.networkExplicit, true);
    assert.ok(!explicit.warnings.some((w) => /wallet is used on/.test(w)));
  }

  const sameNetwork = loadNosanaAccessConfig({ ...both, SOLANA_NETWORK: "mainnet-beta", NOSANA_ACCESS_MODE: "api_key" });
  assert.equal(sameNetwork.walletNetwork, "mainnet");
  assert.ok(!sameNetwork.warnings.some((w) => /wallet is used on/.test(w)));

  // One credential: unchanged.
  assert.equal(loadNosanaAccessConfig({ NOSANA_WALLET_PRIVATE_KEY: WALLET }).walletNetwork, "devnet");
  assert.equal(loadNosanaAccessConfig({ NOSANA_API_KEY: KEY }).apiNetwork, "mainnet");
});

test("a mode that names a missing credential is refused", () => {
  assert.throws(
    () => loadNosanaAccessConfig({ NOSANA_ACCESS_MODE: "api_key", NOSANA_WALLET_PRIVATE_KEY: WALLET }),
    /NOSANA_ACCESS_MODE=api_key requires NOSANA_API_KEY/,
  );
  assert.throws(
    () => loadNosanaAccessConfig({ NOSANA_ACCESS_MODE: "wallet", NOSANA_API_KEY: KEY }),
    /NOSANA_ACCESS_MODE=wallet requires NOSANA_WALLET_PRIVATE_KEY/,
  );
  assert.throws(() => loadNosanaAccessConfig({ NOSANA_ACCESS_MODE: "wallet" }), NosanaAccessConfigError);
  assert.throws(() => loadNosanaAccessConfig({ NOSANA_ACCESS_MODE: "credits" }), NosanaAccessConfigError);
});

test("empty strings count as unset", () => {
  const cfg = loadNosanaAccessConfig({
    NOSANA_API_KEY: "  ",
    NOSANA_WALLET_PRIVATE_KEY: "",
    NOSANA_ACCESS_MODE: "",
    NOSANA_NETWORK: "",
    NOSANA_API_URL: "",
    NOSANA_TIMEOUT_UNIT: "",
  });
  assert.equal(cfg.primary, "none");
  assert.equal(cfg.timeoutUnit, "minutes");
  assert.equal(cfg.apiUrl, undefined);
});

test("NOSANA_NETWORK wins over both defaults", () => {
  assert.equal(
    loadNosanaAccessConfig({ NOSANA_API_KEY: KEY, NOSANA_NETWORK: "devnet" }).network,
    "devnet",
  );
  const wallet = loadNosanaAccessConfig({
    NOSANA_WALLET_PRIVATE_KEY: WALLET,
    SOLANA_NETWORK: "devnet",
    NOSANA_NETWORK: "mainnet",
  });
  assert.equal(wallet.network, "mainnet");
  assert.equal(wallet.networkDerived, false);
  assert.equal(wallet.backendUrl, NOSANA_BACKEND_URLS.mainnet);
  assert.throws(() => loadNosanaAccessConfig({ NOSANA_NETWORK: "testnet" }), NosanaAccessConfigError);
});

test("a malformed key is refused without the key appearing in the message", () => {
  assert.throws(
    () => loadNosanaAccessConfig({ NOSANA_API_KEY: "nos_short" }),
    (err: unknown) =>
      err instanceof NosanaAccessConfigError &&
      /NOSANA_API_KEY/.test(err.message) &&
      !err.message.includes("nos_short"),
  );
});

test("a key without the nos_ prefix is accepted with a warning that does not contain it", () => {
  const odd = "some_other_looking_key_000000000000";
  const cfg = loadNosanaAccessConfig({ NOSANA_API_KEY: odd });
  assert.equal(cfg.primary, "api_key");
  assert.ok(cfg.warnings.some((w) => /nos_/.test(w)));
  assert.ok(cfg.warnings.every((w) => !w.includes(odd)));
});

test("credit thresholds: defaults 5 and 20 USD, parsed as exact micro-USD", () => {
  const defaults = loadNosanaAccessConfig({});
  assert.equal(defaults.minCreditsMicroUsd, 5_000_000n);
  assert.equal(defaults.warnCreditsMicroUsd, 20_000_000n);
  assert.equal(defaults.creditsCacheMs, 30_000);
  assert.equal(defaults.costCacheMs, 600_000);

  const set = loadNosanaAccessConfig({
    NOSANA_MIN_CREDITS_USD: "0.1",
    NOSANA_CREDITS_WARN_USD: "12.345678",
    NOSANA_CREDITS_CACHE_MS: "0",
    NOSANA_COST_CACHE_MS: "1000",
  });
  assert.equal(set.minCreditsMicroUsd, 100_000n);
  assert.equal(set.warnCreditsMicroUsd, 12_345_678n);
  assert.equal(set.creditsCacheMs, 0);
  assert.equal(set.costCacheMs, 1000);

  for (const bad of ["-1", "abc", "1.2345678", "1e3"]) {
    assert.throws(() => loadNosanaAccessConfig({ NOSANA_MIN_CREDITS_USD: bad }), NosanaAccessConfigError);
  }
  assert.throws(() => loadNosanaAccessConfig({ NOSANA_CREDITS_CACHE_MS: "-5" }), NosanaAccessConfigError);
});

test("usdTextToMicroUsd is exact and refuses anything that is not plain decimal text", () => {
  assert.equal(usdTextToMicroUsd("0"), 0n);
  assert.equal(usdTextToMicroUsd("5"), 5_000_000n);
  assert.equal(usdTextToMicroUsd("0.000001"), 1n);
  assert.equal(usdTextToMicroUsd("19.99"), 19_990_000n);
  assert.throws(() => usdTextToMicroUsd("1."), RangeError);
  assert.throws(() => usdTextToMicroUsd(".5"), RangeError);
});

test("NOSANA_API_URL: https anywhere, http only for loopback in development, no trailing slash", () => {
  assert.equal(
    loadNosanaAccessConfig({ NOSANA_API_KEY: KEY, NOSANA_API_URL: "https://api.example.test/" }).backendUrl,
    "https://api.example.test",
  );
  const loopback = loadNosanaAccessConfig({ NOSANA_API_KEY: KEY, NOSANA_API_URL: "http://127.0.0.1:4310" });
  assert.equal(loopback.apiUrl, "http://127.0.0.1:4310");
  assert.equal(loopback.backendUrl, "http://127.0.0.1:4310");

  assert.throws(
    () => loadNosanaAccessConfig({ NOSANA_API_URL: "http://127.0.0.1:4310", NODE_ENV: "production" }),
    /https/,
  );
  assert.throws(() => loadNosanaAccessConfig({ NOSANA_API_URL: "http://api.example.test" }), /https/);
  assert.throws(() => loadNosanaAccessConfig({ NOSANA_API_URL: "ftp://api.example.test" }), /https/);
  assert.throws(() => loadNosanaAccessConfig({ NOSANA_API_URL: "not a url" }), /not a valid URL/);
  assert.throws(
    () => loadNosanaAccessConfig({ NOSANA_API_URL: "https://user:pw@api.example.test" }),
    /bare base URL/,
  );
});

test("timeout unit: minutes by default and settled, so no warning; seconds still parses but is warned about loudly, with or without a credential", () => {
  // Minutes is settled: the OpenAPI document, the deployment-manager source
  // and live INFINITE rotations (see the header of config/nosanaAccess.ts).
  const unset = loadNosanaAccessConfig({ NOSANA_API_KEY: KEY });
  assert.equal(unset.timeoutUnit, "minutes");
  assert.equal(unset.timeoutUnitExplicit, false);
  assert.ok(unset.warnings.every((w) => !/NOSANA_TIMEOUT_UNIT/.test(w)));

  for (const source of [{ NOSANA_API_KEY: KEY, NOSANA_TIMEOUT_UNIT: "seconds" }, { NOSANA_TIMEOUT_UNIT: "seconds" }]) {
    const seconds = loadNosanaAccessConfig(source);
    assert.equal(seconds.timeoutUnit, "seconds");
    assert.equal(seconds.timeoutUnitExplicit, true);
    const warning = seconds.warnings.find((w) => w.startsWith("NOSANA_TIMEOUT_UNIT=seconds"));
    assert.ok(warning, "warned whenever it is set");
    assert.match(warning!, /READS MINUTES/);
    assert.match(warning!, /60 times/);
  }

  const minutes = loadNosanaAccessConfig({ NOSANA_API_KEY: KEY, NOSANA_TIMEOUT_UNIT: "minutes" });
  assert.equal(minutes.timeoutUnit, "minutes");
  assert.equal(minutes.timeoutUnitExplicit, true);
  assert.ok(minutes.warnings.every((w) => !/NOSANA_TIMEOUT_UNIT/.test(w)));

  assert.throws(() => loadNosanaAccessConfig({ NOSANA_TIMEOUT_UNIT: "hours" }), NosanaAccessConfigError);
});

test("NOSANA_SDK_TIMEOUT_MS: 30 s by default, bounded, and never a value it cannot parse", () => {
  assert.equal(loadNosanaAccessConfig({}).sdkTimeoutMs, 30_000);
  assert.equal(loadNosanaAccessConfig({ NOSANA_SDK_TIMEOUT_MS: "" }).sdkTimeoutMs, 30_000);
  assert.equal(loadNosanaAccessConfig({ NOSANA_SDK_TIMEOUT_MS: "45000" }).sdkTimeoutMs, 45_000);
  for (const bad of ["0", "99", "300001", "soon", "1.5"]) {
    assert.throws(() => loadNosanaAccessConfig({ NOSANA_SDK_TIMEOUT_MS: bad }), NosanaAccessConfigError, bad);
  }
});

test("secondsToSdkTimeout converts only for minutes, and rounds up", () => {
  assert.equal(secondsToSdkTimeout(7200, "seconds"), 7200);
  assert.equal(secondsToSdkTimeout(7200, "minutes"), 120);
  assert.equal(secondsToSdkTimeout(601, "minutes"), 11);
  assert.equal(secondsToSdkTimeout(1, "minutes"), 1);
  assert.throws(() => secondsToSdkTimeout(0, "seconds"), RangeError);
  assert.throws(() => secondsToSdkTimeout(1.5, "minutes"), RangeError);
});

test("api_key on devnet is allowed and flagged", () => {
  const cfg = loadNosanaAccessConfig({ NOSANA_API_KEY: KEY, NOSANA_NETWORK: "devnet" });
  assert.equal(cfg.backendUrl, NOSANA_BACKEND_URLS.devnet);
  assert.ok(cfg.warnings.some((w) => /devnet/.test(w)));
});

test("rowAccessMode: a null stamp means the wallet created it", () => {
  assert.equal(rowAccessMode(null), "wallet");
  assert.equal(rowAccessMode(undefined), "wallet");
  assert.equal(rowAccessMode("wallet"), "wallet");
  assert.equal(rowAccessMode("api_key"), "api_key");
  assert.equal(rowAccessMode("something else"), "wallet");
});

test("validateEnv stops the boot on a refused combination and passes the others", async () => {
  await import("./unitEnv.js");
  const { validateEnv, EnvValidationError } = await import("../config/env.js");
  const base = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://wheelsai:wheelsai@localhost:5432/wheelsai",
    JWT_SECRET: "12345678901234567890123456789012",
  };
  assert.throws(
    () => validateEnv({ ...base, NOSANA_API_KEY: KEY, NOSANA_WALLET_PRIVATE_KEY: WALLET }),
    (err: unknown) => err instanceof EnvValidationError && /NOSANA_ACCESS_MODE/.test(err.message),
  );
  assert.throws(
    () => validateEnv({ ...base, NOSANA_ACCESS_MODE: "api_key" }),
    (err: unknown) => err instanceof EnvValidationError && /NOSANA_API_KEY/.test(err.message),
  );
  assert.doesNotThrow(() => validateEnv(base));
  assert.doesNotThrow(() => validateEnv({ ...base, NOSANA_API_KEY: KEY }));
  assert.doesNotThrow(() =>
    validateEnv({ ...base, NOSANA_API_KEY: KEY, NOSANA_WALLET_PRIVATE_KEY: WALLET, NOSANA_ACCESS_MODE: "wallet" }),
  );
});
