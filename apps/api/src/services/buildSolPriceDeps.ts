/**
 * Composition root for the live SOL price (services/solPrice.ts): binds the
 * judge to config/env.ts and to the shared Solana connection.
 *
 * `getSolQuote()` answers with a quote or a refusal and never throws.
 *   off    - refuses with source_off.
 *   static - SOL_PRICE_STATIC_USD with no uncertainty, or static_not_set.
 *   pyth   - ONE getMultipleAccountsInfo call for [the price account, the
 *            clock sysvar] at "confirmed", so the price and the chain's own
 *            time come from the same slot, then the judge.
 *
 * An RPC error is the refusal rpc_unavailable. A failed read is never
 * papered over with an earlier price.
 *
 * A good pyth quote is remembered for up to 5 seconds to spare the RPC. A
 * remembered quote is aged by the time that has passed since it was read
 * and is not served once that age is past the maximum; a fresh read is made
 * instead, and its answer (quote or refusal) is the answer.
 */

import { PublicKey } from "@solana/web3.js";

import { env } from "../config/env.js";
import { getSolanaConnection } from "../lib/solana.js";
import {
  CLOCK_SYSVAR_ADDRESS,
  judgeSolPrice,
  staticSolQuote,
  usdToMicroUsd,
  type SolPriceResult,
  type SolPriceSource,
  type SolQuote,
} from "./solPrice.js";

export const SOL_QUOTE_MEMORY_MS = 5_000;

export interface SolPriceSettings {
  source: SolPriceSource;
  staticUsd?: number | null;
  /** Pyth's SOL/USD price account, base58. */
  account: string;
  feedIdHex: string;
  /** Programs allowed to own the price account, base58. */
  programIds: readonly string[];
  maxAgeSeconds: number;
  maxConfBps: number;
  maxEmaDeviationBps: number;
  minUsd?: number | null;
  maxUsd?: number | null;
}

export interface SolPriceAccountRead {
  owner: string;
  data: Uint8Array;
}

export interface SolPriceProviderDeps {
  /** Read on every call, so a test can change a setting between calls. */
  settings: () => SolPriceSettings;
  /**
   * The accounts at these addresses, in order, from ONE RPC call. null for
   * an account that does not exist. May throw: that is rpc_unavailable.
   */
  readAccounts: (addresses: readonly string[]) => Promise<Array<SolPriceAccountRead | null>>;
  /** Wall clock, milliseconds. Used for the memory and the static quote. */
  nowMs: () => number;
}

export interface SolPriceProvider {
  getSolQuote(): Promise<SolPriceResult>;
  /** Forget the remembered quote. */
  reset(): void;
}

interface Remembered {
  quote: SolQuote;
  /** Chain time minus publish time at the read, never below zero. */
  ageAtReadSeconds: number;
  readAtMs: number;
  /** The settings the quote was judged under. */
  key: string;
}

function settingsKey(s: SolPriceSettings): string {
  return [
    s.source,
    s.account,
    s.feedIdHex,
    s.programIds.join(","),
    s.maxAgeSeconds,
    s.maxConfBps,
    s.maxEmaDeviationBps,
    s.minUsd ?? "",
    s.maxUsd ?? "",
  ].join("|");
}

/**
 * What a failed read says for the log. An RPC client's error can carry the
 * endpoint address, and a provider's address can carry its key, so any
 * address is cut out before the text leaves this file.
 */
export function errorDetail(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<address>").slice(0, 300);
}

export function createSolPriceProvider(deps: SolPriceProviderDeps): SolPriceProvider {
  let remembered: Remembered | null = null;

  function fromMemory(settings: SolPriceSettings, nowMs: number): SolQuote | null {
    const kept = remembered;
    if (!kept) return null;
    const elapsedMs = nowMs - kept.readAtMs;
    if (kept.key !== settingsKey(settings) || elapsedMs < 0 || elapsedMs > SOL_QUOTE_MEMORY_MS) {
      remembered = null;
      return null;
    }
    // Part of a second counts as a whole one: the age only ever leans old.
    const age = kept.ageAtReadSeconds + Math.ceil(elapsedMs / 1000);
    // Written so a maximum that is not a number can never let a quote through.
    if (!(age <= settings.maxAgeSeconds)) {
      remembered = null;
      return null;
    }
    return { ...kept.quote, ageSeconds: Math.max(0, age) };
  }

  async function getSolQuote(): Promise<SolPriceResult> {
    try {
      const settings = deps.settings();
      // Anything that is not a known source is off.
      if (settings.source !== "pyth" && settings.source !== "static") {
        remembered = null;
        return { ok: false, code: "source_off" };
      }

      const nowMs = deps.nowMs();
      if (settings.source === "static") {
        return staticSolQuote(settings.staticUsd, Math.floor(nowMs / 1000));
      }

      // A band that is set but cannot be read as a price is not "no band":
      // it refuses, so a mistyped limit never switches the check off.
      const minMicroUsdPerSol = usdToMicroUsd(settings.minUsd);
      const maxMicroUsdPerSol = usdToMicroUsd(settings.maxUsd);
      if (
        (settings.minUsd != null && (minMicroUsdPerSol === null || minMicroUsdPerSol <= 0n)) ||
        (settings.maxUsd != null && (maxMicroUsdPerSol === null || maxMicroUsdPerSol <= 0n))
      ) {
        remembered = null;
        return { ok: false, code: "out_of_band", detail: "the price band setting is not a usable number" };
      }

      const kept = fromMemory(settings, nowMs);
      if (kept) return { ok: true, quote: kept };

      let accounts: Array<SolPriceAccountRead | null>;
      try {
        accounts = await deps.readAccounts([settings.account, CLOCK_SYSVAR_ADDRESS]);
      } catch (err) {
        remembered = null;
        return { ok: false, code: "rpc_unavailable", detail: errorDetail(err) };
      }
      if (!Array.isArray(accounts) || accounts.length !== 2) {
        remembered = null;
        return { ok: false, code: "rpc_unavailable", detail: "the node did not answer for both accounts" };
      }

      const result = judgeSolPrice({
        source: "pyth",
        account: accounts[0] ?? null,
        clockData: accounts[1]?.data ?? null,
        rules: {
          accountAddress: settings.account,
          allowedOwners: settings.programIds,
          feedIdHex: settings.feedIdHex,
          maxAgeSeconds: settings.maxAgeSeconds,
          maxConfBps: settings.maxConfBps,
          maxEmaDeviationBps: settings.maxEmaDeviationBps,
          minMicroUsdPerSol,
          maxMicroUsdPerSol,
        },
      });

      remembered = result.ok
        ? {
            quote: result.quote,
            ageAtReadSeconds: result.quote.ageSeconds,
            readAtMs: nowMs,
            key: settingsKey(settings),
          }
        : null;
      return result;
    } catch (err) {
      // Nothing above should throw; if it does, the answer is still a
      // refusal and never a price.
      remembered = null;
      return { ok: false, code: "rpc_unavailable", detail: errorDetail(err) };
    }
  }

  return {
    getSolQuote,
    reset: () => {
      remembered = null;
    },
  };
}

/** The settings as config/env.ts holds them. */
export interface SolPriceEnv {
  SOL_PRICE_SOURCE: SolPriceSource;
  SOL_PRICE_STATIC_USD?: number;
  PYTH_SOL_USD_ACCOUNT: string;
  PYTH_SOL_USD_FEED_ID: string;
  PYTH_PROGRAM_IDS: string;
  SOL_PRICE_MAX_AGE_SECONDS: number;
  SOL_PRICE_MAX_CONF_BPS: number;
  SOL_PRICE_MAX_EMA_DEVIATION_BPS: number;
  SOL_PRICE_MIN_USD?: number;
  SOL_PRICE_MAX_USD?: number;
}

export function solPriceSettingsFromEnv(e: SolPriceEnv): SolPriceSettings {
  return {
    source: e.SOL_PRICE_SOURCE,
    staticUsd: e.SOL_PRICE_STATIC_USD ?? null,
    account: e.PYTH_SOL_USD_ACCOUNT.trim(),
    feedIdHex: e.PYTH_SOL_USD_FEED_ID.trim(),
    programIds: e.PYTH_PROGRAM_IDS.split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    maxAgeSeconds: e.SOL_PRICE_MAX_AGE_SECONDS,
    maxConfBps: e.SOL_PRICE_MAX_CONF_BPS,
    maxEmaDeviationBps: e.SOL_PRICE_MAX_EMA_DEVIATION_BPS,
    minUsd: e.SOL_PRICE_MIN_USD ?? null,
    maxUsd: e.SOL_PRICE_MAX_USD ?? null,
  };
}

/** The one method of a Connection the price needs. */
export interface SolPriceConnection {
  getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    commitment: "confirmed"
  ): Promise<Array<{ owner: PublicKey; data: Uint8Array } | null>>;
}

export function bindSolPriceReads(
  getConnection: () => SolPriceConnection
): SolPriceProviderDeps["readAccounts"] {
  return async (addresses) => {
    const infos = await getConnection().getMultipleAccountsInfo(
      addresses.map((address) => new PublicKey(address)),
      "confirmed"
    );
    return infos.map((info) => (info ? { owner: info.owner.toBase58(), data: info.data } : null));
  };
}

let provider: SolPriceProvider | null = null;

function boundProvider(): SolPriceProvider {
  if (!provider) {
    provider = createSolPriceProvider({
      settings: () => solPriceSettingsFromEnv(env),
      readAccounts: bindSolPriceReads(() => getSolanaConnection()),
      nowMs: () => Date.now(),
    });
  }
  return provider;
}

/** The live SOL price: a quote or a refusal. Never throws. */
export function getSolQuote(): Promise<SolPriceResult> {
  return boundProvider().getSolQuote();
}

/** The margin every SOL quote carries against the customer, basis points. */
export function getSolQuoteMarginBps(): number {
  return env.SOL_QUOTE_MARGIN_BPS;
}

/** For tests: drop the bound provider and its remembered quote. */
export function resetSolQuoteForTests(): void {
  provider = null;
}
