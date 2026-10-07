/**
 * GPU tier catalog and Nosana market address resolution.
 *
 * Kept free of the Nosana SDK so billing (computeMetering, deploymentCreditGate)
 * and routes can import it cheaply, and so it is unit-testable on its own.
 *
 * Units - read this before touching a price
 * -----------------------------------------
 * `NosanaMarket.pricePerSecond` is USD per second PER REPLICA: the retail rate
 * WheelsAI bills an org. It is NOT the Nosana on-chain `jobPrice`, which is an
 * integer count of NOS base units (1e-6 NOS) per second - see
 * nosanaDeploymentLifecycle.ts (NOS_DECIMALS / planVaultFunding). The two are
 * never mixed: retail prices are configuration, chain prices are only used to
 * size vault funding.
 *
 * Address source
 * --------------
 * The built-in addresses are the PREMIUM-type markets returned by the Nosana
 * public dashboard API on 2026-09-30:
 *   GET https://dashboard.k8s.prd.nos.ci/api/markets
 * (that host is the SDK's own mainnet `backend_url`, node_modules/@nosana/sdk/dist/config.js).
 * vram comes from each market's `metadata[key=vram]`. The on-chain `jobPrice`
 * of three of them was cross-checked with `sdk.jobs.getMarket()` the same day
 * (3060 = 24, 4090 = 202, H100 = 757 NOS base units / second), which equalled
 * the API's `nos_reward_per_second` x 1e6 that day.
 *
 * Those NOS figures are not constants: Nosana derives them from the market's
 * USD price and the NOS/USD rate, so they move with the NOS price. On
 * 2026-10-07 the same 24 / 202 / 757 matched the fee-INCLUSIVE
 * `nos_job_price_per_second` (0.0000242 / 0.0002024 / 0.0007579), with the
 * reward at 0.000022 / 0.000184 / 0.000689. Whether the on-chain jobPrice
 * carries the fee cannot be told from the API. If it does, the wallet path,
 * which adds NOSANA_NETWORK_FEE_BPS on top, over-funds a vault by 10%: the
 * safe direction, and the surplus is withdrawn on stop. Credits are priced in
 * USD and are not affected.
 *
 * These are MAINNET addresses. Nosana's devnet dashboard lists only test
 * markets, so on devnet a tier is deployable only when the operator supplies an
 * address through NOSANA_MARKETS_JSON (config/nosanaDeploy.ts). An unconfigured
 * tier is an honest error at deploy time, never a placeholder address.
 *
 * Note for history: the address previously labelled "3060 // Example" in this
 * file, 97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf, is the nvidia-4090 market.
 */

import {
  getNosanaDeployConfig,
  type MarketOverride,
} from "../config/nosanaDeploy.js";

export type NosanaNetwork = "devnet" | "mainnet";

export interface NosanaMarket {
  /** Nosana market (jobs program account) address. */
  address: string;
  /**
   * Where `address` is valid: built-ins are "mainnet" only, an operator
   * override (NOSANA_MARKETS_JSON) is trusted on whichever network it runs.
   */
  addressNetwork: "mainnet" | "any";
  name: string;
  gpuModel: string;
  /** GB of GPU memory. */
  vram: number;
  /** USD per second per replica (retail; the unit billing uses). */
  pricePerSecond: number;
}

/** Built-in mainnet tiers. Retail prices are product configuration. */
export const BUILTIN_MARKETS: Readonly<Record<string, NosanaMarket>> = {
  "3060": {
    address: "7AtiXMSH6R1jjBxrcYjehCkkSF7zvYWte63gwEDBcGHq", // nvidia-3060
    addressNetwork: "mainnet",
    name: "RTX 3060",
    gpuModel: "RTX 3060",
    vram: 8,
    pricePerSecond: 0.0001,
  },
  "4070": {
    address: "EzuHhkrhmV98HWzREsgLenKj2iHdJgrKmzfL8psP8Aso", // nvidia-4070
    addressNetwork: "mainnet",
    name: "RTX 4070",
    gpuModel: "RTX 4070",
    vram: 12,
    pricePerSecond: 0.00015,
  },
  "4090": {
    address: "97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf", // nvidia-4090
    addressNetwork: "mainnet",
    name: "RTX 4090",
    gpuModel: "RTX 4090",
    vram: 24,
    pricePerSecond: 0.00025,
  },
  a100: {
    address: "F3aGGSMb73XHbJbDXVbcXo7iYM9fyevvAZGQfwgrnWtB", // nvidia-a100-40gb
    addressNetwork: "mainnet",
    name: "A100 40GB",
    gpuModel: "A100",
    vram: 40,
    pricePerSecond: 0.0008,
  },
  h100: {
    address: "Crop49jpc7prcgAcS82WbWyGHwbN5GgDym3uFbxxCTZg", // nvidia-h100
    addressNetwork: "mainnet",
    name: "H100 80GB",
    gpuModel: "H100",
    vram: 80,
    pricePerSecond: 0.0015,
  },
};

/**
 * Merges operator overrides over the built-ins. A bare-address override only
 * replaces the address of an existing tier; a new tier must be fully specified.
 */
export function buildMarketCatalog(
  builtin: Readonly<Record<string, NosanaMarket>>,
  overrides: Readonly<Record<string, MarketOverride>>,
): Record<string, NosanaMarket> {
  const catalog: Record<string, NosanaMarket> = {};
  for (const [tier, market] of Object.entries(builtin)) {
    catalog[tier] = { ...market };
  }

  for (const [tier, override] of Object.entries(overrides)) {
    const base = catalog[tier];
    if (base) {
      catalog[tier] = {
        ...base,
        address: override.address,
        addressNetwork: "any",
        name: override.name ?? base.name,
        gpuModel: override.gpuModel ?? base.gpuModel,
        vram: override.vram ?? base.vram,
        pricePerSecond: override.pricePerSecond ?? base.pricePerSecond,
      };
      continue;
    }
    if (
      override.name === undefined ||
      override.gpuModel === undefined ||
      override.vram === undefined ||
      override.pricePerSecond === undefined
    ) {
      throw new Error(
        `NOSANA_MARKETS_JSON: new tier '${tier}' must specify name, gpuModel, vram and pricePerSecond (USD/second)`,
      );
    }
    catalog[tier] = {
      address: override.address,
      addressNetwork: "any",
      name: override.name,
      gpuModel: override.gpuModel,
      vram: override.vram,
      pricePerSecond: override.pricePerSecond,
    };
  }
  return catalog;
}

/**
 * The effective catalog: built-ins + NOSANA_MARKETS_JSON. Exported (and
 * re-exported by services/nosana.ts) so compute-metering and treasury
 * settlement price jobs against the same source of truth the scheduler uses.
 */
export const MARKETS: Record<string, NosanaMarket> = buildMarketCatalog(
  BUILTIN_MARKETS,
  getNosanaDeployConfig().marketOverrides,
);

/** "mainnet-beta" (Solana cluster naming) -> "mainnet" (Nosana SDK naming). */
export function toNosanaNetwork(solanaNetwork: "devnet" | "mainnet-beta"): NosanaNetwork {
  return solanaNetwork === "mainnet-beta" ? "mainnet" : "devnet";
}

export class MarketNotConfiguredError extends Error {
  readonly code: "unknown_tier" | "market_not_configured";
  constructor(
    readonly tier: string,
    readonly network: NosanaNetwork,
    reason: "unknown_tier" | "market_not_configured",
  ) {
    super(
      reason === "unknown_tier"
        ? `Unknown GPU tier '${tier}'`
        : `market for tier ${tier} is not configured on ${network} (set NOSANA_MARKETS_JSON to supply a market address)`,
    );
    this.name = "MarketNotConfiguredError";
    this.code = reason;
  }
}

/** The market address for a tier on a network, or an honest error. */
export function resolveMarketAddress(
  tier: string,
  network: NosanaNetwork,
  catalog: Readonly<Record<string, NosanaMarket>> = MARKETS,
): string {
  const market = Object.hasOwn(catalog, tier) ? catalog[tier] : undefined;
  if (!market) throw new MarketNotConfiguredError(tier, network, "unknown_tier");
  if (market.addressNetwork === "mainnet" && network !== "mainnet") {
    throw new MarketNotConfiguredError(tier, network, "market_not_configured");
  }
  return market.address;
}

export function isTierDeployable(
  tier: string,
  network: NosanaNetwork,
  catalog: Readonly<Record<string, NosanaMarket>> = MARKETS,
): boolean {
  try {
    resolveMarketAddress(tier, network, catalog);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tiers a user may pick. With the dev-only mock enabled every tier is
 * selectable (the mock never touches a market); otherwise only tiers whose
 * market address is configured for this network.
 */
export function listDeployableTiers(
  network: NosanaNetwork,
  opts: { allowMock?: boolean; catalog?: Readonly<Record<string, NosanaMarket>> } = {},
): Array<[string, NosanaMarket]> {
  const catalog = opts.catalog ?? MARKETS;
  return Object.entries(catalog).filter(
    ([tier]) => opts.allowMock === true || isTierDeployable(tier, network, catalog),
  );
}
