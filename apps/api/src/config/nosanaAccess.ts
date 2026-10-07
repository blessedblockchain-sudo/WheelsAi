/**
 * How the platform reaches Nosana and pays for it.
 *
 * Two credentials are supported, and either or both may be present:
 *   - a Solana WALLET (NOSANA_WALLET_PRIVATE_KEY): the platform funds a vault
 *     per deployment in NOS + SOL and withdraws it on stop;
 *   - a dashboard API KEY (NOSANA_API_KEY): the same Deployment Manager REST API
 *     with `Authorization: Bearer <key>`, paid from prepaid USD credits. There
 *     is no vault and nothing to withdraw.
 *
 * Like config/nosanaDeploy.ts this module parses its OWN variables, so the
 * resolution rules can be tested without config/env.ts. validateEnv calls
 * loadNosanaAccessConfig, so a combination this module refuses stops the boot.
 *
 * Environment variables
 * ---------------------
 *
 * NOSANA_API_KEY                      (optional)
 *   Dashboard API key. Empty means unset. Never logged: only its last four
 *   characters ever leave this module (`apiKeySuffix`).
 *
 * NOSANA_ACCESS_MODE                  (optional: "wallet" | "api_key")
 *   Which credential creates NEW deployments. Required when both credentials
 *   are set - the platform never guesses which account pays. A mode that names
 *   a missing credential is refused. The other credential, when present, stays
 *   available for rows stamped with it (stop, reclaim, status).
 *
 * NOSANA_NETWORK                      (optional: "mainnet" | "devnet")
 *   Default: "mainnet" in api_key mode (keys and credits are a mainnet
 *   product); in wallet mode, derived from SOLANA_NETWORK as it always was.
 *   Each credential keeps ITS OWN network when both are loaded: unset, the
 *   wallet stays on the network derived from SOLANA_NETWORK and the API key on
 *   mainnet, whichever of them is primary - so making one primary never moves
 *   the other's existing deployments to a backend that does not know them.
 *   Set, it applies to both.
 *
 * NOSANA_API_URL                      (optional)
 *   Base URL of the Nosana backend, passed to the SDK as api.backend_url and
 *   used for the direct credit-balance and market-list reads. https only; plain
 *   http is accepted for a loopback host in development (the fake API used by
 *   tests and rehearsals). Default: the SDK preset for the network.
 *
 * NOSANA_MIN_CREDITS_USD              (default 5)
 *   Hard floor. A new deployment is refused unless the available credits cover
 *   its estimate PLUS this floor.
 *
 * NOSANA_CREDITS_WARN_USD             (default 20)
 *   Operator warning threshold for the available credits.
 *
 * NOSANA_CREDITS_CACHE_MS             (default 30000)
 *   How long a credit balance may be served from memory to the operator view
 *   and the runway check. The deploy gate never uses the cache.
 *
 * NOSANA_COST_CACHE_MS                (default 600000)
 *   How long the public market list (USD cost per tier) is cached.
 *
 * NOSANA_TIMEOUT_UNIT                 (default "minutes": "seconds" | "minutes")
 *   The unit the Deployment Manager applies to a deployment's `timeout`. All of
 *   our arithmetic is in seconds; the value is converted only at the SDK
 *   boundary, rounding up. SETTLED as minutes: the OpenAPI document ("Timeout
 *   in minutes"), the deployment-manager source (127f915, tasks/task/list/
 *   worker.ts lists the job for timeout * 60 seconds) and live INFINITE
 *   deployments that relist every timeout - rotation_time minutes. The SDK's
 *   (0.4.74) and kit's "seconds" JSDoc is stale. "seconds" is kept only so an
 *   old .env still parses, and it is warned about loudly at every boot: it
 *   sends sixty times the intended timeout, and Nosana debits a full timeout
 *   of credits per job when it is listed.
 *
 * NOSANA_SDK_TIMEOUT_MS               (default 30000, range 100..300000)
 *   Deadline on every Nosana SDK call (create, get, start, stop,
 *   updateReplicaCount, updateTimeout, getJob). Neither the SDK nor the API
 *   client under it sets one, so a hung call would block a request or a
 *   worker tick for ever. A create that runs out of time is treated as one
 *   that may have happened (it is looked up by its idempotency key).
 */

import { z } from "zod";

export class NosanaAccessConfigError extends Error {
  constructor(message: string) {
    super(`Invalid Nosana access configuration: ${message}`);
    this.name = "NosanaAccessConfigError";
  }
}

/** A credential that can own a Nosana deployment. */
export type NosanaAccessMode = "wallet" | "api_key";
export type NosanaPrimaryMode = NosanaAccessMode | "none";
export type NosanaAccessNetwork = "mainnet" | "devnet";
export type NosanaTimeoutUnit = "seconds" | "minutes";

export const NOSANA_ACCESS_MODES = ["wallet", "api_key"] as const;

/**
 * The SDK's own backend per network (node_modules/@nosana/sdk/dist/config.js,
 * apiConfigPreset). Repeated here because the direct credit and market reads
 * do not go through the SDK.
 */
export const NOSANA_BACKEND_URLS: Readonly<Record<NosanaAccessNetwork, string>> = {
  mainnet: "https://dashboard.k8s.prd.nos.ci",
  devnet: "https://dashboard.k8s.dev.nos.ci",
};

export interface NosanaAccessConfig {
  /** The credential that creates new deployments; "none" answers 501. */
  primary: NosanaPrimaryMode;
  hasWallet: boolean;
  hasApiKey: boolean;
  network: NosanaAccessNetwork;
  /**
   * The network wallet-created deployments live on: NOSANA_NETWORK when set,
   * else derived from SOLANA_NETWORK - whatever the primary mode is.
   */
  walletNetwork: NosanaAccessNetwork;
  /** The network the API key is used on: NOSANA_NETWORK when set, else mainnet. */
  apiNetwork: NosanaAccessNetwork;
  /** True when NOSANA_NETWORK was set: it then applies to both credentials. */
  networkExplicit: boolean;
  /** True when the network came from SOLANA_NETWORK (wallet access, no NOSANA_NETWORK). */
  networkDerived: boolean;
  /** Secret. Never log it; use apiKeySuffix. */
  apiKey?: string;
  /** Last four characters of the key, for logs and the operator view. */
  apiKeySuffix?: string;
  /** NOSANA_API_URL when set. */
  apiUrl?: string;
  /** apiUrl, or the SDK preset for the network. No trailing slash. */
  backendUrl: string;
  minCreditsMicroUsd: bigint;
  warnCreditsMicroUsd: bigint;
  creditsCacheMs: number;
  costCacheMs: number;
  timeoutUnit: NosanaTimeoutUnit;
  /** True when NOSANA_TIMEOUT_UNIT was set explicitly. */
  timeoutUnitExplicit: boolean;
  /** Deadline on each Nosana SDK call, milliseconds. */
  sdkTimeoutMs: number;
  /** Things an operator should see at boot. Never contain the key. */
  warnings: string[];
}

const MICRO_USD_PER_USD = 1_000_000n;
const USD_AMOUNT = /^\d{1,7}(\.\d{1,6})?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** "12.5" -> 12500000n. Decimal text only, so no float ever touches money. */
export function usdTextToMicroUsd(text: string): bigint {
  if (!USD_AMOUNT.test(text)) {
    throw new RangeError("must be a non-negative USD amount with at most 6 decimals");
  }
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * MICRO_USD_PER_USD + BigInt(fraction.padEnd(6, "0"));
}

/**
 * Our seconds -> the number the Deployment Manager is given. Rounds UP, so a
 * conversion never shortens a timeout.
 */
export function secondsToSdkTimeout(seconds: number, unit: NosanaTimeoutUnit): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new RangeError(`timeout must be a positive integer of seconds, got ${seconds}`);
  }
  return unit === "minutes" ? Math.ceil(seconds / 60) : seconds;
}

/**
 * The seconds a timeout is worth once it has been sent: in minutes, a value
 * that is not a whole minute runs to the end of the minute it was rounded up
 * to. Funding and estimates are sized from this, so they never cover less
 * than what Nosana was asked for.
 */
export function effectiveTimeoutSeconds(seconds: number, unit: NosanaTimeoutUnit): number {
  return unit === "minutes" ? secondsToSdkTimeout(seconds, unit) * 60 : seconds;
}

const intFromEnv = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const usdFromEnv = (fallback: string) =>
  z
    .string()
    .regex(USD_AMOUNT, "must be a non-negative USD amount with at most 6 decimals")
    .default(fallback);

const rawSchema = z.object({
  NOSANA_API_KEY: z.string().min(20, "is too short to be a Nosana API key").optional(),
  NOSANA_WALLET_PRIVATE_KEY: z.string().optional(),
  NOSANA_ACCESS_MODE: z.enum(NOSANA_ACCESS_MODES).optional(),
  NOSANA_NETWORK: z.enum(["mainnet", "devnet"]).optional(),
  NOSANA_API_URL: z.string().optional(),
  NOSANA_MIN_CREDITS_USD: usdFromEnv("5"),
  NOSANA_CREDITS_WARN_USD: usdFromEnv("20"),
  NOSANA_CREDITS_CACHE_MS: intFromEnv(0, 3_600_000).default(30_000),
  NOSANA_COST_CACHE_MS: intFromEnv(0, 86_400_000).default(600_000),
  NOSANA_TIMEOUT_UNIT: z.enum(["seconds", "minutes"]).optional(),
  NOSANA_SDK_TIMEOUT_MS: intFromEnv(100, 300_000).default(30_000),
  SOLANA_NETWORK: z.enum(["devnet", "mainnet-beta"]).default("devnet"),
  NODE_ENV: z.string().default("development"),
});

function parseApiUrl(raw: string, nodeEnv: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new NosanaAccessConfigError("NOSANA_API_URL is not a valid URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new NosanaAccessConfigError(
      "NOSANA_API_URL must be a bare base URL (no credentials, query or fragment)",
    );
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === "http:" && !(loopback && nodeEnv === "development")) {
    throw new NosanaAccessConfigError(
      "NOSANA_API_URL must be https (http is accepted only for a loopback host in development)",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new NosanaAccessConfigError("NOSANA_API_URL must be https");
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function loadNosanaAccessConfig(
  source: Record<string, string | undefined> = process.env,
): NosanaAccessConfig {
  // Empty strings (e.g. `FOO=` in a .env file) mean "unset".
  const cleaned: Record<string, string | undefined> = {};
  for (const key of Object.keys(rawSchema.shape)) {
    const value = source[key];
    cleaned[key] = value === undefined || value.trim() === "" ? undefined : value.trim();
  }

  const parsed = rawSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Only the variable name and zod's own message: never the value, which
    // for NOSANA_API_KEY would be the secret.
    const issue = parsed.error.issues[0];
    throw new NosanaAccessConfigError(
      `${issue?.path.join(".") ?? "config"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  const raw = parsed.data;

  const hasWallet = raw.NOSANA_WALLET_PRIVATE_KEY !== undefined;
  const hasApiKey = raw.NOSANA_API_KEY !== undefined;
  const named = raw.NOSANA_ACCESS_MODE;

  let primary: NosanaPrimaryMode;
  if (named === "api_key" && !hasApiKey) {
    throw new NosanaAccessConfigError("NOSANA_ACCESS_MODE=api_key requires NOSANA_API_KEY");
  }
  if (named === "wallet" && !hasWallet) {
    throw new NosanaAccessConfigError(
      "NOSANA_ACCESS_MODE=wallet requires NOSANA_WALLET_PRIVATE_KEY",
    );
  }
  if (named) {
    primary = named;
  } else if (hasWallet && hasApiKey) {
    throw new NosanaAccessConfigError(
      "both NOSANA_API_KEY and NOSANA_WALLET_PRIVATE_KEY are set; set NOSANA_ACCESS_MODE to wallet or api_key to say which account pays for new deployments",
    );
  } else {
    primary = hasApiKey ? "api_key" : hasWallet ? "wallet" : "none";
  }

  const derivedNetwork: NosanaAccessNetwork =
    raw.SOLANA_NETWORK === "mainnet-beta" ? "mainnet" : "devnet";
  const networkDerived = raw.NOSANA_NETWORK === undefined && primary !== "api_key";
  // One network per credential, independent of which is primary: switching
  // the primary must not point the other credential's rows at another backend.
  const walletNetwork: NosanaAccessNetwork = raw.NOSANA_NETWORK ?? derivedNetwork;
  const apiNetwork: NosanaAccessNetwork = raw.NOSANA_NETWORK ?? "mainnet";
  const network: NosanaAccessNetwork = primary === "api_key" ? apiNetwork : walletNetwork;

  const apiUrl = raw.NOSANA_API_URL ? parseApiUrl(raw.NOSANA_API_URL, raw.NODE_ENV) : undefined;

  const warnings: string[] = [];
  if (hasApiKey && !raw.NOSANA_API_KEY!.startsWith("nos_")) {
    warnings.push("NOSANA_API_KEY does not start with 'nos_'; check that it is a dashboard API key");
  }
  if (primary === "api_key" && network === "devnet") {
    warnings.push("NOSANA_ACCESS_MODE is api_key on devnet; credits on the devnet backend are unverified");
  }
  if (hasApiKey && hasWallet && walletNetwork !== apiNetwork) {
    warnings.push(
      `the Nosana wallet is used on ${walletNetwork} (derived from SOLANA_NETWORK) and the API key on ${apiNetwork}; each keeps its own deployments there - set NOSANA_NETWORK to put both on one network`,
    );
  }
  if (raw.NOSANA_TIMEOUT_UNIT === "seconds") {
    warnings.push(
      "NOSANA_TIMEOUT_UNIT=seconds: THE DEPLOYMENT MANAGER READS MINUTES. Every deployment timeout is sent 60 times too long, and Nosana debits a full timeout of credits per job when it is listed. Remove the variable (minutes is the default)",
    );
  }

  return {
    primary,
    hasWallet,
    hasApiKey,
    network,
    walletNetwork,
    apiNetwork,
    networkExplicit: raw.NOSANA_NETWORK !== undefined,
    networkDerived,
    ...(hasApiKey
      ? { apiKey: raw.NOSANA_API_KEY!, apiKeySuffix: raw.NOSANA_API_KEY!.slice(-4) }
      : {}),
    ...(apiUrl ? { apiUrl } : {}),
    backendUrl: apiUrl ?? NOSANA_BACKEND_URLS[network],
    minCreditsMicroUsd: usdTextToMicroUsd(raw.NOSANA_MIN_CREDITS_USD),
    warnCreditsMicroUsd: usdTextToMicroUsd(raw.NOSANA_CREDITS_WARN_USD),
    creditsCacheMs: raw.NOSANA_CREDITS_CACHE_MS,
    costCacheMs: raw.NOSANA_COST_CACHE_MS,
    timeoutUnit: raw.NOSANA_TIMEOUT_UNIT ?? "minutes",
    timeoutUnitExplicit: raw.NOSANA_TIMEOUT_UNIT !== undefined,
    sdkTimeoutMs: raw.NOSANA_SDK_TIMEOUT_MS,
    warnings,
  };
}

let cached: NosanaAccessConfig | null = null;

/** Process-wide config, parsed once from process.env on first use. */
export function getNosanaAccessConfig(): NosanaAccessConfig {
  if (!cached) cached = loadNosanaAccessConfig(process.env);
  return cached;
}

/** Test seam: drop the cached parse so the next call re-reads process.env. */
export function resetNosanaAccessConfigForTests(): void {
  cached = null;
}

/**
 * The mode recorded on a row that stores a Nosana id. A null column means the
 * row predates the stamp, and everything before it was created by the wallet.
 */
export function rowAccessMode(value: string | null | undefined): NosanaAccessMode {
  return value === "api_key" ? "api_key" : "wallet";
}
