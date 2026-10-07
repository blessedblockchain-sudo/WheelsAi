import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_MARKETS,
  MarketNotConfiguredError,
  buildMarketCatalog,
  isTierDeployable,
  listDeployableTiers,
  resolveMarketAddress,
  toNosanaNetwork,
} from "../services/nosanaMarkets.js";
import {
  NosanaDeployConfigError,
  loadNosanaDeployConfig,
  parseMarketOverrides,
} from "../config/nosanaDeploy.js";

// Drives services/nosanaMarkets.ts (tier catalog + address resolution) and
// config/nosanaDeploy.ts (its env parsing). The catalog must contain only REAL
// Nosana market addresses; a tier that cannot be resolved for the running
// network is an honest error, never a placeholder.

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

test("every built-in market is a real-looking base58 address - no placeholders, no duplicates", () => {
  const addresses = Object.values(BUILTIN_MARKETS).map((m) => m.address);
  for (const [tier, market] of Object.entries(BUILTIN_MARKETS)) {
    assert.match(market.address, BASE58, `${tier} address`);
    assert.ok(!/placeholder|example/i.test(market.address), `${tier} is not a placeholder`);
    assert.ok(market.pricePerSecond > 0, `${tier} has a USD price`);
    assert.ok(market.vram > 0, `${tier} vram`);
  }
  assert.equal(new Set(addresses).size, addresses.length, "each tier maps to its own market");
});

test("built-in tiers map to the Nosana dashboard API markets (fetched 2026-09-30)", () => {
  assert.equal(BUILTIN_MARKETS["3060"]!.address, "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq"); // nvidia-3060
  assert.equal(BUILTIN_MARKETS["4070"]!.address, "EzuHhkrhmV98HWzREsgLenKj2iHdJgrKmzfL8psP8Aso"); // nvidia-4070
  assert.equal(BUILTIN_MARKETS["4090"]!.address, "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf"); // nvidia-4090
  assert.equal(BUILTIN_MARKETS.a100!.address, "F3aGGSMb73XHbJbDXVbcXo7iYM9fyevvAZGQfwgrnWtB"); // nvidia-a100-40gb
  assert.equal(BUILTIN_MARKETS.h100!.address, "Crop49jpc7prcgAcS82WbWyGHwbN5GgDym3uFbxxCTZg"); // nvidia-h100
  // vram per the markets' own metadata
  assert.equal(BUILTIN_MARKETS["3060"]!.vram, 8);
  assert.equal(BUILTIN_MARKETS["4090"]!.vram, 24);
  assert.equal(BUILTIN_MARKETS.h100!.vram, 80);
});

test("retail prices are USD per second and unchanged (billing pins them)", () => {
  assert.equal(BUILTIN_MARKETS["3060"]!.pricePerSecond, 0.0001);
  assert.equal(BUILTIN_MARKETS["4070"]!.pricePerSecond, 0.00015);
  assert.equal(BUILTIN_MARKETS["4090"]!.pricePerSecond, 0.00025);
  assert.equal(BUILTIN_MARKETS.a100!.pricePerSecond, 0.0008);
  assert.equal(BUILTIN_MARKETS.h100!.pricePerSecond, 0.0015);
});

test("retail price stays above the on-chain cost (jobPrice x 1.10 network fee x ~$0.50/NOS)", () => {
  // Cross-check of the USD/NOS unit boundary. On-chain jobPrice (NOS base units
  // per second) read 2026-09-30: 3060=24, 4090=202, H100=757. NOS ~ $0.50.
  const chain: Record<string, number> = { "3060": 24, "4090": 202, h100: 757 };
  for (const [tier, jobPrice] of Object.entries(chain)) {
    const costUsdPerSecond = (jobPrice * 1.1 * 0.5) / 1e6;
    assert.ok(
      BUILTIN_MARKETS[tier]!.pricePerSecond > costUsdPerSecond,
      `${tier}: retail ${BUILTIN_MARKETS[tier]!.pricePerSecond} must exceed cost ${costUsdPerSecond}`,
    );
  }
});

// ============================================
// address resolution per network
// ============================================

test("mainnet resolves every built-in tier to its real market", () => {
  for (const [tier, market] of Object.entries(BUILTIN_MARKETS)) {
    assert.equal(resolveMarketAddress(tier, "mainnet", BUILTIN_MARKETS), market.address);
  }
});

test("devnet has no built-in markets: 'market for tier X is not configured' - never a placeholder", () => {
  for (const tier of Object.keys(BUILTIN_MARKETS)) {
    assert.throws(
      () => resolveMarketAddress(tier, "devnet", BUILTIN_MARKETS),
      (err: unknown) => {
        assert.ok(err instanceof MarketNotConfiguredError);
        assert.equal(err.code, "market_not_configured");
        assert.match(err.message, new RegExp(`market for tier ${tier} is not configured`));
        assert.match(err.message, /NOSANA_MARKETS_JSON/);
        return true;
      },
      tier,
    );
    assert.equal(isTierDeployable(tier, "devnet", BUILTIN_MARKETS), false);
  }
});

test("an unknown tier is reported as unknown, not as unconfigured", () => {
  assert.throws(
    () => resolveMarketAddress("h200", "mainnet", BUILTIN_MARKETS),
    (err: unknown) => err instanceof MarketNotConfiguredError && err.code === "unknown_tier",
  );
  // prototype keys are not tiers
  assert.throws(() => resolveMarketAddress("constructor", "mainnet", BUILTIN_MARKETS), MarketNotConfiguredError);
  assert.throws(() => resolveMarketAddress("__proto__", "mainnet", BUILTIN_MARKETS), MarketNotConfiguredError);
});

test("toNosanaNetwork maps the Solana cluster name", () => {
  assert.equal(toNosanaNetwork("mainnet-beta"), "mainnet");
  assert.equal(toNosanaNetwork("devnet"), "devnet");
});

// ============================================
// NOSANA_MARKETS_JSON overrides
// ============================================

const DEVNET_PREMIUM = "J2mYPCyZkFzhg2oi1EqA8UAYZHhYVmktV4ExB5itFJYW"; // Nosana devnet test market

test("a bare-address override makes a built-in tier deployable on devnet and keeps its pricing", () => {
  const overrides = parseMarketOverrides(JSON.stringify({ "4090": DEVNET_PREMIUM }));
  const catalog = buildMarketCatalog(BUILTIN_MARKETS, overrides);

  assert.equal(resolveMarketAddress("4090", "devnet", catalog), DEVNET_PREMIUM);
  assert.equal(catalog["4090"]!.pricePerSecond, 0.00025, "retail price untouched");
  assert.equal(catalog["4090"]!.vram, 24);
  assert.equal(isTierDeployable("3060", "devnet", catalog), false, "others stay unconfigured");
});

test("an override can add a NEW tier when fully specified", () => {
  const overrides = parseMarketOverrides(
    JSON.stringify({
      "5090": {
        address: "6Xt8hgVLLL2PSHC9NtJP8E8oTdA5ZJc95hZEnHcdqKqb",
        name: "RTX 5090",
        gpuModel: "RTX 5090",
        vram: 32,
        pricePerSecond: 0.0004,
      },
    }),
  );
  const catalog = buildMarketCatalog(BUILTIN_MARKETS, overrides);
  assert.equal(catalog["5090"]!.vram, 32);
  assert.equal(resolveMarketAddress("5090", "mainnet", catalog), "6Xt8hgVLLL2PSHC9NtJP8E8oTdA5ZJc95hZEnHcdqKqb");
});

test("a new tier given only an address is rejected (no invented price)", () => {
  const overrides = parseMarketOverrides(JSON.stringify({ "5090": DEVNET_PREMIUM }));
  assert.throws(() => buildMarketCatalog(BUILTIN_MARKETS, overrides), /must specify name, gpuModel, vram and pricePerSecond/);
});

test("overrides are validated: bad JSON, non-object, bad address, bad tier id, unknown keys", () => {
  assert.deepEqual(parseMarketOverrides(undefined), {});
  assert.deepEqual(parseMarketOverrides("  "), {});
  assert.throws(() => parseMarketOverrides("{not json"), NosanaDeployConfigError);
  assert.throws(() => parseMarketOverrides("[]"), /must be a JSON object/);
  assert.throws(() => parseMarketOverrides(JSON.stringify({ "4090": "not-an-address" })), /base58/);
  assert.throws(() => parseMarketOverrides(JSON.stringify({ "bad tier!": DEVNET_PREMIUM })), /tier id/);
  assert.throws(
    () => parseMarketOverrides(JSON.stringify({ "4090": { address: DEVNET_PREMIUM, surprise: 1 } })),
    NosanaDeployConfigError,
  );
  assert.throws(
    () => parseMarketOverrides(JSON.stringify({ "4090": { address: DEVNET_PREMIUM, pricePerSecond: -1 } })),
    NosanaDeployConfigError,
  );
});

// ============================================
// which tiers the wizard may offer
// ============================================

test("listDeployableTiers: mainnet offers all five, devnet offers none without an override", () => {
  assert.deepEqual(
    listDeployableTiers("mainnet", { catalog: BUILTIN_MARKETS }).map(([t]) => t),
    ["3060", "4070", "4090", "a100", "h100"],
  );
  assert.deepEqual(listDeployableTiers("devnet", { catalog: BUILTIN_MARKETS }), []);
});

test("listDeployableTiers: h100 is offered only when its market address exists for the network", () => {
  const catalog = buildMarketCatalog(
    BUILTIN_MARKETS,
    parseMarketOverrides(JSON.stringify({ "4090": DEVNET_PREMIUM })),
  );
  assert.deepEqual(listDeployableTiers("devnet", { catalog }).map(([t]) => t), ["4090"]);
  assert.ok(listDeployableTiers("mainnet", { catalog }).some(([t]) => t === "h100"));
});

test("the dev-only mock offers every tier (it never touches a market)", () => {
  assert.equal(listDeployableTiers("devnet", { catalog: BUILTIN_MARKETS, allowMock: true }).length, 5);
});

// ============================================
// config/nosanaDeploy.ts
// ============================================

test("loadNosanaDeployConfig defaults are the documented, safe ones", () => {
  const cfg = loadNosanaDeployConfig({});
  assert.equal(cfg.jobTimeoutSeconds, 7200, "2h per job, not 30 days");
  assert.ok(cfg.jobTimeoutSeconds < 30 * 24 * 3600);
  assert.equal(cfg.strategy, "SIMPLE-EXTEND");
  assert.equal(cfg.vaultFundSeconds, 14_400);
  assert.equal(cfg.vaultMinRunwaySeconds, 7200);
  assert.equal(cfg.vaultSolLamportsPerReplica, 10_000_000n);
  assert.equal(cfg.networkFeeBps, 1000);
  assert.equal(cfg.batchJobTimeoutSeconds, 21_600);
  assert.equal(cfg.singleJobTimeoutSeconds, 86_400);
  assert.equal(cfg.reclaimMaxAgeHours, 72);
  assert.equal(cfg.gpuBillingIntervalMs, 60_000);
  assert.equal(cfg.hfToken, undefined);
  assert.equal(cfg.allowLoopbackNodeUrls, false, "loopback node URLs are opt-in");
  assert.deepEqual(cfg.marketOverrides, {});
});

test("ALLOW_LOOPBACK_NODE_URLS is an explicit boolean opt-in", () => {
  assert.equal(loadNosanaDeployConfig({ ALLOW_LOOPBACK_NODE_URLS: "true" }).allowLoopbackNodeUrls, true);
  assert.equal(loadNosanaDeployConfig({ ALLOW_LOOPBACK_NODE_URLS: "1" }).allowLoopbackNodeUrls, true);
  assert.equal(loadNosanaDeployConfig({ ALLOW_LOOPBACK_NODE_URLS: "false" }).allowLoopbackNodeUrls, false);
  assert.equal(loadNosanaDeployConfig({ ALLOW_LOOPBACK_NODE_URLS: "" }).allowLoopbackNodeUrls, false);
  assert.throws(() => loadNosanaDeployConfig({ ALLOW_LOOPBACK_NODE_URLS: "yes" }), NosanaDeployConfigError);
});

test("loadNosanaDeployConfig reads overrides and treats empty strings as unset", () => {
  const cfg = loadNosanaDeployConfig({
    NOSANA_JOB_TIMEOUT_SECONDS: "3600",
    NOSANA_DEPLOYMENT_STRATEGY: "INFINITE",
    NOSANA_VAULT_FUND_SECONDS: "",
    GPU_BILLING_INTERVAL_MS: "0",
    HF_TOKEN: "hf_abc",
    NOSANA_VAULT_SOL_LAMPORTS_PER_REPLICA: "25000000",
  });
  assert.equal(cfg.jobTimeoutSeconds, 3600);
  assert.equal(cfg.strategy, "INFINITE");
  assert.equal(cfg.vaultFundSeconds, 7200, "empty -> default 2x timeout");
  assert.equal(cfg.gpuBillingIntervalMs, 0, "0 disables the billing worker");
  assert.equal(cfg.hfToken, "hf_abc");
  assert.equal(cfg.vaultSolLamportsPerReplica, 25_000_000n);
});

test("loadNosanaDeployConfig refuses INFINITE with a job timeout under an hour: Nosana's floor for INFINITE is 60 minutes", () => {
  for (const timeout of ["600", "3599"]) {
    assert.throws(
      () => loadNosanaDeployConfig({ NOSANA_DEPLOYMENT_STRATEGY: "INFINITE", NOSANA_JOB_TIMEOUT_SECONDS: timeout }),
      (err: unknown) => err instanceof NosanaDeployConfigError && /INFINITE needs NOSANA_JOB_TIMEOUT_SECONDS >= 3600/.test(err.message),
      timeout,
    );
  }
  assert.equal(
    loadNosanaDeployConfig({ NOSANA_DEPLOYMENT_STRATEGY: "INFINITE", NOSANA_JOB_TIMEOUT_SECONDS: "3600" }).jobTimeoutSeconds,
    3600,
  );
  // INFINITE with the default timeout (7,200 s) is fine; the other strategies keep their 600 s minimum.
  assert.equal(loadNosanaDeployConfig({ NOSANA_DEPLOYMENT_STRATEGY: "INFINITE" }).strategy, "INFINITE");
  assert.equal(loadNosanaDeployConfig({ NOSANA_DEPLOYMENT_STRATEGY: "SIMPLE-EXTEND", NOSANA_JOB_TIMEOUT_SECONDS: "600" }).jobTimeoutSeconds, 600);
});

test("loadNosanaDeployConfig rejects unsafe or inconsistent values", () => {
  assert.throws(() => loadNosanaDeployConfig({ NOSANA_JOB_TIMEOUT_SECONDS: "5" }), NosanaDeployConfigError);
  assert.throws(() => loadNosanaDeployConfig({ NOSANA_JOB_TIMEOUT_SECONDS: "99999999" }), NosanaDeployConfigError);
  assert.throws(() => loadNosanaDeployConfig({ NOSANA_DEPLOYMENT_STRATEGY: "FOREVER" }), NosanaDeployConfigError);
  assert.throws(() => loadNosanaDeployConfig({ NOSANA_NETWORK_FEE_BPS: "-1" }), NosanaDeployConfigError);
  assert.throws(() => loadNosanaDeployConfig({ NOSANA_VAULT_SOL_LAMPORTS_PER_REPLICA: "1.5" }), NosanaDeployConfigError);
  assert.throws(
    () => loadNosanaDeployConfig({ NOSANA_JOB_TIMEOUT_SECONDS: "7200", NOSANA_VAULT_FUND_SECONDS: "3600" }),
    /NOSANA_VAULT_FUND_SECONDS must be >= NOSANA_JOB_TIMEOUT_SECONDS/,
  );
  assert.throws(
    () => loadNosanaDeployConfig({ NOSANA_VAULT_FUND_SECONDS: "7200", NOSANA_VAULT_MIN_RUNWAY_SECONDS: "9000" }),
    /MIN_RUNWAY/,
  );
  assert.throws(() => loadNosanaDeployConfig({ NOSANA_MARKETS_JSON: "{oops" }), /NOSANA_MARKETS_JSON/);
});
